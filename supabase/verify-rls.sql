-- Lời Kể: transactional RLS/RPC verification for the schema in supabase/setup.sql.
-- Execute as the project database owner, not through the public Data API.
-- No email/password/login/API request is made. All auth users below are test-only.
-- Every fixture write is in one DO subtransaction, and the outer transaction is
-- explicitly rolled back. An unexpected SQLSTATE or failed assertion propagates.
-- If a SQL client stops on the first error, issue ROLLBACK before reusing it.
-- UUIDs were generated with node:crypto.randomUUID solely for this test file.

begin;
set local statement_timeout = '60s';
set local lock_timeout = '5s';

do $studio_rls_checks$
declare
  admin_id constant uuid := '5336545b-96bd-4163-845b-9fc247c5f06f';
  member_id constant uuid := '1758001e-a569-4348-8b68-90a6ccdfce49';
  other_id constant uuid := 'f3103a83-3429-47f6-b061-85d9c70d6dc9';
  disabled_id constant uuid := 'cffedd59-c2a4-47c6-955b-d02f98034a24';
  fixture_ids constant uuid[] := array[admin_id,member_id,other_id,disabled_id];
  affected bigint;
  remaining integer;
  attempted integer;
  rejected boolean;
  statement text;
  check_name text;
  checks text[] := '{}'::text[];
  row_data record;
