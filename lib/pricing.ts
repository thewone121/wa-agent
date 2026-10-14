/**
 * Provider selection, model selection, and what each reply actually costs.
 *
 * The plan is ₦35,000/month for 1,500 AI replies. That is ~₦23 of revenue per
 * reply, and Meta takes ~₦13.50 of it in service-message fees. Everything the
 * model provider bills has to fit in what's left, which is why this file
 * exists instead of a hardcoded rate somewhere in the request path.
 *
 * PROVIDER-NEUTRAL BY DESIGN. Moonshot (Kimi) and Alibaba (Qwen) both expose
 * OpenAI-compatible chat-completions endpoints, so switching between them is a
 * base URL and two model ids — not a code change. OpenRouter works the same
 * way, which is the escape hatch if a provider is unreachable or unpayable
 * from where you are.
 *
 * Set AI_PROVIDER=kimi or AI_PROVIDER=qwen. Override any individual field with
 * AI_BASE_URL / AI_MODEL_FAST / AI_MODEL_SMART when a provider renames a model
 * or you want to point at OpenRouter.
 */

import { USD_TO_MINOR, optional, optionalNumber } from "./env";

/* ------------------------------------------------------------------ */
/* Rates                                                               */
/* ------------------------------------------------------------------ */
type Rate = {
  /** USD per million input tokens that were NOT served from cache. */
  inputPerM: number;
  /** USD per million output tokens. */
  outputPerM: number;
  /**
   * USD per million input tokens served from the provider's context cache.
   *
   * Unlike Anthropic, neither provider charges a separate cache-WRITE rate and
   * neither takes explicit cache breakpoints. Caching is automatic on a prefix
   * match, so there is nothing to mark and nothing to measure a prefix against.
   * The only thing that matters here is that a cache hit is billed cheaper.
   */
  cachedInputPerM: number;
};

type Provider = {
  baseUrl: string;
  /** Cheap model. Price and availability questions, which is most traffic. */
  fast: string;
  /** Capable model. Order-building, haggling, complaints, event sizing. */
  smart: string;
  rates: { fast: Rate; smart: Rate };
};

/**
 * Published rates as of the last time this file was touched.
 *
 * VERIFY THESE. Both providers reprice and rename models faster than Anthropic
 * does, and a stale rate here does not break anything loudly — it quietly makes
 * the margin figure on the dashboard a lie. `npm run models` lists the model
 * ids a provider will actually accept.
 */
const PROVIDERS: Record<string, Provider> = {
  kimi: {
    baseUrl: "https://api.moonshot.ai/v1",
    fast: "kimi-k2.5",
    smart: "kimi-k2.6",
    rates: {
      fast: { inputPerM: 0.6, outputPerM: 3.0, cachedInputPerM: 0.1 },
      smart: { inputPerM: 0.95, outputPerM: 4.0, cachedInputPerM: 0.16 },
    },
  },
  /**
   * OpenRouter. One key, every model, and — the reason it is the default here —
   * an account that can be funded without the international recurring billing
   * that Nigerian cards get declined for.
   *
   * There is no longer a free Kimi route. `moonshotai/kimi-k2:free` was real
   * when this was first wired up and had been retired by the time the key was
   * tested, which is exactly what `npm run models` exists to catch. Free
   * model ids are not a stable interface; check before a pilot, not during one.
   *
   * Rates below were read from OpenRouter's own /models endpoint, not from a
   * pricing blog. Re-read them the same way rather than editing by hand:
   *   curl -H "Authorization: Bearer $AI_API_KEY"    *        https://openrouter.ai/api/v1/models | jq '.data[]|select(.id|test("moonshot"))'
   *
   * Avoid kimi-k3 for this workload: $15/M output is more than Sonnet 5 charged,
   * and nothing about a three-line WhatsApp reply needs it.
   */
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    fast: "moonshotai/kimi-k2.5",
    smart: "moonshotai/kimi-k2.6",
    rates: {
      fast: { inputPerM: 0.5, outputPerM: 2.5, cachedInputPerM: 0.15 },
      smart: { inputPerM: 0.65, outputPerM: 3.41, cachedInputPerM: 0.15 },
    },
  },
  qwen: {
    // The -intl host. The mainland host (dashscope.aliyuncs.com) takes a
    // different API key and is slower to reach from West Africa.
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    fast: "qwen-plus",
    smart: "qwen3-max",
    rates: {
      fast: { inputPerM: 0.4, outputPerM: 1.2, cachedInputPerM: 0.08 },
      smart: { inputPerM: 1.2, outputPerM: 6.0, cachedInputPerM: 0.24 },
    },
  },
};

const PROVIDER_NAME = optional("AI_PROVIDER", "kimi").toLowerCase();

const PROVIDER: Provider =
  PROVIDERS[PROVIDER_NAME] ??
  (() => {
    throw new Error(
      `Unknown AI_PROVIDER "${PROVIDER_NAME}". Known: ${Object.keys(PROVIDERS).join(", ")}. ` +
        `For anything else (OpenRouter, a self-hosted gateway) keep AI_PROVIDER on the ` +
        `provider whose rates match and override AI_BASE_URL.`,
    );
  })();

