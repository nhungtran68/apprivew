begin;

alter table public.studio_payment_orders
  add column if not exists last_reconciled_at timestamptz;

create or replace function studio_private.payment_begin_reconcile(
  p_order_code bigint, p_user_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_request_id uuid;
begin
  if p_order_code is null or p_user_id is null then return false; end if;
  update public.studio_payment_orders
    set last_reconciled_at = now()
    where order_code = p_order_code and user_id = p_user_id
      and status <> 'paid'
      and (last_reconciled_at is null or last_reconciled_at < now() - interval '15 seconds')
    returning request_id into v_request_id;
  return v_request_id is not null;
end;
$$;

create or replace function public.studio_payment_begin_reconcile(
  p_order_code bigint, p_user_id uuid
) returns boolean language sql security invoker set search_path = '' as $$
  select studio_private.payment_begin_reconcile(p_order_code,p_user_id);
$$;

revoke all on function
  studio_private.payment_begin_reconcile(bigint,uuid),
  public.studio_payment_begin_reconcile(bigint,uuid)
  from public, anon, authenticated;
grant execute on function
  studio_private.payment_begin_reconcile(bigint,uuid),
  public.studio_payment_begin_reconcile(bigint,uuid)
  to service_role;

commit;
