/**
 * WhatsApp Cloud API client.
 *
 * Two rules that drive everything here:
 *  1. Inside the 24h service window you may send free-form text.
 *     Outside it, ONLY an approved template will deliver.
 *  2. From 1 Oct 2026 service messages are billed per message
 *     (first 1,000 per number per month free). So every send is
 *     counted — see bump_usage in backend.sql.
 */

import crypto from "crypto";
import { required, optional } from "./env";

const GRAPH = `https://graph.facebook.com/${optional("WHATSAPP_GRAPH_VERSION", "v21.0")}`;

export type InboundMessage = {
  waMessageId: string;
  from: string; // customer's wa phone
  phoneNumberId: string; // which merchant number received it
  type: "text" | "image" | "audio" | "document" | "interactive" | "unsupported";
  text: string | null;
  mediaId: string | null;
  profileName: string | null;
  timestamp: Date;
};

/* ------------------------------------------------------------------
 * Signature verification — reject anything not signed by Meta.
 * Must run against the RAW body, not the parsed JSON.
 * ---------------------------------------------------------------- */
export function verifySignature(rawBody: string, header: string | null): boolean {
  if (!header) return false;

  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    // Refusing is the only safe behaviour: with no secret every possible
    // signature is "unverifiable", and treating that as valid would let
    // anyone POST fabricated customer messages into the agent.
    console.error("[whatsapp] WHATSAPP_APP_SECRET is not set — rejecting webhook");
    return false;
  }

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Meta's GET handshake, run once when you configure the webhook. */
export function verifyHandshake(mode: string | null, token: string | null): boolean {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!expected || !token || mode !== "subscribe") return false;

  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------
 * Delivery failures, from status callbacks.
 *
 * A 200 from the send API only means Meta ACCEPTED the message. Whether it
 * reached the phone arrives later, as a status callback on this same webhook.
 * Without reading these, a reply Meta refused to deliver looks identical to
 * one that landed — which is exactly how a locked business account (131031)
 * went unnoticed: the dashboard showed replies the customer never received.
 *
 * Only failures come back. sent/delivered/read would need a column to keep
 * them in; a failure fits the existing messages.send_error.
 * ---------------------------------------------------------------- */
export type FailedStatus = { waMessageId: string; reason: string };

// The codes an owner will actually meet, in words they can act on. Anything
// else falls through to Meta's own text with the code, which is searchable.
const FAILURE_REASONS: Record<string, string> = {
  "131031": "Meta has locked this business account",
  "131047": "Over 24h since the customer last wrote — only an approved template can be sent now",
  "131026": "This number can't receive the message",
};