/* ------------------------------------------------------------------ */
/* Resolved configuration                                              */
/* ------------------------------------------------------------------ */
export const BASE_URL = optional("AI_BASE_URL", PROVIDER.baseUrl);

/** The cheap model. Most messages are a price check and never leave here. */
export const FAST = optional("AI_MODEL_FAST", PROVIDER.fast);

/** The capable model. Anything that can cost the merchant money if fumbled. */
export const SMART = optional("AI_MODEL_SMART", PROVIDER.smart);

export type ModelId = string;

/**
 * Rates are keyed by the resolved model id so a cost lookup works even after
 * AI_MODEL_* overrides. An id this map has never seen falls back to the
 * expensive tier, so a bad override under-reports margin, never over-reports it.
 */
const RATES: Record<string, Rate> = {
  [FAST]: {
    inputPerM: optionalNumber("AI_FAST_INPUT_PER_M", PROVIDER.rates.fast.inputPerM),
    outputPerM: optionalNumber("AI_FAST_OUTPUT_PER_M", PROVIDER.rates.fast.outputPerM),
    cachedInputPerM: optionalNumber(
      "AI_FAST_CACHED_PER_M",
      PROVIDER.rates.fast.cachedInputPerM,
    ),
  },
  [SMART]: {
    inputPerM: optionalNumber("AI_SMART_INPUT_PER_M", PROVIDER.rates.smart.inputPerM),
    outputPerM: optionalNumber("AI_SMART_OUTPUT_PER_M", PROVIDER.rates.smart.outputPerM),
    cachedInputPerM: optionalNumber(
      "AI_SMART_CACHED_PER_M",
      PROVIDER.rates.smart.cachedInputPerM,
    ),
  },
};

function rateFor(model: string): Rate {
  return RATES[model] ?? RATES[SMART];
}

/* ------------------------------------------------------------------ */
/* Cost                                                                */
/* ------------------------------------------------------------------ */
export type Usage = {
  model: string;
  /**
   * The provider's `usage.prompt_tokens`. On an OpenAI-compatible API this is
   * the TOTAL prompt, cached tokens INCLUDED.
   */
  promptTokens: number;
  /** The provider's `usage.completion_tokens`. */
  outputTokens: number;
  /**
   * `usage.prompt_tokens_details.cached_tokens`. A SUBSET of promptTokens, not
   * a separate bucket.
   *
   * This is the opposite of Anthropic's convention, where input_tokens already
   * excludes the cached ones. Billing it as a fourth additive bucket — which is
   * what the Anthropic version of this function did, correctly, for Anthropic —
   * would double-count every cached token here.
   */
  cachedTokens: number;
};

/** Cost of one reply in minor units (kobo). */
export function estimateCostMinor(u: Usage): number {
  const r = rateFor(u.model);

  // Cached tokens are inside promptTokens, so subtract before billing the rest
  // at the full rate. Clamped because a provider that reports cached_tokens
  // larger than prompt_tokens (it happens on retries) must not produce a
  // negative line item.
  const cached = Math.max(0, Math.min(u.cachedTokens, u.promptTokens));
  const uncached = u.promptTokens - cached;

  const usd =
    (uncached * r.inputPerM) / 1_000_000 +
    (cached * r.cachedInputPerM) / 1_000_000 +
    (u.outputTokens * r.outputPerM) / 1_000_000;

  return Math.round(usd * USD_TO_MINOR);
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */
// Intent signals ONLY. Never put a product name or a word from the merchant's
// catalogue in here — those appear in nearly every message, which would route
// all traffic to the expensive model and wipe out the margin on a ₦35k plan.
const COMPLEX: RegExp[] = [
  // buying intent
  /\border\b/i, /\bbuy\b/i, /\bdeliver/i, /\bpay/i, /\baddress\b/i, /\bconfirm/i,
  // negotiation — must escalate, never improvised
  /\bdiscount/i, /\breduce\b/i, /\blast price\b/i, /\bbargain/i,
  // trouble — needs the careful model
  /\brefund/i, /\bcomplain/i, /\bwrong\b/i, /\bnever\b/i, /\bwaiting\b/i, /\bdamage/i,
  // event sizing (quantity reasoning)
  /\bevent\b/i, /\bguests?\b/i, /\bcater/i, /\bhow many\b/i, /\bwedding\b/i, /\bparty\b/i,
];

/**
 * Pick the model for this turn.
 *
 * `stickyModel` is whatever answered earlier in this same conversation. Once a
 * thread has needed the capable model it stays there: a thread that got
 * complicated rarely gets simple again, and alternating models throws away the
 * provider's context cache on every switch, so the saving from routing back
 * down is smaller than the cache it costs.
 */
export function pickModel(
  text: string,
  turnCount: number,
  stickyModel?: string | null,
): ModelId {
  if (stickyModel === SMART) return SMART;
  if (turnCount > 6) return SMART;            // long threads drift
  if (text.length > 220) return SMART;
  if (COMPLEX.some((re) => re.test(text))) return SMART;
  return FAST;
}
