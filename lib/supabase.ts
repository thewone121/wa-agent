/**
 * Server-only Supabase client.
 *
 * Uses the SERVICE ROLE key, which bypasses RLS. That is correct for the
 * webhook (there is no logged-in user on an inbound WhatsApp message) and
 * catastrophic anywhere the browser can reach. Never import this from a
 * client component — the dashboard uses lib/supabase-browser.ts instead,
 * which holds the anon key and goes through RLS.
 */

import { createClient, SupabaseClient, PostgrestError } from "@supabase/supabase-js";
import { required } from "./env";
import type { Currency } from "./money";

let cached: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */
export type Merchant = {
  id: string;
  name: string;
  currency: Currency;
  timezone: string;
  wa_phone_number_id: string;
  ai_tone: string;
  business_hours: Record<string, string>;
  escalation_number: string | null;
  delivery_fee_minor: number;
  greeting: string | null;
  plan_reply_cap: number;
  owner_notify: boolean;
};

const MERCHANT_COLS =
  "id,name,currency,timezone,wa_phone_number_id,ai_tone,business_hours," +
  "escalation_number,delivery_fee_minor,greeting,plan_reply_cap,owner_notify";

export type OrderSummary = {
  id: string;
  status: "draft" | "pending_payment" | "confirmed" | "fulfilled" | "cancelled";
  subtotal_minor: number;
  delivery_minor: number;
  total_minor: number;
  currency: Currency;
  delivery_address: string | null;
  notes: string | null;
  created_at: string;
  paid_at: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  customer_name: string | null;
  customer_phone: string;
  merchant_id: string;
  conversation_id: string | null;
  items: {
    product_name: string;
    quantity: number;
    unit_price_minor: number;
    line_total_minor: number;
  }[];
};

/* ------------------------------------------------------------------ */
/* Merchant lookup                                                     */
/* ------------------------------------------------------------------ */

/** Find which tenant a message belongs to, by the number that received it. */
export async function merchantByPhoneNumberId(
  phoneNumberId: string,
): Promise<Merchant | null> {
  const { data } = await admin()
    .from("merchants")
    .select(MERCHANT_COLS)
    .eq("wa_phone_number_id", phoneNumberId)
    .eq("is_active", true)
    .maybeSingle();

  // Cast through unknown: MERCHANT_COLS is a runtime string, so supabase-js
  // can't infer the row shape from it and falls back to a generic type.
  return (data as unknown as Merchant) ?? null;
}

/* ------------------------------------------------------------------ */
/* Idempotency                                                         */
/* ------------------------------------------------------------------ */

/**
 * Claim an inbound message, returning false if another invocation already has it.
 *
 * Meta retries any webhook it doesn't get a fast 200 for, and it does not wait
 * for the retry to be the *only* delivery in flight. The previous version read
 * the messages table and then inserted, which leaves a window: two concurrent
 * deliveries of the same message both see "not processed", both call Claude,
 * and the customer gets answered twice while you pay twice.
 *
 * The unique index messages_wa_id_idx already made the second insert fail — so
 * the fix is to stop asking and just insert, letting Postgres arbitrate. 23505
 * is unique_violation, and here it means "someone else got there first".
 */
export async function claimInbound(row: {
  merchant_id: string;
  conversation_id: string;
  wa_message_id: string;
  body: string | null;
  media_type: string | null;
  media_id: string | null;
}): Promise<boolean> {
  const { error } = await admin()
    .from("messages")
    .insert({ ...row, direction: "inbound" });

  if (!error) return true;
  if ((error as PostgrestError).code === "23505") return false;
  throw error;
}

export async function logMessage(row: {
  merchant_id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  wa_message_id?: string | null;
  body?: string | null;
  media_type?: string | null;
  media_id?: string | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_tokens?: number | null;
  cache_write_tokens?: number | null;
  cost_minor?: number;
  billable_service?: boolean;
  send_error?: string | null;
}) {
  const { error } = await admin().from("messages").insert(row);
  if (error) console.error("[db] logMessage failed", error.message);
}

