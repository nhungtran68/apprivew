-- Additive migration for the four administrator-managed script types.
-- Existing personal/shared custom script types remain untouched.
begin;

create table if not exists public.studio_script_builtin_styles (
  format text primary key check (format in ('review','story','tips','sales')),
  owner_id uuid not null references auth.users(id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 240),
  prompt_ciphertext text not null check (
    char_length(prompt_ciphertext) <= 40000
    and prompt_ciphertext ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{23,}$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.studio_script_builtin_styles enable row level security;
revoke all on public.studio_script_builtin_styles from public, anon, authenticated;
grant select, insert, update on public.studio_script_builtin_styles to authenticated;

drop policy if exists studio_script_builtin_styles_select on public.studio_script_builtin_styles;
create policy studio_script_builtin_styles_select on public.studio_script_builtin_styles
  for select to authenticated
  using ((select studio_private.is_enabled()));

drop policy if exists studio_script_builtin_styles_insert on public.studio_script_builtin_styles;
create policy studio_script_builtin_styles_insert on public.studio_script_builtin_styles
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and (select studio_private.is_enabled())
    and (select studio_private.is_admin())
  );

drop policy if exists studio_script_builtin_styles_update on public.studio_script_builtin_styles;
create policy studio_script_builtin_styles_update on public.studio_script_builtin_styles
  for update to authenticated
  using (
    (select studio_private.is_enabled())
    and (select studio_private.is_admin())
  )
  with check (
    owner_id = (select auth.uid())
    and (select studio_private.is_enabled())
    and (select studio_private.is_admin())
  );

commit;
