-- Run after setup.sql. Prompt text is encrypted in the app before it reaches
-- this table; the server-only STUDIO_ENCRYPTION_KEY must be kept across deploys.
-- Safe to rerun. No existing member or voice data is changed.
begin;

create table if not exists public.studio_script_templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('shared','personal')),
  format text not null check (format in ('review','story','tips','sales')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 240),
  prompt_ciphertext text not null check (
    char_length(prompt_ciphertext) <= 40000
    and prompt_ciphertext ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{23,}$'
  ),
  sort_order integer not null default 0 check (sort_order between -100000 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists studio_script_templates_owner_idx
  on public.studio_script_templates (owner_id,created_at);
create index if not exists studio_script_templates_shared_idx
  on public.studio_script_templates (format,sort_order,created_at)
  where scope='shared';

alter table public.studio_script_templates enable row level security;
revoke all on public.studio_script_templates from public,anon,authenticated;
grant select,insert,update,delete on public.studio_script_templates to authenticated;

-- All enabled members may use shared templates. A personal template is visible
-- only to its owner. The ciphertext is never decrypted in the database; a
-- member with direct Data API access can see ciphertext, not the admin prompt.
drop policy if exists studio_script_templates_select on public.studio_script_templates;
create policy studio_script_templates_select on public.studio_script_templates
  for select to authenticated
  using (
    (select studio_private.is_enabled())
    and (scope='shared' or owner_id=(select auth.uid()))
  );

-- Members can create only personal templates. The shared catalog is curated
-- by an enabled admin, and each row always belongs to its creating account.
drop policy if exists studio_script_templates_insert on public.studio_script_templates;
create policy studio_script_templates_insert on public.studio_script_templates
  for insert to authenticated
  with check (
    owner_id=(select auth.uid())
    and (select studio_private.is_enabled())
    and (scope='personal' or (select studio_private.is_admin()))
  );

drop policy if exists studio_script_templates_update on public.studio_script_templates;
create policy studio_script_templates_update on public.studio_script_templates
  for update to authenticated
  using (
    owner_id=(select auth.uid())
    and (select studio_private.is_enabled())
    and (scope='personal' or (select studio_private.is_admin()))
  )
  with check (
    owner_id=(select auth.uid())
    and (select studio_private.is_enabled())
    and (scope='personal' or (select studio_private.is_admin()))
  );

drop policy if exists studio_script_templates_delete on public.studio_script_templates;
create policy studio_script_templates_delete on public.studio_script_templates
  for delete to authenticated
  using (
    owner_id=(select auth.uid())
    and (select studio_private.is_enabled())
    and (scope='personal' or (select studio_private.is_admin()))
  );

commit;