export function parseFailedStatuses(payload: any): FailedStatus[] {
  const out: FailedStatus[] = [];

  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const s of change?.value?.statuses ?? []) {
        if (s?.status !== "failed" || !s?.id) continue;

        const e = s.errors?.[0];
        const code = e?.code != null ? String(e.code) : null;
        const text =
          (code && FAILURE_REASONS[code]) ??
          e?.error_data?.details ??
          e?.title ??
          e?.message ??
          "Delivery failed";

        out.push({ waMessageId: String(s.id), reason: code ? `${text} (${code})` : text });
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------
 * Parse the webhook payload.
 * Meta nests messages 4 levels deep and batches them, so this
 * returns an array. Status callbacks are handled by
 * parseFailedStatuses above, not here.
 * ---------------------------------------------------------------- */
export function parseInbound(payload: any): InboundMessage[] {
  const out: InboundMessage[] = [];

  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value?.messages) continue;

      const phoneNumberId = value?.metadata?.phone_number_id;
      const profileName = value?.contacts?.[0]?.profile?.name ?? null;

      for (const m of value.messages) {
        let type: InboundMessage["type"] = "unsupported";
        let text: string | null = null;
        let mediaId: string | null = null;

        if (m.type === "text") {
          type = "text";
          text = m.text?.body ?? null;
        } else if (m.type === "interactive") {
          type = "interactive";
          text =
            m.interactive?.button_reply?.title ??
            m.interactive?.list_reply?.title ??
            null;
        } else if (m.type === "button") {
          // Quick-reply buttons attached to a template reply arrive as their
          // own type, not as `interactive`. Without this they were parsed as
          // "unsupported" and the customer got the "please type it" fallback
          // right after tapping the button we sent them.
          type = "interactive";
          text = m.button?.text ?? m.button?.payload ?? null;
        } else if (m.type === "image") {
          type = "image";
          mediaId = m.image?.id ?? null;
          text = m.image?.caption ?? null;
        } else if (m.type === "audio" || m.type === "voice") {
          // Voice notes land here. Not transcribed — see the webhook handler.
          type = "audio";
          mediaId = m.audio?.id ?? m.voice?.id ?? null;
        } else if (m.type === "document") {
          type = "document";
          mediaId = m.document?.id ?? null;
          text = m.document?.caption ?? null;
        }

        // Meta sends seconds; Number() on a missing value yields NaN, which
        // becomes an Invalid Date and then a null timestamptz on insert.
        const ts = Number(m.timestamp);

        out.push({
          waMessageId: m.id,
          from: m.from,
          phoneNumberId,
          type,
          text,
          mediaId,
          profileName,
          timestamp: Number.isFinite(ts) ? new Date(ts * 1000) : new Date(),
        });
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------
 * Sends
 * ---------------------------------------------------------------- */
async function post(phoneNumberId: string, body: unknown) {
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${required("WHATSAPP_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}) as any);

  if (!res.ok) {
    throw new WhatsAppError(
      json?.error?.message ?? "send failed",
      json?.error?.code,
      res.status,
    );
  }

  return json?.messages?.[0]?.id as string | undefined;
}

export class WhatsAppError extends Error {
  constructor(
    message: string,
    public code?: number,
    public status?: number,
  ) {
    super(message);
    this.name = "WhatsAppError";
  }

  /** True when the failure means "you're outside the service window". */
  get needsTemplate() {
    // 131047 re-engagement required, 131051 unsupported message type for
    // this window, 470 the legacy code Meta still returns on some numbers.
    return this.code === 131047 || this.code === 131051 || this.code === 470;
  }

  /** Template rejected — wrong name, unapproved, or wrong variable count. */
  get templateProblem() {
    return this.code === 132000 || this.code === 132001 || this.code === 132012;
  }

  /** Worth retrying later: rate limits and Meta-side faults. */
  get retryable() {
    if (this.code === 131048 || this.code === 131049 || this.code === 80007) return true;
    return typeof this.status === "number" && this.status >= 500;
  }
}

/**
 * Free-form reply. Only valid inside the 24h window.
 *
 * WhatsApp's body limit is 4096 characters. Slicing mid-word produced replies
 * that ended on half a price, so this cuts at the last space instead — though
 * with max_tokens at 400 the agent should never come close.
 */
export function sendText(phoneNumberId: string, to: string, body: string) {
  return post(phoneNumberId, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body: truncate(body, 4096) },
  });
}

export function truncate(body: string, max: number): string {
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/** Template message. The only thing that delivers outside the window. */
export function sendTemplate(
  phoneNumberId: string,
  to: string,
  templateName: string,
  languageCode: string,
  variables: string[] = [],
) {
  return post(phoneNumberId, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components: variables.length
        ? [
            {
              type: "body",
              // Meta rejects an empty string for a positional variable, and
              // the whole send fails — one missing customer name would drop
              // the entire restock batch.
              parameters: variables.map((v) => ({
                type: "text",
                text: v && v.trim() ? v.slice(0, 1024) : "-",
              })),
            },
          ]
        : [],
    },
  });
}

/** Mark inbound as read — cheap, free, and makes the bot feel alive. */
export async function markRead(phoneNumberId: string, waMessageId: string) {
  try {
    await post(phoneNumberId, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: waMessageId,
    });
  } catch {
    // never let a read receipt break the reply path
  }
}

/** Resolve a media id to a temporary download URL (for future transcription). */
export async function getMediaUrl(mediaId: string): Promise<string | null> {
  const res = await fetch(`${GRAPH}/${mediaId}`, {
    headers: { Authorization: `Bearer ${required("WHATSAPP_TOKEN")}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.url ?? null;
}
