/**
 * The owner console, over WhatsApp.
 *
 * The owner already has WhatsApp open all day — that is the whole premise of
 * the product — so the fastest surface for "mark that order paid" is the same
 * thread the handover notification arrived in. The dashboard is for reading;
 * this is for acting.
 *
 * Recognised by phone number: any inbound message from the merchant's
 * escalation_number is a command, not a customer enquiry. Two consequences
 * worth being explicit about:
 *
 *   - The owner's own number can never be a customer of their own bot. That
 *     is the right trade — an owner testing their bot from their admin number
 *     is confusing either way, and they should use a second number.
 *   - Commands are NOT parsed by the model. A typo must fail loudly rather
 *     than be helpfully interpreted into cancelling the wrong order, and it
 *     keeps owner traffic off the Anthropic bill entirely.
 */

import {
  Merchant,
  findOrderByRef,
  orderSummary,
  setOrderStatus,
  recentOrders,
  conversationByPhone,
  resumeConversation,
  closeConversation,
  merchantUsage,
  admin,
  OrderSummary,
} from "./supabase";
import { fmtMoney, orderRef, parseMoneyToMinor } from "./money";

/* ------------------------------------------------------------------ */
/* Phone matching                                                      */
/* ------------------------------------------------------------------ */

/**
 * Compare two phone numbers that may be written differently.
 *
 * Meta delivers `from` as digits with country code and no plus (2348012345678).
 * Owners type their escalation number as +234..., 234..., or 0801... . Comparing
 * raw strings meant the console silently never triggered — which looks exactly
 * like "the feature doesn't work" with nothing in the logs.
 *
 * Matching on a common suffix of at least 9 digits handles all three forms
 * without a phone-number library. 9 digits is long enough that a collision
 * needs two numbers that differ only in country code.
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  if (!da || !db) return false;
  if (da === db) return true;

  const n = Math.min(da.length, db.length, 10);
  if (n < 9) return false;
  return da.slice(-n) === db.slice(-n);
}

export function isOwner(merchant: Merchant, from: string): boolean {
  return samePhone(merchant.escalation_number, from);
}

/* ------------------------------------------------------------------ */
/* Help                                                                */
/* ------------------------------------------------------------------ */
const HELP = `Owner commands:

orders — last 10 orders
orders pending — filter by status
order ABC123 — full detail
paid ABC123 — mark paid/confirmed
done ABC123 — mark fulfilled
cancel ABC123 [reason] — cancel and restore stock

stock — items that are out of stock
stock <name> — check one item
stock <name> = 12 — set the count
price <name> = 25000 — set the price

chats — open conversations
resume <phone> — let the bot reply again
close <phone> — end a thread

usage — this month's replies and cost
mute / unmute — order notifications
help — this message`;

/* ------------------------------------------------------------------ */
/* Command router                                                      */
/* ------------------------------------------------------------------ */

export type OwnerReply = { reply: string };

/**
 * Split "stock jollof rice = 12" into ["stock jollof rice", "12"].
 * The value is after the LAST `=` so product names containing one survive.
 */
function splitAssignment(text: string): { left: string; right: string | null } {
  const i = text.lastIndexOf("=");
  if (i === -1) return { left: text.trim(), right: null };
  return { left: text.slice(0, i).trim(), right: text.slice(i + 1).trim() };
}

