-- Execute as project database owner after supabase/voice-sync-guard.sql.
-- Provider-free and transactional: fixtures and changes are all rolled back.
begin;
set local statement_timeout='60s';
set local lock_timeout='5s';

do $voice_sync_guard_checks$
declare
  admin_id constant uuid := 'a1513010-a5a6-4453-89fd-b4782fab7098';
  member_id constant uuid := '56c32647-e834-496e-a2af-702cd4fb51a3';
  other_id constant uuid := '20c14808-2baa-495d-8843-d684e7fd0b41';
  disabled_id constant uuid := '210d0a3c-c540-4b4b-b4b6-3c70553ed90e';
  fixture_ids constant uuid[] := array[admin_id,member_id,other_id,disabled_id];
  own_id constant text := 'maziao:vieten_speech:guardVerifyOwn';
  external_id constant text := 'maziao:lingual_speech_v2:guardVerifyExternal';
  private_id constant text := 'maziao:vieten_speech:guardVerifyOtherPrivate';
  private_alias constant text := 'maziao:lingual_speech_v2:guardVerifyOtherPrivate';
  pending_id constant text := 'maziao:lingual_speech_v2:guardVerifyOtherPending';
  pending_alias constant text := 'maziao:vieten_speech:guardVerifyOtherPending';
  public_id constant text := 'maziao:vieten_speech:guardVerifyPublic';
  fixture_voices constant text[] := array[own_id,external_id,private_id,private_alias,pending_id,pending_alias,public_id];
  allowed text[];
  statement text;
  rejected boolean;
  affected bigint;
  checks integer := 0;
