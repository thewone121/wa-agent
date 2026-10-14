/**
 * Seed the pilot merchant + catalogue.
 *
 *   npm run seed
 *
 * Reads the same env vars as the app. Safe to re-run — it upserts the
 * merchant by slug and each product by (merchant, name, variant).
 *
 * Prices are in MINOR UNITS (kobo). ₦15,000 = 1_500_000.
 * Edit the CATALOGUE below with the merchant's real items before running.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.\n" +
      "Locally: put them in .env.local and run with `npx dotenv -e .env.local -- npm run seed`,\n" +
      "or export them in your shell.",
  );
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------
// Pilot merchant
// ---------------------------------------------------------------
const MERCHANT = {
  name: "Thrill Bites",
  slug: "thrill-bites",
  currency: "NGN" as const,
  timezone: "Africa/Lagos",
  // From Meta → WhatsApp → API Setup. NOT the phone number itself.
  wa_phone_number_id: process.env.SEED_PHONE_NUMBER_ID ?? "",
  wa_display_number: "+2349165073999",
  ai_tone:
    "warm and friendly, Nigerian English; switches to Pidgin if the customer does; treats every enquiry as event catering",
  delivery_fee_minor: 0,
  // Digits only, to match what Meta delivers as the sender on inbound
  // messages. lib/owner.ts compares on a digit suffix, but storing it
  // normalised keeps the owner-console match predictable.
  escalation_number: (process.env.SEED_ESCALATION_NUMBER ?? "").replace(/\D/g, "") || null,
};

// ---------------------------------------------------------------
// Real catalogue — small chops / event platters
// ---------------------------------------------------------------
const CATALOGUE = [
  { name: "CHIPY Pack",            category: "Mini Bites/Canapes", price_minor: 1_500_000, track_stock: false, description: "Small chops pack" },
  { name: "Build up Pack",         category: "Mini Bites/Canapes", price_minor: 1_700_000, track_stock: false, description: "Small chops pack" },
  { name: "Solo pack 003",         category: "Mini Bites/Canapes", price_minor: 1_800_000, track_stock: false, description: "Single-serve pack" },
  { name: "Jumbo Pizzas",          category: "Mini Bites/Canapes", price_minor: 2_600_000, track_stock: false, description: "Jumbo pizza" },
  { name: "Bento mini platter",    category: "Build up platter",   price_minor: 3_000_000, track_stock: false, description: "Individually packed, good for ~40 guests" },
  { name: "Build up platter",      category: "Build up platter",   price_minor: 4_500_000, track_stock: false, description: "Covers roughly 30-50 guests" },
  { name: "Platter",               category: "Build up platter",   price_minor: 15_000_000, track_stock: false, description: "Large event platter" },
  { name: "Odogworess Platter",    category: "Build up platter",   price_minor: 17_000_000, track_stock: false, description: "Largest event platter" },
];

async function main() {
  if (!MERCHANT.wa_phone_number_id) {
    console.error(
      "Set SEED_PHONE_NUMBER_ID first — it's the phone_number_id from Meta → WhatsApp → API Setup.",
    );
    process.exit(1);
  }

  if (!MERCHANT.escalation_number) {
    console.warn(
      "⚠ SEED_ESCALATION_NUMBER is not set. Without it, handovers and new-order\n" +
        "  notifications have nowhere to go, and the owner commands stay locked.\n" +
        "  You can set it later in the dashboard under Settings.\n",
    );
  }

  // The merchant row needs an owner in auth.users. Use the first user
  // in the project (the account you signed up with).
  const { data: users, error: uErr } = await db.auth.admin.listUsers();
  if (uErr) throw uErr;

  const owner = users?.users?.[0];
  if (!owner) {
    console.error(
      "No auth user found. Create one in Supabase → Authentication → Users, then re-run.\n" +
        "That same email and password is what you'll sign into the dashboard with.",
    );
    process.exit(1);
  }

  const { data: merchant, error: mErr } = await db
    .from("merchants")
    .upsert({ ...MERCHANT, owner_id: owner.id }, { onConflict: "slug" })
    .select("id,name")
    .single();

  if (mErr) throw mErr;
  console.log(`merchant: ${merchant.name} (${merchant.id})`);
  console.log(`owner:    ${owner.email}`);

  /* Upsert rather than delete-and-reinsert.
     order_items references products ON DELETE RESTRICT, so wiping the
     catalogue fails as soon as one order exists — which is to say, it worked
     right up until the pilot made its first sale. */
  const { error: pErr } = await db.from("products").upsert(
    CATALOGUE.map((p) => ({
      ...p,
      merchant_id: merchant.id,
      variant_label: null,
      stock: 0,
      is_active: true,
    })),
    { onConflict: "merchant_id,name,variant_label" },
  );

  if (pErr) throw pErr;
  console.log(`seeded ${CATALOGUE.length} products`);

  // Anything previously seeded and since removed from CATALOGUE is hidden
  // rather than deleted, so old orders keep their product references.
  const names = CATALOGUE.map((p) => p.name);
  const { data: stale } = await db
    .from("products")
    .update({ is_active: false })
    .eq("merchant_id", merchant.id)
    .not("name", "in", `(${names.map((n) => `"${n}"`).join(",")})`)
    .select("name");

  if (stale?.length) {
    console.log(`hid ${stale.length} product(s) no longer in the catalogue`);
  }

  console.log("\nNext: sign in to /dashboard with the account above.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
