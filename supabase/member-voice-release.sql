-- A deleted personal clone frees one saved-voice slot. Previously charged AI
-- units stay spent. Only the signed-in owner can release their own row.
create or replace function studio_private.release_voice_clone(p_voice_id text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  member_role text;
  member_enabled boolean;
  removed_voice text;
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  if p_voice_id is null or p_voice_id !~ '^maziao:(vieten_speech|lingual_speech_v2):[a-zA-Z0-9_-]{1,100}$'
    then raise exception 'INVALID_VOICE'; end if;

  -- Serialize slot changes with the existing clone-charge RPC.
  select role, enabled into member_role, member_enabled
    from public.studio_members where user_id = auth.uid() for update;
  if not found or not member_enabled then raise exception 'MEMBER_DISABLED'; end if;
  if member_role <> 'member' then raise exception 'MEMBER_VOICE_ONLY'; end if;

  delete from public.studio_voices
    where user_id = auth.uid() and voice_id = p_voice_id and source = 'personal'
    returning voice_id into removed_voice;
  if removed_voice is null then return false; end if;

  -- Never let a forged or duplicate row lower the counter below the number
  -- of currently saved personal voices. Repeated calls are idempotent.
  update public.studio_members
    set voice_clone_used = greatest(
      voice_clone_used - 1,
      (select count(*)::integer from public.studio_voices
       where user_id = auth.uid() and source = 'personal'),
      0),
      updated_at = now()
    where user_id = auth.uid();
  return true;
end;
$$;
revoke all on function studio_private.release_voice_clone(text) from public, anon;
grant execute on function studio_private.release_voice_clone(text) to authenticated;

create or replace function public.release_studio_voice_clone(p_voice_id text)
returns boolean language sql security invoker set search_path = ''
as $$ select studio_private.release_voice_clone(p_voice_id); $$;
revoke all on function public.release_studio_voice_clone(text) from public, anon;
grant execute on function public.release_studio_voice_clone(text) to authenticated;
