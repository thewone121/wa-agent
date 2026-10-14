/**
 * One customer turn: from "a customer said something" to "the assistant's
 * reply is recorded", independent of how that reply travels.
 *
 * The WhatsApp webhook runs it with a sender that posts to Meta. The
 * dashboard's "Try it as a customer" screen runs it with a sender that only
 * records the reply. Sharing it is the whole point: the try-it screen is only
 * worth showing anyone if it is exactly what a real customer gets — same
 * throttle, same history, same model routing, same tools, same cost
 * accounting — rather than a lookalike that quietly drifts.
 *
 * What it deliberately does NOT do is the transport-specific work around the
 * turn: read receipts, the owner console, voice notes, and notifying the owner
 * over WhatsApp. Callers own those. The escalation check also stays with the
 * caller, because the webhook has to run it before its voice-note handling.
 */

import { respond, type AgentResult } from "./agent";
import {
  bumpUsage,
  conversationModel,
  recentInboundCount,
  recentTurns,
  type BumpResult,
  type Merchant,
} from "./supabase";
import { THROTTLE_MAX_REPLIES, THROTTLE_WINDOW_SECONDS } from "./env";

/** Records (and, for WhatsApp, sends) one outbound message. */
export type Send = (body: string, usage?: Record<string, unknown>) => Promise<void>;

export type TurnOutcome =
  | { kind: "throttled" }
  | { kind: "replied"; result: AgentResult; usage: BumpResult | null };

export async function customerTurn(args: {
  merchant: Merchant;
  customerId: string;
  conversationId: string;
  text: string;
  /** The inbound row just written, so it isn't sent to the model twice. */
  excludeWaMessageId: string;
  send: Send;
  /**
   * Whether this reply is also a Meta service message. True on WhatsApp;
   * false on the try-it screen, where nothing is sent to Meta and counting it
   * would overstate the month's Meta usage.
   */
  countsAsServiceMessage: boolean;
}): Promise<TurnOutcome> {
  const { merchant, customerId, conversationId, text, send } = args;

  /* --- abuse throttle ------------------------------------------------
     Every reply past this point costs model tokens and, on WhatsApp, a Meta
     service message. Nothing else bounds that: one script pointed at the
     number could drain the balance in minutes. The customer gets told once,
     and the check is in Postgres because serverless instances share no
     memory. */
  const recent = await recentInboundCount(conversationId, THROTTLE_WINDOW_SECONDS);
  if (recent > THROTTLE_MAX_REPLIES) {
    if (recent === THROTTLE_MAX_REPLIES + 1) {
      await send("You're sending faster than I can keep up 😅 Give me a moment and send it again.");
    }
    return { kind: "throttled" };
  }

  const [history, sticky] = await Promise.all([
    recentTurns(conversationId, { excludeWaMessageId: args.excludeWaMessageId }),
    conversationModel(conversationId),
  ]);

  const result = await respond({ merchant, customerId, conversationId }, history, text, sticky);

  await send(result.reply, {
    model: result.model,
    // prompt_tokens from the provider INCLUDES the cached ones; the column
    // kept its old name so the dashboard query did not have to change.
    input_tokens: result.promptTokens,
    output_tokens: result.outputTokens,
    cached_tokens: result.cachedTokens,
    // Kimi and Qwen do not bill a separate cache WRITE, so there is nothing to
    // record here. The column stays for rows written by the Anthropic client.
    cache_write_tokens: null,
    cost_minor: result.costMinor,
  });

  // Cost tracking — feeds the 1,500-reply cap and the margin view.
  const usage = await bumpUsage({
    merchantId: merchant.id,
    aiReplies: 1,
    serviceMessages: args.countsAsServiceMessage ? 1 : 0,
    costMinor: result.costMinor,
  });

  return { kind: "replied", result, usage };
}
