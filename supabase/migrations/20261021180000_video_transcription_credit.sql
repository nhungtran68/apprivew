-- Allow one separately metered, idempotent Speech-to-Text operation.
-- Apply after credits-ledger.sql. Existing credit balances are unchanged.
begin;

alter table public.studio_credit_operations
  drop constraint if exists studio_credit_operations_kind_check;
alter table public.studio_credit_operations
  add constraint studio_credit_operations_kind_check
  check (kind in ('script','analyze','scene_plan','transcribe','tts','clone','stock_video'));

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

-- Replacing a function retains its existing service_role EXECUTE grant.
commit;