begin
  -- Prevent a surprising launch role or an existing fixture collision from
  -- converting the owner setup into an RLS-constrained or destructive test.
  if current_user not in ('postgres','supabase_admin') then
    raise exception 'TEST_REQUIRES_PROJECT_DATABASE_OWNER: %', current_user;
  end if;
  if exists(select 1 from auth.users where id=any(fixture_ids)) then
    raise exception 'TEST_FIXTURE_UUID_ALREADY_EXISTS';
  end if;
  if exists(select 1 from public.studio_members where user_id=any(fixture_ids)) then
    raise exception 'TEST_MEMBER_FIXTURE_ALREADY_EXISTS';
  end if;

  -- User-editable metadata is deliberately hostile. The signup trigger must
  -- copy only the email and must use safe membership defaults in every case.
  insert into auth.users(id,email,raw_user_meta_data)
  select id, id::text || '@example.invalid',
    jsonb_build_object('role','admin','enabled',true,'ai_units_limit',100000,
      'ai_units_used',-100,'display_name','TEST PRIVILEGE INJECTION')
  from unnest(fixture_ids) as fixtures(id);

  select count(*) into affected from public.studio_members where user_id=any(fixture_ids);
  if affected<>4 then raise exception 'CHECK_FAILED signup_trigger_provisions_four_members: %', affected; end if;
  if exists(select 1 from public.studio_members where user_id=any(fixture_ids)
    and (role<>'member' or enabled or ai_units_limit<>0 or ai_units_used<>0 or display_name<>''
      or email<>user_id::text || '@example.invalid')) then
    raise exception 'CHECK_FAILED signup_trigger_ignores_privileged_user_metadata';
  end if;
  checks := checks || array['signup_trigger_provisions_members','signup_trigger_ignores_privileged_metadata'];

  update public.studio_members set role='admin',enabled=true,ai_units_limit=1000 where user_id=admin_id;
  update public.studio_members set enabled=true,ai_units_limit=10 where user_id=member_id;
  update public.studio_members set enabled=true,ai_units_limit=20 where user_id=other_id;
  update public.studio_members set enabled=false,ai_units_limit=10 where user_id=disabled_id;
  insert into public.studio_settings(user_id,profile_json) values
    (other_id,'{"marker":"foreign-profile"}'::jsonb),
    (disabled_id,'{"marker":"disabled-profile"}'::jsonb);
  insert into public.studio_voices(user_id,voice_id,name,source,authorization_tag) values
    (other_id,'test-foreign-voice','Foreign fixture voice','personal','TEST_ONLY_FOREIGN'),
    (disabled_id,'test-disabled-voice','Disabled fixture voice','personal','TEST_ONLY_DISABLED');

  perform set_config('request.jwt.claim.sub',member_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_id,'role','authenticated',
    'user_metadata',jsonb_build_object('role','admin','enabled',true,'ai_units_limit',100000))::text,true);
  execute 'set local role authenticated';
  if auth.uid() is distinct from member_id then raise exception 'CHECK_FAILED authenticated_member_impersonation'; end if;
  if studio_private.is_admin() is distinct from false or studio_private.is_enabled() is distinct from true then
    raise exception 'CHECK_FAILED editable_jwt_metadata_cannot_grant_admin';
  end if;
  checks := checks || array['member_impersonation','editable_jwt_metadata_not_authorization'];

  select count(*) into affected from public.studio_members where user_id=member_id;
  if affected<>1 then raise exception 'CHECK_FAILED member_reads_own_membership'; end if;
  select count(*) into affected from public.studio_members where user_id=any(array[admin_id,other_id,disabled_id]);
  if affected<>0 then raise exception 'CHECK_FAILED member_cannot_read_foreign_memberships'; end if;
  checks := checks || array['member_reads_own_membership','member_cannot_read_foreign_memberships'];

  -- Protected columns have no authenticated UPDATE grant, including for admins.
  for statement,check_name in
    select * from (values
      (format('update public.studio_members set role=''admin'' where user_id=%L',member_id),'member_cannot_change_role'),
      (format('update public.studio_members set email=''changed@example.invalid'' where user_id=%L',member_id),'member_cannot_change_membership_email'),
      (format('update public.studio_members set user_id=%L where user_id=%L',admin_id,member_id),'member_cannot_change_membership_owner'),
      (format('insert into public.studio_members(user_id,email) values(%L,''injected@example.invalid'')',member_id),'member_cannot_insert_memberships'),
      (format('delete from public.studio_members where user_id=%L',member_id),'member_cannot_delete_memberships')
    ) as attempts(sql,check_id)
  loop
    rejected := false;
    begin execute statement;
    exception when insufficient_privilege then rejected:=true;
    end;
    if not rejected then raise exception 'CHECK_FAILED % (expected SQLSTATE 42501)',check_name; end if;
    checks:=array_append(checks,check_name);
  end loop;

  -- Granted quota/enabled columns still require the admin UPDATE RLS policy.
  for statement,check_name in
    select * from (values
      (format('update public.studio_members set enabled=false where user_id=%L',member_id),'member_cannot_change_enabled'),
      (format('update public.studio_members set ai_units_limit=100000 where user_id=%L',member_id),'member_cannot_raise_quota'),
      (format('update public.studio_members set ai_units_used=999 where user_id=%L',member_id),'member_cannot_change_usage'),
      (format('update public.studio_members set ai_units_limit=100000 where user_id=%L',other_id),'member_cannot_change_foreign_quota')
    ) as attempts(sql,check_id)
  loop
    execute statement;
    get diagnostics affected=row_count;
    if affected<>0 then raise exception 'CHECK_FAILED % (affected %)',check_name,affected; end if;
    checks:=array_append(checks,check_name);
  end loop;
  select * into row_data from public.studio_members where user_id=member_id;
  if row_data.role<>'member' or not row_data.enabled or row_data.ai_units_limit<>10 or row_data.ai_units_used<>0 then
    raise exception 'CHECK_FAILED protected_membership_values_unchanged';
  end if;
  checks:=array_append(checks,'protected_membership_values_unchanged');

  -- Real profile INSERT/SELECT/UPDATE/DELETE by its owner.
  insert into public.studio_settings(user_id,profile_json) values(member_id,'{"marker":"own-profile"}'::jsonb);
  select count(*) into affected from public.studio_settings where user_id=member_id and profile_json->>'marker'='own-profile';
  if affected<>1 then raise exception 'CHECK_FAILED profile_own_insert_select'; end if;
  update public.studio_settings set profile_json='{"marker":"own-profile-updated"}'::jsonb where user_id=member_id;
  get diagnostics affected=row_count;
  if affected<>1 then raise exception 'CHECK_FAILED profile_own_update'; end if;
  select count(*) into affected from public.studio_settings where user_id=member_id and profile_json->>'marker'='own-profile-updated';
  if affected<>1 then raise exception 'CHECK_FAILED profile_own_update_persisted'; end if;
  select count(*) into affected from public.studio_settings where user_id=other_id;
  if affected<>0 then raise exception 'CHECK_FAILED profile_foreign_select_denied'; end if;
  checks:=checks || array['profile_own_insert_select','profile_own_update','profile_foreign_select_denied'];

  for statement,check_name in
    select * from (values
      (format('update public.studio_settings set profile_json=''{}''::jsonb where user_id=%L',other_id),'profile_foreign_update_denied'),
      (format('delete from public.studio_settings where user_id=%L',other_id),'profile_foreign_delete_denied')
    ) as attempts(sql,check_id)
  loop
    execute statement; get diagnostics affected=row_count;
    if affected<>0 then raise exception 'CHECK_FAILED %',check_name; end if;
    checks:=array_append(checks,check_name);
  end loop;
  for statement,check_name in
    select * from (values
      (format('insert into public.studio_settings(user_id,profile_json) values(%L,''{}''::jsonb)',admin_id),'profile_foreign_insert_denied'),
      (format('update public.studio_settings set user_id=%L where user_id=%L',admin_id,member_id),'profile_owner_reassignment_denied')
    ) as attempts(sql,check_id)
  loop
    rejected:=false;
    begin execute statement; exception when insufficient_privilege then rejected:=true; end;
    if not rejected then raise exception 'CHECK_FAILED % (expected SQLSTATE 42501)',check_name; end if;
    checks:=array_append(checks,check_name);
  end loop;
  delete from public.studio_settings where user_id=member_id;
  get diagnostics affected=row_count;
  if affected<>1 then raise exception 'CHECK_FAILED profile_own_delete'; end if;
  if exists(select 1 from public.studio_settings where user_id=member_id) then raise exception 'CHECK_FAILED profile_delete_persisted'; end if;
  insert into public.studio_settings(user_id,profile_json) values(member_id,'{"marker":"own-profile-restored"}'::jsonb);
  checks:=array_append(checks,'profile_own_delete');

  -- Real voice INSERT/SELECT/UPDATE/DELETE, plus WITH CHECK ownership protection.
  insert into public.studio_voices(user_id,voice_id,name,source,authorization_tag)
    values(member_id,'test-own-voice','Own fixture voice','personal','TEST_ONLY_OWN');
  select count(*) into affected from public.studio_voices where user_id=member_id and voice_id='test-own-voice';
  if affected<>1 then raise exception 'CHECK_FAILED voice_own_insert_select'; end if;
  update public.studio_voices set name='Updated own fixture voice' where user_id=member_id and voice_id='test-own-voice';
  get diagnostics affected=row_count;
  if affected<>1 then raise exception 'CHECK_FAILED voice_own_update'; end if;
  select count(*) into affected from public.studio_voices where user_id=member_id and name='Updated own fixture voice';
  if affected<>1 then raise exception 'CHECK_FAILED voice_own_update_persisted'; end if;
  select count(*) into affected from public.studio_voices where user_id=other_id;
  if affected<>0 then raise exception 'CHECK_FAILED voice_foreign_select_denied'; end if;
  checks:=checks || array['voice_own_insert_select','voice_own_update','voice_foreign_select_denied'];
  for statement,check_name in
    select * from (values
      (format('update public.studio_voices set name=''stolen'' where user_id=%L',other_id),'voice_foreign_update_denied'),
      (format('delete from public.studio_voices where user_id=%L',other_id),'voice_foreign_delete_denied')
    ) as attempts(sql,check_id)
  loop
    execute statement; get diagnostics affected=row_count;
    if affected<>0 then raise exception 'CHECK_FAILED %',check_name; end if;
    checks:=array_append(checks,check_name);
  end loop;
  for statement,check_name in
    select * from (values
      (format('insert into public.studio_voices(user_id,voice_id,name,source,authorization_tag) values(%L,''test-attack-voice'',''attack'',''personal'',''TEST_ONLY_DENIED'')',admin_id),'voice_foreign_insert_denied'),
      (format('update public.studio_voices set user_id=%L where user_id=%L and voice_id=''test-own-voice''',admin_id,member_id),'voice_owner_reassignment_denied')
    ) as attempts(sql,check_id)
  loop
    rejected:=false;
    begin execute statement; exception when insufficient_privilege then rejected:=true; end;
    if not rejected then raise exception 'CHECK_FAILED % (expected SQLSTATE 42501)',check_name; end if;
    checks:=array_append(checks,check_name);
  end loop;
  delete from public.studio_voices where user_id=member_id and voice_id='test-own-voice';
  get diagnostics affected=row_count;
  if affected<>1 then raise exception 'CHECK_FAILED voice_own_delete'; end if;
  if exists(select 1 from public.studio_voices where user_id=member_id and voice_id='test-own-voice') then raise exception 'CHECK_FAILED voice_delete_persisted'; end if;
  insert into public.studio_voices(user_id,voice_id,name,source,authorization_tag)
    values(member_id,'test-own-voice','Restored own fixture voice','personal','TEST_ONLY_OWN');
  checks:=array_append(checks,'voice_own_delete');

  -- The public RPC can consume only the caller's allowance and returns the
  -- remaining balance. Invalid/over-limit calls must neither spend nor refund.
  remaining:=public.consume_studio_ai_units(1);
  if remaining<>9 then raise exception 'CHECK_FAILED consume_one_returns_nine: %',remaining; end if;
  remaining:=public.consume_studio_ai_units(2);
  if remaining<>7 then raise exception 'CHECK_FAILED consume_two_returns_seven: %',remaining; end if;
  select ai_units_used into attempted from public.studio_members where user_id=member_id;
  if attempted<>3 then raise exception 'CHECK_FAILED consumption_persists_own_usage'; end if;
  checks:=checks || array['consume_one_unit','consume_multiple_units','consumption_updates_own_usage'];
  foreach attempted in array array[0,-1,null,10001,2147483647]
  loop
    rejected:=false;
    begin perform public.consume_studio_ai_units(attempted);
    exception when raise_exception then
      if sqlerrm<>'INVALID_AI_UNITS' then raise; end if;
      rejected:=true;
    end;
    if not rejected then raise exception 'CHECK_FAILED invalid_units_rejected: %',attempted; end if;
    checks:=array_append(checks,'consume_rejects_' || coalesce(attempted::text,'null'));
  end loop;
  select ai_units_used into attempted from public.studio_members where user_id=member_id;
  if attempted<>3 then raise exception 'CHECK_FAILED invalid_calls_do_not_change_usage'; end if;
  checks:=array_append(checks,'invalid_calls_do_not_spend_or_refund');
  rejected:=false;
  begin perform public.consume_studio_ai_units(8);
  exception when raise_exception then
    if sqlerrm<>'QUOTA_EXCEEDED' then raise; end if;
    rejected:=true;
  end;
  if not rejected then raise exception 'CHECK_FAILED over_quota_rejected'; end if;
  select ai_units_used into attempted from public.studio_members where user_id=member_id;
  if attempted<>3 then raise exception 'CHECK_FAILED over_quota_call_not_partially_consumed'; end if;
  remaining:=public.consume_studio_ai_units(7);
  if remaining<>0 then raise exception 'CHECK_FAILED exact_quota_boundary: %',remaining; end if;
  rejected:=false;
  begin perform public.consume_studio_ai_units(1);
  exception when raise_exception then
    if sqlerrm<>'QUOTA_EXCEEDED' then raise; end if;
    rejected:=true;
  end;
  if not rejected then raise exception 'CHECK_FAILED exhausted_quota_rejected'; end if;
  update public.studio_members set ai_units_used=0 where user_id=member_id;
  get diagnostics affected=row_count;
  if affected<>0 then raise exception 'CHECK_FAILED member_cannot_refund_consumed_units'; end if;
  select ai_units_used into attempted from public.studio_members where user_id=member_id;
  if attempted<>10 then raise exception 'CHECK_FAILED exhausted_usage_unchanged'; end if;
  checks:=checks || array['over_quota_rejected_atomically','exact_quota_boundary_returns_zero','exhausted_quota_rejected','member_cannot_refund_consumed_units'];

  -- Disabled members retain visibility of their own membership status, while
  -- profile/voice data and quota use are unavailable immediately.
  perform set_config('request.jwt.claim.sub',disabled_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',disabled_id,'role','authenticated',
    'user_metadata',jsonb_build_object('role','admin','enabled',true))::text,true);
  if studio_private.is_enabled() is distinct from false or studio_private.is_admin() is distinct from false then
    raise exception 'CHECK_FAILED disabled_metadata_does_not_enable_member';
  end if;
  select count(*) into affected from public.studio_members where user_id=disabled_id and not enabled;
  if affected<>1 then raise exception 'CHECK_FAILED disabled_member_reads_own_status'; end if;
  if exists(select 1 from public.studio_settings where user_id=disabled_id)
    or exists(select 1 from public.studio_voices where user_id=disabled_id) then
    raise exception 'CHECK_FAILED disabled_cannot_read_own_profile_or_voices';
  end if;
  checks:=checks || array['disabled_metadata_cannot_enable','disabled_reads_own_status','disabled_profile_voice_select_denied'];
  for statement,check_name in
    select * from (values
      (format('update public.studio_settings set profile_json=''{}''::jsonb where user_id=%L',disabled_id),'disabled_profile_update_denied'),
      (format('delete from public.studio_settings where user_id=%L',disabled_id),'disabled_profile_delete_denied'),
      (format('update public.studio_voices set name=''changed'' where user_id=%L',disabled_id),'disabled_voice_update_denied'),
      (format('delete from public.studio_voices where user_id=%L',disabled_id),'disabled_voice_delete_denied'),
      (format('update public.studio_members set enabled=true where user_id=%L',disabled_id),'disabled_cannot_self_enable')
    ) as attempts(sql,check_id)
  loop
    execute statement; get diagnostics affected=row_count;
    if affected<>0 then raise exception 'CHECK_FAILED %',check_name; end if;
    checks:=array_append(checks,check_name);
  end loop;
  for statement,check_name in
    select * from (values
      (format('insert into public.studio_settings(user_id,profile_json) values(%L,''{}''::jsonb)',disabled_id),'disabled_profile_insert_denied'),
      (format('insert into public.studio_voices(user_id,voice_id,name,source,authorization_tag) values(%L,''test-new-disabled'',''disabled'',''personal'',''TEST_ONLY_DENIED'')',disabled_id),'disabled_voice_insert_denied')
    ) as attempts(sql,check_id)
  loop
    rejected:=false;
    begin execute statement; exception when insufficient_privilege then rejected:=true; end;
    if not rejected then raise exception 'CHECK_FAILED %',check_name; end if;
    checks:=array_append(checks,check_name);
  end loop;
  rejected:=false;
  begin perform public.consume_studio_ai_units(1);
  exception when raise_exception then if sqlerrm<>'MEMBER_DISABLED' then raise; end if; rejected:=true;
  end;
  if not rejected then raise exception 'CHECK_FAILED disabled_cannot_consume'; end if;
  checks:=array_append(checks,'disabled_cannot_consume');

  -- Real admin updates allowed columns, reads all fixture memberships, and
  -- immediately disables another member without relying on refreshed JWT data.
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  if studio_private.is_admin() is distinct from true then raise exception 'CHECK_FAILED enabled_database_admin_recognized'; end if;
  select count(*) into affected from public.studio_members where user_id=any(fixture_ids);
  if affected<>4 then raise exception 'CHECK_FAILED admin_reads_all_fixture_memberships'; end if;
  update public.studio_members set enabled=false,ai_units_limit=15,ai_units_used=2,updated_at=now() where user_id=member_id;
  get diagnostics affected=row_count;
  if affected<>1 then raise exception 'CHECK_FAILED admin_updates_member_controls'; end if;
  select * into row_data from public.studio_members where user_id=member_id;
  if row_data.enabled or row_data.ai_units_limit<>15 or row_data.ai_units_used<>2 then raise exception 'CHECK_FAILED admin_update_values_persisted'; end if;
  -- Admin status does not grant access to another member's private content.
  if exists(select 1 from public.studio_settings where user_id=other_id)
    or exists(select 1 from public.studio_voices where user_id=other_id) then
    raise exception 'CHECK_FAILED admin_cannot_read_foreign_private_content';
  end if;
  rejected:=false;
  begin update public.studio_members set role='admin' where user_id=other_id;
  exception when insufficient_privilege then rejected:=true;
  end;
  if not rejected then raise exception 'CHECK_FAILED browser_admin_cannot_promote_roles'; end if;
  select ai_units_used into attempted from public.studio_members where user_id=other_id;
  if attempted<>0 then raise exception 'CHECK_FAILED rpc_never_consumed_foreign_allowance'; end if;
  checks:=checks || array['admin_reads_memberships','admin_updates_enabled_and_quota','admin_private_content_not_bypassed','browser_admin_cannot_promote_roles','rpc_never_consumes_foreign_allowance'];
  perform set_config('request.jwt.claim.sub',member_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_id,'role','authenticated')::text,true);
  if exists(select 1 from public.studio_settings where user_id=member_id)
    or exists(select 1 from public.studio_voices where user_id=member_id) then
    raise exception 'CHECK_FAILED admin_disabling_immediately_blocks_private_content';
  end if;
  rejected:=false;
  begin perform public.consume_studio_ai_units(1);
  exception when raise_exception then if sqlerrm<>'MEMBER_DISABLED' then raise; end if; rejected:=true;
  end;
  if not rejected then raise exception 'CHECK_FAILED admin_disabling_immediately_blocks_rpc'; end if;
  checks:=checks || array['admin_disable_immediate_content_block','admin_disable_immediate_rpc_block'];

  -- An authenticated database role without a valid subject is not a signed-in
  -- member. RPC guard must execute even though EXECUTE itself is granted.
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
  if auth.uid() is not null then raise exception 'CHECK_FAILED missing_sub_impersonation'; end if;
  rejected:=false;
  begin perform public.consume_studio_ai_units(1);
  exception when raise_exception then if sqlerrm<>'SIGN_IN_REQUIRED' then raise; end if; rejected:=true;
  end;
  if not rejected then raise exception 'CHECK_FAILED rpc_requires_auth_subject'; end if;
  checks:=array_append(checks,'authenticated_rpc_requires_subject');

  execute 'reset role';
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  execute 'set local role anon';
  for statement,check_name in
    select * from (values
      ('select count(*) from public.studio_members','anon_members_select_denied'),
      ('select count(*) from public.studio_settings','anon_profiles_select_denied'),
      ('select count(*) from public.studio_voices','anon_voices_select_denied'),
      (format('insert into public.studio_settings(user_id,profile_json) values(%L,''{}''::jsonb)',admin_id),'anon_profile_insert_denied'),
      (format('update public.studio_settings set profile_json=''{}''::jsonb where user_id=%L',other_id),'anon_profile_update_denied'),
      (format('delete from public.studio_settings where user_id=%L',other_id),'anon_profile_delete_denied'),
      (format('insert into public.studio_voices(user_id,voice_id,name,source,authorization_tag) values(%L,''test-anon-voice'',''anon'',''personal'',''TEST_ONLY_DENIED'')',admin_id),'anon_voice_insert_denied'),
      (format('update public.studio_voices set name=''changed'' where user_id=%L',other_id),'anon_voice_update_denied'),
      (format('delete from public.studio_voices where user_id=%L',other_id),'anon_voice_delete_denied'),
      ('select public.consume_studio_ai_units(1)','anon_public_rpc_execute_denied'),
      ('select studio_private.consume_units(1)','anon_private_rpc_execute_denied'),
      ('select studio_private.is_admin()','anon_admin_lookup_denied')
    ) as attempts(sql,check_id)
  loop
    rejected:=false;
    begin execute statement; exception when insufficient_privilege then rejected:=true; end;
    if not rejected then raise exception 'CHECK_FAILED % (expected SQLSTATE 42501)',check_name; end if;
    checks:=array_append(checks,check_name);
  end loop;
  execute 'reset role';

  -- Owner checks confirm denied writes did not silently mutate hidden rows.
  if not exists(select 1 from public.studio_settings where user_id=other_id and profile_json->>'marker'='foreign-profile')
    or not exists(select 1 from public.studio_settings where user_id=disabled_id and profile_json->>'marker'='disabled-profile') then
    raise exception 'CHECK_FAILED hidden_profiles_unchanged';
  end if;
  if not exists(select 1 from public.studio_voices where user_id=other_id and name='Foreign fixture voice')
    or not exists(select 1 from public.studio_voices where user_id=disabled_id and name='Disabled fixture voice') then
    raise exception 'CHECK_FAILED hidden_voices_unchanged';
  end if;
  select count(*) into affected from public.studio_members where user_id=any(fixture_ids);
  if affected<>4 then raise exception 'CHECK_FAILED membership_fixtures_still_present_before_rollback'; end if;
  checks:=checks || array['hidden_profiles_unchanged','hidden_voices_unchanged'];
  raise notice 'STUDIO_RLS_CHECKS_PASSED %',jsonb_build_object('count',cardinality(checks),'checks',checks);
