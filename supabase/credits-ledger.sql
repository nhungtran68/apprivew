-- Run once in the Supabase SQL Editor after setup.sql. Do not remove or reset
-- studio_members.ai_units_*: existing members receive one explicit conversion
-- of their remaining legacy allowance into application credits.
-- The public RPCs below are executable ONLY with the server-side service key.
begin;

create schema if not exists studio_private;
grant usage on schema studio_private to service_role;

create table if not exists public.studio_credit_accounts (
  user_id uuid primary key references public.studio_members(user_id) on delete restrict,
  balance integer not null default 0 check (balance >= 0),
  reserved integer not null default 0 check (reserved >= 0 and reserved <= balance),
  updated_at timestamptz not null default now()
);

create table if not exists public.studio_credit_operations (
  request_id uuid primary key,
  user_id uuid not null references public.studio_credit_accounts(user_id) on delete restrict,
  kind text not null check (kind in ('script','analyze','scene_plan','transcribe','tts','clone','stock_video')),
  reserved_credits integer not null check (reserved_credits between 1 and 10000),
  charged_credits integer not null default 0 check (charged_credits >= 0),
  status text not null default 'reserved' check (status in ('reserved','settled','refunded')),
  provider_task_id text,
  metadata jsonb not null default '{}'::jsonb,
  provider_usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (charged_credits <= reserved_credits),
  check (status = 'settled' or charged_credits = 0)
);

create table if not exists public.studio_credit_adjustments (
  request_id uuid primary key,
  user_id uuid not null references public.studio_credit_accounts(user_id) on delete restrict,
  actor_id uuid not null references public.studio_members(user_id),
  delta integer not null check (delta <> 0),
  reason text not null check (length(reason) between 3 and 300),
  created_at timestamptz not null default now()
);

create table if not exists public.studio_credit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.studio_credit_accounts(user_id) on delete restrict,
  request_id uuid,
  event_type text not null check (event_type in ('legacy_conversion','reserve','settle','refund','adjust')),
  balance_delta integer not null,
  reserved_delta integer not null,
  balance_after integer not null check (balance_after >= 0),
  reserved_after integer not null check (reserved_after >= 0),
  created_at timestamptz not null default now(),
  check (reserved_after <= balance_after)
);

create index if not exists studio_credit_operations_user_created_idx
  on public.studio_credit_operations(user_id, created_at desc);
create index if not exists studio_credit_operations_pending_idx
  on public.studio_credit_operations(created_at) where status = 'reserved';
create index if not exists studio_credit_events_user_created_idx
  on public.studio_credit_events(user_id, created_at desc);

alter table public.studio_credit_accounts enable row level security;
alter table public.studio_credit_operations enable row level security;
alter table public.studio_credit_adjustments enable row level security;
alter table public.studio_credit_events enable row level security;
revoke all on public.studio_credit_accounts, public.studio_credit_operations,
  public.studio_credit_adjustments, public.studio_credit_events from public, anon, authenticated;
grant select on public.studio_credit_accounts, public.studio_credit_operations,
  public.studio_credit_adjustments, public.studio_credit_events to authenticated, service_role;

drop policy if exists studio_credit_accounts_own_read on public.studio_credit_accounts;
drop policy if exists studio_credit_operations_own_read on public.studio_credit_operations;
drop policy if exists studio_credit_adjustments_own_read on public.studio_credit_adjustments;
drop policy if exists studio_credit_events_own_read on public.studio_credit_events;
create policy studio_credit_accounts_own_read on public.studio_credit_accounts
  for select to authenticated using (user_id = (select auth.uid()));
create policy studio_credit_operations_own_read on public.studio_credit_operations
  for select to authenticated using (user_id = (select auth.uid()));
create policy studio_credit_adjustments_own_read on public.studio_credit_adjustments
  for select to authenticated using (user_id = (select auth.uid()));
create policy studio_credit_events_own_read on public.studio_credit_events
  for select to authenticated using (user_id = (select auth.uid()));

