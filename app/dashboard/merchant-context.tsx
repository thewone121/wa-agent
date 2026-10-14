"use client";

/**
 * Who is logged in, and which merchant do they own.
 *
 * Resolved once in the dashboard layout and shared by context, rather than
 * refetched per page — every page needs the merchant id and the currency, and
 * six pages each doing their own `my_merchant()` call is six round trips on a
 * connection where each one is felt.
 */

import { createContext, useContext } from "react";

export type DashboardMerchant = {
  id: string;
  name: string;
  slug: string;
  currency: "NGN" | "GHS";
  timezone: string;
  wa_display_number: string | null;
  escalation_number: string | null;
  greeting: string | null;
  ai_tone: string;
  business_hours: Record<string, string>;
  delivery_fee_minor: number;
  owner_notify: boolean;
  plan_reply_cap: number;
  is_active: boolean;
};

const MerchantContext = createContext<DashboardMerchant | null>(null);

export const MerchantProvider = MerchantContext.Provider;

/** Throws outside the dashboard layout, which is a bug, not a state to render. */
export function useMerchant(): DashboardMerchant {
  const m = useContext(MerchantContext);
  if (!m) throw new Error("useMerchant must be used inside the dashboard layout");
  return m;
}
