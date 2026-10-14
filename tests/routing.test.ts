import test from "node:test";
import assert from "node:assert/strict";
import {
  pickModel,
  estimateCostMinor,
  isNegotiation,
  SMART,
  FAST,
} from "../lib/pricing";

/* These run with no environment set, so they exercise the default provider
   (kimi) at its table rates and USD_TO_MINOR's default of ₦1,350/$. */

test("plain lookups stay on the cheap model", () => {
  assert.equal(pickModel("how much be the bento platter", 0), FAST);
  assert.equal(pickModel("you get size 43?", 2), FAST);
  assert.equal(pickModel("hello", 0), FAST);
});

test("buying, haggling, trouble and event sizing go to the capable model", () => {
  assert.equal(pickModel("i want to order 2", 0), SMART);
  assert.equal(pickModel("abeg reduce am small", 0), SMART);
  assert.equal(pickModel("i need refund", 0), SMART);
  assert.equal(pickModel("small chops for 40 guests", 0), SMART);
});

test("long messages and long threads escalate on their own", () => {
  assert.equal(pickModel("x".repeat(221), 0), SMART);
  assert.equal(pickModel("hi", 7), SMART);
});

test("routing is sticky once a thread has needed the capable model", () => {
  assert.equal(pickModel("ok", 1, SMART), SMART);
  assert.equal(pickModel("thanks", 1, SMART), SMART);
});

test("a thread on the cheap model can still escalate, but never the reverse", () => {
  assert.equal(pickModel("i want to order", 1, FAST), SMART);
  assert.equal(pickModel("how much", 1, FAST), FAST);
});

test("catalogue nouns must never route traffic to the capable model", () => {
  // The margin on a ₦35k plan dies if a word that appears in most messages
  // is treated as an intent signal.
  for (const word of ["platter", "pizza", "pack", "chops", "bento", "jollof"]) {
    assert.equal(pickModel(`how much be the ${word}`, 0), FAST, word);
  }
});

test("haggling is caught in code, in Pidgin and English", () => {
  // The exact message that slipped past the model on 2026-10-14.
  assert.ok(isNegotiation("abeg na too much. last price for the 2? reduce am small"));
  for (const text of [
    "oga last price?",
    "reduce am small na",
    "any discount for 50 guests?",
    "dis one too expensive",
    "e too much abeg",
    "is it cheaper if I buy two?",
    "what's your best price",
    "can we bargain",
  ]) {
    assert.ok(isNegotiation(text), text);
  }
});

test("ordinary price questions are NOT treated as haggling", () => {
  // "how much" is the most common opening there is. Matching it would hand
  // every new customer to the owner and make the assistant pointless.
  for (const text of [
    "how much be the bento mini platter?",
    "how much for 2?",
    "what is the price of the platter",
    "I want to order",
    "deliver to Yaba",
  ]) {
    assert.ok(!isNegotiation(text), text);
  }
});

test("uncached prompt tokens bill at the full input rate", () => {
  const cost = estimateCostMinor({
    model: FAST,
    promptTokens: 1_000_000,
    outputTokens: 0,
    cachedTokens: 0,
  });
  // $0.60 per 1M input on the cheap model, at ₦1,350/$ = ₦810 = 81,000 kobo.
  assert.equal(cost, 81_000);
});

test("cached tokens are a SUBSET of prompt tokens, not a separate bucket", () => {
  // This is the convention that flipped when we left Anthropic. There,
  // input_tokens already EXCLUDED the cached ones and the two were added.
  // Here cached_tokens is contained in prompt_tokens, so adding them would
  // bill every cached token twice.
  const allCached = estimateCostMinor({
    model: FAST,
    promptTokens: 1_000_000,
    outputTokens: 0,
    cachedTokens: 1_000_000,
  });
  const noneCached = estimateCostMinor({
    model: FAST,
    promptTokens: 1_000_000,
    outputTokens: 0,
    cachedTokens: 0,
  });

  // A fully cached prompt costs the cache-hit rate and nothing else.
  assert.equal(allCached, 13_500); // $0.10/1M
  assert.ok(allCached < noneCached, "a cache hit must be cheaper than a miss");

  // Half cached lands exactly between the two, which it cannot do if the
  // buckets are being added instead of split.
  const half = estimateCostMinor({
    model: FAST,
    promptTokens: 1_000_000,
    outputTokens: 0,
    cachedTokens: 500_000,
  });
  assert.equal(half, 47_250); // 500k @ $0.60 + 500k @ $0.10
});

test("output is the expensive bucket on the capable model", () => {
  const cost = estimateCostMinor({
    model: SMART,
    promptTokens: 0,
    outputTokens: 1_000_000,
    cachedTokens: 0,
  });
  // $4.00 per 1M output.
  assert.equal(cost, 540_000);
});

test("an unknown model bills at the higher rate, never the lower", () => {
  // A stale or mistyped AI_MODEL_* override must under-report margin, not
  // over-report it.
  const unknown = estimateCostMinor({
    model: "some-model-that-was-renamed",
    promptTokens: 1_000_000,
    outputTokens: 0,
    cachedTokens: 0,
  });
  const fast = estimateCostMinor({
    model: FAST,
    promptTokens: 1_000_000,
    outputTokens: 0,
    cachedTokens: 0,
  });
  assert.ok(unknown > fast);
});

test("a provider over-reporting cached tokens cannot produce a negative cost", () => {
  // Seen on retried requests: cached_tokens comes back larger than
  // prompt_tokens. Clamping keeps the line item at the cache rate instead of
  // billing a negative number of uncached tokens.
  const cost = estimateCostMinor({
    model: FAST,
    promptTokens: 100,
    outputTokens: 0,
    cachedTokens: 1_000_000,
  });
  assert.ok(cost >= 0, `got ${cost}`);
  assert.ok(cost < 100, "nonsense input must not become a large charge");
});
