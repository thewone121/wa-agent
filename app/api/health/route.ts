/**
 * Deploy check.
 *
 * Reports which required env vars are missing, by NAME only — never a value,
 * never a prefix. The alternative is finding out a var didn't make it into the
 * Vercel environment when a customer's message goes unanswered.
 *
 * Also confirms the database is reachable and that the v2 SQL has actually
 * been run: a deploy with the new code and the old schema fails at runtime,
 * inside `after()`, where nothing surfaces it.
 */

import { NextResponse } from "next/server";
import { missingRequired } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const missing = missingRequired();

  const checks: Record<string, string> = {};
  let ok = missing.length === 0;

  if (missing.length === 0) {
    try {
      const { admin } = await import("@/lib/supabase");

      const { error: dbErr } = await admin().from("merchants").select("id").limit(1);
      checks.database = dbErr ? `unreachable: ${dbErr.message}` : "ok";
      if (dbErr) ok = false;

      // A function added in the v2 SQL. Missing means backend.sql wasn't re-run.
      const { error: fnErr } = await admin().rpc("recent_inbound_count", {
        p_conversation_id: "00000000-0000-0000-0000-000000000000",
        p_seconds: 1,
      });
      const stale = fnErr?.message?.includes("Could not find the function");
      checks.schema = stale
        ? "stale — re-run supabase/schema.sql then supabase/backend.sql"
        : fnErr
          ? `error: ${fnErr.message}`
          : "ok";
      if (fnErr) ok = false;
    } catch (e) {
      checks.database = `error: ${e instanceof Error ? e.message : String(e)}`;
      ok = false;
    }
  }

  const dashboardReady =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  return NextResponse.json(
    {
      ok,
      missingEnv: missing,
      checks,
      dashboard: dashboardReady
        ? "ok"
        : "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not set",
    },
    { status: ok ? 200 : 503 },
  );
}
