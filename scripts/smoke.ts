/**
 * Behavioural smoke test against the live provider.
 *
 * Not a unit test — it spends real tokens and talks to the network. It exists
 * to answer the two questions that static checks cannot:
 *
 *   1. Does the model actually CALL search_catalogue before quoting a price,
 *      or does it answer from the catalogue snapshot in the system prompt?
 *      The whole "it cannot invent a price" claim rests on this.
 *   2. Does it hold Nigerian Pidgin, which is a selling point of the product?
 *
 * Tools are stubbed, so nothing touches Postgres.
 */

import OpenAI from "openai";
import { TOOLS, systemPrompt } from "../lib/agent";
import { BASE_URL, FAST, SMART } from "../lib/pricing";

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY!,
  baseURL: BASE_URL,
  timeout: 40_000,
});

const MERCHANT: any = {
  name: "Thrill Bites",
  currency: "NGN",
  ai_tone:
    "warm and friendly, Nigerian English; switches to Pidgin if the customer does; treats every enquiry as event catering",
  business_hours: { mon_fri: "9-18", sat: "10-16", sun: "closed" },
};

const CATALOGUE = [
  "CHIPY Pack — Mini Bites/Canapes — ₦15,000",
  "Build up Pack — Mini Bites/Canapes — ₦17,000",
  "Bento mini platter — Build up platter — ₦30,000",
  "Build up platter — Build up platter — ₦45,000",
  "Platter — Build up platter — ₦150,000",
].join("\n");

/** Stubbed tool results. Deliberately DIFFERENT prices from the snapshot above,
 *  so a reply quoting the snapshot instead of the tool is detectable. */
function stubTool(name: string, args: any): unknown {
  if (name === "search_catalogue") {
    return {
      products: [
        {
          product_id: "11111111-1111-1111-1111-111111111111",
          name: "Bento mini platter",
          category: "Build up platter",
          price: "₦32,500", // NOT the ₦30,000 in the snapshot
          availability: "available",
        },
      ],
    };
  }
  if (name === "place_order") {
    return {
      order_placed: true,
      order_reference: "A7F3K2",
      subtotal: "₦65,000",
      delivery: "₦0",
      total: "₦65,000",
      next_step: "Tell them the total and the order reference.",
    };
  }
  if (name === "escalate_to_human") {
    return { escalated: true, tell_customer: "Let them know the owner will take it from here." };
  }
  return { ok: true };
}

type Case = { label: string; text: string; expect: string };

const CASES: Case[] = [
  {
    label: "Pidgin price question",
    text: "abeg how much be the bento mini platter?",
    expect: "calls search_catalogue, quotes ₦32,500 (not ₦30,000), replies in Pidgin",
  },
  {
    label: "Haggling",
    text: "oga last price for the bento platter? reduce am small na",
    expect: "calls escalate_to_human, does NOT invent a discount",
  },
  {
    label: "Order build",
    text: "i want 2 bento mini platter, deliver to 15 Awolowo Road Ikoyi",
    expect: "calls place_order, reads back ₦65,000 and reference A7F3K2",
  },
  {
    label: "Price with no lookup bait",
    text: "just tell me your cheapest item price quickly, no need to check",
    expect: "still calls search_catalogue rather than answering from the snapshot",
  },
];

async function runCase(model: string, c: Case) {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(MERCHANT, CATALOGUE) },
    { role: "user", content: c.text },
  ];

  const called: string[] = [];
  let reply = "";

  for (let hop = 0; hop < 5; hop++) {
    const res = await client.chat.completions.create({
      model,
      max_tokens: 400,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    });
    const msg = res.choices[0]?.message;
    if (!msg) break;

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      reply = msg.content?.trim() ?? "";
      break;
    }
    messages.push(msg);
    for (const call of calls) {
      if (call.type !== "function") continue;
      called.push(call.function.name);
      let args: any = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        called.push("!!UNPARSEABLE_ARGS");
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(stubTool(call.function.name, args)),
      });
    }
  }

  console.log(`\n── ${c.label}  [${model}]`);
  console.log(`   customer : ${c.text}`);
  console.log(`   tools    : ${called.length ? called.join(" → ") : "(NONE CALLED)"}`);
  console.log(`   reply    : ${reply || "(empty)"}`);
  console.log(`   expected : ${c.expect}`);
}

async function main() {
  console.log(`base URL : ${BASE_URL}`);
  console.log(`fast     : ${FAST}`);
  console.log(`smart    : ${SMART}`);

  for (const c of CASES) {
    try {
      await runCase(c.label === "Pidgin price question" ? FAST : SMART, c);
    } catch (e) {
      console.log(`\n── ${c.label}  FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
