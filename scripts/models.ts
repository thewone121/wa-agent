/**
 * List the model ids the configured provider will actually accept.
 *
 *   npx dotenv -e .env.local -- npm run models
 *
 * Kimi and Qwen rename and retire models considerably faster than the rates
 * table in lib/pricing.ts gets updated, and a wrong model id fails as a 404 at
 * the worst possible moment — inside the webhook, after Meta has already been
 * ACKed, where the customer just sees no reply. Run this before a pilot and
 * after any provider switch.
 */

import OpenAI from "openai";
import { BASE_URL, FAST, SMART } from "../lib/pricing";

const key = process.env.AI_API_KEY;
if (!key) {
  console.error("Set AI_API_KEY first (it lives in .env.local).");
  process.exit(1);
}

async function main() {
  console.log(`provider base URL : ${BASE_URL}`);
  console.log(`configured fast   : ${FAST}`);
  console.log(`configured smart  : ${SMART}\n`);

  const client = new OpenAI({ apiKey: key, baseURL: BASE_URL, timeout: 20_000 });

  let ids: string[];
  try {
    const res = await client.models.list();
    ids = res.data.map((m) => m.id).sort();
  } catch (e) {
    console.error(
      "Could not list models. Check AI_API_KEY and AI_BASE_URL.\n",
      e instanceof Error ? e.message : e,
    );
    process.exit(1);
  }

  console.log(`${ids.length} model(s) available:`);
  for (const id of ids) console.log(`  ${id}`);

  // The whole point of the script: say plainly whether what's configured works.
  const missing = [FAST, SMART].filter((m) => !ids.includes(m));
  if (missing.length) {
    console.error(
      `\n✗ NOT AVAILABLE: ${missing.join(", ")}\n` +
        `  Pick replacements from the list above and set AI_MODEL_FAST / AI_MODEL_SMART.\n` +
        `  Update the rates in lib/pricing.ts to match, or the margin figure will be wrong.`,
    );
    process.exit(1);
  }

  console.log("\n✓ Both configured models exist on this provider.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
