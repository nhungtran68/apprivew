-- PayOS prepaid credit orders. Apply after credits-ledger.sql.
-- Only a verified server-side PayOS webhook may call mark_paid. The database
-- then records the payment and grants credits in a single transaction.
begin;

create table if not exists public.studio_payment_packs (
  id text primary key check (id ~ '^pack_[a-z0-9_]{1,40}$'),
  name text not null check (length(name) between 2 and 80),
  credits integer not null check (credits between 1 and 1000000),
  price_vnd integer not null check (price_vnd between 1000 and 2000000000),
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.studio_payment_gateway (
  provider text primary key check (provider = 'payos'),
  webhook_url text,
  webhook_confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((webhook_url is null) = (webhook_confirmed_at is null))
);
insert into public.studio_payment_gateway(provider) values ('payos')
on conflict (provider) do nothing;

-- Do not overwrite a catalog entry if an operator has edited it already.
insert into public.studio_payment_packs (id,name,credits,price_vnd,sort_order)
values ('pack_500','Gói 500 credit',500,50000,10),
       ('pack_1000','Gói 1.000 credit',1000,100000,20),
       ('pack_3000','Gói 3.000 credit',3000,300000,30)
on conflict (id) do nothing;

create table if not exists public.studio_payment_orders (
  request_id uuid primary key,
  user_id uuid not null references public.studio_credit_accounts(user_id) on delete restrict,
  order_code bigint not null unique check (order_code between 1 and 9007199254740991),
  pack_id text not null references public.studio_payment_packs(id) on delete restrict,
  credits integer not null check (credits between 1 and 1000000),
  price_vnd integer not null check (price_vnd between 1000 and 2000000000),
  provider text not null default 'payos' check (provider = 'payos'),
  status text not null default 'pending'
    check (status in ('pending','paid','cancelled','expired')),
  checkout_url text check (checkout_url is null or length(checkout_url) between 10 and 2048),
  provider_payment_link_id text unique
    check (provider_payment_link_id is null or length(provider_payment_link_id) between 1 and 200),
  -- The confirmed paymentLinkId. This is stable across webhook and GET.
  provider_reference text unique
    check (provider_reference is null or length(provider_reference) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  closed_at timestamptz,
  check ((status = 'paid') = (paid_at is not null)),
  check ((status = 'paid') = (provider_reference is not null))
);

create index if not exists studio_payment_orders_user_created_idx
  on public.studio_payment_orders(user_id,created_at desc);
create index if not exists studio_payment_orders_pending_idx
  on public.studio_payment_orders(created_at) where status = 'pending';

-- Purchase is a first-class credit ledger event, linked to its payment order.
alter table public.studio_credit_events
  drop constraint if exists studio_credit_events_event_type_check;
alter table public.studio_credit_events
  add constraint studio_credit_events_event_type_check
  check (event_type in ('legacy_conversion','reserve','settle','refund','adjust','purchase'));
create unique index if not exists studio_credit_events_purchase_request_idx
  on public.studio_credit_events(request_id) where event_type = 'purchase';

alter table public.studio_payment_packs enable row level security;
alter table public.studio_payment_orders enable row level security;
alter table public.studio_payment_gateway enable row level security;
revoke all on public.studio_payment_packs, public.studio_payment_orders
  from public, anon, authenticated;
revoke all on public.studio_payment_gateway from public, anon, authenticated;
grant select on public.studio_payment_packs, public.studio_payment_orders
  to authenticated;
grant all on public.studio_payment_packs, public.studio_payment_orders
  to service_role;
grant select, update on public.studio_payment_gateway to service_role;

drop policy if exists studio_payment_packs_member_read on public.studio_payment_packs;
create policy studio_payment_packs_member_read on public.studio_payment_packs
  for select to authenticated using (enabled);
drop policy if exists studio_payment_orders_own_read on public.studio_payment_orders;
create policy studio_payment_orders_own_read on public.studio_payment_orders
  for select to authenticated using (user_id = (select auth.uid()));

create schema if not exists studio_private;
grant usage on schema studio_private to service_role;

create or replace function studio_private.payment_order_json(
  p_order public.studio_payment_orders, p_created boolean
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'created', p_created,
    'orderId', p_order.request_id,
    'userId', p_order.user_id,
    'orderCode', p_order.order_code,
    'packId', p_order.pack_id,
    'credits', p_order.credits,
    'priceVnd', p_order.price_vnd,
    'status', p_order.status,
    'checkoutUrl', p_order.checkout_url,
    'paymentLinkId', p_order.provider_payment_link_id,
    'reference', p_order.provider_reference
  );
$$;

create or replace function studio_private.payment_create(
  p_user_id uuid, p_request_id uuid, p_order_code bigint,
  p_pack_id text, p_credits integer, p_price_vnd integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  order_row public.studio_payment_orders%rowtype;
  pack_row public.studio_payment_packs%rowtype;
begin
  if p_user_id is null or p_request_id is null or p_order_code is null or
     p_order_code < 1 or p_order_code > 9007199254740991 or
     p_pack_id is null or length(p_pack_id) > 50 or
     p_credits is null or p_credits < 1 or p_credits > 1000000 or
     p_price_vnd is null or p_price_vnd < 1000 or p_price_vnd > 2000000000 then
    raise exception 'INVALID_PAYMENT_ORDER';
  end if;

  -- Check the idempotency key before consulting current prices: a retry of an
  -- existing order remains valid even if its catalog price changes later.
  select * into order_row from public.studio_payment_orders
    where request_id = p_request_id for update;
  if found then
    if order_row.user_id <> p_user_id or order_row.order_code <> p_order_code or
       order_row.pack_id <> p_pack_id or order_row.credits <> p_credits or
       order_row.price_vnd <> p_price_vnd then
      raise exception 'PAYMENT_ORDER_CONFLICT';
    end if;
    return studio_private.payment_order_json(order_row,false);
  end if;

  if not exists (select 1 from public.studio_members
                 where user_id = p_user_id and enabled) then
    raise exception 'MEMBER_DISABLED';
  end if;
  -- Retries with the same request ID returned above are free. Limit new
  -- checkout links so a member cannot flood the payment provider.
  if (select count(*) from public.studio_payment_orders
      where user_id = p_user_id and created_at >= now() - interval '1 hour') >= 10 then
    raise exception 'PAYMENT_RATE_LIMIT';
  end if;
  select * into pack_row from public.studio_payment_packs
    where id = p_pack_id and enabled;
  if not found or pack_row.credits <> p_credits or pack_row.price_vnd <> p_price_vnd then
    raise exception 'PAYMENT_PACK_MISMATCH';
  end if;

  insert into public.studio_payment_orders
    (request_id,user_id,order_code,pack_id,credits,price_vnd)
  values (p_request_id,p_user_id,p_order_code,p_pack_id,p_credits,p_price_vnd)
  on conflict do nothing returning * into order_row;
  if not found then
    select * into order_row from public.studio_payment_orders
      where request_id = p_request_id for update;
    if not found then raise exception 'PAYMENT_ORDER_CODE_CONFLICT'; end if;
    if order_row.user_id <> p_user_id or order_row.order_code <> p_order_code or
       order_row.pack_id <> p_pack_id or order_row.credits <> p_credits or
       order_row.price_vnd <> p_price_vnd then
      raise exception 'PAYMENT_ORDER_CONFLICT';
    end if;
    return studio_private.payment_order_json(order_row,false);
  end if;
  return studio_private.payment_order_json(order_row,true);
end;
$$;

create or replace function studio_private.payment_set_link(
  p_request_id uuid, p_checkout_url text, p_payment_link_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare order_row public.studio_payment_orders%rowtype;
begin
  if p_request_id is null or p_checkout_url is null or
     p_checkout_url !~ '^https://[^[:space:]]+$' or
     length(p_checkout_url) > 2048 or
     p_payment_link_id is null or length(p_payment_link_id) not between 1 and 200 then
    raise exception 'INVALID_PAYMENT_LINK';
  end if;
  select * into order_row from public.studio_payment_orders
    where request_id = p_request_id for update;
  if not found then raise exception 'PAYMENT_ORDER_MISSING'; end if;
  if order_row.status = 'paid' and
     order_row.provider_reference <> p_payment_link_id then
    raise exception 'PAYMENT_LINK_CONFLICT';
  end if;
  if order_row.checkout_url is not null or order_row.provider_payment_link_id is not null then
    if order_row.checkout_url <> p_checkout_url or
       order_row.provider_payment_link_id <> p_payment_link_id then
      raise exception 'PAYMENT_LINK_CONFLICT';
    end if;
    return studio_private.payment_order_json(order_row,false);
  end if;
  update public.studio_payment_orders
    set checkout_url = p_checkout_url,
        provider_payment_link_id = p_payment_link_id,
        updated_at = now()
    where request_id = p_request_id returning * into order_row;
  return studio_private.payment_order_json(order_row,true);
end;
$$;

create or replace function studio_private.payment_mark_paid(
  p_order_code bigint, p_amount_vnd integer, p_reference text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  order_row public.studio_payment_orders%rowtype;
  account_row public.studio_credit_accounts%rowtype;
  clean_reference text := btrim(p_reference);
begin
  if p_order_code is null or p_order_code < 1 or
     p_amount_vnd is null or p_amount_vnd < 1000 or
     clean_reference is null or length(clean_reference) not between 1 and 200 then
    raise exception 'INVALID_PAYMENT_CONFIRMATION';
  end if;
  select * into order_row from public.studio_payment_orders
    where order_code = p_order_code for update;
  if not found then raise exception 'PAYMENT_ORDER_MISSING'; end if;
  if order_row.price_vnd <> p_amount_vnd then
    raise exception 'PAYMENT_AMOUNT_MISMATCH';
  end if;
  if order_row.provider_payment_link_id is not null and
     order_row.provider_payment_link_id <> clean_reference then
    raise exception 'PAYMENT_LINK_CONFLICT';
  end if;
  if order_row.status = 'paid' then
    if order_row.provider_reference <> clean_reference then
      raise exception 'PAYMENT_REFERENCE_CONFLICT';
    end if;
    select * into account_row from public.studio_credit_accounts
      where user_id = order_row.user_id;
    return studio_private.payment_order_json(order_row,false) ||
      jsonb_build_object('balance',account_row.balance,
        'reserved',account_row.reserved,
        'available',account_row.balance-account_row.reserved);
  end if;

  -- A signed, verified payment takes precedence over a stale cancellation or
  -- timeout. Never retain money without granting the corresponding credits.
  select * into account_row from public.studio_credit_accounts
    where user_id = order_row.user_id for update;
  if not found then raise exception 'CREDIT_ACCOUNT_MISSING'; end if;
  if account_row.balance::bigint + order_row.credits > 2000000000 then
    raise exception 'INVALID_CREDIT_BALANCE';
  end if;

  update public.studio_payment_orders
    set status = 'paid', provider_reference = clean_reference,
        paid_at = now(), closed_at = null, updated_at = now()
    where request_id = order_row.request_id returning * into order_row;
  update public.studio_credit_accounts
    set balance = balance + order_row.credits, updated_at = now()
    where user_id = order_row.user_id returning * into account_row;
  insert into public.studio_credit_events
    (user_id,request_id,event_type,balance_delta,reserved_delta,balance_after,reserved_after)
  values (order_row.user_id,order_row.request_id,'purchase',order_row.credits,0,
    account_row.balance,account_row.reserved);
  return studio_private.payment_order_json(order_row,true) ||
    jsonb_build_object('balance',account_row.balance,
      'reserved',account_row.reserved,
      'available',account_row.balance-account_row.reserved);
end;
$$;

create or replace function studio_private.payment_mark_closed(
  p_order_code bigint, p_status text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare order_row public.studio_payment_orders%rowtype;
begin
  if p_order_code is null or p_order_code < 1 or
     p_status is null or p_status not in ('cancelled','expired') then
    raise exception 'INVALID_PAYMENT_STATUS';
  end if;
  select * into order_row from public.studio_payment_orders
    where order_code = p_order_code for update;
  if not found then raise exception 'PAYMENT_ORDER_MISSING'; end if;
  if order_row.status <> 'pending' then
    return studio_private.payment_order_json(order_row,false);
  end if;
  update public.studio_payment_orders
    set status = p_status, closed_at = now(), updated_at = now()
    where request_id = order_row.request_id returning * into order_row;
  return studio_private.payment_order_json(order_row,true);
end;
$$;

-- PostgREST RPC wrappers are invoker functions and executable only with the
-- Vercel server's service key. Browsers have SELECT access but no write path.
create or replace function public.studio_payment_create(
  p_user_id uuid, p_request_id uuid, p_order_code bigint,
  p_pack_id text, p_credits integer, p_price_vnd integer
) returns jsonb language sql security invoker set search_path = '' as $$
  select studio_private.payment_create(
    p_user_id,p_request_id,p_order_code,p_pack_id,p_credits,p_price_vnd);
$$;
create or replace function public.studio_payment_set_link(
  p_request_id uuid, p_checkout_url text, p_payment_link_id text
) returns jsonb language sql security invoker set search_path = '' as $$
  select studio_private.payment_set_link(
    p_request_id,p_checkout_url,p_payment_link_id);
$$;
create or replace function public.studio_payment_mark_paid(
  p_order_code bigint, p_amount_vnd integer, p_reference text
) returns jsonb language sql security invoker set search_path = '' as $$
  select studio_private.payment_mark_paid(p_order_code,p_amount_vnd,p_reference);
$$;
create or replace function public.studio_payment_mark_closed(
  p_order_code bigint, p_status text
) returns jsonb language sql security invoker set search_path = '' as $$
  select studio_private.payment_mark_closed(p_order_code,p_status);
$$;

revoke all on function
  studio_private.payment_order_json(public.studio_payment_orders,boolean),
  studio_private.payment_create(uuid,uuid,bigint,text,integer,integer),
  studio_private.payment_set_link(uuid,text,text),
  studio_private.payment_mark_paid(bigint,integer,text),
  studio_private.payment_mark_closed(bigint,text)
  from public, anon, authenticated;
grant execute on function
  studio_private.payment_order_json(public.studio_payment_orders,boolean),
  studio_private.payment_create(uuid,uuid,bigint,text,integer,integer),
  studio_private.payment_set_link(uuid,text,text),
  studio_private.payment_mark_paid(bigint,integer,text),
  studio_private.payment_mark_closed(bigint,text)
  to service_role;
revoke all on function
  public.studio_payment_create(uuid,uuid,bigint,text,integer,integer),
  public.studio_payment_set_link(uuid,text,text),
  public.studio_payment_mark_paid(bigint,integer,text),
  public.studio_payment_mark_closed(bigint,text)
  from public, anon, authenticated;
grant execute on function
  public.studio_payment_create(uuid,uuid,bigint,text,integer,integer),
  public.studio_payment_set_link(uuid,text,text),
  public.studio_payment_mark_paid(bigint,integer,text),
  public.studio_payment_mark_closed(bigint,text)
  to service_role;

commit;
