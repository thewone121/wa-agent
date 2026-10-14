/**
 * WhatsApp Cloud API webhook.
 *
 * GET  — Meta's verification handshake (once, when you configure the webhook)
 * POST — inbound messages
 *
 * Meta retries anything that isn't a fast 200, so this ACKs immediately and
 * does the work after. A slow reply here means duplicate messages to your
 * customers and duplicate spend on your side.
 */

import { NextRequest, NextResponse, after } from "next/server";
import {
  verifySignature,
  verifyHandshake,
  parseInbound,
  parseFailedStatuses,
  sendText,
  markRead,
  WhatsAppError,
  InboundMessage,
} from "@/lib/whatsapp";
import {
  admin,
  merchantByPhoneNumberId,
  claimInbound,
  logMessage,
  markSendFailed,
  conversationStatus,
  orderSummary,
  markOrderNotified,
  Merchant,
} from "@/lib/supabase";
import { customerTurn } from "@/lib/turn";
import {
  isOwner,
  handleOwnerCommand,
  formatOrderNotification,
  formatHandoverNotification,
} from "@/lib/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* ------------------------------------------------------------------ */
/* GET — verification handshake                                        */
/* ------------------------------------------------------------------ */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  if (verifyHandshake(params.get("hub.mode"), params.get("hub.verify_token"))) {
    return new NextResponse(params.get("hub.challenge"), { status: 200 });
  }
  return new NextResponse("forbidden", { status: 403 });
}

