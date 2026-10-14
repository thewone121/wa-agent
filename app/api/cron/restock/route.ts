/**
 * Scheduled sweep. Two jobs, one route.
 *
 * Runs once a day at 08:00 UTC (09:00 in Lagos) — see vercel.json. Vercel's
 * free Hobby plan refuses to deploy anything more frequent; on Pro this can go
 * back to hourly ("0 * * * *"), which matters most for job 2 below.
 *
 * 1. RESTOCK ALERTS — the retention feature: "tell me when size 45 is back"
 *    turns a dead lead into a future sale. It runs outside the 24h service
 *    window, so it MUST use an approved MARKETING template — a free-form
 *    reply will not deliver.
 *
 *    Marketing templates to Nigerian numbers cost roughly ₦70 each, vs ~₦13.50
 *    for a service reply. So this fires only on explicit intent (the customer
 *    said yes), once per customer per product, and is capped per run.
 *
 * 2. ORDER NOTIFICATIONS — retry for owners who were outside their own 24h
 *    window when an order came in. Without this an order placed overnight,
 *    while the owner hadn't messaged the business number that day, is
 *    silently never announced.
 *
 * Both live in one route so one schedule covers both. On a daily schedule an
 * overnight order is announced the next morning at the latest, rather than
 * within the hour.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  admin,
  unnotifiedOrders,
  orderSummary,
  markOrderNotified,
  merchantByPhoneNumberId,
  bumpUsage,
} from "@/lib/supabase";
import { sendTemplate, sendText, WhatsAppError } from "@/lib/whatsapp";
import { formatOrderNotification } from "@/lib/owner";
import { fmtMoney } from "@/lib/money";
import {
  RESTOCK_TEMPLATE_NAME,
  RESTOCK_TEMPLATE_LANG,
  RESTOCK_MAX_PER_RUN,
} from "@/lib/env";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Alert = {
  alert_id: string;
  merchant_id: string;
  wa_phone: string;
  customer_name: string | null;
  product_name: string;
  price_minor: number;
  wa_phone_number_id: string;
  currency: "NGN" | "GHS";
  merchant_name: string;
};

export async function GET(req: NextRequest) {
  // Vercel Cron sends this header. Without the check, anyone who finds the
  // URL can burn your marketing-template budget.
  //
  // Compared in constant time: a plain !== leaks the secret one character at
  // a time to anyone who can measure response latency across many requests.
  if (!authorised(req.headers.get("authorization"))) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const [restock, orders] = await Promise.all([runRestock(), runOrderNotifications()]);

  return NextResponse.json({ ok: true, restock, orders });
}

function authorised(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;

  const a = Buffer.from(`Bearer ${secret}`);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* 1. Restock alerts                                                   */
/* ------------------------------------------------------------------ */
async function runRestock() {
  const db = admin();

  const { data, error } = await db.rpc("pending_stock_alerts", { p_merchant_id: null });

  if (error) {
    console.error("[restock] query failed", error);
    return { ok: false, error: error.message };
  }

  const alerts = (data ?? []) as Alert[];
  const batch = alerts.slice(0, RESTOCK_MAX_PER_RUN);

  let sent = 0;
  let failed = 0;

  // Once a template is rejected it will be rejected for every send in this
  // run, so the whole batch is abandoned rather than burning the rate limit.
  const brokenTemplates = new Set<string>();

  for (const a of batch) {
    if (brokenTemplates.has(a.merchant_id)) continue;

    try {
      await sendTemplate(
        a.wa_phone_number_id,
        a.wa_phone,
        RESTOCK_TEMPLATE_NAME,
        RESTOCK_TEMPLATE_LANG,
        [
          a.customer_name ?? "there",
          a.product_name,
          // Currency now comes from the merchant row. This was hardcoded to
          // ₦, so a GHS merchant quoted naira prices in a paid template.
          fmtMoney(a.price_minor, a.currency),
        ],
      );

      await db
        .from("stock_alerts")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", a.alert_id);

      await bumpUsage({ merchantId: a.merchant_id, templateMessages: 1 });

      sent++;
    } catch (e) {
      failed++;

      if (e instanceof WhatsAppError && e.templateProblem) {
        // Template not approved, or its variable count doesn't match what
        // Meta approved. Nothing to retry until the template is fixed — and
        // it's per-merchant, so one broken template shouldn't stop the rest.
        console.error(
          `[restock] template rejected for merchant ${a.merchant_id} — check approval in Meta:`,
          e.message,
        );
        brokenTemplates.add(a.merchant_id);
        continue;
      }

      // A number that no longer exists on WhatsApp will fail forever. Mark it
      // so it doesn't reappear in every run from now on.
      if (e instanceof WhatsAppError && !e.retryable) {
        await db
          .from("stock_alerts")
          .update({ notified_at: new Date().toISOString() })
          .eq("id", a.alert_id);
      }

      console.error("[restock] send failed", a.wa_phone, e);
    }
  }

  return { pending: alerts.length, sent, failed, capped: alerts.length > batch.length };
}

/* ------------------------------------------------------------------ */
/* 2. Order notification retry                                         */
/* ------------------------------------------------------------------ */
async function runOrderNotifications() {
  const pending = await unnotifiedOrders();

  let sent = 0;
  let failed = 0;

  // One merchant lookup per merchant, not per order.
  type NotifyTarget = {
    wa_phone_number_id: string | null;
    escalation_number: string | null;
    owner_notify: boolean;
  };
  const merchants = new Map<string, NotifyTarget | null>();

  for (const row of pending) {
    const order = await orderSummary(row.out_order_id);
    if (!order) continue;

    let merchant = merchants.get(row.out_merchant_id);
    if (merchant === undefined) {
      const { data } = await admin()
        .from("merchants")
        .select("id,wa_phone_number_id,escalation_number,owner_notify")
        .eq("id", row.out_merchant_id)
        .maybeSingle();
      merchant = (data as unknown as NotifyTarget) ?? null;
      merchants.set(row.out_merchant_id, merchant);
    }

    // owner_notify off means the owner asked for silence via `mute`; skip
    // rather than mark, so turning it back on replays the backlog.
    if (!merchant?.escalation_number || !merchant.wa_phone_number_id) continue;
    if (!merchant.owner_notify) continue;

    try {
      await sendText(
        merchant.wa_phone_number_id,
        merchant.escalation_number,
        formatOrderNotification(order),
      );
      await markOrderNotified(order.id);
      sent++;
    } catch (e) {
      failed++;
      if (e instanceof WhatsAppError && e.needsTemplate) {
        // Still outside the owner's window. Leave it unmarked and try again
        // next hour — the moment the owner messages their business number the
        // window reopens and the backlog goes out.
        continue;
      }
      console.error("[orders] owner notification failed", order.id, e);
    }
  }

  return { pending: pending.length, sent, failed };
}
