-- Protect member clones when importing the provider account's own-voice list.
-- Run after the existing Studio schema. Idempotent; publishes no voices.
begin;

-- The existing primary key starts with user_id, but this private check starts
-- with the provider's raw clone ID, independent of its selected speech model.
create index if not exists studio_voices_maziao_private_raw_idx
  on public.studio_voices ((split_part(voice_id,':',3)),user_id)
  where source in ('personal','needs_verification') and voice_id like 'maziao:%';

create or replace function studio_private.publishable_admin_voice_ids(p_voice_ids text[]) returns text[]
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or studio_private.is_admin() is distinct from true then
    raise exception using errcode='42501',message='ADMIN_REQUIRED';
  end if;
  if p_voice_ids is null or cardinality(p_voice_ids)>100 or exists(
    select 1 from unnest(p_voice_ids) as requested(voice_id)
    where requested.voice_id is null or requested.voice_id !~ '^maziao:(vieten_speech|lingual_speech_v2):[a-zA-Z0-9_-]{1,100}$'
  ) then raise exception using errcode='22023',message='INVALID_VOICE_IDS'; end if;
  -- Only echoes a subset of the caller's bounded input. Never exposes names,
  -- owner UUIDs, private tags, or a private voice list to any caller.
  return array(
    select distinct requested.voice_id from unnest(p_voice_ids) as requested(voice_id)
    where not exists(
      select 1 from public.studio_voices owned
      where owned.user_id<>auth.uid() and owned.source in ('personal','needs_verification')
        and owned.voice_id like 'maziao:%'
        and split_part(owned.voice_id,':',3)=split_part(requested.voice_id,':',3)
    ) order by requested.voice_id
  );
end;
$$;
revoke all on function studio_private.publishable_admin_voice_ids(text[]) from public,anon,authenticated;
grant execute on function studio_private.publishable_admin_voice_ids(text[]) to authenticated;

create or replace function public.publishable_studio_admin_voice_ids(p_voice_ids text[]) returns text[]
language sql stable security invoker set search_path = ''
as $$ select studio_private.publishable_admin_voice_ids(p_voice_ids); $$;
revoke all on function public.publishable_studio_admin_voice_ids(text[]) from public,anon,authenticated;
grant execute on function public.publishable_studio_admin_voice_ids(text[]) to authenticated;

-- Check direct Data API upserts as well as the app's publish route. A caller
-- cannot evade member privacy by labelling an imported clone as "system".
-- Hiding a row is always permitted by this guard; existing admin RLS still
-- governs all writes, including deactivation and non-Maziao catalog records.
create or replace function studio_private.guard_shared_voice_publication() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.enabled and (new.kind='admin_clone' or new.voice_id like 'maziao:%') then
    if not (new.voice_id=any(studio_private.publishable_admin_voice_ids(array[new.voice_id]))) then
      raise exception using errcode='42501',message='VOICE_PUBLICATION_BLOCKED';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function studio_private.guard_shared_voice_publication() from public,anon,authenticated;
drop trigger if exists studio_voice_catalog_publication_guard on public.studio_voice_catalog;
create trigger studio_voice_catalog_publication_guard before insert or update
  on public.studio_voice_catalog for each row execute function studio_private.guard_shared_voice_publication();

commit;
