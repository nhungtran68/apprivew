-- Run after migrations/20261019103324_payos_credit_orders.sql.
-- All order and wallet changes are rolled back before PASS.
begin;
set local role service_role;
do $payment_test$
declare
  v_user uuid;
  v_balance integer;
  v_reserved integer;
  v_pack_id text;
  v_credits integer;
  v_price integer;
  v_order_1 uuid := gen_random_uuid();
  v_order_2 uuid := gen_random_uuid();
  v_order_3 uuid := gen_random_uuid();
  v_order_4 uuid := gen_random_uuid();
  v_code_1 bigint := floor(extract(epoch from clock_timestamp()) * 1000000)::bigint;
  v_ref text := gen_random_uuid()::text;
  v_response jsonb;
  v_current integer;
begin
  if has_function_privilege('anon',
       'public.studio_payment_mark_paid(bigint,integer,text)', 'EXECUTE') or
     has_function_privilege('authenticated',
       'public.studio_payment_mark_paid(bigint,integer,text)', 'EXECUTE') or
     has_table_privilege('authenticated',
       'public.studio_payment_orders', 'INSERT') then
    raise exception 'BROWSER_PAYMENT_WRITE_PERMISSION';
  end if;

  select a.user_id,a.balance,a.reserved into v_user,v_balance,v_reserved
  from public.studio_credit_accounts a
  join public.studio_members m on m.user_id = a.user_id
  where m.enabled order by a.balance desc limit 1;
  if v_user is null then raise exception 'TEST_MEMBER_MISSING'; end if;
  select id,credits,price_vnd into v_pack_id,v_credits,v_price
  from public.studio_payment_packs where enabled order by sort_order limit 1;
  if v_pack_id is null then raise exception 'ACTIVE_PAYMENT_PACK_MISSING'; end if;

  v_response := public.studio_payment_create(
    v_user,v_order_1,v_code_1,v_pack_id,v_credits,v_price);
  if v_response->>'created' <> 'true' or v_response->>'status' <> 'pending' then
    raise exception 'CREATE_ORDER_FAILED';
  end if;
  v_response := public.studio_payment_create(
    v_user,v_order_1,v_code_1,v_pack_id,v_credits,v_price);
  if v_response->>'created' <> 'false' then
    raise exception 'DUPLICATE_ORDER_CREATED';
  end if;
  if not public.studio_payment_begin_reconcile(v_code_1,v_user) or
     public.studio_payment_begin_reconcile(v_code_1,v_user) then
    raise exception 'RECONCILE_RATE_LIMIT_FAILED';
  end if;
  begin
    perform public.studio_payment_create(
      v_user,v_order_1,v_code_1,v_pack_id,v_credits,v_price+1000);
    raise exception 'ALTERED_ORDER_WAS_ACCEPTED';
  exception when others then
    if sqlerrm <> 'PAYMENT_ORDER_CONFLICT' then raise; end if;
  end;
  begin
    perform public.studio_payment_mark_paid(v_code_1,v_price+1000,v_ref);
    raise exception 'WRONG_AMOUNT_WAS_ACCEPTED';
  exception when others then
    if sqlerrm <> 'PAYMENT_AMOUNT_MISMATCH' then raise; end if;
  end;

  v_response := public.studio_payment_set_link(
    v_order_1,'https://pay.payos.vn/web/test',v_ref);
  if v_response->>'created' <> 'true' then raise exception 'SAVE_LINK_FAILED'; end if;
  v_response := public.studio_payment_mark_paid(v_code_1,v_price,v_ref);
  if v_response->>'created' <> 'true' or v_response->>'status' <> 'paid' then
    raise exception 'SETTLE_PAYMENT_FAILED';
  end if;
  v_response := public.studio_payment_mark_paid(v_code_1,v_price,v_ref);
  if v_response->>'created' <> 'false' then
    raise exception 'DUPLICATE_PAYMENT_CREDITED';
  end if;
  begin
    perform public.studio_payment_mark_paid(v_code_1,v_price,gen_random_uuid()::text);
    raise exception 'SECOND_REFERENCE_WAS_ACCEPTED';
  exception when others then
    if sqlerrm not in ('PAYMENT_LINK_CONFLICT','PAYMENT_REFERENCE_CONFLICT') then raise; end if;
  end;
  select balance into v_current from public.studio_credit_accounts where user_id=v_user;
  if v_current <> v_balance+v_credits or
     (select count(*) from public.studio_credit_events
       where request_id=v_order_1 and event_type='purchase') <> 1 then
    raise exception 'PURCHASE_LEDGER_MISMATCH';
  end if;

  -- A cancelled/expired order can still settle if the provider confirms that
  -- money was actually received; a stale close notification cannot undo it.
  perform public.studio_payment_create(
    v_user,v_order_2,v_code_1+1,v_pack_id,v_credits,v_price);
  v_response := public.studio_payment_mark_closed(v_code_1+1,'expired');
  if v_response->>'status' <> 'expired' then raise exception 'EXPIRE_FAILED'; end if;
  v_response := public.studio_payment_mark_paid(
    v_code_1+1,v_price,gen_random_uuid()::text);
  if v_response->>'status' <> 'paid' then raise exception 'LATE_PAYMENT_NOT_CREDITED'; end if;
  v_response := public.studio_payment_mark_closed(v_code_1+1,'cancelled');
  if v_response->>'created' <> 'false' or v_response->>'status' <> 'paid' then
    raise exception 'PAID_ORDER_WAS_CLOSED';
  end if;

  -- A provider transaction reference cannot be reused for a different order.
  perform public.studio_payment_create(
    v_user,v_order_3,v_code_1+2,v_pack_id,v_credits,v_price);
  begin
    perform public.studio_payment_mark_paid(v_code_1+2,v_price,v_ref);
    raise exception 'REUSED_REFERENCE_WAS_ACCEPTED';
  exception when unique_violation then null;
  end;

  -- Webhook may arrive before the create-link response is saved. The later
  -- link must match the paymentLinkId used to grant credits.
  perform public.studio_payment_create(
    v_user,v_order_4,v_code_1+3,v_pack_id,v_credits,v_price);
  perform public.studio_payment_mark_paid(
    v_code_1+3,v_price,gen_random_uuid()::text);
  begin
    perform public.studio_payment_set_link(
      v_order_4,'https://pay.payos.vn/web/test',gen_random_uuid()::text);
    raise exception 'CROSS_LINK_WAS_ACCEPTED';
  exception when others then
    if sqlerrm <> 'PAYMENT_LINK_CONFLICT' then raise; end if;
  end;
  select balance,reserved into v_current,v_reserved
  from public.studio_credit_accounts where user_id=v_user;
  if v_current <> v_balance+3*v_credits or
     (select count(*) from public.studio_credit_events
       where request_id in (v_order_1,v_order_2,v_order_3,v_order_4)
         and event_type='purchase') <> 3 then
    raise exception 'FINAL_PAYMENT_BALANCE_MISMATCH';
  end if;
end
$payment_test$;
rollback;
select 'payment_order_transaction_test_passed' as result;
