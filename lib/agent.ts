/**
 * The agent: an OpenAI-compatible chat model plus tools, wired to the
 * merchant's real catalogue.
 *
 * PROVIDER. Moonshot (Kimi) and Alibaba (Qwen) both speak the OpenAI
 * chat-completions dialect, so this file talks to neither of them by name. The
 * base URL and the two model ids come from lib/pricing.ts, which reads them
 * from the environment. Swapping provider is a config change, not a code one.
 *
 * Two cost decisions are baked in, and they are what make ₦35k/month
 * profitable rather than break-even:
 *
 *  1. MODEL ROUTING. Simple lookups ("how much", "you get size 43") go to the
 *     cheap model. Only order-building and messy negotiation reach the capable
 *     one. Routing is sticky per conversation — see pickModel.
 *  2. CONTEXT CACHING. The tool definitions and system prompt are identical on
 *     every turn of a conversation. Both providers cache a repeated prefix
 *     automatically and bill a hit at roughly a sixth of the miss rate. There
 *     is no breakpoint to mark and no minimum prefix to clear — which is why
 *     the Anthropic version of this file had forty lines of caching logic and
 *     this one has none. `TOOLS` stays a module constant so the prefix is
 *     byte-identical between turns; rebuilding it per request in a different
 *     key order would defeat the match.
 */

import OpenAI from "openai";
import { admin, Merchant } from "./supabase";
import { fmtMoney, orderRef } from "./money";
import { SMART, FAST, BASE_URL, pickModel, estimateCostMinor, isNegotiation } from "./pricing";
import { required, optional } from "./env";

/**
 * Recorded in messages.model when a reply came from a fixed rule rather than
 * a model. The transcript shows it, so the owner can tell the difference, and
 * conversation_model() stickiness ignores it because it isn't SMART.
 */
export const RULE_MODEL = "rule";

let client: OpenAI | null = null;
function ai(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: required("AI_API_KEY"),
      baseURL: BASE_URL,
      // A WhatsApp reply that takes 30s has already lost the customer, and the
      // webhook has its own deadline. Fail fast and hand off instead.
      timeout: 25_000,
      maxRetries: 1,
    });
  }
  return client;
}

/**
 * Provider-specific request fields, as raw JSON.
 *
 * Thinking/reasoning toggles are not standardised across OpenAI-compatible
 * servers: DashScope takes `enable_thinking`, Moonshot gates it per model, and
 * an unknown field is a 400 on some gateways and silently ignored on others.
 * Rather than guess per provider, anything extra goes here verbatim.
 *
 *   AI_EXTRA_BODY={"enable_thinking":false}
 */
function extraBody(): Record<string, unknown> {
  const raw = optional("AI_EXTRA_BODY", "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    console.error("[agent] AI_EXTRA_BODY is not valid JSON; ignoring it");
    return {};
  }
}

export { fmtMoney };

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */
/**
 * `strict: true` asks the provider to validate arguments against the schema
 * before they reach runTool. OpenAI honours it; Kimi and Qwen accept the field
 * but their enforcement is not guaranteed, so runTool's callers parse
 * defensively rather than trusting it. That is the one real regression in
 * moving off Anthropic, and it is why every argument is re-checked in SQL.
 *
 * strict requires additionalProperties:false and an explicit required list on
 * every object, including nested ones.
 */
