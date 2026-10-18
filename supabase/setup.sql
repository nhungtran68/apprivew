-- Lời Kể: run once in a new Supabase project's SQL Editor as project owner.
-- Shared AI credentials live ONLY in Vercel environment variables.
begin;
create schema if not exists studio_private;
revoke all on schema studio_private from public, anon;
grant usage on schema studio_private to authenticated;

create table if not exists public.studio_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  display_name text not null default '',
  role text not null default 'member' check (role in ('member','admin')),
  enabled boolean not null default true,
  ai_units_limit integer not null default 1000 check (ai_units_limit between 0 and 100000),
  ai_units_used integer not null default 0 check (ai_units_used >= 0),
  voice_clone_limit integer not null default 3 check (voice_clone_limit between 0 and 100),
  voice_clone_used integer not null default 0 check (voice_clone_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.studio_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.studio_voices (
  user_id uuid not null references auth.users(id) on delete cascade,
  voice_id text not null,
  name text not null,
  source text not null check (source in ('personal','needs_verification','shared')),
  authorization_tag text not null,
  verified_at timestamptz not null default now(),
  primary key (user_id,voice_id)
);
create table if not exists public.studio_voice_catalog (
  voice_id text primary key,
  name text not null default '',
  enabled boolean not null default true,
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  kind text not null default 'system' check (kind in ('system','admin_clone')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists studio_members_created_at_idx on public.studio_members(created_at desc);
alter table public.studio_members enable row level security;
alter table public.studio_settings enable row level security;
alter table public.studio_voices enable row level security;
alter table public.studio_voice_catalog enable row level security;
revoke all on public.studio_members, public.studio_settings, public.studio_voices, public.studio_voice_catalog from anon, authenticated;
grant select on public.studio_members to authenticated;
grant update (enabled,ai_units_limit,ai_units_used,voice_clone_limit,voice_clone_used,updated_at) on public.studio_members to authenticated;
grant select,insert,update,delete on public.studio_settings,public.studio_voices,public.studio_voice_catalog to authenticated;

-- These private lookup functions are narrowly scoped to the authenticated caller.
-- They bypass recursive member RLS, never trust editable user_metadata, and take no user ID argument.
create or replace function studio_private.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select auth.uid() is not null and exists(select 1 from public.studio_members m where m.user_id=auth.uid() and m.enabled and m.role='admin'); $$;
create or replace function studio_private.is_enabled() returns boolean
language sql stable security definer set search_path = ''
as $$ select auth.uid() is not null and exists(select 1 from public.studio_members m where m.user_id=auth.uid() and m.enabled); $$;
revoke all on function studio_private.is_admin(),studio_private.is_enabled() from public,anon;
grant execute on function studio_private.is_admin(),studio_private.is_enabled() to authenticated;

create policy studio_members_read on public.studio_members for select to authenticated
using (user_id=(select auth.uid()) or (select studio_private.is_admin()));
create policy studio_members_admin_update on public.studio_members for update to authenticated
using ((select studio_private.is_admin())) with check ((select studio_private.is_admin()));
create policy studio_settings_own_select on public.studio_settings for select to authenticated
using (user_id=(select auth.uid()) and (select studio_private.is_enabled()));
create policy studio_settings_own_insert on public.studio_settings for insert to authenticated
with check (user_id=(select auth.uid()) and (select studio_private.is_enabled()));
create policy studio_settings_own_update on public.studio_settings for update to authenticated
using (user_id=(select auth.uid()) and (select studio_private.is_enabled()))
with check (user_id=(select auth.uid()) and (select studio_private.is_enabled()));
create policy studio_settings_own_delete on public.studio_settings for delete to authenticated
using (user_id=(select auth.uid()) and (select studio_private.is_enabled()));
create policy studio_voices_own_select on public.studio_voices for select to authenticated
using (user_id=(select auth.uid()) and (select studio_private.is_enabled()));
create policy studio_voices_own_insert on public.studio_voices for insert to authenticated
with check (user_id=(select auth.uid()) and (select studio_private.is_enabled()));
create policy studio_voices_own_update on public.studio_voices for update to authenticated
using (user_id=(select auth.uid()) and (select studio_private.is_enabled()))
with check (user_id=(select auth.uid()) and (select studio_private.is_enabled()));
create policy studio_voices_own_delete on public.studio_voices for delete to authenticated
using (user_id=(select auth.uid()) and (select studio_private.is_enabled()));

create policy studio_voice_catalog_select on public.studio_voice_catalog for select to authenticated
using ((select studio_private.is_admin()) or (enabled and (select studio_private.is_enabled())));
create policy studio_voice_catalog_admin_insert on public.studio_voice_catalog for insert to authenticated
with check ((select studio_private.is_admin()));
create policy studio_voice_catalog_admin_update on public.studio_voice_catalog for update to authenticated
using ((select studio_private.is_admin())) with check ((select studio_private.is_admin()));
create policy studio_voice_catalog_admin_delete on public.studio_voice_catalog for delete to authenticated
using ((select studio_private.is_admin()));

-- New users can never choose role or quotas. Every registered member is active
-- immediately with the platform defaults; administrators may still lock abuse.
create or replace function studio_private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $
begin
  insert into public.studio_members(user_id,email,role,enabled,ai_units_limit,voice_clone_limit)
  values(new.id,coalesce(new.email,''),'member',true,1000,3)
  on conflict(user_id) do nothing;
  return new;
end;
$;
revoke all on function studio_private.handle_new_user() from public,anon,authenticated;
drop trigger if exists studio_auth_user_created on auth.users;
create trigger studio_auth_user_created after insert on auth.users for each row execute function studio_private.handle_new_user();
insert into public.studio_members(user_id,email) select id,coalesce(email,'') from auth.users on conflict(user_id) do nothing;

-- One atomic update avoids overspending under concurrent requests. There is deliberately NO refund API.
-- Calling this RPC directly can only consume the caller's own allowance.
create or replace function studio_private.consume_units(p_units integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare remaining integer;
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  if p_units is null or p_units<1 or p_units>10000 then raise exception 'INVALID_AI_UNITS'; end if;
  update public.studio_members set ai_units_used=ai_units_used+p_units,updated_at=now()
    where user_id=auth.uid() and enabled and ai_units_used+p_units<=ai_units_limit
    returning ai_units_limit-ai_units_used into remaining;
  if not found then
    if not exists(select 1 from public.studio_members where user_id=auth.uid() and enabled) then raise exception 'MEMBER_DISABLED'; end if;
    raise exception 'QUOTA_EXCEEDED';
  end if;
  return remaining;
end;
$$;
revoke all on function studio_private.consume_units(integer) from public,anon;
grant execute on function studio_private.consume_units(integer) to authenticated;
create or replace function public.consume_studio_ai_units(p_units integer) returns integer
language sql security invoker set search_path = '' as $$ select studio_private.consume_units(p_units); $$;
revoke all on function public.consume_studio_ai_units(integer) from public,anon;
grant execute on function public.consume_studio_ai_units(integer) to authenticated;

create or replace function studio_private.consume_voice_clone(p_units integer)
returns table(remaining_units integer, clone_used integer, clone_limit integer, unlimited boolean)
language plpgsql security definer set search_path = '' as $
declare member_role text; member_enabled boolean; current_clone_used integer; current_clone_limit integer;
begin
  if auth.uid() is null then raise exception 'SIGN_IN_REQUIRED'; end if;
  if p_units is null or p_units<1 or p_units>10000 then raise exception 'INVALID_AI_UNITS'; end if;
  select role,enabled,voice_clone_used,voice_clone_limit
    into member_role,member_enabled,current_clone_used,current_clone_limit
    from public.studio_members where user_id=auth.uid();
  if not found or not member_enabled then raise exception 'MEMBER_DISABLED'; end if;
  if member_role='admin' then
    update public.studio_members set ai_units_used=ai_units_used+p_units,updated_at=now()
      where user_id=auth.uid() and enabled and ai_units_used+p_units<=ai_units_limit
      returning ai_units_limit-ai_units_used,voice_clone_used,voice_clone_limit,true
      into remaining_units,clone_used,clone_limit,unlimited;
    if not found then raise exception 'QUOTA_EXCEEDED'; end if;
  else
    update public.studio_members
      set ai_units_used=ai_units_used+p_units,voice_clone_used=voice_clone_used+1,updated_at=now()
      where user_id=auth.uid() and enabled
        and ai_units_used+p_units<=ai_units_limit
        and voice_clone_used<voice_clone_limit
      returning ai_units_limit-ai_units_used,voice_clone_used,voice_clone_limit,false
      into remaining_units,clone_used,clone_limit,unlimited;
    if not found then
      select voice_clone_used,voice_clone_limit into current_clone_used,current_clone_limit
        from public.studio_members where user_id=auth.uid();
      if current_clone_used>=current_clone_limit then raise exception 'VOICE_CLONE_LIMIT'; end if;
      raise exception 'QUOTA_EXCEEDED';
    end if;
  end if;
  return next;
end;
$;
revoke all on function studio_private.consume_voice_clone(integer) from public,anon;
grant execute on function studio_private.consume_voice_clone(integer) to authenticated;
create or replace function public.consume_studio_voice_clone(p_units integer)
returns table(remaining_units integer, clone_used integer, clone_limit integer, unlimited boolean)
language sql security invoker set search_path = ''
as $ select * from studio_private.consume_voice_clone(p_units); $;
revoke all on function public.consume_studio_voice_clone(integer) from public,anon;
grant execute on function public.consume_studio_voice_clone(integer) to authenticated;

-- Private media: only active members, only under auth.uid()/..., no public bucket access.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('studio-media','studio-media',false,62914560,array['audio/wav','audio/x-wav','audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/webm','audio/ogg','video/webm','video/mp4'])
on conflict(id) do nothing;
create policy studio_media_own_select on storage.objects for select to authenticated
using (bucket_id='studio-media' and (storage.foldername(name))[1]=(select auth.uid())::text and (select studio_private.is_enabled()));
create policy studio_media_own_insert on storage.objects for insert to authenticated
with check (bucket_id='studio-media' and (storage.foldername(name))[1]=(select auth.uid())::text and (select studio_private.is_enabled()));
create policy studio_media_own_update on storage.objects for update to authenticated
using (bucket_id='studio-media' and (storage.foldername(name))[1]=(select auth.uid())::text and (select studio_private.is_enabled()))
with check (bucket_id='studio-media' and (storage.foldername(name))[1]=(select auth.uid())::text and (select studio_private.is_enabled()));
create policy studio_media_own_delete on storage.objects for delete to authenticated
using (bucket_id='studio-media' and (storage.foldername(name))[1]=(select auth.uid())::text and (select studio_private.is_enabled()));
commit;

-- FIRST ADMIN: after creating/inviting your own Auth user, run this separately with its actual UUID:
-- update public.studio_members set role='admin',enabled=true,ai_units_limit=1000 where user_id='YOUR_AUTH_USER_UUID';
-- All other registered users are active members automatically with 3 clone slots.
-- Do not give browser users a service-role key. Run Supabase security advisors after applying.
