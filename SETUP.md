# Setup — do these in order

Everything here is your side. None of it is hard; it's mostly signing up for
things and pasting keys. Budget ~2 hours total.

> **Already running an earlier version?** Jump to
> [Upgrading](#upgrading-from-the-first-version) — the SQL files changed and
> both need re-running before the new code will work.

---

## 0. Before anything (has lead time)

- [ ] **Virtual USD card**, funded — Geegpay / Grey / Chipper. Naira debit cards
      get declined for international recurring billing on Meta, Anthropic and
      Vercel. Sort this first; funding can take a day to clear.
- [ ] **Dedicated SIM** that has never been used on WhatsApp. Once a number is
      registered on the consumer WhatsApp app it can't be used on the Cloud API
      without deregistering first.

---

## 1. Supabase

1. Create a project at supabase.com.
2. SQL Editor → paste **`supabase/schema.sql`** → Run.
3. SQL Editor → paste **`supabase/backend.sql`** → Run.
4. Authentication → Users → add yourself (email + password). The seed script
   needs one user to own the merchant row, and **this is also your dashboard
   login**.
5. Settings → API → copy:
   - `URL` → both `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL`
   - **`service_role`** key → `SUPABASE_SERVICE_ROLE_KEY`
   - **`anon`** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`

> The `service_role` key bypasses row-level security. It belongs in server env
> vars only. If it ever ends up in browser code, every merchant's data is public.
>
> The `anon` key is the opposite — it's *designed* to be public, and every query
> made with it is filtered by the RLS policies in `schema.sql`. That's the only
> key the dashboard ever uses.

---

## 2. Anthropic

console.anthropic.com → API Keys → create one. This is separate from your Claude
Pro subscription and is billed separately.

---

## 3. Meta / WhatsApp Cloud API

1. developers.facebook.com → Create App → type **Business**.
2. Add the **WhatsApp** product.
3. API Setup → add your dedicated number → verify it.
4. Copy the **temporary access token** and the **phone number ID**
   (the ID, not the phone number).
5. App Settings → Basic → copy the **App Secret**.
6. **Add a payment method to the WhatsApp Business Account.**
   From 1 Oct 2026 service messages are billed per message, and Meta stops
   delivering them entirely for accounts with no payment method on file.
   This is a hard cutoff, not a warning.

You can run the pilot **unverified**. Unverified accounts are capped at 250
*business-initiated* conversations per rolling 24h. Replies inside an open 24h
window don't count against that — and this bot is ~90% replies. So the cap only
limits restock alerts, not normal conversation. Do CAC registration later, when
a paying client or the shared cap actually forces it.

> The temporary token expires in 24h. Fine for testing. Before the pilot goes
> live, generate a permanent one via a System User in Business Settings.

---

## 4. Deploy

```bash
npm install
npm run check
```

`npm run check` runs the typechecker and the test suite. Both should pass before
you deploy anything.

```bash
git init && git add . && git commit -m "initial"
# push to GitHub, then import the repo at vercel.com
```

In Vercel → Settings → Environment Variables, add every value from
`.env.example`. Deploy.

Then open `https://<your-vercel-url>/api/health`. It tells you exactly which
variables are missing and whether the database and schema are reachable —
without you having to message the bot to find out.

> Vercel's free Hobby tier is **non-commercial**. The moment you charge a
> client, you need Pro ($20/mo). Hobby also only allows cron jobs that run
> **once per day** — anything more frequent fails the deployment outright — so
> `vercel.json` runs the sweep daily at 08:00 UTC. On Pro, set it back to
> `0 * * * *` for hourly restock alerts and order-notification retries.

---

## 5. Connect the webhook

Meta app → WhatsApp → Configuration → Edit:

- **Callback URL**: `https://<your-vercel-url>/api/whatsapp`
- **Verify token**: the exact string you put in `WHATSAPP_VERIFY_TOKEN`
- Click **Verify and save**
- Subscribe to the **`messages`** field

If verification fails, it's almost always one of: the env var isn't deployed
yet, the token doesn't match character-for-character, or you used `http://`.

---

## 6. Seed the pilot catalogue

```bash
export SEED_PHONE_NUMBER_ID=...        # from Meta API Setup
export SEED_ESCALATION_NUMBER=234...   # your own number, for handovers
npm run seed
```

Edit the `CATALOGUE` array in `scripts/seed.ts` first if the prices have moved.
Re-running is safe — it upserts rather than wiping the catalogue.

`SEED_ESCALATION_NUMBER` does double duty: it's where handovers and new-order
alerts go, **and** it's the number that unlocks the owner commands. Include the
country code.

---

## 7. Test

Message the number from your own phone:

- `how much be the bento platter` → should quote ₦30,000 from the DB
- `i need small chops for 40 guests` → should recommend a pack
- `abeg reduce am small` → should escalate, not haggle
- send a voice note → should politely ask you to type

Then message it from **your escalation number** and send `help` — you should get
the owner command list rather than a sales reply.

**Send me the transcripts where it gets things wrong.** That loop is the
actual work — the code is the easy part. The dashboard shows per-message model
and cost, which is what you tune the routing rules against.

---

## 8. The dashboard

`https://<your-vercel-url>/dashboard`, signed in with the Supabase user from
step 1.4.

- **Overview** — replies, AI cost, and margin for the month. If margin goes
  negative, the routing rules in `lib/pricing.ts` are what to look at.
- **Conversations** — every thread, with the 24h window state and which model
  answered each turn.
- **Orders** — mark paid, mark delivered, cancel (which restores stock).
- **Catalogue** — click any price or stock number to edit it. Changes are live
  on the next message.
- **Settings** — tone, handover number, delivery fee.

---

## 9. Owner commands (over WhatsApp)

Message the business number **from your escalation number**:

| Command | What it does |
|---|---|
| `orders` / `orders pending` | Recent orders, optionally filtered |
| `order ABC123` | Full detail for one order |
| `paid ABC123` | Mark paid |
| `done ABC123` | Mark delivered |
| `cancel ABC123 [reason]` | Cancel and put the stock back |
| `stock` | What's out of stock |
| `stock jollof = 12` | Set a count |
| `price jollof = 25000` | Set a price |
| `chats` | Recent conversations |
| `resume <phone>` | Let the bot reply again after a handover |
| `close <phone>` | End a thread |
| `usage` | This month's replies and cost |
| `mute` / `unmute` | Order notifications |

These are matched literally, not by the model — a typo gets rejected rather than
interpreted, and none of it costs Anthropic tokens.

**`resume` matters.** When the bot escalates, it goes silent on that thread
permanently until you resume it. That's deliberate — nothing is worse than the
bot talking over you mid-complaint — but it does mean a forgotten thread stays
mute.

---

## 10. Restock template (do last)

The restock alert fires outside the 24h window, so it needs an approved
**marketing** template. Meta → WhatsApp Manager → Message Templates → Create:

- Name: `restock_alert`
- Category: **Marketing**
- Body:
  `Hi {{1}}! Good news — {{2}} is back in stock at {{3}}. Want me to hold one for you?`

Three variables, in that order. The cron job passes them positionally, so a
mismatch means Meta rejects every send.

Approval takes hours to days. Marketing templates cost ~₦70 each vs ~₦13.50 for
a service reply, which is why the job is capped at 50 per run.

---

## Upgrading from the first version

Both SQL files gained sections, and the app will not work against the old
schema.

1. SQL Editor → re-run **all of `supabase/schema.sql`**. Every new statement is
   `add column if not exists` / `create ... if not exists`, so this is safe on a
   live project and won't touch your data.
2. SQL Editor → re-run **all of `supabase/backend.sql`**.
3. Add the new environment variables from `.env.example` — at minimum
   `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`, or the
   dashboard won't load.
4. Redeploy, then check `/api/health`. It reports `schema: stale` if step 2
   didn't take.

The most important change is in step 2: the RPC functions previously trusted a
caller-supplied `merchant_id`, and PostgREST exposes all of them to any
logged-in user. Until `backend.sql` is re-run, one merchant can read another's
conversations and orders. With a single pilot merchant nothing is exposed —
but do not onboard a second one before running it.