export const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_catalogue",
      description:
        "Look up products. ALWAYS call this before stating any price or availability. " +
        "Never answer a price from memory or from earlier in the conversation.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Product name, category, or size the customer mentioned",
          },
          in_stock_only: {
            type: "boolean",
            description: "Only return items currently in stock",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "place_order",
      description:
        "Create the order once the customer has confirmed the items. Totals are computed " +
        "server-side — do not calculate or quote a total yourself before calling this.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                product_id: {
                  type: "string",
                  description: "The product_id returned by search_catalogue, verbatim",
                },
                quantity: { type: "integer", minimum: 1 },
              },
              required: ["product_id", "quantity"],
              additionalProperties: false,
            },
          },
          delivery_address: { type: "string" },
          notes: { type: "string" },
        },
        required: ["items", "delivery_address", "notes"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "register_stock_alert",
      description:
        "Save a restock request when the customer wants an out-of-stock item. " +
        "Only call this if they actually say yes to being notified.",
      parameters: {
        type: "object",
        properties: { product_id: { type: "string" } },
        required: ["product_id"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Hand off to the business owner. Call this for complaints, refunds, anything about " +
        "an existing order you cannot see, price negotiation beyond the listed price, or " +
        "whenever the customer asks for a person.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
];

/* ------------------------------------------------------------------ */
/* System prompt                                                       */
/* ------------------------------------------------------------------ */
export function systemPrompt(m: Merchant, catalogue: string) {
  return `You are the sales assistant for ${m.name}, replying to customers on WhatsApp.

TONE: ${m.ai_tone}
Keep replies short — one to three lines. This is WhatsApp, not email. No bullet lists,
no markdown, no headings. Emoji sparingly, at most one per message.
If the customer writes in Pidgin, reply in Pidgin.

HARD RULES
- Never state a price or say something is in stock without calling search_catalogue first.
- Never invent products, sizes, delivery times, or discounts.
- Never agree to a price other than the listed one. If they haggle, call escalate_to_human.
- Never promise a delivery date. Say the owner will confirm.
- If you don't know, say so plainly and offer to get the owner.
- Ask for one thing at a time. Don't send a form.

ORDER FLOW
1. Find what they want (search_catalogue)
2. Confirm item and quantity back to them
3. Ask for delivery address
4. Call place_order, then read back the total it returns, and the order reference
Never quote a total you calculated yourself.

BUSINESS HOURS: ${JSON.stringify(m.business_hours)}
CURRENCY: ${m.currency}

CATALOGUE SNAPSHOT (for orientation only — still call search_catalogue for live prices and stock):
${catalogue}`;
}

/**
 * Compact catalogue for the cached prefix.
 *
 * The limit went from 60 to 200 deliberately. The snapshot is the only part of
 * the prefix that scales with the merchant, and the prefix has to clear the
 * model's cache minimum to cache at all (4096 tokens on Haiku) — a 60-item cap
 * guaranteed it never would for anyone. Products are still one short line each.
 */
async function catalogueSnapshot(merchantId: string, currency: string) {
  const { data } = await admin()
    .from("products")
    .select("name,variant_label,category,price_minor,stock,track_stock")
    .eq("merchant_id", merchantId)
    .eq("is_active", true)
    .order("category")
    .order("name")
    .limit(200);

  if (!data?.length) return "(no products loaded yet)";

  return data
    .map((p) => {
      const label = [p.name, p.variant_label].filter(Boolean).join(" ");
      const stock = p.track_stock ? (p.stock > 0 ? `${p.stock} left` : "OUT OF STOCK") : "";
      return `- ${label} — ${fmtMoney(p.price_minor, currency)}${stock ? ` (${stock})` : ""}`;
    })
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Tool execution                                                      */
/* ------------------------------------------------------------------ */
export type Ctx = {
  merchant: Merchant;
  customerId: string;
  conversationId: string;
};

type ToolOutcome = {
  output: unknown;
  escalated?: boolean;
  orderId?: string;
};

async function runTool(name: string, input: any, ctx: Ctx): Promise<ToolOutcome> {
  const db = admin();

  if (name === "search_catalogue") {
    const { data, error } = await db.rpc("search_catalogue", {
      p_merchant_id: ctx.merchant.id,
      p_query: input.query ?? null,
      p_in_stock: !!input.in_stock_only,
    });
    if (error) return { output: { error: error.message } };
    return {
      output: {
        products: (data ?? []).map((p: any) => ({
          product_id: p.id,
          name: [p.name, p.variant_label].filter(Boolean).join(" "),
          category: p.category,
          price: fmtMoney(p.price_minor, ctx.merchant.currency),
          availability: !p.track_stock
            ? "available"
            : p.stock > 0
              ? `${p.stock} in stock`
              : "out of stock",
        })),
      },
    };
  }

  if (name === "place_order") {
    const { data, error } = await db.rpc("place_order", {
      p_merchant_id: ctx.merchant.id,
      p_customer_id: ctx.customerId,
      p_conversation_id: ctx.conversationId,
      p_items: input.items,
      p_address: input.delivery_address || null,
      p_notes: input.notes || null,
    });

    if (error) {
      // Surface the specific failure so the model can respond honestly.
      if (error.message.includes("INSUFFICIENT_STOCK")) {
        const [, productName, left] = error.message.split(":");
        return {
          output: {
            error: `Not enough stock for ${productName}. Only ${left} left.`,
          },
        };
      }
      if (error.message.includes("PRODUCT_NOT_FOUND")) {
        return {
          output: {
            error: "That product id is not valid. Call search_catalogue again.",
          },
        };
      }
      if (error.message.includes("ORDER_EMPTY")) {
        return { output: { error: "No items were included. Confirm what they want first." } };
      }
      console.error("[agent] place_order failed", error.message);
      return { output: { error: "Could not place the order. Offer to get the owner." } };
    }

    const row = Array.isArray(data) ? data[0] : data;
    const orderId = row.out_order_id as string;

    return {
      orderId,
      output: {
        order_placed: true,
        // The customer needs something quotable, and the owner console
        // resolves this same reference back to the order.
        order_reference: orderRef(orderId),
        subtotal: fmtMoney(row.out_subtotal_minor, ctx.merchant.currency),
        delivery: fmtMoney(row.out_delivery_minor, ctx.merchant.currency),
        total: fmtMoney(row.out_total_minor, ctx.merchant.currency),
        next_step:
          "Tell them the total and the order reference, and that the owner will confirm payment details.",
      },
    };
  }

  if (name === "register_stock_alert") {
    const { error } = await db.rpc("register_stock_alert", {
      p_merchant_id: ctx.merchant.id,
      p_customer_id: ctx.customerId,
      p_product_id: input.product_id,
    });
    return { output: error ? { error: error.message } : { saved: true } };
  }

  if (name === "escalate_to_human") {
    await handOver(ctx, input.reason ?? "unspecified");
    return {
      escalated: true,
      output: {
        escalated: true,
        tell_customer: "Let them know the owner will take it from here.",
      },
    };
  }

  return { output: { error: `unknown tool ${name}` } };
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */
export type AgentResult = {
  reply: string;
  model: string;
  /**
   * The provider's `prompt_tokens`: the WHOLE prompt, cached tokens included.
   * Anthropic reported this bucket with the cached tokens already removed, so
   * do not compare these figures against rows written by the old client.
   */
  promptTokens: number;
  outputTokens: number;
  /** Subset of promptTokens that the provider served from its context cache. */
  cachedTokens: number;
  costMinor: number;
  escalated: boolean;
  /** Set when this turn created an order, so the caller can notify the owner. */
  orderId: string | null;
};

const MAX_HOPS = 5;

export async function respond(
  ctx: Ctx,
  history: { role: "user" | "assistant"; content: string }[],
  incoming: string,
  stickyModel?: string | null,
): Promise<AgentResult> {
  /* --- haggling: decided in code, before the model sees it -----------
     See isNegotiation in lib/pricing.ts for why this is not left to the
     prompt. The reply is fixed so no wording can imply a discount, and it
     costs nothing because no model is called. */
  if (isNegotiation(incoming)) {
    await handOver(ctx, "price negotiation");
    return {
      reply: "Let me get the owner to talk to you about the price — they'll reply here shortly 🙏",
      model: RULE_MODEL,
      promptTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costMinor: 0,
      escalated: true,
      orderId: null,
    };
  }

  const catalogue = await catalogueSnapshot(ctx.merchant.id, ctx.merchant.currency);
  const model = pickModel(incoming, history.length, stickyModel);

  // System prompt first and unchanged between turns, so the provider's cache
  // can match on it. Everything that varies goes after it.
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(ctx.merchant, catalogue) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: incoming },
  ];

  let promptTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let escalated = false;
  let orderId: string | null = null;

  /** Every reply that tells the customer the owner will help must make it
      true: mute the bot on this thread and flag it for the owner. Saying it
      without doing it left customers waiting on an owner who was never told. */
  const handOverAndFinish = async (reply: string, reason: string): Promise<AgentResult> => {
    if (!escalated) await handOver(ctx, reason);
    return finish(reply, true);
  };

  const finish = (reply: string, didEscalate = escalated): AgentResult => ({
    reply,
    model,
    promptTokens,
    outputTokens,
    cachedTokens,
    costMinor: estimateCostMinor({ model, promptTokens, outputTokens, cachedTokens }),
    escalated: didEscalate,
    orderId,
  });

  // Tool loop. Capped so a confused model can't spend your money in circles.
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const res = await ai().chat.completions.create({
      model,
      max_tokens: 400,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      ...extraBody(),
    });

    // Usage is optional in the OpenAI schema and some gateways omit it on the
    // last chunk. A missing block means an under-reported cost, never a crash.
    promptTokens += res.usage?.prompt_tokens ?? 0;
    outputTokens += res.usage?.completion_tokens ?? 0;
    cachedTokens += res.usage?.prompt_tokens_details?.cached_tokens ?? 0;

    const msg = res.choices[0]?.message;
    if (!msg) {
      console.error("[agent] provider returned no choices");
      return handOverAndFinish("Let me get the owner to help with that.", "the assistant got no answer");
    }

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      const text = msg.content?.trim();
      if (text) return finish(text);
      // An empty answer is the model failing, not the model deciding. Seen in
      // practice on haggling, where it should have called escalate_to_human.
      return handOverAndFinish("Let me get the owner to help with that.", "the assistant had no answer");
    }

    // The assistant turn carrying the tool_calls has to go back verbatim, and
    // every one of its calls needs exactly one matching `tool` message after
    // it. A missing pair is a 400 on the next request, which the customer sees
    // as silence.
    messages.push(msg);

    for (const call of calls) {
      if (call.type !== "function") {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ error: "unsupported tool call type" }),
        });
        continue;
      }

      // Arguments arrive as a JSON STRING here, not a parsed object as they did
      // from Anthropic, and `strict` is advisory on these providers. Malformed
      // JSON is a thing that happens, and it must become a tool result the
      // model can recover from rather than an exception that kills the reply.
      let args: Record<string, unknown> = {};
      let parseFailed = false;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        parseFailed = true;
      }

      let outcome: ToolOutcome;
      if (parseFailed) {
        console.error("[agent] unparseable tool arguments", call.function.name);
        outcome = {
          output: { error: "Those arguments were malformed. Try the call again." },
        };
      } else {
        try {
          outcome = await runTool(call.function.name, args, ctx);
        } catch (e) {
          console.error("[agent] tool threw", call.function.name, e);
          outcome = { output: { error: "That lookup failed. Offer to get the owner." } };
        }
      }

      if (outcome.escalated) escalated = true;
      if (outcome.orderId) orderId = outcome.orderId;

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(outcome.output),
      });
    }
  }

  // Ran out of hops. Hand off rather than loop again.
  return handOverAndFinish("Let me get the owner to help you with this one.", "the assistant went round in circles");
}

/** Mutes the bot on this thread and puts it in the owner's "waiting on you". */
async function handOver(ctx: Ctx, reason: string): Promise<void> {
  const { error } = await admin().rpc("escalate_conversation", {
    p_conversation_id: ctx.conversationId,
    p_reason: reason,
  });
  if (error) console.error("[agent] hand-over failed", error.message);
}

export { SMART, FAST, pickModel };