begin
  if current_user not in ('postgres','supabase_admin') then raise exception 'TEST_REQUIRES_PROJECT_DATABASE_OWNER'; end if;
  if exists(select 1 from auth.users where id=any(fixture_ids))
    or exists(select 1 from public.studio_voices where voice_id=any(fixture_voices))
    or exists(select 1 from public.studio_voices where voice_id='maziao:vieten_speech:guardVerifyExternal')
    or exists(select 1 from public.studio_voice_catalog where voice_id=any(fixture_voices)) then raise exception 'TEST_FIXTURE_ALREADY_EXISTS'; end if;
  insert into auth.users(id,email,raw_user_meta_data)
    select id,id::text || '@example.invalid','{"role":"admin","enabled":true}'::jsonb from unnest(fixture_ids) as fixture(id);
  update public.studio_members set role='admin',enabled=true where user_id=admin_id;
  update public.studio_members set role='member',enabled=true where user_id=any(array[member_id,other_id]);
  update public.studio_members set role='admin',enabled=false where user_id=disabled_id;
  insert into public.studio_voices(user_id,voice_id,name,source,authorization_tag) values
    (admin_id,own_id,'Own private fixture','personal','TEST_ONLY_INVALID_SIGNATURE'),
    (other_id,private_id,'Other private fixture','personal','TEST_ONLY_INVALID_SIGNATURE'),
    (other_id,pending_id,'Other pending fixture','needs_verification','TEST_ONLY_INVALID_SIGNATURE'),
    (other_id,public_id,'Other public grant fixture','shared','TEST_ONLY_INVALID_SIGNATURE');

  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  if not studio_private.is_admin() then raise exception 'CHECK_FAILED active_admin_fixture'; end if;
  checks:=checks+1;
  select public.publishable_studio_admin_voice_ids(fixture_voices) into allowed;
  if cardinality(allowed)<>3 or not own_id=any(allowed) or not external_id=any(allowed) or not public_id=any(allowed)
    or private_id=any(allowed) or private_alias=any(allowed) or pending_id=any(allowed) or pending_alias=any(allowed) then
    raise exception 'CHECK_FAILED other_private_and_pending_excluded_across_models_even_invalid_hmac';
  end if;
  checks:=checks+1;
  if cardinality(public.publishable_studio_admin_voice_ids(array[own_id,own_id]))<>1
    or cardinality(public.publishable_studio_admin_voice_ids('{}'::text[]))<>0 then raise exception 'CHECK_FAILED rpc_deduplication_and_empty'; end if;
  checks:=checks+1;
  for statement in select * from (values
    ('select public.publishable_studio_admin_voice_ids(null::text[])'),
    ('select public.publishable_studio_admin_voice_ids(array[null]::text[])'),
    ('select public.publishable_studio_admin_voice_ids(array[''invalid id''])'),
    ('select public.publishable_studio_admin_voice_ids(array(select ''maziao:vieten_speech:bounded'' || n from generate_series(1,101) as n))')
  ) as invalid(sql)
  loop
    rejected:=false;
    begin execute statement; exception when invalid_parameter_value then rejected:=true; end;
    if not rejected then raise exception 'CHECK_FAILED rpc_rejects_invalid_or_unbounded_ids'; end if;
    checks:=checks+1;
  end loop;
  insert into public.studio_voice_catalog(voice_id,name,kind,enabled) values
    (own_id,'Own published fixture','admin_clone',true),(external_id,'External published fixture','admin_clone',true),
    (public_id,'Public published fixture','system',true),(private_alias,'Hidden private fixture','admin_clone',false);
  select count(*) into affected from public.studio_voice_catalog where voice_id=any(fixture_voices);
  if affected<>4 then raise exception 'CHECK_FAILED allowed_publication_and_hidden_private_draft'; end if;
  checks:=checks+1;
  for statement in select * from (values
    (format('insert into public.studio_voice_catalog(voice_id,name,kind,enabled) values(%L,''blocked'',''admin_clone'',true)',private_id)),
    (format('insert into public.studio_voice_catalog(voice_id,name,kind,enabled) values(%L,''blocked'',''system'',true)',pending_id)),
    (format('update public.studio_voice_catalog set enabled=true where voice_id=%L',private_alias)),
    (format('insert into public.studio_voice_catalog(voice_id,name,kind,enabled) values(%L,''blocked'',''admin_clone'',true) on conflict(voice_id) do update set enabled=true',private_alias))
  ) as denied(sql)
  loop
    rejected:=false;
    begin execute statement; exception when insufficient_privilege then rejected:=true; end;
    if not rejected then raise exception 'CHECK_FAILED direct_publication_cross_model_or_kind_bypass_blocked'; end if;
    checks:=checks+1;
  end loop;
  update public.studio_voice_catalog set name='Still safely hidden',enabled=false where voice_id=private_alias;
  get diagnostics affected=row_count;
  if affected<>1 then raise exception 'CHECK_FAILED admin_can_keep_private_row_hidden'; end if;
  checks:=checks+1;

  perform set_config('request.jwt.claim.sub',member_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_id,'role','authenticated','user_metadata',jsonb_build_object('role','admin'))::text,true);
  for statement in select * from (values
    ('select public.publishable_studio_admin_voice_ids(array[''maziao:vieten_speech:memberProbe''])'),
    ('select studio_private.publishable_admin_voice_ids(array[''maziao:vieten_speech:memberProbe''])'),
    ('insert into public.studio_voice_catalog(voice_id,name,kind,enabled) values(''maziao:vieten_speech:memberProbe'',''blocked'',''admin_clone'',true)')
  ) as denied(sql)
  loop
    rejected:=false;
    begin execute statement; exception when insufficient_privilege then rejected:=true; end;
    if not rejected then raise exception 'CHECK_FAILED member_cannot_probe_or_publish_even_with_editable_admin_metadata'; end if;
    checks:=checks+1;
  end loop;
  if exists(select 1 from public.studio_voice_catalog where voice_id=private_alias) then raise exception 'CHECK_FAILED member_cannot_read_hidden_private_catalog'; end if;
  checks:=checks+1;
  update public.studio_voice_catalog set enabled=false where voice_id=own_id;
  get diagnostics affected=row_count;
  if affected<>0 then raise exception 'CHECK_FAILED member_cannot_hide_catalog'; end if;
  checks:=checks+1;

  perform set_config('request.jwt.claim.sub',disabled_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',disabled_id,'role','authenticated')::text,true);
  rejected:=false;
  begin perform public.publishable_studio_admin_voice_ids(array[own_id]); exception when insufficient_privilege then rejected:=true; end;
  if not rejected then raise exception 'CHECK_FAILED disabled_admin_cannot_probe'; end if;
  checks:=checks+1;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  execute 'set local role anon';
  for statement in select * from (values
    ('select public.publishable_studio_admin_voice_ids(array[''maziao:vieten_speech:anonProbe''])'),
    ('select studio_private.publishable_admin_voice_ids(array[''maziao:vieten_speech:anonProbe''])')
  ) as denied(sql)
  loop
    rejected:=false;
    begin execute statement; exception when insufficient_privilege then rejected:=true; end;
    if not rejected then raise exception 'CHECK_FAILED anon_rpc_denied'; end if;
    checks:=checks+1;
  end loop;
  execute 'reset role';
  if not exists(select 1 from public.studio_voice_catalog where voice_id=own_id and enabled)
    or exists(select 1 from public.studio_voice_catalog where voice_id=any(array[private_id,pending_id]))
    or not exists(select 1 from public.studio_voice_catalog where voice_id=private_alias and not enabled and name='Still safely hidden') then raise exception 'CHECK_FAILED denied_writes_left_rows_intact'; end if;
  checks:=checks+1;

  -- A newly recorded private grant must also block re-publication of an older
  -- catalog row, while allowing an administrator to deactivate it immediately.
  insert into public.studio_voices(user_id,voice_id,name,source,authorization_tag)
    values(other_id,'maziao:vieten_speech:guardVerifyExternal','Later private fixture','personal','TEST_ONLY_INVALID_SIGNATURE');
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  update public.studio_voice_catalog set enabled=false where voice_id=external_id;
  get diagnostics affected=row_count;
  if affected<>1 then raise exception 'CHECK_FAILED admin_can_hide_newly_private_voice'; end if;
  checks:=checks+1;
  rejected:=false;
  begin update public.studio_voice_catalog set enabled=true where voice_id=external_id; exception when insufficient_privilege then rejected:=true; end;
  if not rejected then raise exception 'CHECK_FAILED newly_private_cross_model_voice_cannot_be_reenabled'; end if;
  checks:=checks+1;
  execute 'reset role';
  if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='publishable_studio_admin_voice_ids' and not p.prosecdef)
    or not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='studio_private' and p.proname='publishable_admin_voice_ids' and p.prosecdef and 'search_path=""'=any(p.proconfig)) then
    raise exception 'CHECK_FAILED rpc_privilege_boundary_and_empty_search_path';
  end if;
  checks:=checks+1;
  perform set_config('studio.voice_sync_guard_checks',checks::text,true);
end;
$voice_sync_guard_checks$;

select current_setting('studio.voice_sync_guard_checks')::integer as voice_sync_guard_checks_passed,
  'No provider calls. All fixture changes are rolled back below.' as verification;
rollback;
