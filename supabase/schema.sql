-- ============================================================
-- WhatsApp AI Commerce Agent — schema.sql
-- Run this FIRST in the Supabase SQL editor.
-- Money is stored as bigint MINOR UNITS (kobo for NGN, pesewas for GHS).
-- Never floats. Never trust prices from the client.
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- Enums
-- ------------------------------------------------------------
do $$ begin
  create type currency_code as enum ('NGN', 'GHS');
exception when duplicate_object then null; end $$;

do $$ begin
  create type conversation_status as enum ('open', 'escalated', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type message_direction as enum ('inbound', 'outbound');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status as enum ('draft', 'pending_payment', 'confirmed', 'fulfilled', 'cancelled');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------
-- merchants
-- One row per business. This is the tenant boundary.
-- ------------------------------------------------------------
create table if not exists merchants (
  id                        uuid primary key default gen_random_uuid(),
  owner_id                  uuid not null references auth.users(id) on delete cascade,
  name                      text not null,
  slug                      text not null unique,
  currency                  currency_code not null default 'NGN',
  timezone                  text not null default 'Africa/Lagos',

  -- WhatsApp Cloud API binding
  wa_phone_number_id        text unique,
  wa_display_number         text,

  -- Agent behaviour
  ai_tone                   text not null default 'friendly, concise, Nigerian English; uses Pidgin if the customer does',
  business_hours            jsonb not null default '{"mon_fri":"09:00-18:00","sat":"10:00-16:00","sun":"closed"}'::jsonb,
  escalation_number         text,
  delivery_fee_minor        bigint not null default 0,
  greeting                  text,

  -- Billing / plan
  plan_reply_cap            int not null default 1500,
  plan_price_minor          bigint not null default 3500000,   -- NGN 35,000 in kobo
  overage_price_minor       bigint not null default 2500,      -- NGN 25 in kobo

  is_active                 boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists merchants_owner_idx on merchants(owner_id);

-- ------------------------------------------------------------
-- products
-- ------------------------------------------------------------
create table if not exists products (
  id              uuid primary key default gen_random_uuid(),
  merchant_id     uuid not null references merchants(id) on delete cascade,
  name            text not null,
  description     text,
  category        text,
  price_minor     bigint not null check (price_minor >= 0),
  stock           int not null default 0 check (stock >= 0),
  track_stock     boolean not null default true,
  variant_label   text,                      -- e.g. "Size 43", "Black/White"
  image_url       text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists products_merchant_idx on products(merchant_id) where is_active;
create index if not exists products_search_idx on products using gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(category,'') || ' ' || coalesce(variant_label,'')));

-- ------------------------------------------------------------
-- customers  (one per WhatsApp number per merchant)
-- ------------------------------------------------------------
create table if not exists customers (
  id              uuid primary key default gen_random_uuid(),
  merchant_id     uuid not null references merchants(id) on delete cascade,
  wa_phone        text not null,
  name            text,
  address         text,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  unique (merchant_id, wa_phone)
);

create index if not exists customers_merchant_idx on customers(merchant_id);

-- ------------------------------------------------------------
-- conversations
-- window_expires_at tracks Meta's 24h service window.
-- Outside it you MUST use an approved template, not a free-form reply.
-- ------------------------------------------------------------
create table if not exists conversations (
  id                uuid primary key default gen_random_uuid(),
  merchant_id       uuid not null references merchants(id) on delete cascade,
  customer_id       uuid not null references customers(id) on delete cascade,
  status            conversation_status not null default 'open',
  window_expires_at timestamptz,
  escalated_at      timestamptz,
  escalation_reason text,
  last_message_at   timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

create index if not exists conversations_merchant_idx on conversations(merchant_id, last_message_at desc);
create unique index if not exists conversations_active_idx on conversations(merchant_id, customer_id) where status <> 'closed';

-- ------------------------------------------------------------
-- messages
-- Full transcript. cost_minor lets you see per-merchant margin.
-- ------------------------------------------------------------
create table if not exists messages (
  id                uuid primary key default gen_random_uuid(),
  merchant_id       uuid not null references merchants(id) on delete cascade,
  conversation_id   uuid not null references conversations(id) on delete cascade,
  direction         message_direction not null,
  wa_message_id     text,
  body              text,
  media_type        text,                    -- image | audio | document | null
  media_id          text,
  model             text,                    -- which model answered (haiku/sonnet)
  input_tokens      int,
  output_tokens     int,
  cached_tokens     int,
  billable_service  boolean not null default false,  -- counts toward Meta's 1,000 free
  created_at        timestamptz not null default now()
);

create index if not exists messages_conversation_idx on messages(conversation_id, created_at);
create unique index if not exists messages_wa_id_idx on messages(wa_message_id) where wa_message_id is not null;

-- ------------------------------------------------------------
-- orders + order_items
-- Totals are ALWAYS computed by place_order(), never passed in.
-- ------------------------------------------------------------
create table if not exists orders (
  id                uuid primary key default gen_random_uuid(),
  merchant_id       uuid not null references merchants(id) on delete cascade,
  customer_id       uuid not null references customers(id) on delete restrict,
  conversation_id   uuid references conversations(id) on delete set null,
  status            order_status not null default 'draft',
  subtotal_minor    bigint not null default 0,
  delivery_minor    bigint not null default 0,
  total_minor       bigint not null default 0,
  currency          currency_code not null,
  delivery_address  text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists orders_merchant_idx on orders(merchant_id, created_at desc);

create table if not exists order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders(id) on delete cascade,
  product_id        uuid not null references products(id) on delete restrict,
  product_name      text not null,           -- snapshot, survives product edits
  quantity          int not null check (quantity > 0),
  unit_price_minor  bigint not null check (unit_price_minor >= 0),
  line_total_minor  bigint not null check (line_total_minor >= 0)
);

create index if not exists order_items_order_idx on order_items(order_id);

-- ------------------------------------------------------------
-- stock_alerts — "tell me when size 45 is back"
-- This is the retention feature. Fires a MARKETING template (~NGN 70),
-- so only fire it on real intent.
-- ------------------------------------------------------------
create table if not exists stock_alerts (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid not null references merchants(id) on delete cascade,
  customer_id   uuid not null references customers(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  created_at    timestamptz not null default now(),
  notified_at   timestamptz,
  unique (customer_id, product_id)
);

create index if not exists stock_alerts_pending_idx on stock_alerts(product_id) where notified_at is null;

-- ------------------------------------------------------------
-- usage_counters — drives the NGN 35k / 1,500 reply cap + overage
-- ------------------------------------------------------------
create table if not exists usage_counters (
  merchant_id        uuid not null references merchants(id) on delete cascade,
  period_month       date not null,          -- first day of month
  ai_replies         int not null default 0,
  service_messages   int not null default 0, -- Meta: first 1,000/number/month free
  template_messages  int not null default 0,
  ai_cost_minor      bigint not null default 0,
  primary key (merchant_id, period_month)
);

-- ------------------------------------------------------------
-- Row Level Security
-- Merchants see only their own rows. The webhook uses the service
-- role key, which bypasses RLS — that is intentional and is why the
-- service key must never reach the browser.
-- ------------------------------------------------------------
alter table merchants       enable row level security;
alter table products        enable row level security;
alter table customers       enable row level security;
alter table conversations   enable row level security;
alter table messages        enable row level security;
alter table orders          enable row level security;
alter table order_items     enable row level security;
alter table stock_alerts    enable row level security;
alter table usage_counters  enable row level security;

create or replace function owns_merchant(m uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from merchants where id = m and owner_id = auth.uid());
$$;

drop policy if exists merchants_own on merchants;
create policy merchants_own on merchants
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists products_own on products;
create policy products_own on products
  for all using (owns_merchant(merchant_id)) with check (owns_merchant(merchant_id));

drop policy if exists customers_own on customers;
create policy customers_own on customers
  for all using (owns_merchant(merchant_id)) with check (owns_merchant(merchant_id));

drop policy if exists conversations_own on conversations;
create policy conversations_own on conversations
  for all using (owns_merchant(merchant_id)) with check (owns_merchant(merchant_id));

drop policy if exists messages_own on messages;
create policy messages_own on messages
  for all using (owns_merchant(merchant_id)) with check (owns_merchant(merchant_id));

drop policy if exists orders_own on orders;
create policy orders_own on orders
  for all using (owns_merchant(merchant_id)) with check (owns_merchant(merchant_id));

drop policy if exists order_items_own on order_items;
create policy order_items_own on order_items
  for all using (exists (select 1 from orders o where o.id = order_id and owns_merchant(o.merchant_id)));

drop policy if exists stock_alerts_own on stock_alerts;
create policy stock_alerts_own on stock_alerts
  for all using (owns_merchant(merchant_id)) with check (owns_merchant(merchant_id));

drop policy if exists usage_own on usage_counters;
create policy usage_own on usage_counters
  for select using (owns_merchant(merchant_id));

-- ============================================================
-- v2 additions.
--
-- Everything below is additive and re-runnable: if you already ran the
-- original schema.sql against a live project, paste the whole file again.
-- `create table if not exists` will NOT add a column to a table that already
-- exists, which is why these are explicit `alter table ... add column`.
-- ============================================================

-- ------------------------------------------------------------
-- orders — lifecycle timestamps
--
-- The original schema had an order_status enum but nowhere to record WHEN a
-- transition happened or whether the owner was ever told. An order could be
-- placed and sit unseen forever; owner_notified_at is what closes that hole.
-- ------------------------------------------------------------
alter table orders add column if not exists paid_at           timestamptz;
alter table orders add column if not exists fulfilled_at      timestamptz;
alter table orders add column if not exists cancelled_at      timestamptz;
alter table orders add column if not exists cancel_reason     text;
alter table orders add column if not exists owner_notified_at timestamptz;

-- Finding the un-notified orders is the hot path for the notifier.
create index if not exists orders_unnotified_idx
  on orders(merchant_id) where owner_notified_at is null;

create index if not exists orders_status_idx
  on orders(merchant_id, status, created_at desc);

-- ------------------------------------------------------------
-- order_events — audit trail
--
-- Who moved this order, when, and from where. When a customer insists they
-- cancelled and the owner insists they didn't, this table is the answer.
-- ------------------------------------------------------------
create table if not exists order_events (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  merchant_id uuid not null references merchants(id) on delete cascade,
  from_status order_status,
  to_status   order_status not null,
  actor       text not null default 'system',   -- 'owner' | 'agent' | 'system' | 'dashboard'
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists order_events_order_idx on order_events(order_id, created_at);

-- ------------------------------------------------------------
-- merchants — owner notifications and cap warnings
-- ------------------------------------------------------------
alter table merchants add column if not exists owner_notify boolean not null default true;

-- Set to the current month once the reply cap warning has gone out, so the
-- owner is told they're over the plan ONCE, not on every reply after 1,500.
alter table merchants add column if not exists cap_notified_month date;

-- ------------------------------------------------------------
-- conversations — resume tracking
--
-- escalate_conversation could set status but nothing could ever unset it, so
-- an escalated thread was permanently mute. The owner console now reopens it.
-- ------------------------------------------------------------
alter table conversations add column if not exists resumed_at timestamptz;

-- The throttle counts recent inbound messages per conversation. Without this
-- index that count is a sequential scan on every single inbound message.
create index if not exists messages_convo_recent_idx
  on messages(conversation_id, direction, created_at desc);

-- ------------------------------------------------------------
-- RLS for the new table
-- ------------------------------------------------------------
alter table order_events enable row level security;

drop policy if exists order_events_own on order_events;
create policy order_events_own on order_events
  for all using (owns_merchant(merchant_id)) with check (owns_merchant(merchant_id));

-- ------------------------------------------------------------
-- messages — per-reply cost
--
-- The original comment on this table promised "cost_minor lets you see
-- per-merchant margin", but the column was never created. Per-reply cost was
-- only ever aggregated into usage_counters, so you could see the month's
-- total and never which conversation caused it.
--
-- cache_write_tokens matters because cache writes bill at 1.25x input. A
-- cost model that ignores them under-reports every first turn.
-- ------------------------------------------------------------
alter table messages add column if not exists cost_minor         bigint not null default 0;
alter table messages add column if not exists cache_write_tokens int;

-- Outbound sends that Meta rejected. Previously these vanished into a
-- console.warn, so a conversation could go silent with nothing in the
-- transcript explaining why.
alter table messages add column if not exists send_error text;

-- ------------------------------------------------------------
-- usage_counters — overage
-- ------------------------------------------------------------
alter table usage_counters add column if not exists overage_replies int not null default 0;

-- ------------------------------------------------------------
-- products — a stable identity for re-running the seed
--
-- scripts/seed.ts used to delete every product and re-insert. order_items
-- references products ON DELETE RESTRICT, so that delete fails the moment a
-- single order exists — the seed worked exactly until the pilot had its
-- first sale, then broke permanently.
--
-- This gives products a natural key so the seed can upsert instead.
-- `nulls not distinct` (Postgres 15+) is what makes variant_label work as
-- part of the key: without it, every NULL variant is treated as unique and
-- the constraint never fires for unvarianted products.
-- ------------------------------------------------------------
create unique index if not exists products_identity_idx
  on products (merchant_id, name, variant_label) nulls not distinct;