/**
 * Meta came back and said a reply we sent never reached the phone. Record it
 * on the outbound row so the transcript shows "Not delivered" instead of a
 * reply that looks fine. Matched on wa_message_id, which deliver() stores
 * from the send response.
 */
export async function markSendFailed(waMessageId: string, reason: string) {
  const { error } = await admin()
    .from("messages")
    .update({ send_error: reason })
    .eq("wa_message_id", waMessageId)
    .eq("direction", "outbound");
  if (error) console.error("[db] markSendFailed", error.message);
}

/* ------------------------------------------------------------------ */
/* Conversation context                                                */
/* ------------------------------------------------------------------ */

export type Turn = { role: "user" | "assistant"; content: string };

/**
 * Last N turns for conversation context, oldest first.
 *
 * Two constraints the previous version violated:
 *
 *  1. The inbound message is written to the transcript BEFORE the agent runs
 *     (so the idempotency claim is durable). That means the newest row here is
 *     the message we're about to answer — passing it as history AND as the
 *     incoming message showed it to the model twice. `excludeWaMessageId`
 *     drops it.
 *
 *  2. The Messages API requires the first message to be `user`. Taking the
 *     last 16 rows of a live transcript lands on an assistant row roughly half
 *     the time, which is a hard 400 — and it fails on established
 *     conversations, not in testing.
 */
