/**
 * Demo conversations, orders and usage for the pilot merchant.
 *
 *   npx dotenv-cli -e .env.local -- npm run demo
 *
 * `npm run seed` creates the merchant and the catalogue and stops there, which
 * leaves Overview, Conversations and Orders completely empty — a bad thing to
 * turn a laptop around to. This fills them with three threads that between them
 * exercise every state the dashboard can render: a completed sale, a live
 * enquiry, and an escalation waiting on the owner.
 *
 * EVERYTHING HERE IS FABRICATED. The customers do not exist. It is safe to run
 * against a pilot database only because the phone numbers are in the UK test
 * range (+44 7700 900xxx, reserved by Ofcom for fiction) and can never collide
 * with a real Nigerian customer. Re-running is safe: conversations are keyed on
 * those numbers and reused.
 *
 * Costs are computed at Kimi k2.5/k2.6 rates — what these replies WOULD cost in
 * production — not at the free tier's zero. Otherwise the margin figure on
 * Overview reads 100% and tells you nothing.
 *
 * DO NOT RUN THIS once a merchant has real traffic. It overwrites the current
 * month's usage counters with fixed demo figures, which would erase the real
 * reply count and AI spend the margin figure depends on.
 */

import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (they're in .env.local).");
  process.exit(1);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

const USD_TO_MINOR = Number(process.env.USD_TO_MINOR ?? 135_000);

/** Kimi rates, USD per million tokens. Read from OpenRouter's /models endpoint. */
const RATE = {
  fast: { in: 0.5, out: 2.5 },
  smart: { in: 0.65, out: 3.41 },
};
const FAST = "moonshotai/kimi-k2.5";
const SMART = "moonshotai/kimi-k2.6";

function cost(model: string, inTok: number, outTok: number): number {
  const r = model === SMART ? RATE.smart : RATE.fast;
  return Math.round(((inTok * r.in) / 1e6 + (outTok * r.out) / 1e6) * USD_TO_MINOR);
}

/** Ofcom's reserved drama range. Cannot belong to anyone. */
const PHONES = {
  chinedu: "447700900101",
  amaka: "447700900102",
  tunde: "447700900103",
};

type Turn = {
  dir: "inbound" | "outbound";
  body: string;
  model?: string;
  inTok?: number;
  outTok?: number;
  /** Minutes before now. */
  ago: number;
};

async function thread(
  merchantId: string,
  phone: string,
  name: string,
  turns: Turn[],
): Promise<{ customerId: string; conversationId: string }> {
  const { data, error } = await db.rpc("upsert_customer_conversation", {
    p_merchant_id: merchantId,
    p_wa_phone: phone,
    p_name: name,
  });
  if (error) throw new Error(`upsert_customer_conversation: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  const customerId = row.out_customer_id as string;
  const conversationId = row.out_conversation_id as string;

  // Clear previous demo messages so a re-run does not stack duplicates.
  await db.from("messages").delete().eq("conversation_id", conversationId);

  const rows = turns.map((t) => ({
    merchant_id: merchantId,
    conversation_id: conversationId,
    direction: t.dir,
    body: t.body,
    model: t.dir === "outbound" ? (t.model ?? FAST) : null,
    input_tokens: t.dir === "outbound" ? (t.inTok ?? 1180) : null,
    output_tokens: t.dir === "outbound" ? (t.outTok ?? 90) : null,
    cached_tokens: t.dir === "outbound" ? 940 : null,
    cost_minor:
      t.dir === "outbound"
        ? cost(t.model ?? FAST, t.inTok ?? 1180, t.outTok ?? 90)
        : 0,
    billable_service: t.dir === "outbound",
    created_at: new Date(Date.now() - t.ago * 60_000).toISOString(),
  }));

  const { error: mErr } = await db.from("messages").insert(rows);
  if (mErr) throw new Error(`messages insert: ${mErr.message}`);

  await db
    .from("conversations")
    .update({ last_message_at: rows[rows.length - 1].created_at })
    .eq("id", conversationId);

  return { customerId, conversationId };
}

async function main() {
  const { data: merchant, error: mErr } = await db
    .from("merchants")
    .select("id,name,currency")
    .eq("slug", "thrill-bites")
    .single();
  if (mErr || !merchant) {
    console.error("No merchant found. Run `npm run seed` first.");
    process.exit(1);
  }
  console.log(`merchant: ${merchant.name}`);

  const { data: products, error: pErr } = await db
    .from("products")
    .select("id,name,price_minor")
    .eq("merchant_id", merchant.id);
  if (pErr || !products?.length) {
    console.error("No products. Run `npm run seed` first.");
    process.exit(1);
  }
  const byName = new Map(products.map((p) => [p.name, p]));
  const bento = byName.get("Bento mini platter");
  const chipy = byName.get("CHIPY Pack");
  const buildup = byName.get("Build up platter");
  if (!bento || !chipy || !buildup) {
    console.error("Expected catalogue items missing. Re-run `npm run seed`.");
    process.exit(1);
  }

  /* --- stock, so the Catalogue page isn't a column of zeros ---------- */
  for (const [p, stock] of [
    [chipy, 24],
    [bento, 8],
    [buildup, 3],
    [byName.get("Jumbo Pizzas"), 0], // one genuinely out of stock, for the alert
  ] as const) {
    if (!p) continue;
    const { error } = await db.rpc("set_product_stock", {
      p_merchant_id: merchant.id,
      p_product_id: p.id,
      p_stock: stock,
    });
    if (error) console.warn(`  stock ${p.name}: ${error.message}`);
  }
  console.log("set stock on 4 products");

  /* --- 1. completed sale, in Pidgin --------------------------------- */
  const c1 = await thread(merchant.id, PHONES.chinedu, "Chinedu Okafor", [
    { dir: "inbound", body: "abeg how much be the bento mini platter?", ago: 320 },
    {
      dir: "outbound",
      body: "Bento mini platter dey for ₦30,000. E good for around 40 guests. You wan order?",
      ago: 319,
    },
    { dir: "inbound", body: "yes i want 2", ago: 316 },
    {
      dir: "outbound",
      body: "Sharp. 2 Bento mini platter. Where we go deliver am?",
      ago: 315,
      model: SMART,
      inTok: 1340,
      outTok: 74,
    },
    { dir: "inbound", body: "15 Awolowo Road, Ikoyi", ago: 312 },
    {
      dir: "outbound",
      // {REF} is swapped for the real order reference once the order exists,
      // so the chat and the Orders page quote the same number.
      body: "Order confirmed. 2 Bento mini platter, ₦60,000 total. Your reference na {REF}. Oga go message you about payment.",
      ago: 311,
      model: SMART,
      inTok: 1510,
      outTok: 112,
    },
  ]);

  // Reuse this thread's order on a re-run. place_order is not idempotent, and
  // a second run used to leave Chinedu with two identical ₦60,000 orders.
  const { data: existing } = await db
    .from("orders")
    .select("id,status,total_minor")
    .eq("conversation_id", c1.conversationId)
    .limit(1)
    .maybeSingle();

  let orderId: string | null = existing?.id ?? null;

  if (orderId) {
    console.log(`order reused: ₦${(existing!.total_minor / 100).toLocaleString()} (${existing!.status})`);
  } else {
    const { data: orderRow, error: oErr } = await db.rpc("place_order", {
      p_merchant_id: merchant.id,
      p_customer_id: c1.customerId,
      p_conversation_id: c1.conversationId,
      p_items: [{ product_id: bento.id, quantity: 2 }],
      p_address: "15 Awolowo Road, Ikoyi, Lagos",
      p_notes: "Demo data — not a real order",
    });
    if (oErr) {
      console.warn(`  place_order: ${oErr.message}`);
    } else {
      const o = Array.isArray(orderRow) ? orderRow[0] : orderRow;
      orderId = o.out_order_id as string;
      const { error: sErr } = await db.rpc("set_order_status", {
        p_merchant_id: merchant.id,
        p_order_id: orderId,
        p_status: "confirmed",
        p_actor: "owner",
        p_note: "demo",
      });
      console.log(
        `order placed: ₦${(o.out_total_minor / 100).toLocaleString()}${sErr ? ` (status: ${sErr.message})` : " → confirmed"}`,
      );
    }
  }

  // Same derivation as orderRef() in lib/money.ts and find_order() in SQL:
  // the first six hex characters of the id. If these ever disagree, the owner
  // types "paid <ref>" from the chat and the console can't find the order.
  if (orderId) {
    const ref = orderId.replace(/-/g, "").slice(0, 6).toUpperCase();
    const { data: msgs } = await db
      .from("messages")
      .select("id,body")
      .eq("conversation_id", c1.conversationId)
      .like("body", "%{REF}%");
    for (const m of msgs ?? []) {
      await db.from("messages").update({ body: m.body.replace("{REF}", ref) }).eq("id", m.id);
    }
    console.log(`order reference in chat: ${ref}`);
  }

  /* --- 2. live enquiry, still open ---------------------------------- */
  await thread(merchant.id, PHONES.amaka, "Amaka Eze", [
    { dir: "inbound", body: "Good afternoon. Do you cater for weddings?", ago: 95 },
    {
      dir: "outbound",
      body: "Good afternoon! Yes we do. How many guests are you planning for?",
      ago: 94,
      model: SMART,
      inTok: 1290,
      outTok: 68,
    },
    { dir: "inbound", body: "about 120 people, traditional wedding in December", ago: 41 },
    {
      dir: "outbound",
      body: "For 120 guests the Build up platter works well — ₦45,000 each, and 3 would cover it comfortably. Shall I check December availability with the owner?",
      ago: 40,
      model: SMART,
      inTok: 1620,
      outTok: 134,
    },
  ]);

  /* --- 3. haggling → escalated, waiting on the owner ---------------- */
  const c3 = await thread(merchant.id, PHONES.tunde, "Tunde Bakare", [
    { dir: "inbound", body: "how much for the build up platter", ago: 28 },
    {
      dir: "outbound",
      body: "Build up platter is ₦45,000. It covers roughly 30-50 guests.",
      ago: 27,
    },
    { dir: "inbound", body: "oga last price? reduce am small na", ago: 24 },
    {
      dir: "outbound",
      body: "Let me get the owner to help you with that one.",
      ago: 23,
      model: SMART,
      inTok: 1380,
      outTok: 42,
    },
  ]);
  const { error: eErr } = await db.rpc("escalate_conversation", {
    p_conversation_id: c3.conversationId,
    p_reason: "price negotiation",
  });
  console.log(eErr ? `  escalate: ${eErr.message}` : "escalated 1 conversation");

  /* --- usage counters, so Overview has a margin to show --------------
     Written as absolute values, not through bump_usage: bump_usage ADDS, so
     every re-run of this script used to inflate the month's reply count. */
  const periodMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const { error: uErr } = await db.from("usage_counters").upsert(
    {
      merchant_id: merchant.id,
      period_month: periodMonth,
      ai_replies: 14,
      service_messages: 14,
      template_messages: 0,
      ai_cost_minor: 1_870,
      overage_replies: 0,
    },
    { onConflict: "merchant_id,period_month" },
  );
  if (uErr) console.warn(`  usage_counters: ${uErr.message}`);

  console.log("\n3 conversations, 1 order, stock and usage written.");
  console.log("Sign in at http://localhost:3000/dashboard");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
