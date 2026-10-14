"use client";

/**
 * Browser Supabase client for the dashboard.
 *
 * This holds the ANON key, not the service role key. That distinction is the
 * whole security model of the dashboard:
 *
 *   - The anon key is public by design. It is compiled into the JavaScript
 *     bundle and anyone can read it.
 *   - Every query it makes is filtered by the RLS policies in schema.sql,
 *     which resolve `auth.uid()` from the logged-in user's JWT.
 *   - So a merchant sees their own rows and nothing else, enforced by
 *     Postgres rather than by any check written here.
 *
 * Never import lib/supabase.ts (service role) into a client component. That
 * key bypasses RLS, and bundling it would make every merchant's data public.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function browserClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set for the dashboard. " +
        "Both are safe to expose — see Settings → API in Supabase.",
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return cached;
}