export async function recentTurns(
  conversationId: string,
  opts: { limit?: number; excludeWaMessageId?: string } = {},
): Promise<Turn[]> {
  const limit = opts.limit ?? 16;

  let q = admin()
    .from("messages")
    .select("direction,body,wa_message_id")
    .eq("conversation_id", conversationId)
    .not("body", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (opts.excludeWaMessageId) {
    q = q.neq("wa_message_id", opts.excludeWaMessageId);
  }

  const { data } = await q;

  const turns: Turn[] = (data ?? [])
    .reverse()
    .slice(-limit)
    .map((m) => ({
      role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: m.body as string,
    }));

  return trimToUserStart(turns);
}

/**
 * Drop leading assistant turns so the history starts on `user`.
 *
 * Exported for the tests — this is the rule that is easy to regress and
 * impossible to notice until a real conversation is long enough to slide.
 */
export function trimToUserStart(turns: Turn[]): Turn[] {
  let i = 0;
  while (i < turns.length && turns[i].role !== "user") i++;
  return turns.slice(i);
}

/** Which model last answered here. Drives sticky routing — see pricing.pickModel. */
export async function conversationModel(conversationId: string): Promise<string | null> {
  const { data } = await admin().rpc("conversation_model", {
    p_conversation_id: conversationId,
  });
  return (data as string | null) ?? null;
}

/** Inbound messages in this thread in the last N seconds — the abuse throttle. */
export async function recentInboundCount(
  conversationId: string,
  seconds: number,
): Promise<number> {
  const { data, error } = await admin().rpc("recent_inbound_count", {
    p_conversation_id: conversationId,
    p_seconds: seconds,
  });
  // Fail open: a broken counter must not stop the business replying to customers.
  if (error) {
    console.error("[db] recentInboundCount failed", error.message);
    return 0;
  }
  return Number(data ?? 0);
}

export async function conversationStatus(
  conversationId: string,
): Promise<"open" | "escalated" | "closed" | null> {
  const { data } = await admin()
    .from("conversations")
    .select("status")
    .eq("id", conversationId)
    .maybeSingle();
  return (data?.status as "open" | "escalated" | "closed") ?? null;
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

export async function orderSummary(orderId: string): Promise<OrderSummary | null> {
  const { data, error } = await admin().rpc("order_summary", { p_order_id: orderId });
  if (error) {
    console.error("[db] orderSummary failed", error.message);
    return null;
  }
  return (data as OrderSummary) ?? null;
}

export async function findOrderByRef(
  merchantId: string,
  ref: string,
): Promise<string | null> {
  const { data, error } = await admin().rpc("find_order", {
    p_merchant_id: merchantId,
    p_ref: ref,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function setOrderStatus(
  merchantId: string,
  orderId: string,
  status: OrderSummary["status"],
  actor = "owner",
  note?: string,
): Promise<OrderSummary> {
  const { data, error } = await admin().rpc("set_order_status", {
    p_merchant_id: merchantId,
    p_order_id: orderId,
    p_status: status,
    p_actor: actor,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as OrderSummary;
}

export async function unnotifiedOrders(
  merchantId?: string,
): Promise<{ out_order_id: string; out_merchant_id: string }[]> {
  const { data, error } = await admin().rpc("unnotified_orders", {
    p_merchant_id: merchantId ?? null,
  });
  if (error) {
    console.error("[db] unnotifiedOrders failed", error.message);
    return [];
  }
  return (data as { out_order_id: string; out_merchant_id: string }[]) ?? [];
}

export async function markOrderNotified(orderId: string): Promise<void> {
  await admin().rpc("mark_order_notified", { p_order_id: orderId });
}

export type OrderRow = {
  id: string;
  status: OrderSummary["status"];
  total_minor: number;
  currency: Currency;
  customer_name: string | null;
  customer_phone: string;
  created_at: string;
  item_count: number;
};

export async function recentOrders(
  merchantId: string,
  status?: OrderSummary["status"],
  limit = 10,
): Promise<OrderRow[]> {
  const { data, error } = await admin().rpc("recent_orders", {
    p_merchant_id: merchantId,
    p_status: status ?? null,
    p_limit: limit,
  });
  if (error) throw error;
  return (data as OrderRow[]) ?? [];
}

/* ------------------------------------------------------------------ */
/* Conversations (owner console)                                       */
/* ------------------------------------------------------------------ */

export async function conversationByPhone(merchantId: string, phone: string) {
  const { data, error } = await admin().rpc("conversation_by_phone", {
    p_merchant_id: merchantId,
    p_wa_phone: phone,
  });
  if (error) throw error;
  const rows = (data ?? []) as {
    out_conversation_id: string;
    out_customer_id: string;
    out_status: string;
    out_customer_name: string | null;
  }[];
  return rows[0] ?? null;
}

export async function resumeConversation(merchantId: string, conversationId: string) {
  const { error } = await admin().rpc("resume_conversation", {
    p_merchant_id: merchantId,
    p_conversation_id: conversationId,
  });
  if (error) throw error;
}

export async function closeConversation(merchantId: string, conversationId: string) {
  const { error } = await admin().rpc("close_conversation", {
    p_merchant_id: merchantId,
    p_conversation_id: conversationId,
  });
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

export type UsageSnapshot = {
  period_month: string;
  ai_replies: number;
  service_messages: number;
  template_messages: number;
  ai_cost_minor: number;
  overage_replies: number;
  reply_cap: number;
  plan_price_minor: number;
  overage_price_minor: number;
  currency: Currency;
};

export type BumpResult = {
  out_ai_replies: number;
  out_reply_cap: number;
  out_over_cap: boolean;
  out_overage_replies: number;
  out_first_over_cap: boolean;
};

export async function bumpUsage(args: {
  merchantId: string;
  aiReplies?: number;
  serviceMessages?: number;
  templateMessages?: number;
  costMinor?: number;
}): Promise<BumpResult | null> {
  const { data, error } = await admin().rpc("bump_usage", {
    p_merchant_id: args.merchantId,
    p_ai_replies: args.aiReplies ?? 0,
    p_service_messages: args.serviceMessages ?? 0,
    p_template_messages: args.templateMessages ?? 0,
    p_ai_cost_minor: args.costMinor ?? 0,
  });
  if (error) {
    // Accounting must never break the reply. A lost counter is a reporting
    // problem; an unanswered customer is a business problem.
    console.error("[db] bumpUsage failed", error.message);
    return null;
  }
  const rows = (Array.isArray(data) ? data : [data]) as BumpResult[];
  return rows[0] ?? null;
}

export async function merchantUsage(merchantId: string): Promise<UsageSnapshot | null> {
  const { data, error } = await admin().rpc("merchant_usage", {
    p_merchant_id: merchantId,
  });
  if (error) throw error;
  return (data as UsageSnapshot) ?? null;
}
