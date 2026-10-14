# WhatsApp AI Commerce Agent

An AI sales assistant for WhatsApp-first businesses in Nigeria and Ghana. The
customer messages the shop's WhatsApp number; the agent answers from the real
catalogue, builds orders, and hands off to the owner when it should.

Setup instructions are in **[SETUP.md](SETUP.md)**. This file is the map.

```
app/
  api/whatsapp/route.ts      inbound webhook — signature, idempotency, routing
  api/cron/restock/route.ts  daily: restock alerts + owner-notification retry
  api/health/route.ts        deploy check: which env vars are missing
  dashboard/                 merchant dashboard (browser, anon key, RLS)
  login/                     Supabase email/password

lib/
  agent.ts        the model + tools. Routing, the tool loop, provider-neutral
  pricing.ts      provider table, model ids, rates, routing rules
  owner.ts        the owner console, over WhatsApp
  whatsapp.ts     Cloud API client, signature verification, payload parsing
  supabase.ts     server data layer (SERVICE ROLE — never import in a client)
  supabase-browser.ts  dashboard client (ANON key — goes through RLS)
  money.ts        minor-unit formatting and parsing
  env.ts          validated environment access

supabase/
  schema.sql      tables, indexes, RLS policies        run FIRST
  backend.sql     functions, guards, grants            run SECOND

tests/            node:test — no database or network needed
```

---

## The three rules the design is built on

**1. The model never knows a price.**
Every price and stock figure comes from `search_catalogue` at the moment it is
quoted. Totals come from `place_order`, computed in Postgres. The model is told
to call the tool and is given a catalogue snapshot "for orientation only" — so
even a model that ignores its instructions cannot invent a price, because it
has no channel to state one that wasn't returned by a query.

**2. Money is a bigint of minor units.**
Kobo, not naira. There is no float anywhere in the path from database to
message. `minor / 100` happens once, in `fmtMoney`, to draw a string.

**3. Meta's 24h window decides what can be sent.**
Inside it, free-form text. Outside it, only an approved template. That single
constraint is why the restock alert is a cron job with a template rather than
just another reply, and why owner notifications have a retry sweep.

---

## Cost model

The plan is ₦35,000/month for 1,500 AI replies — about ₦23 of revenue per
reply, of which Meta takes ~₦13.50 as a service-message fee. What is left is
the model budget, and two mechanisms defend it.

**The provider is configuration, not code.** Moonshot (Kimi) and Alibaba (Qwen)
both expose OpenAI-compatible chat completions, so `lib/agent.ts` names
neither. `AI_PROVIDER` picks one; `AI_BASE_URL` and `AI_MODEL_*` override
individual fields, which is also how you point the whole thing at OpenRouter.
Run `npm run models` to check a configured model id actually exists before a
pilot — a renamed model is a 404 inside the webhook, after Meta has been ACKed,
which the customer experiences as silence.

**Model routing** (`lib/pricing.ts`). Price and availability questions go to
the cheap model. Order-building, haggling, complaints and event sizing go to
the capable one. Routing is **sticky**: once a thread has needed the capable
model it stays there, because threads that got complicated rarely get simple
again and the context cache is scoped per model.

> The `COMPLEX` patterns are intent signals only. Never add a product noun to
> that list — catalogue words appear in nearly every message, so one of them
> routes all traffic to the expensive model and erases the margin. There is a
> test for this.

**Context caching**, automatically. The tool definitions and system prompt are
identical every turn, and both providers cache a repeated prefix on their own
and bill a hit at roughly a sixth of the miss rate. There is no breakpoint to
mark and no minimum prefix length to clear, so the forty lines of caching logic
this file used to document are gone. What survives is the reason `TOOLS` is a
module constant: rebuilding it per request in a different key order changes the
prefix bytes and defeats the match.

> Watch the token accounting if you ever port this back. On an
> OpenAI-compatible API `prompt_tokens` is the WHOLE prompt and
> `cached_tokens` is a subset of it. Anthropic reports the two as disjoint.
> Billing them the same way on both is a double-count in one direction and a
> double-discount in the other; `estimateCostMinor` has a test pinning it.

Per-reply cost is written to `messages.cost_minor` and shown on each bubble in
the transcript view. The Overview page turns that into a margin figure.

## Safety boundaries

| Boundary | Where |
|---|---|
| Webhook authenticity | HMAC-SHA256 over the **raw** body, constant-time compare |
| Duplicate delivery | Insert-as-claim on `messages.wa_message_id`'s unique index |
| Runaway spend per customer | `recent_inbound_count` throttle, counted in Postgres |
| Runaway spend per turn | 5-hop tool loop cap, `max_tokens: 400` |
| Cross-tenant reads | `can_access_merchant()` in every RPC, plus REVOKEs |
| Billing fields | Column-level `GRANT UPDATE` on `merchants` |
| Stock integrity | `set_order_status` is the only path; cancel restores stock |
| Cron abuse | Constant-time bearer check on `CRON_SECRET` |

The throttle is in Postgres rather than in memory on purpose: serverless
instances share no memory, and an in-process counter resets on every cold
start — which is exactly when a flood arrives.

---

## Two keys, two very different jobs

`lib/supabase.ts` holds the **service role** key. It bypasses RLS, which is
correct for the webhook (an inbound WhatsApp message has no logged-in user) and
catastrophic anywhere a browser can reach it.

`lib/supabase-browser.ts` holds the **anon** key. It's public by design and
every query it makes is filtered by RLS using the logged-in owner's JWT.

Never import the first from a client component.

Because `security definer` functions bypass RLS by design, they cannot also
trust a caller-supplied `merchant_id` — PostgREST exposes every function to
every logged-in user. `can_access_merchant()` is the guard, and anything the
browser has no business calling is revoked from `anon, authenticated` outright.

---

## Development

```bash
npm install
npm run check      # typecheck + tests
npm run dev
```

`npm test` needs no database, no network, and no API keys — everything it
covers is pure logic: signature verification, payload parsing, money
formatting, model routing, cost arithmetic, phone matching, and the
conversation-history shape the Messages API requires.

Everything that touches Postgres or Meta is verified by running it. Start with
`/api/health`.
