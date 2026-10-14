-- ============================================================
-- WhatsApp AI Commerce Agent — backend.sql
-- Run this SECOND, after schema.sql.
-- Every function here is the reason the AI can't be talked into
-- a wrong price or a phantom order.
-- ============================================================

-- ------------------------------------------------------------
-- touch_updated_at
-- ------------------------------------------------------------
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists merchants_touch on merchants;
create trigger merchants_touch before update on merchants
  for each row execute function touch_updated_at();

drop trigger if exists products_touch on products;
create trigger products_touch before update on products
  for each row execute function touch_updated_at();

drop trigger if exists orders_touch on orders;
create trigger orders_touch before update on orders
  for each row execute function touch_updated_at();

-- ------------------------------------------------------------
-- upsert_customer_conversation
-- Called on every inbound message. Creates the customer and the
-- open conversation if needed, and rolls the 24h service window
-- forward — this is what decides free-form reply vs template.
-- ------------------------------------------------------------
create or replace function upsert_customer_conversation(
  p_merchant_id uuid,
  p_wa_phone    text,
  p_name        text default null
)
returns table (out_customer_id uuid, out_conversation_id uuid, out_window_expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_customer uuid;
  v_convo    uuid;
  v_expires  timestamptz := now() + interval '24 hours';
begin
  insert into customers (merchant_id, wa_phone, name)
  values (p_merchant_id, p_wa_phone, p_name)
  on conflict (merchant_id, wa_phone) do update
    set last_seen_at = now(),
        name = coalesce(customers.name, excluded.name)
  returning customers.id into v_customer;

  select c.id into v_convo
  from conversations c
  where c.merchant_id = p_merchant_id
    and c.customer_id = v_customer
    and c.status <> 'closed'
  limit 1;

  if v_convo is null then
    insert into conversations (merchant_id, customer_id, window_expires_at, last_message_at)
    values (p_merchant_id, v_customer, v_expires, now())
    returning conversations.id into v_convo;
  else
    update conversations
      set window_expires_at = v_expires,
          last_message_at = now()
    where conversations.id = v_convo;
  end if;

  return query select v_customer, v_convo, v_expires;
end $$;

-- ------------------------------------------------------------
-- search_catalogue
-- The AI's only route to product data. Returns prices from the DB,
-- so the model can never invent or negotiate one.
-- ------------------------------------------------------------
create or replace function search_catalogue(
  p_merchant_id uuid,
  p_query       text default null,
  p_category    text default null,
  p_in_stock    boolean default false,
  p_limit       int default 12
)
returns table (
  id uuid, name text, variant_label text, category text,
  price_minor bigint, stock int, track_stock boolean, description text
)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.variant_label, p.category,
         p.price_minor, p.stock, p.track_stock, p.description
  from products p
  where p.merchant_id = p_merchant_id
    and p.is_active
    and (p_category is null or p.category ilike p_category)
    and (not p_in_stock or not p.track_stock or p.stock > 0)
    and (
      p_query is null
      or p.name ilike '%' || p_query || '%'
      or p.category ilike '%' || p_query || '%'
      or p.variant_label ilike '%' || p_query || '%'
      or to_tsvector('simple', coalesce(p.name,'') || ' ' || coalesce(p.category,'') || ' ' || coalesce(p.variant_label,''))
         @@ plainto_tsquery('simple', p_query)
    )
  order by (p.track_stock and p.stock = 0), p.name
  limit least(p_limit, 25);
$$;

-- ------------------------------------------------------------
-- place_order
-- Single transaction: validates products belong to this merchant,
-- checks stock, computes every total server-side, decrements stock.
-- Items come in as [{"product_id":"...","quantity":2}, ...].
-- Any price the model "remembers" is ignored.
-- ------------------------------------------------------------
create or replace function place_order(
  p_merchant_id     uuid,
  p_customer_id     uuid,
  p_conversation_id uuid,
  p_items           jsonb,
  p_address         text default null,
  p_notes           text default null
)
returns table (out_order_id uuid, out_subtotal_minor bigint, out_delivery_minor bigint, out_total_minor bigint)
language plpgsql security definer set search_path = public as $$
declare
  v_order     uuid;
  v_subtotal  bigint := 0;
  v_delivery  bigint;
  v_currency  currency_code;
  v_item      jsonb;
  v_product   products%rowtype;
  v_qty       int;
  v_line      bigint;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'ORDER_EMPTY';
  end if;

  select currency, delivery_fee_minor into v_currency, v_delivery
  from merchants where id = p_merchant_id;

  if v_currency is null then
    raise exception 'MERCHANT_NOT_FOUND';
  end if;

  insert into orders (merchant_id, customer_id, conversation_id, status, currency, delivery_address, notes)
  values (p_merchant_id, p_customer_id, p_conversation_id, 'pending_payment', v_currency, p_address, p_notes)
  returning id into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := greatest((v_item->>'quantity')::int, 1);

    -- lock the row so two concurrent orders can't oversell the same unit
    select * into v_product
    from products
    where id = (v_item->>'product_id')::uuid
      and merchant_id = p_merchant_id
      and is_active
    for update;

    if v_product.id is null then
      raise exception 'PRODUCT_NOT_FOUND:%', v_item->>'product_id';
    end if;

    if v_product.track_stock and v_product.stock < v_qty then
      raise exception 'INSUFFICIENT_STOCK:%:%', v_product.name, v_product.stock;
    end if;

    v_line := v_product.price_minor * v_qty;
    v_subtotal := v_subtotal + v_line;

    insert into order_items (order_id, product_id, product_name, quantity, unit_price_minor, line_total_minor)
    values (v_order, v_product.id,
            trim(v_product.name || ' ' || coalesce(v_product.variant_label, '')),
            v_qty, v_product.price_minor, v_line);

    if v_product.track_stock then
      update products set stock = stock - v_qty where id = v_product.id;
    end if;
  end loop;

  update orders
    set subtotal_minor = v_subtotal,
        delivery_minor = coalesce(v_delivery, 0),
        total_minor    = v_subtotal + coalesce(v_delivery, 0)
  where orders.id = v_order;

  return query
    select v_order, v_subtotal, coalesce(v_delivery,0), v_subtotal + coalesce(v_delivery,0);
end $$;

-- ------------------------------------------------------------
-- register_stock_alert
-- ------------------------------------------------------------
create or replace function register_stock_alert(
  p_merchant_id uuid,
  p_customer_id uuid,
  p_product_id  uuid
)
returns void language sql security definer set search_path = public as $$
  insert into stock_alerts (merchant_id, customer_id, product_id)
  values (p_merchant_id, p_customer_id, p_product_id)
  on conflict (customer_id, product_id) do update set notified_at = null;
$$;

-- ------------------------------------------------------------
-- bump_usage
-- Called after every AI reply. This is your margin dashboard and
-- the basis for overage billing past the 1,500-reply cap.
-- ------------------------------------------------------------
create or replace function bump_usage(
  p_merchant_id      uuid,
  p_ai_replies       int default 0,
  p_service_messages int default 0,
  p_template_messages int default 0,
  p_ai_cost_minor    bigint default 0
)
returns table (out_ai_replies int, out_reply_cap int, out_over_cap boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', now())::date;
  v_replies int;
  v_cap int;
begin
  insert into usage_counters (merchant_id, period_month, ai_replies, service_messages, template_messages, ai_cost_minor)
  values (p_merchant_id, v_month, p_ai_replies, p_service_messages, p_template_messages, p_ai_cost_minor)
  on conflict (merchant_id, period_month) do update
    set ai_replies        = usage_counters.ai_replies + excluded.ai_replies,
        service_messages  = usage_counters.service_messages + excluded.service_messages,
        template_messages = usage_counters.template_messages + excluded.template_messages,
        ai_cost_minor     = usage_counters.ai_cost_minor + excluded.ai_cost_minor
  returning usage_counters.ai_replies into v_replies;

  select m.plan_reply_cap into v_cap from merchants m where m.id = p_merchant_id;

  return query select v_replies, v_cap, v_replies > v_cap;
end $$;

-- ------------------------------------------------------------
-- escalate_conversation
-- ------------------------------------------------------------
create or replace function escalate_conversation(
  p_conversation_id uuid,
  p_reason          text
)
returns void language sql security definer set search_path = public as $$
  update conversations
    set status = 'escalated',
        escalated_at = now(),
        escalation_reason = p_reason
  where id = p_conversation_id;
$$;

-- ------------------------------------------------------------
-- pending_stock_alerts — for the restock notifier job
-- ------------------------------------------------------------
create or replace function pending_stock_alerts(p_merchant_id uuid default null)
returns table (
  alert_id uuid, merchant_id uuid, wa_phone text, customer_name text,
  product_name text, price_minor bigint, wa_phone_number_id text
)
language sql stable security definer set search_path = public as $$
  select sa.id, sa.merchant_id, c.wa_phone, c.name,
         trim(p.name || ' ' || coalesce(p.variant_label,'')),
         p.price_minor, m.wa_phone_number_id
  from stock_alerts sa
  join products p  on p.id = sa.product_id
  join customers c on c.id = sa.customer_id
  join merchants m on m.id = sa.merchant_id
  where sa.notified_at is null
    and p.is_active
    and p.stock > 0
    and m.is_active
    and (p_merchant_id is null or sa.merchant_id = p_merchant_id);
$$;

-- ============================================================
-- v2 additions. Re-runnable — every function is create-or-replace.
-- Run AFTER re-running schema.sql.
-- ============================================================

-- ------------------------------------------------------------
-- upsert_customer_conversation — race-safe replacement
--
-- The original did select-then-insert. Two messages from the same customer
-- arriving together (a common WhatsApp pattern — people send three lines as
-- three separate messages) both saw no conversation and both inserted, and
-- the second died on the conversations_active_idx unique index. That
-- exception aborted the whole webhook handler, so the customer got no reply.
--
-- Now the insert races deliberately and catches the conflict.
-- ------------------------------------------------------------
create or replace function upsert_customer_conversation(
  p_merchant_id uuid,
  p_wa_phone    text,
  p_name        text default null
)
returns table (out_customer_id uuid, out_conversation_id uuid, out_window_expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_customer uuid;
  v_convo    uuid;
  v_expires  timestamptz := now() + interval '24 hours';
begin
  insert into customers (merchant_id, wa_phone, name)
  values (p_merchant_id, p_wa_phone, p_name)
  on conflict (merchant_id, wa_phone) do update
    set last_seen_at = now(),
        name = coalesce(customers.name, excluded.name)
  returning customers.id into v_customer;

  -- Claim an existing open thread first.
  update conversations
    set window_expires_at = v_expires,
        last_message_at   = now()
  where merchant_id = p_merchant_id
    and customer_id = v_customer
    and status <> 'closed'
  returning conversations.id into v_convo;

  if v_convo is null then
    begin
      insert into conversations (merchant_id, customer_id, window_expires_at, last_message_at)
      values (p_merchant_id, v_customer, v_expires, now())
      returning conversations.id into v_convo;
    exception when unique_violation then
      -- A concurrent message won the race. Use the row it created.
      select c.id into v_convo
      from conversations c
      where c.merchant_id = p_merchant_id
        and c.customer_id = v_customer
        and c.status <> 'closed'
      limit 1;
    end;
  end if;

  return query select v_customer, v_convo, v_expires;
end $$;

-- ------------------------------------------------------------
-- recent_inbound_count — the abuse throttle
--
-- One customer must not be able to cause unbounded Anthropic spend. This is
-- counted in the database rather than in memory because serverless functions
-- do not share memory between invocations — an in-process counter resets on
-- every cold start, which is exactly when a flood arrives.
-- ------------------------------------------------------------
create or replace function recent_inbound_count(
  p_conversation_id uuid,
  p_seconds         int default 120
)
returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int
  from messages
  where conversation_id = p_conversation_id
    and direction = 'inbound'
    and created_at > now() - make_interval(secs => p_seconds);
$$;

-- ------------------------------------------------------------
-- conversation_model — sticky model routing
--
-- Returns the model that last answered in this thread. Once a conversation
-- has needed Sonnet it stays there: threads that got complicated rarely get
-- simple again, and the prompt cache is scoped per model, so alternating
-- between models writes a fresh cache entry on every switch and reads neither.
-- ------------------------------------------------------------
create or replace function conversation_model(p_conversation_id uuid)
returns text
language sql stable security definer set search_path = public as $$
  select m.model
  from messages m
  where m.conversation_id = p_conversation_id
    and m.direction = 'outbound'
    and m.model is not null
  order by m.created_at desc
  limit 1;
$$;

-- ------------------------------------------------------------
-- order_summary — one order with its lines, as json
--
-- Used by the owner console over WhatsApp and by the dashboard. Returns json
-- rather than a rowset so the caller gets the order and its items in one
-- round trip instead of two.
-- ------------------------------------------------------------
create or replace function order_summary(p_order_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id',               o.id,
    'status',           o.status,
    'subtotal_minor',   o.subtotal_minor,
    'delivery_minor',   o.delivery_minor,
    'total_minor',      o.total_minor,
    'currency',         o.currency,
    'delivery_address', o.delivery_address,
    'notes',            o.notes,
    'created_at',       o.created_at,
    'paid_at',          o.paid_at,
    'fulfilled_at',     o.fulfilled_at,
    'cancelled_at',     o.cancelled_at,
    'customer_name',    c.name,
    'customer_phone',   c.wa_phone,
    'merchant_id',      o.merchant_id,
    'conversation_id',  o.conversation_id,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_name',     oi.product_name,
        'quantity',         oi.quantity,
        'unit_price_minor', oi.unit_price_minor,
        'line_total_minor', oi.line_total_minor
      ) order by oi.product_name)
      from order_items oi where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from orders o
  join customers c on c.id = o.customer_id
  where o.id = p_order_id;
$$;

-- ------------------------------------------------------------
-- find_order — resolve the 6-char reference the owner types
--
-- Owners will not type a uuid into WhatsApp. place_order reads back a short
-- reference (first 6 hex chars, uppercased) and this resolves it, scoped to
-- the merchant so one merchant can never reach another's order.
--
-- Ambiguity is an error, not a guess: a 6-hex-char collision needs roughly
-- 4,000 orders, but picking the wrong one would mean cancelling a stranger's
-- order, so it refuses instead.
-- ------------------------------------------------------------
create or replace function find_order(p_merchant_id uuid, p_ref text)
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_ids uuid[];
begin
  select array_agg(o.id) into v_ids
  from orders o
  where o.merchant_id = p_merchant_id
    and upper(left(replace(o.id::text, '-', ''), 6)) = upper(trim(p_ref));

  if v_ids is null or array_length(v_ids, 1) = 0 then
    return null;
  end if;

  if array_length(v_ids, 1) > 1 then
    raise exception 'ORDER_REF_AMBIGUOUS:%', p_ref;
  end if;

  return v_ids[1];
end $$;

-- ------------------------------------------------------------
-- set_order_status — the only way an order changes state
--
-- Guards the transitions and writes the audit row in the same transaction.
-- Cancelling restores stock; that restore is the reason this is a function
-- and not an UPDATE from the application.
--
-- Stock is decremented by place_order at status pending_payment. Before this
-- existed, an order the customer never paid for held that stock forever — the
-- item stayed unsellable and its restock alert never fired.
-- ------------------------------------------------------------
create or replace function set_order_status(
  p_merchant_id uuid,
  p_order_id    uuid,
  p_status      order_status,
  p_actor       text default 'owner',
  p_note        text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order  orders%rowtype;
  v_item   order_items%rowtype;
begin
  select * into v_order
  from orders
  where id = p_order_id and merchant_id = p_merchant_id
  for update;

  if v_order.id is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_order.status = p_status then
    return order_summary(p_order_id);           -- idempotent, not an error
  end if;

  -- Terminal states stay terminal. Re-opening a cancelled order would need
  -- its stock re-decremented, and that stock may since have been sold.
  if v_order.status in ('fulfilled', 'cancelled') then
    raise exception 'ORDER_TERMINAL:%', v_order.status;
  end if;

  if p_status = 'cancelled' then
    -- Put every tracked unit back before flipping the status.
    for v_item in select * from order_items where order_id = p_order_id loop
      update products
        set stock = stock + v_item.quantity
      where id = v_item.product_id and track_stock;
    end loop;

    update orders
      set status = 'cancelled',
          cancelled_at = now(),
          cancel_reason = p_note
    where id = p_order_id;

  elsif p_status = 'confirmed' then
    update orders set status = 'confirmed', paid_at = coalesce(paid_at, now())
    where id = p_order_id;

  elsif p_status = 'fulfilled' then
    update orders set status = 'fulfilled', fulfilled_at = now()
    where id = p_order_id;

  else
    update orders set status = p_status where id = p_order_id;
  end if;

  insert into order_events (order_id, merchant_id, from_status, to_status, actor, note)
  values (p_order_id, p_merchant_id, v_order.status, p_status, p_actor, p_note);

  return order_summary(p_order_id);
end $$;

-- ------------------------------------------------------------
-- unnotified_orders — what the owner has not been told about
--
-- place_order creates the order inside the customer conversation. Nothing in
-- v1 ever told the business owner it existed, so a sale could complete and
-- then sit unseen. This drives the notification.
-- ------------------------------------------------------------
create or replace function unnotified_orders(p_merchant_id uuid default null)
returns table (out_order_id uuid, out_merchant_id uuid)
language sql stable security definer set search_path = public as $$
  select o.id, o.merchant_id
  from orders o
  join merchants m on m.id = o.merchant_id
  where o.owner_notified_at is null
    and o.status <> 'draft'
    and m.is_active
    and m.owner_notify
    and m.escalation_number is not null
    and (p_merchant_id is null or o.merchant_id = p_merchant_id)
  order by o.created_at
  limit 100;
$$;

create or replace function mark_order_notified(p_order_id uuid)
returns void language sql security definer set search_path = public as $$
  update orders set owner_notified_at = now() where id = p_order_id;
$$;

-- ------------------------------------------------------------
-- recent_orders — owner console and dashboard listing
-- ------------------------------------------------------------
create or replace function recent_orders(
  p_merchant_id uuid,
  p_status      order_status default null,
  p_limit       int default 10
)
returns table (
  id uuid, status order_status, total_minor bigint, currency currency_code,
  customer_name text, customer_phone text, created_at timestamptz, item_count int
)
language sql stable security definer set search_path = public as $$
  select o.id, o.status, o.total_minor, o.currency,
         c.name, c.wa_phone, o.created_at,
         (select count(*)::int from order_items oi where oi.order_id = o.id)
  from orders o
  join customers c on c.id = o.customer_id
  where o.merchant_id = p_merchant_id
    and (p_status is null or o.status = p_status)
  order by o.created_at desc
  limit least(p_limit, 50);
$$;

-- ------------------------------------------------------------
-- set_product_stock — owner restocking
--
-- Raising stock above zero is what makes pending_stock_alerts return rows, so
-- this is the trigger for the whole restock-notification feature. Scoped by
-- merchant_id so the owner console can never touch another tenant's product.
-- ------------------------------------------------------------
create or replace function set_product_stock(
  p_merchant_id uuid,
  p_product_id  uuid,
  p_stock       int
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_product products%rowtype;
begin
  if p_stock < 0 then
    raise exception 'STOCK_NEGATIVE';
  end if;

  update products
    set stock = p_stock, track_stock = true
  where id = p_product_id and merchant_id = p_merchant_id
  returning * into v_product;

  if v_product.id is null then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'id', v_product.id,
    'name', trim(v_product.name || ' ' || coalesce(v_product.variant_label, '')),
    'stock', v_product.stock,
    'price_minor', v_product.price_minor
  );
end $$;

-- ------------------------------------------------------------
-- resume_conversation / close_conversation
--
-- escalate_conversation could set status = 'escalated' but nothing could ever
-- unset it. Once the bot handed a thread to the owner it went permanently
-- mute for that customer, even weeks later on a brand new question.
-- ------------------------------------------------------------
create or replace function resume_conversation(
  p_merchant_id uuid,
  p_conversation_id uuid
)
returns void language sql security definer set search_path = public as $$
  update conversations
    set status = 'open',
        resumed_at = now(),
        escalated_at = null,
        escalation_reason = null
  where id = p_conversation_id and merchant_id = p_merchant_id;
$$;

create or replace function close_conversation(
  p_merchant_id uuid,
  p_conversation_id uuid
)
returns void language sql security definer set search_path = public as $$
  update conversations
    set status = 'closed'
  where id = p_conversation_id and merchant_id = p_merchant_id;
$$;

-- ------------------------------------------------------------
-- conversation_by_phone — the owner types a phone number, not a uuid
-- ------------------------------------------------------------
create or replace function conversation_by_phone(
  p_merchant_id uuid,
  p_wa_phone    text
)
returns table (
  out_conversation_id uuid, out_customer_id uuid,
  out_status conversation_status, out_customer_name text
)
language sql stable security definer set search_path = public as $$
  select c.id, c.customer_id, c.status, cu.name
  from conversations c
  join customers cu on cu.id = c.customer_id
  where c.merchant_id = p_merchant_id
    -- Match on digits only: owners type +234..., 234..., or 0803... for the
    -- same person, and WhatsApp stores one canonical form.
    and regexp_replace(cu.wa_phone, '\D', '', 'g')
        like '%' || regexp_replace(p_wa_phone, '\D', '', 'g')
  order by c.last_message_at desc
  limit 1;
$$;

-- ------------------------------------------------------------
-- bump_usage — now records overage separately
--
-- The plan is 1,500 replies for NGN 35,000, then overage_price_minor per
-- reply. v1 returned out_over_cap and no caller read it, so overage was
-- invisible and unbillable. This counts the replies past the cap as they
-- happen, and out_first_over_cap fires exactly once per month so the owner
-- gets one warning rather than one per message.
-- ------------------------------------------------------------
--
-- v1 returned three columns; this returns five. `create or replace` cannot
-- change a function s return type, so the old definition must be dropped
-- first. Without this drop the script aborts HERE on a fresh database, and
-- every statement below it -- the dashboard RPCs, can_access_merchant, and
-- all of the grants -- is never created.
-- ------------------------------------------------------------
drop function if exists bump_usage(uuid, int, int, int, bigint);

create or replace function bump_usage(
  p_merchant_id      uuid,
  p_ai_replies       int default 0,
  p_service_messages int default 0,
  p_template_messages int default 0,
  p_ai_cost_minor    bigint default 0
)
returns table (
  out_ai_replies int, out_reply_cap int, out_over_cap boolean,
  out_overage_replies int, out_first_over_cap boolean
)
language plpgsql security definer set search_path = public as $$
declare
  v_month     date := date_trunc('month', now())::date;
  v_replies   int;
  v_cap       int;
  v_before    int;
  v_overage   int;
  v_notified  date;
  v_first     boolean := false;
begin
  select m.plan_reply_cap, m.cap_notified_month into v_cap, v_notified
  from merchants m where m.id = p_merchant_id;

  if v_cap is null then
    raise exception 'MERCHANT_NOT_FOUND';
  end if;

  select coalesce(u.ai_replies, 0) into v_before
  from usage_counters u
  where u.merchant_id = p_merchant_id and u.period_month = v_month;

  v_before := coalesce(v_before, 0);

  -- Replies in THIS call that land past the cap.
  v_overage := greatest((v_before + p_ai_replies) - greatest(v_cap, 0), 0)
             - greatest(v_before - greatest(v_cap, 0), 0);

  insert into usage_counters (
    merchant_id, period_month, ai_replies, service_messages,
    template_messages, ai_cost_minor, overage_replies
  )
  values (
    p_merchant_id, v_month, p_ai_replies, p_service_messages,
    p_template_messages, p_ai_cost_minor, v_overage
  )
  on conflict (merchant_id, period_month) do update
    set ai_replies        = usage_counters.ai_replies + excluded.ai_replies,
        service_messages  = usage_counters.service_messages + excluded.service_messages,
        template_messages = usage_counters.template_messages + excluded.template_messages,
        ai_cost_minor     = usage_counters.ai_cost_minor + excluded.ai_cost_minor,
        overage_replies   = usage_counters.overage_replies + excluded.overage_replies
  returning usage_counters.ai_replies, usage_counters.overage_replies
  into v_replies, v_overage;

  -- Warn the owner once per month, not once per reply.
  if v_replies > v_cap and (v_notified is distinct from v_month) then
    update merchants set cap_notified_month = v_month where id = p_merchant_id;
    v_first := true;
  end if;

  return query select v_replies, v_cap, v_replies > v_cap, v_overage, v_first;
end $$;

-- ------------------------------------------------------------
-- merchant_usage — current month, for the owner console and dashboard
-- ------------------------------------------------------------
create or replace function merchant_usage(p_merchant_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'period_month',       to_char(date_trunc('month', now()), 'YYYY-MM'),
    'ai_replies',         coalesce(u.ai_replies, 0),
    'service_messages',   coalesce(u.service_messages, 0),
    'template_messages',  coalesce(u.template_messages, 0),
    'ai_cost_minor',      coalesce(u.ai_cost_minor, 0),
    'overage_replies',    coalesce(u.overage_replies, 0),
    'reply_cap',          m.plan_reply_cap,
    'plan_price_minor',   m.plan_price_minor,
    'overage_price_minor', m.overage_price_minor,
    'currency',           m.currency
  )
  from merchants m
  left join usage_counters u
    on u.merchant_id = m.id
   and u.period_month = date_trunc('month', now())::date
  where m.id = p_merchant_id;
$$;

-- ------------------------------------------------------------
-- dashboard_overview — every headline number in one round trip
--
-- The dashboard is a browser client going through RLS. Doing this as six
-- separate selects would be six round trips on every page load; as one
-- security-definer function scoped by owns_merchant it is one.
-- ------------------------------------------------------------
create or replace function dashboard_overview(p_merchant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  -- security definer bypasses RLS, so the ownership check must be explicit.
  if not can_access_merchant(p_merchant_id) then
    raise exception 'FORBIDDEN';
  end if;

  select jsonb_build_object(
    'usage', merchant_usage(p_merchant_id),

    'open_conversations', (
      select count(*) from conversations
      where merchant_id = p_merchant_id and status = 'open'
    ),
    'escalated_conversations', (
      select count(*) from conversations
      where merchant_id = p_merchant_id and status = 'escalated'
    ),
    'messages_today', (
      select count(*) from messages
      where merchant_id = p_merchant_id and created_at >= date_trunc('day', now())
    ),
    'orders_pending', (
      select count(*) from orders
      where merchant_id = p_merchant_id and status = 'pending_payment'
    ),
    'revenue_month_minor', (
      select coalesce(sum(total_minor), 0) from orders
      where merchant_id = p_merchant_id
        and status in ('confirmed', 'fulfilled')
        and created_at >= date_trunc('month', now())
    ),
    'out_of_stock', (
      select count(*) from products
      where merchant_id = p_merchant_id and is_active and track_stock and stock = 0
    ),
    'pending_alerts', (
      select count(*) from stock_alerts sa
      join products p on p.id = sa.product_id
      where sa.merchant_id = p_merchant_id and sa.notified_at is null and p.stock > 0
    )
  ) into v_result;

  return v_result;
end $$;

-- ------------------------------------------------------------
-- my_merchant — which merchant is the logged-in dashboard user?
--
-- Called by the browser client with the anon key + the user's JWT, so
-- auth.uid() is the logged-in owner.
-- ------------------------------------------------------------
create or replace function my_merchant()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', m.id, 'name', m.name, 'slug', m.slug, 'currency', m.currency,
    'timezone', m.timezone, 'wa_display_number', m.wa_display_number,
    'escalation_number', m.escalation_number, 'greeting', m.greeting,
    'ai_tone', m.ai_tone, 'business_hours', m.business_hours,
    'delivery_fee_minor', m.delivery_fee_minor, 'owner_notify', m.owner_notify,
    'plan_reply_cap', m.plan_reply_cap, 'is_active', m.is_active
  )
  from merchants m
  where m.owner_id = auth.uid()
  order by m.created_at
  limit 1;
$$;

-- ------------------------------------------------------------
-- conversation_transcript — one thread for the dashboard
-- ------------------------------------------------------------
create or replace function conversation_transcript(
  p_conversation_id uuid,
  p_limit           int default 200
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_merchant uuid;
  v_result   jsonb;
begin
  select merchant_id into v_merchant from conversations where id = p_conversation_id;

  if v_merchant is null then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;
  if not can_access_merchant(v_merchant) then
    raise exception 'FORBIDDEN';
  end if;

  select jsonb_build_object(
    'conversation', (
      select jsonb_build_object(
        'id', c.id, 'status', c.status,
        'window_expires_at', c.window_expires_at,
        'escalated_at', c.escalated_at,
        'escalation_reason', c.escalation_reason,
        'last_message_at', c.last_message_at,
        'customer_name', cu.name, 'customer_phone', cu.wa_phone
      )
      from conversations c join customers cu on cu.id = c.customer_id
      where c.id = p_conversation_id
    ),
    'messages', coalesce((
      -- `x` is a COLUMN of `sub`, not a table, so it has to be qualified
      -- through `sub`. Written as `x.created_at` this raised "missing
      -- FROM-clause entry for table x" on every call. plpgsql doesn't resolve
      -- names until the function runs, so creating it succeeded and the bug
      -- only appeared the first time someone opened a conversation.
      select jsonb_agg(sub.x order by sub.created_at)
      from (
        select jsonb_build_object(
          'id', m.id, 'direction', m.direction, 'body', m.body,
          'media_type', m.media_type, 'model', m.model,
          'cost_minor', m.cost_minor, 'send_error', m.send_error,
          'created_at', m.created_at
        ) as x, m.created_at
        from messages m
        where m.conversation_id = p_conversation_id
        order by m.created_at desc
        limit least(p_limit, 500)
      ) sub
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end $$;

-- ------------------------------------------------------------
-- conversation_list — dashboard inbox
-- ------------------------------------------------------------
create or replace function conversation_list(
  p_merchant_id uuid,
  p_status      conversation_status default null,
  p_limit       int default 50
)
returns table (
  id uuid, status conversation_status, customer_name text, customer_phone text,
  last_message_at timestamptz, window_expires_at timestamptz,
  escalation_reason text, last_body text, message_count int
)
language sql stable security definer set search_path = public as $$
  select c.id, c.status, cu.name, cu.wa_phone,
         c.last_message_at, c.window_expires_at, c.escalation_reason,
         (select m.body from messages m
           where m.conversation_id = c.id and m.body is not null
           order by m.created_at desc limit 1),
         (select count(*)::int from messages m where m.conversation_id = c.id)
  from conversations c
  join customers cu on cu.id = c.customer_id
  where c.merchant_id = p_merchant_id
    and (p_status is null or c.status = p_status)
  order by c.last_message_at desc
  limit least(p_limit, 200);
$$;

-- ------------------------------------------------------------
-- pending_stock_alerts — now carries the merchant's currency
--
-- The restock job formatted every price with a hardcoded ₦. A GHS merchant's
-- customers were quoted naira amounts inside an approved marketing template —
-- the most expensive message type there is, and unfixable after send.
--
-- `create or replace` cannot change a function's return type, and this adds
-- two columns to the returns table, so the old one has to go first.
-- ------------------------------------------------------------
drop function if exists pending_stock_alerts(uuid);

create or replace function pending_stock_alerts(p_merchant_id uuid default null)
returns table (
  alert_id uuid, merchant_id uuid, wa_phone text, customer_name text,
  product_name text, price_minor bigint, wa_phone_number_id text,
  currency currency_code, merchant_name text
)
language sql stable security definer set search_path = public as $$
  select sa.id, sa.merchant_id, c.wa_phone, c.name,
         trim(p.name || ' ' || coalesce(p.variant_label,'')),
         p.price_minor, m.wa_phone_number_id,
         m.currency, m.name
  from stock_alerts sa
  join products p  on p.id = sa.product_id
  join customers c on c.id = sa.customer_id
  join merchants m on m.id = sa.merchant_id
  where sa.notified_at is null
    and p.is_active
    and p.stock > 0
    and m.is_active
    and m.wa_phone_number_id is not null
    and (p_merchant_id is null or sa.merchant_id = p_merchant_id)
  -- Oldest request first: whoever has been waiting longest gets told first
  -- when a restock is smaller than the queue of people waiting for it.
  order by sa.created_at;
$$;

-- ============================================================
-- Tenant isolation for the RPC surface.
--
-- THE PROBLEM
--
-- Every function above is `security definer`, which means it runs with the
-- definer's rights and RLS does not apply inside it. That is necessary: the
-- webhook has no logged-in user, so policies keyed on auth.uid() would block
-- it entirely.
--
-- But `security definer` plus a caller-supplied p_merchant_id is a hole. The
-- dashboard calls these from the browser with the anon key, and Supabase
-- exposes every function over PostgREST. So any logged-in merchant could
-- call, say:
--
--     supabase.rpc('conversation_list', { p_merchant_id: <someone else's id> })
--
-- and read another business's customer conversations. The RLS policies in
-- schema.sql do not help here — the function bypasses them by design.
--
-- THE FIX, in two layers:
--
--  1. can_access_merchant() — an explicit ownership check inside every
--     function the browser is allowed to call.
--  2. REVOKE on everything the browser has no business calling at all, so a
--     function that never gets a guard still isn't reachable from a browser.
--
-- Layer 2 alone would be enough today. Layer 1 is there because the next
-- function someone adds will be granted to `authenticated` by default, and a
-- guard that is the house style is more likely to be copied than a GRANT
-- statement at the bottom of a file.
-- ============================================================

-- ------------------------------------------------------------
-- can_access_merchant
--
-- True for the service role (the webhook and cron, which have no auth.uid())
-- and for the merchant's own logged-in owner. False for everyone else,
-- including a different logged-in merchant.
-- ------------------------------------------------------------
create or replace function can_access_merchant(m uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select
    -- The service role key. It already bypasses RLS everywhere else; these
    -- functions are the trusted server path.
    --
    -- nullif guards the cast: outside a PostgREST request this setting is
    -- unset (null, fine) but in some contexts it is the empty string, and
    -- ''::jsonb raises — which would break every call rather than deny it.
    coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      ''
    ) = 'service_role'
    or coalesce(auth.role(), '') = 'service_role'
    or exists (select 1 from merchants where id = m and owner_id = auth.uid());
$$;

-- ------------------------------------------------------------
-- Guarded reads
--
-- These return no rows rather than raising: a read for a merchant you don't
-- own is indistinguishable from a merchant with no rows, which leaks less
-- than an error that confirms the id exists.
-- ------------------------------------------------------------

create or replace function conversation_list(
  p_merchant_id uuid,
  p_status      conversation_status default null,
  p_limit       int default 50
)
returns table (
  id uuid, status conversation_status, customer_name text, customer_phone text,
  last_message_at timestamptz, window_expires_at timestamptz,
  escalation_reason text, last_body text, message_count int
)
language sql stable security definer set search_path = public as $$
  select c.id, c.status, cu.name, cu.wa_phone,
         c.last_message_at, c.window_expires_at, c.escalation_reason,
         (select m.body from messages m
           where m.conversation_id = c.id and m.body is not null
           order by m.created_at desc limit 1),
         (select count(*)::int from messages m where m.conversation_id = c.id)
  from conversations c
  join customers cu on cu.id = c.customer_id
  where c.merchant_id = p_merchant_id
    and can_access_merchant(p_merchant_id)
    and (p_status is null or c.status = p_status)
  order by c.last_message_at desc
  limit least(p_limit, 200);
$$;

create or replace function recent_orders(
  p_merchant_id uuid,
  p_status      order_status default null,
  p_limit       int default 10
)
returns table (
  id uuid, status order_status, total_minor bigint, currency currency_code,
  customer_name text, customer_phone text, created_at timestamptz, item_count int
)
language sql stable security definer set search_path = public as $$
  select o.id, o.status, o.total_minor, o.currency,
         c.name, c.wa_phone, o.created_at,
         (select count(*)::int from order_items oi where oi.order_id = o.id)
  from orders o
  join customers c on c.id = o.customer_id
  where o.merchant_id = p_merchant_id
    and can_access_merchant(p_merchant_id)
    and (p_status is null or o.status = p_status)
  order by o.created_at desc
  limit least(p_limit, 50);
$$;

create or replace function order_summary(p_order_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id',               o.id,
    'status',           o.status,
    'subtotal_minor',   o.subtotal_minor,
    'delivery_minor',   o.delivery_minor,
    'total_minor',      o.total_minor,
    'currency',         o.currency,
    'delivery_address', o.delivery_address,
    'notes',            o.notes,
    'created_at',       o.created_at,
    'paid_at',          o.paid_at,
    'fulfilled_at',     o.fulfilled_at,
    'cancelled_at',     o.cancelled_at,
    'customer_name',    c.name,
    'customer_phone',   c.wa_phone,
    'merchant_id',      o.merchant_id,
    'conversation_id',  o.conversation_id,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_name',     oi.product_name,
        'quantity',         oi.quantity,
        'unit_price_minor', oi.unit_price_minor,
        'line_total_minor', oi.line_total_minor
      ) order by oi.product_name)
      from order_items oi where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from orders o
  join customers c on c.id = o.customer_id
  where o.id = p_order_id
    and can_access_merchant(o.merchant_id);
$$;

create or replace function merchant_usage(p_merchant_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'period_month',       to_char(date_trunc('month', now()), 'YYYY-MM'),
    'ai_replies',         coalesce(u.ai_replies, 0),
    'service_messages',   coalesce(u.service_messages, 0),
    'template_messages',  coalesce(u.template_messages, 0),
    'ai_cost_minor',      coalesce(u.ai_cost_minor, 0),
    'overage_replies',    coalesce(u.overage_replies, 0),
    'reply_cap',          m.plan_reply_cap,
    'plan_price_minor',   m.plan_price_minor,
    'overage_price_minor', m.overage_price_minor,
    'currency',           m.currency
  )
  from merchants m
  left join usage_counters u
    on u.merchant_id = m.id
   and u.period_month = date_trunc('month', now())::date
  where m.id = p_merchant_id
    and can_access_merchant(p_merchant_id);
$$;

create or replace function search_catalogue(
  p_merchant_id uuid,
  p_query       text default null,
  p_category    text default null,
  p_in_stock    boolean default false,
  p_limit       int default 12
)
returns table (
  id uuid, name text, variant_label text, category text,
  price_minor bigint, stock int, track_stock boolean, description text
)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.variant_label, p.category,
         p.price_minor, p.stock, p.track_stock, p.description
  from products p
  where p.merchant_id = p_merchant_id
    and can_access_merchant(p_merchant_id)
    and p.is_active
    and (p_category is null or p.category ilike p_category)
    and (not p_in_stock or not p.track_stock or p.stock > 0)
    and (
      p_query is null
      or p.name ilike '%' || p_query || '%'
      or p.category ilike '%' || p_query || '%'
      or p.variant_label ilike '%' || p_query || '%'
      or to_tsvector('simple', coalesce(p.name,'') || ' ' || coalesce(p.category,'') || ' ' || coalesce(p.variant_label,''))
         @@ plainto_tsquery('simple', p_query)
    )
  order by (p.track_stock and p.stock = 0), p.name
  limit least(p_limit, 25);
$$;

create or replace function conversation_by_phone(
  p_merchant_id uuid,
  p_wa_phone    text
)
returns table (
  out_conversation_id uuid, out_customer_id uuid,
  out_status conversation_status, out_customer_name text
)
language sql stable security definer set search_path = public as $$
  select c.id, c.customer_id, c.status, cu.name
  from conversations c
  join customers cu on cu.id = c.customer_id
  where c.merchant_id = p_merchant_id
    and can_access_merchant(p_merchant_id)
    and regexp_replace(cu.wa_phone, '\D', '', 'g')
        like '%' || regexp_replace(p_wa_phone, '\D', '', 'g')
  order by c.last_message_at desc
  limit 1;
$$;

-- ------------------------------------------------------------
-- Guarded writes
--
-- These raise instead of returning empty. A write that silently does nothing
-- is worse than an error — the dashboard would show "cancelled" on an order
-- that is still live.
-- ------------------------------------------------------------

create or replace function resume_conversation(
  p_merchant_id uuid,
  p_conversation_id uuid
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not can_access_merchant(p_merchant_id) then
    raise exception 'FORBIDDEN';
  end if;

  update conversations
    set status = 'open',
        resumed_at = now(),
        escalated_at = null,
        escalation_reason = null
  where id = p_conversation_id and merchant_id = p_merchant_id;
end $$;

create or replace function close_conversation(
  p_merchant_id uuid,
  p_conversation_id uuid
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not can_access_merchant(p_merchant_id) then
    raise exception 'FORBIDDEN';
  end if;

  update conversations set status = 'closed'
  where id = p_conversation_id and merchant_id = p_merchant_id;
end $$;

-- set_order_status, set_product_stock and find_order are plpgsql already;
-- each gains the same guard as its first statement.
create or replace function find_order(p_merchant_id uuid, p_ref text)
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_ids uuid[];
begin
  if not can_access_merchant(p_merchant_id) then
    raise exception 'FORBIDDEN';
  end if;

  select array_agg(o.id) into v_ids
  from orders o
  where o.merchant_id = p_merchant_id
    and upper(left(replace(o.id::text, '-', ''), 6)) = upper(trim(p_ref));

  if v_ids is null or array_length(v_ids, 1) = 0 then
    return null;
  end if;

  if array_length(v_ids, 1) > 1 then
    raise exception 'ORDER_REF_AMBIGUOUS:%', p_ref;
  end if;

  return v_ids[1];
end $$;

create or replace function set_order_status(
  p_merchant_id uuid,
  p_order_id    uuid,
  p_status      order_status,
  p_actor       text default 'owner',
  p_note        text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order  orders%rowtype;
  v_item   order_items%rowtype;
begin
  if not can_access_merchant(p_merchant_id) then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_order
  from orders
  where id = p_order_id and merchant_id = p_merchant_id
  for update;

  if v_order.id is null then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_order.status = p_status then
    return order_summary(p_order_id);           -- idempotent, not an error
  end if;

  if v_order.status in ('fulfilled', 'cancelled') then
    raise exception 'ORDER_TERMINAL:%', v_order.status;
  end if;

  if p_status = 'cancelled' then
    for v_item in select * from order_items where order_id = p_order_id loop
      update products
        set stock = stock + v_item.quantity
      where id = v_item.product_id and track_stock;
    end loop;

    update orders
      set status = 'cancelled', cancelled_at = now(), cancel_reason = p_note
    where id = p_order_id;

  elsif p_status = 'confirmed' then
    update orders set status = 'confirmed', paid_at = coalesce(paid_at, now())
    where id = p_order_id;

  elsif p_status = 'fulfilled' then
    update orders set status = 'fulfilled', fulfilled_at = now()
    where id = p_order_id;

  else
    update orders set status = p_status where id = p_order_id;
  end if;

  insert into order_events (order_id, merchant_id, from_status, to_status, actor, note)
  values (p_order_id, p_merchant_id, v_order.status, p_status, p_actor, p_note);

  return order_summary(p_order_id);
end $$;

create or replace function set_product_stock(
  p_merchant_id uuid,
  p_product_id  uuid,
  p_stock       int
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_product products%rowtype;
begin
  if not can_access_merchant(p_merchant_id) then
    raise exception 'FORBIDDEN';
  end if;

  if p_stock < 0 then
    raise exception 'STOCK_NEGATIVE';
  end if;

  update products
    set stock = p_stock, track_stock = true
  where id = p_product_id and merchant_id = p_merchant_id
  returning * into v_product;

  if v_product.id is null then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'id', v_product.id,
    'name', trim(v_product.name || ' ' || coalesce(v_product.variant_label, '')),
    'stock', v_product.stock,
    'price_minor', v_product.price_minor
  );
end $$;

-- ============================================================
-- Layer 2: take the server-only functions off the browser's menu entirely.
--
-- Supabase grants EXECUTE on new functions to `anon` and `authenticated` by
-- default, and PostgREST exposes every one of them at /rest/v1/rpc/<name>.
-- Nothing below is ever called from a browser — they are the webhook and
-- cron paths, reached with the service role key, which is not affected by
-- these revokes.
--
-- Without this, a logged-in merchant could call escalate_conversation on any
-- conversation id, or place_order against their own catalogue with arbitrary
-- customer ids, purely by knowing the function names — which are public.
-- ============================================================

revoke execute on function upsert_customer_conversation(uuid, text, text) from anon, authenticated;
revoke execute on function place_order(uuid, uuid, uuid, jsonb, text, text)  from anon, authenticated;
revoke execute on function register_stock_alert(uuid, uuid, uuid)            from anon, authenticated;
revoke execute on function escalate_conversation(uuid, text)                 from anon, authenticated;
revoke execute on function bump_usage(uuid, int, int, int, bigint)           from anon, authenticated;
revoke execute on function pending_stock_alerts(uuid)                        from anon, authenticated;
revoke execute on function unnotified_orders(uuid)                           from anon, authenticated;
revoke execute on function mark_order_notified(uuid)                         from anon, authenticated;
revoke execute on function recent_inbound_count(uuid, int)                   from anon, authenticated;
revoke execute on function conversation_model(uuid)                          from anon, authenticated;

-- Nothing anonymous should reach any RPC. The dashboard is always logged in.
revoke execute on function conversation_list(uuid, conversation_status, int)        from anon;
revoke execute on function conversation_transcript(uuid, int)                       from anon;
revoke execute on function recent_orders(uuid, order_status, int)                   from anon;
revoke execute on function order_summary(uuid)                                      from anon;
revoke execute on function set_order_status(uuid, uuid, order_status, text, text)   from anon;
revoke execute on function find_order(uuid, text)                                   from anon;
revoke execute on function set_product_stock(uuid, uuid, int)                       from anon;
revoke execute on function resume_conversation(uuid, uuid)                          from anon;
revoke execute on function close_conversation(uuid, uuid)                           from anon;
revoke execute on function conversation_by_phone(uuid, text)                        from anon;
revoke execute on function merchant_usage(uuid)                                     from anon;
revoke execute on function dashboard_overview(uuid)                                 from anon;
revoke execute on function my_merchant()                                            from anon;
revoke execute on function search_catalogue(uuid, text, text, boolean, int)         from anon;

-- ============================================================
-- Column-level grants on merchants.
--
-- The merchants_own policy is `for all using (owner_id = auth.uid())`, which
-- is right for reads and wrong for writes: it lets a merchant update ANY
-- column on their own row. From the browser console, with the anon key that
-- is already in the page bundle, that includes:
--
--     plan_reply_cap    → give themselves unlimited replies
--     plan_price_minor  → set their own plan to zero
--     overage_price_minor
--     is_active
--     wa_phone_number_id → re-point the tenant lookup at another number
--
-- RLS has no column-level form, so this is a GRANT. Both have to pass: the
-- policy decides WHICH ROW, the grant decides WHICH COLUMNS. The service role
-- is unaffected — it bypasses both, which is how billing fields get changed.
--
-- The listed columns are exactly what the Settings page writes.
-- ============================================================

revoke update on merchants from authenticated;

grant update (
  ai_tone,
  greeting,
  business_hours,
  escalation_number,
  delivery_fee_minor,
  owner_notify,
  timezone
) on merchants to authenticated;

-- Reads still go through the policy, which already scopes them to the owner.
grant select on merchants to authenticated;

-- Nothing anonymous touches any of this.
revoke all on merchants from anon;

-- ------------------------------------------------------------
-- orders: no direct writes from the browser.
--
-- Every status change has to go through set_order_status, because cancelling
-- restores stock and that restore must happen in the same transaction. A
-- direct `update orders set status = 'cancelled'` skips it, and the stock
-- stays held against an order that no longer exists — the item is then
-- unsellable and its restock alert never fires.
-- ------------------------------------------------------------
revoke insert, update, delete on orders from anon, authenticated;
revoke insert, update, delete on order_items from anon, authenticated;
revoke all on order_events from anon, authenticated;
grant select on orders, order_items to authenticated;

-- usage_counters is the billing record. Read-only was already the intent —
-- its policy is `for select` — but the table grant was still full.
revoke insert, update, delete on usage_counters from anon, authenticated;
grant select on usage_counters to authenticated;

-- Conversations and messages: the dashboard reads them and changes status
-- only through resume_conversation / close_conversation, which are guarded.
revoke insert, update, delete on messages from anon, authenticated;
revoke insert, update, delete on conversations from anon, authenticated;
grant select on messages, conversations, customers to authenticated;
revoke all on messages, conversations, customers from anon;

-- Products are the one table the dashboard edits directly. The products_own
-- policy scopes that to the merchant's own rows, which is all that's needed —
-- there is no cross-row invariant to protect here.
grant select, insert, update, delete on products to authenticated;
revoke all on products from anon;

revoke all on stock_alerts from anon;
grant select on stock_alerts to authenticated;
revoke insert, update, delete on stock_alerts from anon, authenticated;
