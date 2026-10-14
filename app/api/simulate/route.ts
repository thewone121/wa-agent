/**
 * "Try it as a customer" — the dashboard's live demo.
 *
 * Runs the real customer turn from lib/turn.ts: the same model, catalogue,
 * tools, throttle and cost accounting a WhatsApp customer gets, writing to the
 * same tables, so the conversation and any order it creates appear in Chats
 * and Orders like any other. The only difference is transport — the reply is
 * recorded and returned to the browser instead of being posted to WhatsApp.
 *
 * Signed-in owners only. The caller's Supabase access token is verified here
 * and the merchant is resolved from it, so nobody on the open internet can run
 * up the AI bill or write into a merchant's data through this route.
 *
 * Test customers get phone numbers starting 000. No real E.164 number starts
 * with 0, so a try-it session can never land in a real customer's thread, and
 * every test conversation is easy to find and delete afterwards.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  admin,
  claimInbound,
  conversationStatus,
  logMessage,
  merchantByOwner,
} from "@/lib/supabase";
import { customerTurn } from "@/lib/turn";
import { orderRef } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Shared with the browser: 000 followed by nine digits. */
const TEST_PHONE = /^000\d{9}$/;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
  /* --- who is asking ------------------------------------------------- */
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in to the dashboard first." }, 401);

  const db = admin();
  const { data: auth, error: authErr } = await db.auth.getUser(token);
  if (authErr || !auth?.user) {
    return json({ error: "Your session has expired. Sign in again." }, 401);
  }

  const merchant = await merchantByOwner(auth.user.id);
  if (!merchant) return json({ error: "This account doesn't own an active business." }, 403);

  /* --- what they sent ------------------------------------------------ */
  let body: { text?: unknown; phone?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "That request wasn't readable." }, 400);
  }

  const text = typeof body.text === "string" ? body.text.trim().slice(0, 1000) : "";
  const phone = typeof body.phone === "string" ? body.phone : "";
  const name =
    typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 40) : "Test customer";

  if (!TEST_PHONE.test(phone)) return json({ error: "That isn't a test customer." }, 400);
  if (!text) return json({ error: "Type a message first." }, 400);

  /* --- record it as an inbound message, exactly as the webhook does --- */
  const { data: ctxRows, error: ctxErr } = await db.rpc("upsert_customer_conversation", {
    p_merchant_id: merchant.id,
    p_wa_phone: phone,
    p_name: name,
  });
  if (ctxErr || !ctxRows?.length) {
    console.error("[simulate] upsert_customer_conversation failed", ctxErr?.message);
    return json({ error: "Couldn't start the conversation." }, 500);
  }

  const customerId: string = ctxRows[0].out_customer_id;
  const conversationId: string = ctxRows[0].out_conversation_id;
  const waMessageId = `sim.${randomUUID()}`;

  const claimed = await claimInbound({
    merchant_id: merchant.id,
    conversation_id: conversationId,
    wa_message_id: waMessageId,
    body: text,
    media_type: null,
    media_id: null,
  });
  if (!claimed) return json({ error: "That message was already recorded." }, 409);

  // Handed to the owner earlier in this test chat: the assistant stays quiet,
  // which is exactly what a real customer would experience.
  if ((await conversationStatus(conversationId)) === "escalated") {
    return json({ conversationId, replies: [], muted: true });
  }

  /* --- the real turn, with a sender that records instead of posting --- */
  const replies: string[] = [];
  try {
    const outcome = await customerTurn({
      merchant,
      customerId,
      conversationId,
      text,
      excludeWaMessageId: waMessageId,
      countsAsServiceMessage: false,
      send: async (reply, usage = {}) => {
        replies.push(reply);
        await logMessage({
          merchant_id: merchant.id,
          conversation_id: conversationId,
          direction: "outbound",
          body: reply,
          // Nothing went to Meta, so this is not a billable service message.
          billable_service: false,
          ...usage,
        });
      },
    });

    if (outcome.kind === "throttled") {
      return json({ conversationId, replies, throttled: true });
    }

    const { result } = outcome;

    // The total as Postgres computed it, so the "order created" note in the
    // demo quotes the same figure the Orders page will show.
    let orderTotalMinor: number | null = null;
    if (result.orderId) {
      const { data: order } = await db
        .from("orders")
        .select("total_minor")
        .eq("id", result.orderId)
        .maybeSingle();
      orderTotalMinor = order ? Number(order.total_minor) : null;
    }

    return json({
      conversationId,
      replies,
      model: result.model,
      costMinor: result.costMinor,
      escalated: result.escalated,
      orderId: result.orderId,
      orderRef: result.orderId ? orderRef(result.orderId) : null,
      orderTotalMinor,
    });
  } catch (e) {
    // The model provider is the part most likely to fail in a demo, and a raw
    // stack trace in front of an audience helps nobody.
    const status = (e as { status?: number })?.status;
    console.error("[simulate] turn failed", status, e instanceof Error ? e.message : e);

    if (status === 429) {
      return json(
        {
          conversationId,
          error:
            "The AI provider is limiting requests — on the free tier that usually means today's allowance is used up. Add credit on OpenRouter, or try again later.",
        },
        503,
      );
    }
    if (status === 401 || status === 402) {
      return json(
        { conversationId, error: "The AI account was refused — check the API key and that it has credit." },
        503,
      );
    }
    return json({ conversationId, error: "The assistant couldn't answer just now. Try again." }, 502);
  }
}