/* ------------------------------------------------------------------ */
/* POST — inbound messages                                             */
/* ------------------------------------------------------------------ */
export async function POST(req: NextRequest) {
  const raw = await req.text();

  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"))) {
    return new NextResponse("bad signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }

  const messages = parseInbound(payload);
  const failures = parseFailedStatuses(payload);

  // ACK now, work after. Meta will not wait for the model.
  after(async () => {
    for (const f of failures) {
      await markSendFailed(f.waMessageId, f.reason);
    }
    for (const m of messages) {
      try {
        await handle(m);
      } catch (e) {
        console.error("[whatsapp] handler failed", m.waMessageId, e);
      }
    }
  });

  return NextResponse.json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Per-message handler                                                 */
/* ------------------------------------------------------------------ */
async function handle(msg: InboundMessage) {
  const merchant = await merchantByPhoneNumberId(msg.phoneNumberId);
  if (!merchant) {
    console.warn("[whatsapp] no merchant for phone_number_id", msg.phoneNumberId);
    return;
  }

  const db = admin();

  const { data: ctxRows, error: ctxErr } = await db.rpc("upsert_customer_conversation", {
    p_merchant_id: merchant.id,
    p_wa_phone: msg.from,
    p_name: msg.profileName,
  });
  if (ctxErr || !ctxRows?.length) throw ctxErr ?? new Error("no conversation");

  const customerId: string = ctxRows[0].out_customer_id;
  const conversationId: string = ctxRows[0].out_conversation_id;

  /* --- idempotency ---------------------------------------------------
     Writing the inbound row IS the claim. Meta retries aggressively and
     those retries overlap, so "check then insert" left a window where two
     invocations both decided the message was new. Whoever loses the unique
     index on wa_message_id stops here. */
  const claimed = await claimInbound({
    merchant_id: merchant.id,
    conversation_id: conversationId,
    wa_message_id: msg.waMessageId,
    body: msg.text,
    media_type: msg.type === "text" ? null : msg.type,
    media_id: msg.mediaId,
  });
  if (!claimed) return;

  await markRead(msg.phoneNumberId, msg.waMessageId);

  /* --- owner console -------------------------------------------------
     Messages from the merchant's own escalation number are commands, not
     customer enquiries. Checked before everything below so the owner can
     still drive the console while a thread is escalated or throttled. */
  if (isOwner(merchant, msg.from)) {
    if (!msg.text?.trim()) {
      await deliver(merchant, msg.from, conversationId, "Send *help* for the command list.");
      return;
    }
    const { reply } = await handleOwnerCommand(merchant, msg.text);
    await deliver(merchant, msg.from, conversationId, reply);
    return;
  }

  // Already handed to a human — stay quiet. Nothing worse than the bot
  // talking over the owner mid-complaint. `resume <phone>` reopens it.
  if ((await conversationStatus(conversationId)) === "escalated") return;

  /* --- voice notes -------------------------------------------------
     A large share of customers here send voice, not text. Until
     transcription is wired in, say so honestly rather than going silent. */
  if (msg.type === "audio") {
    await deliver(
      merchant,
      msg.from,
      conversationId,
      "Sorry, I can't listen to voice notes yet — please type it and I'll help you right away 🙏",
    );
    return;
  }

  if (!msg.text?.trim()) {
    await deliver(
      merchant,
      msg.from,
      conversationId,
      "Got your message! Could you type what you're looking for?",
    );
    return;
  }

  /* --- the turn itself ----------------------------------------------
     Throttle, history, the model, cost accounting — shared with the
     dashboard's try-it screen through lib/turn.ts, so that screen is the
     real thing rather than a copy. */
  const outcome = await customerTurn({
    merchant,
    customerId,
    conversationId,
    text: msg.text,
    excludeWaMessageId: msg.waMessageId,
    countsAsServiceMessage: true,
    send: (body, usage) => deliver(merchant, msg.from, conversationId, body, usage),
  });
  if (outcome.kind !== "replied") return;
  const { result, usage } = outcome;

  /* --- owner notifications ------------------------------------------
     Best-effort, and deliberately after the customer has been answered.
     Every one of these is wrapped: the owner's number may be outside its
     own 24h window, in which case Meta refuses the send. That must never
     turn into an unanswered customer. */
  if (result.orderId) {
    await notifyOwnerOfOrder(merchant, result.orderId);
  }

  if (result.escalated) {
    await notifyOwner(
      merchant,
      formatHandoverNotification(msg.from, msg.profileName, msg.text),
    );
  }

  // Once per month, not once per reply past 1,500.
  if (usage?.out_first_over_cap) {
    await notifyOwner(
      merchant,
      `📊 You've passed ${usage.out_reply_cap} AI replies this month. ` +
        `Replies keep going out — anything past the cap bills as overage. Send *usage* for the running total.`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Owner notifications                                                 */
/* ------------------------------------------------------------------ */
/** Returns whether the message actually reached the owner. */
async function notifyOwner(merchant: Merchant, body: string): Promise<boolean> {
  if (!merchant.escalation_number || !merchant.owner_notify) return false;

  try {
    await sendText(merchant.wa_phone_number_id, merchant.escalation_number, body);
    return true;
  } catch (e) {
    // The owner's own thread with the business number has a 24h window too.
    // If they haven't messaged it today, Meta refuses — the dashboard and the
    // `orders` command are the fallback, so this is a warning, not a failure.
    if (e instanceof WhatsAppError && e.needsTemplate) {
      console.warn("[whatsapp] owner outside 24h window; notification not delivered");
      return false;
    }
    console.error("[whatsapp] owner notification failed", e);
    return false;
  }
}

async function notifyOwnerOfOrder(merchant: Merchant, orderId: string): Promise<void> {
  const order = await orderSummary(orderId);
  if (!order) return;

  // Marked only on a confirmed send. Marking optimistically would hide the
  // order from unnotified_orders(), so the scheduled retry — the entire reason
  // that sweep exists — would never see the ones that failed.
  if (await notifyOwner(merchant, formatOrderNotification(order))) {
    await markOrderNotified(orderId);
  }
}

/* ------------------------------------------------------------------ */
/* Send + log                                                          */
/* ------------------------------------------------------------------ */
async function deliver(
  merchant: Pick<Merchant, "id" | "wa_phone_number_id">,
  to: string,
  conversationId: string,
  body: string,
  usage: Record<string, unknown> = {},
) {
  try {
    const id = await sendText(merchant.wa_phone_number_id, to, body);
    await logMessage({
      merchant_id: merchant.id,
      conversation_id: conversationId,
      direction: "outbound",
      wa_message_id: id ?? null,
      body,
      billable_service: true,
      ...usage,
    });
  } catch (e) {
    const reason =
      e instanceof WhatsAppError
        ? `${e.code ?? e.status ?? "?"}: ${e.message}`
        : String(e);

    // Record the failed send in the transcript. Previously this vanished into
    // a console.warn, so the dashboard showed a conversation that simply
    // stopped, with nothing explaining why.
    await logMessage({
      merchant_id: merchant.id,
      conversation_id: conversationId,
      direction: "outbound",
      body,
      send_error: reason,
      ...usage,
    });

    if (e instanceof WhatsAppError && e.needsTemplate) {
      // Outside the 24h service window. A free-form reply will never deliver
      // here — it has to go out as an approved template instead.
      console.warn("[whatsapp] outside service window, template required:", to);
      return;
    }
    throw e;
  }
}
