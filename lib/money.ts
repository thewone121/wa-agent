/**
 * Money formatting.
 *
 * Everything in the database is a bigint of MINOR units — kobo for NGN,
 * pesewas for GHS. Nothing here ever converts back to a float for storage
 * or arithmetic; `minor / 100` happens once, at the last possible moment,
 * purely to draw a string.
 */

export type Currency = "NGN" | "GHS";

const SYMBOL: Record<string, string> = { NGN: "₦", GHS: "GH₵" };

/**
 * ₦30,000 rather than ₦30,000.00 — the trailing zeros read as a form field,
 * not a chat message. Kobo are shown only when there are kobo, which for a
 * catalogue priced in whole naira means never.
 */
export function fmtMoney(minor: number | string | null | undefined, currency: string): string {
  const n = Number(minor ?? 0);
  if (!Number.isFinite(n)) return `${SYMBOL[currency] ?? ""}0`;

  const negative = n < 0;
  const abs = Math.abs(n);
  const major = Math.floor(abs / 100);
  const rem = abs % 100;

  const body =
    rem === 0
      ? major.toLocaleString("en-US")
      : (abs / 100).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

  return `${negative ? "-" : ""}${SYMBOL[currency] ?? ""}${body}`;
}

/**
 * Parse an owner-typed amount into minor units: "35000", "₦35,000",
 * "35k", "35,000.50". Used by the WhatsApp owner console, where the owner is
 * typing one-handed and will not format anything carefully.
 *
 * Returns null on anything it cannot read — the caller must not guess.
 */
export function parseMoneyToMinor(input: string): number | null {
  const cleaned = input.trim().replace(/[₦$,\s]|GH₵/gi, "");
  if (!cleaned) return null;

  const k = /^(\d+(?:\.\d+)?)k$/i.exec(cleaned);
  if (k) return Math.round(Number(k[1]) * 1000 * 100);

  const m = /^(\d+(?:\.\d{1,2})?)$/.exec(cleaned);
  if (!m) return null;

  return Math.round(Number(m[1]) * 100);
}

/** Short, human-quotable order reference: the first 6 chars of the uuid. */
export function orderRef(orderId: string): string {
  return orderId.replace(/-/g, "").slice(0, 6).toUpperCase();
}
