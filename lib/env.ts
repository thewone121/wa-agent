/**
 * Environment access, validated once at module load.
 *
 * The previous version read `process.env.X!` inline. In TypeScript `!` only
 * silences the type checker — at runtime a missing var becomes the string
 * "undefined" or an empty string and the failure surfaces somewhere useless:
 * an HMAC that never matches, a Supabase client that 401s on every query.
 * Failing here instead means a missing var breaks the deploy, not a customer
 * conversation at 9pm on a Friday.
 */

type EnvKey =
  | "SUPABASE_URL"
  | "SUPABASE_SERVICE_ROLE_KEY"
  | "AI_API_KEY"
  | "WHATSAPP_TOKEN"
  | "WHATSAPP_APP_SECRET"
  | "WHATSAPP_VERIFY_TOKEN"
  | "CRON_SECRET";

/** Vars the server cannot function without. */
const REQUIRED: EnvKey[] = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "AI_API_KEY",
  "WHATSAPP_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "CRON_SECRET",
];

export function required(key: EnvKey): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(
      `Missing required environment variable ${key}. ` +
        `Set it in .env.local for dev, or Vercel → Settings → Environment Variables in production.`,
    );
  }
  return v;
}

export function optional(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length ? v : fallback;
}

export function optionalNumber(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function optionalBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.toLowerCase();
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Report every missing var at once rather than one per redeploy.
 * Surfaced by /api/health so you can check a deploy without messaging it.
 */
export function missingRequired(): string[] {
  return REQUIRED.filter((k) => !process.env[k]);
}

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** NGN per USD expressed in minor units. 135000 = ₦1,350/$. */
export const USD_TO_MINOR = optionalNumber("USD_TO_MINOR", 135_000);

export const RESTOCK_TEMPLATE_NAME = optional("RESTOCK_TEMPLATE_NAME", "restock_alert");
export const RESTOCK_TEMPLATE_LANG = optional("RESTOCK_TEMPLATE_LANG", "en");
export const RESTOCK_MAX_PER_RUN = optionalNumber("RESTOCK_MAX_PER_RUN", 50);

/**
 * Abuse ceiling. One customer cannot cost more than this many AI replies in
 * the window, no matter how fast they type. Without it a single script
 * pointed at the number drains the Anthropic balance.
 */
export const THROTTLE_MAX_REPLIES = optionalNumber("THROTTLE_MAX_REPLIES", 12);
export const THROTTLE_WINDOW_SECONDS = optionalNumber("THROTTLE_WINDOW_SECONDS", 120);

/**
 * Thinking / reasoning toggles are provider-specific and not part of the
 * OpenAI-compatible surface, so there is no portable flag for them. Anything
 * extra goes to the provider verbatim through AI_EXTRA_BODY instead — see
 * lib/agent.ts. Example:
 *
 *   AI_EXTRA_BODY={"enable_thinking":false}
 */
