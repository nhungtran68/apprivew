-- Run after credits-ledger.sql. This exercises the public RPCs as the server
-- role and rolls back every test transaction before returning PASS.
begin;
set local role service_role;
do $credit_test$
declare
  v_user uuid;
  v_balance integer;
  v_reserved integer;
  v_after_balance integer;
  v_after_reserved integer;
  v_one uuid := gen_random_uuid();
  v_two uuid := gen_random_uuid();
  v_response jsonb;
begin
  select user_id, balance, reserved into v_user, v_balance, v_reserved
  from public.studio_credit_accounts
  where balance - reserved >= 25
  order by balance - reserved desc limit 1;
  if v_user is null then raise exception 'TEST_MEMBER_WITH_25_CREDITS_MISSING'; end if;

  v_response := public.studio_credit_reserve(v_user,v_one,'script',10,'{}'::jsonb);
  if v_response->>'created' <> 'true' or v_response->>'status' <> 'reserved' then
    raise exception 'RESERVE_FAILED';
  end if;
  v_response := public.studio_credit_reserve(v_user,v_one,'script',10,'{}'::jsonb);
  if v_response->>'created' <> 'false' then raise exception 'DUPLICATE_RESERVE_FAILED'; end if;
  v_response := public.studio_credit_settle(v_user,v_one,10,'{}'::jsonb);
  if v_response->>'created' <> 'true' or v_response->>'status' <> 'settled' then
    raise exception 'SETTLE_FAILED';
  end if;
  v_response := public.studio_credit_settle(v_user,v_one,10,'{}'::jsonb);
  if v_response->>'created' <> 'false' then raise exception 'DUPLICATE_SETTLE_FAILED'; end if;

  v_response := public.studio_credit_reserve(v_user,v_two,'analyze',15,'{}'::jsonb);
  if v_response->>'created' <> 'true' then raise exception 'REFUND_SETUP_FAILED'; end if;
  v_response := public.studio_credit_refund(v_user,v_two);
  if v_response->>'created' <> 'true' or v_response->>'status' <> 'refunded' then
    raise exception 'REFUND_FAILED';
  end if;
  v_response := public.studio_credit_refund(v_user,v_two);
  if v_response->>'created' <> 'false' then raise exception 'DUPLICATE_REFUND_FAILED'; end if;

  select balance,reserved into v_after_balance,v_after_reserved
  from public.studio_credit_accounts where user_id=v_user;
  if v_after_balance <> v_balance-10 or v_after_reserved <> v_reserved then
    raise exception 'BALANCE_MISMATCH';
  end if;
  if (select count(*) from public.studio_credit_events where request_id in (v_one,v_two)) <> 4 then
    raise exception 'EVENT_COUNT_MISMATCH';
  end if;

  begin
    perform public.studio_credit_reserve(v_user,gen_random_uuid(),'script',v_after_balance-v_after_reserved+1,'{}'::jsonb);
    raise exception 'OVERSPEND_WAS_ACCEPTED';
  exception when others then
    if sqlerrm <> 'INSUFFICIENT_CREDITS' then raise; end if;
  end;
end
$credit_test$;
rollback;
select 'credit_transaction_test_passed' as result;