exception when others then
  -- The DO block is a subtransaction: propagating the error rolls back all its
  -- fixture writes even if a client stops before the outer ROLLBACK statement.
  raise;
end;
$studio_rls_checks$;

rollback;

-- This executes after ROLLBACK. A failure above propagates and prevents a success
-- report; a passing run must also prove the fixture users/data were removed.
do $studio_rls_cleanup$
declare
  ids constant uuid[]:=array[
    '5336545b-96bd-4163-845b-9fc247c5f06f'::uuid,
    '1758001e-a569-4348-8b68-90a6ccdfce49'::uuid,
    'f3103a83-3429-47f6-b061-85d9c70d6dc9'::uuid,
    'cffedd59-c2a4-47c6-955b-d02f98034a24'::uuid
  ];
begin
  if exists(select 1 from auth.users where id=any(ids))
    or exists(select 1 from public.studio_members where user_id=any(ids))
    or exists(select 1 from public.studio_settings where user_id=any(ids))
    or exists(select 1 from public.studio_voices where user_id=any(ids)) then
    raise exception 'CHECK_FAILED rollback_left_fixture_data';
  end if;
end;
$studio_rls_cleanup$;

select jsonb_build_object(
  'passed',true,
  'fixtures_rolled_back',true,
  'test_users_remaining',0,
  'groups',jsonb_build_array(
    'signup trigger ignores privileged user metadata',
    'membership read isolation and privilege escalation protection',
    'own versus foreign profile and voice CRUD with ownership reassignment protection',
    'quota RPC positive units, zero, negative, null, excessive units and quota boundary',
    'invalid and rejected quota calls cannot spend or refund',
    'disabled members and immediate admin revocation',
    'admin can update enabled/quota controls but cannot promote roles or read private content',
    'anonymous access blocked and authenticated RPC requires a subject',
    'all fixture users and application data absent after rollback'
  )
) as rls_transaction_verification;