export async function handleOwnerCommand(
  merchant: Merchant,
  raw: string,
): Promise<OwnerReply> {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const [verb, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();
  const v = verb.toLowerCase();

  try {
    if (v === "help" || v === "?" || v === "commands") {
      return { reply: HELP };
    }

    if (v === "orders") {
      return { reply: await listOrders(merchant, arg) };
    }

    if (v === "order") {
      return { reply: await showOrder(merchant, arg) };
    }

    if (v === "paid" || v === "confirm") {
      return { reply: await transition(merchant, arg, "confirmed", "marked paid") };
    }

    if (v === "done" || v === "fulfilled" || v === "delivered") {
      return { reply: await transition(merchant, arg, "fulfilled", "marked fulfilled") };
    }

    if (v === "cancel") {
      const [ref, ...reason] = arg.split(/\s+/);
      return {
        reply: await transition(
          merchant,
          ref,
          "cancelled",
          "cancelled, stock restored",
          reason.join(" ") || undefined,
        ),
      };
    }

    if (v === "stock") {
      return { reply: await stockCommand(merchant, arg) };
    }

    if (v === "price") {
      return { reply: await priceCommand(merchant, arg) };
    }

    if (v === "chats" || v === "conversations") {
      return { reply: await listChats(merchant) };
    }

    if (v === "resume") {
      return { reply: await resumeChat(merchant, arg) };
    }

    if (v === "close") {
      return { reply: await closeChat(merchant, arg) };
    }

    if (v === "usage" || v === "stats") {
      return { reply: await usageReport(merchant) };
    }

    if (v === "mute" || v === "unmute") {
      const on = v === "unmute";
      await admin().from("merchants").update({ owner_notify: on }).eq("id", merchant.id);
      return {
        reply: on
          ? "Order notifications on. You'll get a message for every new order."
          : "Order notifications off. Check `orders` or the dashboard instead.",
      };
    }

    // Unknown. Do not guess — guessing here cancels orders.
    return {
      reply: `Didn't recognise "${lower.split(/\s+/)[0]}". Send *help* for the list.`,
    };
  } catch (e) {
    console.error("[owner] command failed", text, e);
    return { reply: `That failed: ${errText(e)}` };
  }
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("ORDER_NOT_FOUND")) return "no order with that reference.";
  if (msg.includes("ORDER_REF_AMBIGUOUS")) {
    return "that reference matches more than one order — use the dashboard.";
  }
  if (msg.includes("ORDER_TERMINAL")) {
    const status = msg.split(":")[1] ?? "closed";
    return `that order is already ${status.trim()} and can't be changed.`;
  }
  if (msg.includes("PRODUCT_NOT_FOUND")) return "no product by that name.";
  if (msg.includes("STOCK_NEGATIVE")) return "stock can't be negative.";
  return msg.slice(0, 140);
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

const STATUS_WORDS: Record<string, OrderSummary["status"]> = {
  pending: "pending_payment",
  unpaid: "pending_payment",
  paid: "confirmed",
  confirmed: "confirmed",
  done: "fulfilled",
  fulfilled: "fulfilled",
  cancelled: "cancelled",
  canceled: "cancelled",
};

async function listOrders(merchant: Merchant, arg: string): Promise<string> {
  const status = STATUS_WORDS[arg.toLowerCase().trim()];
  if (arg.trim() && !status) {
    return `Unknown status "${arg}". Try: pending, paid, done, cancelled.`;
  }

  const rows = await recentOrders(merchant.id, status, 10);
  if (!rows.length) {
    return status ? `No ${arg} orders.` : "No orders yet.";
  }

  const lines = rows.map((o) => {
    const who = o.customer_name || o.customer_phone;
    return `${orderRef(o.id)} · ${fmtMoney(o.total_minor, o.currency)} · ${who} · ${shortStatus(o.status)}`;
  });

  return [status ? `${arg} orders:` : "Recent orders:", ...lines, "", "order <ref> for detail"].join(
    "\n",
  );
}

function shortStatus(s: OrderSummary["status"]): string {
  return s === "pending_payment" ? "awaiting payment" : s;
}

async function showOrder(merchant: Merchant, ref: string): Promise<string> {
  if (!ref) return "Which order? e.g. order ABC123";

  const id = await findOrderByRef(merchant.id, ref);
  if (!id) return `No order ${ref.toUpperCase()}.`;

  const o = await orderSummary(id);
  if (!o) return `No order ${ref.toUpperCase()}.`;

  const items = o.items
    .map(
      (i) =>
        `  ${i.quantity} × ${i.product_name} — ${fmtMoney(i.line_total_minor, o.currency)}`,
    )
    .join("\n");

  return [
    `Order ${orderRef(o.id)} — ${shortStatus(o.status)}`,
    `${o.customer_name || "Customer"} (${o.customer_phone})`,
    "",
    items,
    "",
    `Subtotal ${fmtMoney(o.subtotal_minor, o.currency)}`,
    o.delivery_minor > 0 ? `Delivery ${fmtMoney(o.delivery_minor, o.currency)}` : null,
    `Total ${fmtMoney(o.total_minor, o.currency)}`,
    o.delivery_address ? `\nDeliver to: ${o.delivery_address}` : null,
    o.notes ? `Notes: ${o.notes}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function transition(
  merchant: Merchant,
  ref: string,
  status: OrderSummary["status"],
  verb: string,
  note?: string,
): Promise<string> {
  if (!ref) return `Which order? e.g. ${status === "cancelled" ? "cancel" : "paid"} ABC123`;

  const id = await findOrderByRef(merchant.id, ref);
  if (!id) return `No order ${ref.toUpperCase()}.`;

  const o = await setOrderStatus(merchant.id, id, status, "owner", note);
  return `Order ${orderRef(o.id)} ${verb}. ${fmtMoney(o.total_minor, o.currency)} · ${o.customer_name || o.customer_phone}`;
}

/* ------------------------------------------------------------------ */
/* Stock and price                                                     */
/* ------------------------------------------------------------------ */

async function findProduct(merchantId: string, query: string) {
  const { data, error } = await admin().rpc("search_catalogue", {
    p_merchant_id: merchantId,
    p_query: query,
    p_limit: 5,
  });
  if (error) throw error;
  return (data ?? []) as {
    id: string;
    name: string;
    variant_label: string | null;
    price_minor: number;
    stock: number;
    track_stock: boolean;
  }[];
}

function productLabel(p: { name: string; variant_label: string | null }) {
  return [p.name, p.variant_label].filter(Boolean).join(" ");
}

async function stockCommand(merchant: Merchant, arg: string): Promise<string> {
  // Bare `stock` — what's out.
  if (!arg.trim()) {
    const { data } = await admin()
      .from("products")
      .select("name,variant_label,stock")
      .eq("merchant_id", merchant.id)
      .eq("is_active", true)
      .eq("track_stock", true)
      .eq("stock", 0)
      .limit(20);

    if (!data?.length) return "Nothing is out of stock.";
    return [
      "Out of stock:",
      ...data.map((p) => `· ${productLabel(p as any)}`),
      "",
      "stock <name> = 12 to restock",
    ].join("\n");
  }

  const { left, right } = splitAssignment(arg);
  const matches = await findProduct(merchant.id, left);

  if (!matches.length) return `No product matching "${left}".`;

  // Read-only check.
  if (right === null) {
    return matches
      .map(
        (p) =>
          `${productLabel(p)} — ${fmtMoney(p.price_minor, merchant.currency)} · ${
            p.track_stock ? `${p.stock} in stock` : "untracked"
          }`,
      )
      .join("\n");
  }

  // Writing needs exactly one match — never guess which product to restock.
  if (matches.length > 1) {
    return [
      `"${left}" matches ${matches.length} items:`,
      ...matches.map((p) => `· ${productLabel(p)}`),
      "",
      "Be more specific.",
    ].join("\n");
  }

  const n = Number(right);
  if (!Number.isInteger(n) || n < 0) return `"${right}" isn't a whole number.`;

  const { data, error } = await admin().rpc("set_product_stock", {
    p_merchant_id: merchant.id,
    p_product_id: matches[0].id,
    p_stock: n,
  });
  if (error) throw error;

  const p = data as { name: string; stock: number };
  const note =
    n > 0 && matches[0].stock === 0
      ? "\nAnyone waiting on it gets the restock alert within the hour."
      : "";
  return `${p.name} → ${p.stock} in stock.${note}`;
}

async function priceCommand(merchant: Merchant, arg: string): Promise<string> {
  const { left, right } = splitAssignment(arg);
  if (right === null) return "Use: price <name> = 25000";

  const matches = await findProduct(merchant.id, left);
  if (!matches.length) return `No product matching "${left}".`;
  if (matches.length > 1) {
    return [
      `"${left}" matches ${matches.length} items:`,
      ...matches.map((p) => `· ${productLabel(p)}`),
      "",
      "Be more specific.",
    ].join("\n");
  }

  const minor = parseMoneyToMinor(right);
  if (minor === null) return `Couldn't read "${right}" as an amount.`;

  const { error } = await admin()
    .from("products")
    .update({ price_minor: minor })
    .eq("id", matches[0].id)
    .eq("merchant_id", merchant.id);
  if (error) throw error;

  return `${productLabel(matches[0])} → ${fmtMoney(minor, merchant.currency)}.`;
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

async function listChats(merchant: Merchant): Promise<string> {
  const { data, error } = await admin().rpc("conversation_list", {
    p_merchant_id: merchant.id,
    p_limit: 10,
  });
  if (error) throw error;

  const rows = (data ?? []) as {
    status: string;
    customer_name: string | null;
    customer_phone: string;
    last_body: string | null;
    escalation_reason: string | null;
  }[];

  if (!rows.length) return "No conversations yet.";

  return [
    "Recent chats:",
    ...rows.map((c) => {
      const who = c.customer_name || c.customer_phone;
      const flag = c.status === "escalated" ? " ⚠️ waiting on you" : "";
      const last = c.last_body ? ` — "${c.last_body.slice(0, 40)}"` : "";
      return `· ${who}${flag}${last}`;
    }),
    "",
    "resume <phone> to hand a thread back to the bot",
  ].join("\n");
}

async function resumeChat(merchant: Merchant, phone: string): Promise<string> {
  if (!phone) return "Which number? e.g. resume 2348012345678";

  const c = await conversationByPhone(merchant.id, phone);
  if (!c) return `No conversation with ${phone}.`;

  await resumeConversation(merchant.id, c.out_conversation_id);
  return `Bot is replying to ${c.out_customer_name || phone} again.`;
}

async function closeChat(merchant: Merchant, phone: string): Promise<string> {
  if (!phone) return "Which number? e.g. close 2348012345678";

  const c = await conversationByPhone(merchant.id, phone);
  if (!c) return `No conversation with ${phone}.`;

  await closeConversation(merchant.id, c.out_conversation_id);
  return `Closed the thread with ${c.out_customer_name || phone}. A new message starts a fresh one.`;
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

async function usageReport(merchant: Merchant): Promise<string> {
  const u = await merchantUsage(merchant.id);
  if (!u) return "No usage recorded yet.";

  const lines = [
    `${u.period_month}`,
    `${u.ai_replies} of ${u.reply_cap} replies`,
    `AI cost ${fmtMoney(u.ai_cost_minor, u.currency)}`,
  ];

  if (u.template_messages > 0) {
    lines.push(`${u.template_messages} restock alerts sent`);
  }

  if (u.overage_replies > 0) {
    lines.push(
      `${u.overage_replies} over the cap — ${fmtMoney(
        u.overage_replies * u.overage_price_minor,
        u.currency,
      )} overage`,
    );
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Notifications the owner receives                                    */
/* ------------------------------------------------------------------ */

export function formatOrderNotification(o: OrderSummary): string {
  const items = o.items.map((i) => `  ${i.quantity} × ${i.product_name}`).join("\n");

  return [
    `🛒 New order ${orderRef(o.id)}`,
    `${o.customer_name || "Customer"} (${o.customer_phone})`,
    "",
    items,
    `Total ${fmtMoney(o.total_minor, o.currency)}`,
    o.delivery_address ? `\nDeliver to: ${o.delivery_address}` : null,
    "",
    `Reply *paid ${orderRef(o.id)}* once they pay, or *cancel ${orderRef(o.id)}* to release the stock.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatHandoverNotification(
  customerPhone: string,
  customerName: string | null,
  lastMessage: string,
  reason?: string | null,
): string {
  return [
    `⚠️ Handover — ${customerName || customerPhone}`,
    reason ? `Reason: ${reason}` : null,
    "",
    `"${lastMessage.slice(0, 160)}"`,
    "",
    `The bot has gone quiet on this thread. Reply to them on ${customerPhone}, then send *resume ${customerPhone}* to hand it back.`,
  ]
    .filter(Boolean)
    .join("\n");
}