-- This insert is intentionally before the trigger. Rerunning the script will
-- neither grant again nor rewrite balances. Existing allowances remain intact.
with seeded as (
  insert into public.studio_credit_accounts(user_id, balance)
  select user_id, greatest(0, ai_units_limit - ai_units_used)
  from public.studio_members
  on conflict (user_id) do nothing
  returning user_id, balance
)
insert into public.studio_credit_events
  (user_id, event_type, balance_delta, reserved_delta, balance_after, reserved_after)
select user_id, 'legacy_conversion', balance, 0, balance, 0 from seeded;

create or replace function studio_private.credit_account_for_new_member()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.studio_credit_accounts(user_id) values (new.user_id)
    on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function studio_private.credit_account_for_new_member() from public, anon, authenticated;
drop trigger if exists studio_credit_member_created on public.studio_members;
create trigger studio_credit_member_created after insert on public.studio_members
  for each row execute function studio_private.credit_account_for_new_member();

create or replace function studio_private.credit_reserve(
  p_user_id uuid, p_request_id uuid, p_kind text, p_credits integer,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account_row public.studio_credit_accounts%rowtype;
  operation_row public.studio_credit_operations%rowtype;
  inserted_id uuid;
begin
  if p_user_id is null or p_request_id is null or
    p_kind is null or p_kind not in ('script','analyze','scene_plan','transcribe','tts','clone','stock_video') or
    p_credits is null or p_credits < 1 or p_credits > 10000 or
    p_metadata is null or jsonb_typeof(p_metadata) <> 'object' or
    octet_length(p_metadata::text) > 2000 then
    raise exception 'INVALID_CREDIT_REQUEST';
  end if;
  if not exists (select 1 from public.studio_members
                 where user_id = p_user_id and enabled) then
    raise exception 'MEMBER_DISABLED';
  end if;
  select * into account_row from public.studio_credit_accounts
    where user_id = p_user_id for update;
  if not found then raise exception 'CREDIT_ACCOUNT_MISSING'; end if;

  select * into operation_row from public.studio_credit_operations
    where request_id = p_request_id;
  if found then
    if operation_row.user_id <> p_user_id or operation_row.kind <> p_kind or
       operation_row.reserved_credits <> p_credits or
       operation_row.metadata <> p_metadata then
      raise exception 'CREDIT_REQUEST_CONFLICT';
    end if;
    return jsonb_build_object('created',false,'status',operation_row.status,
      'balance',account_row.balance,'reserved',account_row.reserved,
      'available',account_row.balance-account_row.reserved,
      'chargedCredits',operation_row.charged_credits,
      'providerTaskId',operation_row.provider_task_id);
  end if;

  if account_row.balance-account_row.reserved < p_credits then
    raise exception 'INSUFFICIENT_CREDITS';
  end if;
  insert into public.studio_credit_operations
    (request_id,user_id,kind,reserved_credits,metadata)
  values (p_request_id,p_user_id,p_kind,p_credits,p_metadata)
  on conflict (request_id) do nothing returning request_id into inserted_id;
  if inserted_id is null then
    select * into operation_row from public.studio_credit_operations
      where request_id = p_request_id;
    if operation_row.user_id <> p_user_id or operation_row.kind <> p_kind or
       operation_row.reserved_credits <> p_credits or
       operation_row.metadata <> p_metadata then
      raise exception 'CREDIT_REQUEST_CONFLICT';
    end if;
    return jsonb_build_object('created',false,'status',operation_row.status,
      'balance',account_row.balance,'reserved',account_row.reserved,
      'available',account_row.balance-account_row.reserved,
      'chargedCredits',operation_row.charged_credits,
      'providerTaskId',operation_row.provider_task_id);
  end if;
  update public.studio_credit_accounts
    set reserved = reserved+p_credits, updated_at = now()
    where user_id = p_user_id
    returning * into account_row;
  insert into public.studio_credit_events
    (user_id,request_id,event_type,balance_delta,reserved_delta,balance_after,reserved_after)
  values (p_user_id,p_request_id,'reserve',0,p_credits,account_row.balance,account_row.reserved);
  return jsonb_build_object('created',true,'status','reserved',
    'balance',account_row.balance,'reserved',account_row.reserved,
    'available',account_row.balance-account_row.reserved,'chargedCredits',0);
end;
$$;

create or replace function studio_private.credit_settle(
  p_user_id uuid, p_request_id uuid, p_charge_credits integer,
  p_provider_usage jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account_row public.studio_credit_accounts%rowtype;
  operation_row public.studio_credit_operations%rowtype;
  charge_credits integer;
begin
  if p_user_id is null or p_request_id is null or
    p_provider_usage is null or jsonb_typeof(p_provider_usage) <> 'object' or
    octet_length(p_provider_usage::text) > 4000 then
    raise exception 'INVALID_CREDIT_REQUEST';
  end if;
  select * into account_row from public.studio_credit_accounts
    where user_id = p_user_id for update;
  if not found then raise exception 'CREDIT_ACCOUNT_MISSING'; end if;
  select * into operation_row from public.studio_credit_operations
    where request_id = p_request_id and user_id = p_user_id for update;
  if not found then raise exception 'CREDIT_REQUEST_MISSING'; end if;
  charge_credits := coalesce(p_charge_credits, operation_row.reserved_credits);
  if charge_credits < 1 or charge_credits > operation_row.reserved_credits then
    raise exception 'INVALID_CREDIT_CHARGE';
  end if;
  if operation_row.status = 'settled' then
    if operation_row.charged_credits <> charge_credits then
      raise exception 'CREDIT_REQUEST_CONFLICT';
    end if;
    return jsonb_build_object('created',false,'status','settled',
      'balance',account_row.balance,'reserved',account_row.reserved,
      'available',account_row.balance-account_row.reserved,
      'chargedCredits',operation_row.charged_credits);
  end if;
  if operation_row.status <> 'reserved' then raise exception 'CREDIT_REQUEST_REFUNDED'; end if;
  update public.studio_credit_accounts
    set balance = balance-charge_credits,
        reserved = reserved-operation_row.reserved_credits,
        updated_at = now()
    where user_id = p_user_id
    returning * into account_row;
  update public.studio_credit_operations
    set status = 'settled', charged_credits = charge_credits,
        provider_usage = p_provider_usage, updated_at = now()
    where request_id = p_request_id;
  insert into public.studio_credit_events
    (user_id,request_id,event_type,balance_delta,reserved_delta,balance_after,reserved_after)
  values (p_user_id,p_request_id,'settle',-charge_credits,
    -operation_row.reserved_credits,account_row.balance,account_row.reserved);
  return jsonb_build_object('created',true,'status','settled',
    'balance',account_row.balance,'reserved',account_row.reserved,
    'available',account_row.balance-account_row.reserved,
    'chargedCredits',charge_credits);
end;
$$;

create or replace function studio_private.credit_refund(
  p_user_id uuid, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account_row public.studio_credit_accounts%rowtype;
  operation_row public.studio_credit_operations%rowtype;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'INVALID_CREDIT_REQUEST';
  end if;
  select * into account_row from public.studio_credit_accounts
    where user_id = p_user_id for update;
  if not found then raise exception 'CREDIT_ACCOUNT_MISSING'; end if;
  select * into operation_row from public.studio_credit_operations
    where request_id = p_request_id and user_id = p_user_id for update;
  if not found then raise exception 'CREDIT_REQUEST_MISSING'; end if;
  if operation_row.status = 'settled' then raise exception 'CREDIT_REQUEST_SETTLED'; end if;
  if operation_row.status = 'refunded' then
    return jsonb_build_object('created',false,'status','refunded',
      'balance',account_row.balance,'reserved',account_row.reserved,
      'available',account_row.balance-account_row.reserved,'chargedCredits',0);
  end if;
  update public.studio_credit_accounts
    set reserved = reserved-operation_row.reserved_credits,
        updated_at = now() where user_id = p_user_id
    returning * into account_row;
  update public.studio_credit_operations
    set status = 'refunded', updated_at = now() where request_id = p_request_id;
  insert into public.studio_credit_events
    (user_id,request_id,event_type,balance_delta,reserved_delta,balance_after,reserved_after)
  values (p_user_id,p_request_id,'refund',0,-operation_row.reserved_credits,
    account_row.balance,account_row.reserved);
  return jsonb_build_object('created',true,'status','refunded',
    'balance',account_row.balance,'reserved',account_row.reserved,
    'available',account_row.balance-account_row.reserved,'chargedCredits',0);
end;
$$;

create or replace function studio_private.credit_mark_provider_task(
  p_user_id uuid, p_request_id uuid, p_provider_task_id text
) returns void language plpgsql security definer set search_path = '' as $$
declare operation_row public.studio_credit_operations%rowtype;
begin
  if p_user_id is null or p_request_id is null or
     p_provider_task_id is null or length(p_provider_task_id) not between 1 and 200 then
    raise exception 'INVALID_CREDIT_REQUEST';
  end if;
  select * into operation_row from public.studio_credit_operations
    where request_id = p_request_id and user_id = p_user_id for update;
  if not found then raise exception 'CREDIT_REQUEST_MISSING'; end if;
  if operation_row.status <> 'reserved' then raise exception 'CREDIT_REQUEST_FINISHED'; end if;
  if operation_row.provider_task_id is not null and
     operation_row.provider_task_id <> p_provider_task_id then
    raise exception 'CREDIT_REQUEST_CONFLICT';
  end if;
  update public.studio_credit_operations set provider_task_id = p_provider_task_id,
    updated_at = now() where request_id = p_request_id;
end;
$$;

create or replace function studio_private.credit_adjust(
  p_actor_id uuid, p_user_id uuid, p_request_id uuid,
  p_delta integer, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account_row public.studio_credit_accounts%rowtype;
  adjustment_row public.studio_credit_adjustments%rowtype;
  inserted_id uuid;
begin
  if p_actor_id is null or p_user_id is null or p_request_id is null or
     p_delta is null or p_delta = 0 or abs(p_delta::bigint) > 1000000 or
     p_reason is null or length(p_reason) not between 3 and 300 then
    raise exception 'INVALID_CREDIT_ADJUSTMENT';
  end if;
  if not exists (select 1 from public.studio_members where user_id = p_actor_id
                 and role = 'admin' and enabled) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  select * into account_row from public.studio_credit_accounts
    where user_id = p_user_id for update;
  if not found then raise exception 'CREDIT_ACCOUNT_MISSING'; end if;
  select * into adjustment_row from public.studio_credit_adjustments
    where request_id = p_request_id;
  if found then
    if adjustment_row.actor_id <> p_actor_id or adjustment_row.user_id <> p_user_id or
       adjustment_row.delta <> p_delta or adjustment_row.reason <> p_reason then
      raise exception 'CREDIT_REQUEST_CONFLICT';
    end if;
    return jsonb_build_object('created',false,'balance',account_row.balance,
      'reserved',account_row.reserved,
      'available',account_row.balance-account_row.reserved);
  end if;
  if account_row.balance::bigint+p_delta::bigint < account_row.reserved or
     account_row.balance::bigint+p_delta::bigint > 2000000000 then
    raise exception 'INVALID_CREDIT_BALANCE';
  end if;
  insert into public.studio_credit_adjustments
    (request_id,user_id,actor_id,delta,reason)
  values (p_request_id,p_user_id,p_actor_id,p_delta,p_reason)
  on conflict (request_id) do nothing returning request_id into inserted_id;
  if inserted_id is null then
    select * into adjustment_row from public.studio_credit_adjustments
      where request_id = p_request_id;
    if adjustment_row.actor_id <> p_actor_id or adjustment_row.user_id <> p_user_id or
       adjustment_row.delta <> p_delta or adjustment_row.reason <> p_reason then
      raise exception 'CREDIT_REQUEST_CONFLICT';
    end if;
    return jsonb_build_object('created',false,'balance',account_row.balance,
      'reserved',account_row.reserved,
      'available',account_row.balance-account_row.reserved);
  end if;
  update public.studio_credit_accounts set balance = balance+p_delta,
    updated_at = now() where user_id = p_user_id returning * into account_row;
  insert into public.studio_credit_events
    (user_id,request_id,event_type,balance_delta,reserved_delta,balance_after,reserved_after)
  values (p_user_id,p_request_id,'adjust',p_delta,0,
    account_row.balance,account_row.reserved);
  return jsonb_build_object('created',true,'balance',account_row.balance,
    'reserved',account_row.reserved,
    'available',account_row.balance-account_row.reserved);
end;
$$;

-- Only Vercel server code holding SUPABASE_SERVICE_ROLE_KEY may use these.
-- The authenticated browser role cannot reserve, settle, refund, or grant.
create or replace function public.studio_credit_reserve(
  p_user_id uuid, p_request_id uuid, p_kind text, p_credits integer,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb language sql security invoker set search_path = '' as $$
  select studio_private.credit_reserve(p_user_id,p_request_id,p_kind,p_credits,p_metadata);
$$;
create or replace function public.studio_credit_settle(
  p_user_id uuid, p_request_id uuid, p_charge_credits integer,
  p_provider_usage jsonb default '{}'::jsonb
) returns jsonb language sql security invoker set search_path = '' as $$
  select studio_private.credit_settle(p_user_id,p_request_id,p_charge_credits,p_provider_usage);
$$;
create or replace function public.studio_credit_refund(
  p_user_id uuid, p_request_id uuid
) returns jsonb language sql security invoker set search_path = '' as $$
  select studio_private.credit_refund(p_user_id,p_request_id);
$$;
create or replace function public.studio_credit_mark_provider_task(
  p_user_id uuid, p_request_id uuid, p_provider_task_id text
) returns void language sql security invoker set search_path = '' as $$
  select studio_private.credit_mark_provider_task(p_user_id,p_request_id,p_provider_task_id);
$$;
create or replace function public.studio_credit_adjust(
  p_actor_id uuid, p_user_id uuid, p_request_id uuid,
  p_delta integer, p_reason text
) returns jsonb language sql security invoker set search_path = '' as $$
  select studio_private.credit_adjust(p_actor_id,p_user_id,p_request_id,p_delta,p_reason);
$$;

revoke all on function studio_private.credit_reserve(uuid,uuid,text,integer,jsonb),
  studio_private.credit_settle(uuid,uuid,integer,jsonb),
  studio_private.credit_refund(uuid,uuid),
  studio_private.credit_mark_provider_task(uuid,uuid,text),
  studio_private.credit_adjust(uuid,uuid,uuid,integer,text)
  from public, anon, authenticated;
grant execute on function studio_private.credit_reserve(uuid,uuid,text,integer,jsonb),
  studio_private.credit_settle(uuid,uuid,integer,jsonb),
  studio_private.credit_refund(uuid,uuid),
  studio_private.credit_mark_provider_task(uuid,uuid,text),
  studio_private.credit_adjust(uuid,uuid,uuid,integer,text)
  to service_role;
revoke all on function public.studio_credit_reserve(uuid,uuid,text,integer,jsonb),
  public.studio_credit_settle(uuid,uuid,integer,jsonb),
  public.studio_credit_refund(uuid,uuid),
  public.studio_credit_mark_provider_task(uuid,uuid,text),
  public.studio_credit_adjust(uuid,uuid,uuid,integer,text)
  from public, anon, authenticated;
grant execute on function public.studio_credit_reserve(uuid,uuid,text,integer,jsonb),
  public.studio_credit_settle(uuid,uuid,integer,jsonb),
  public.studio_credit_refund(uuid,uuid),
  public.studio_credit_mark_provider_task(uuid,uuid,text),
  public.studio_credit_adjust(uuid,uuid,uuid,integer,text)
  to service_role;

commit;
