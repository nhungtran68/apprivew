-- Generated media library. Object storage remains private; this table only
-- indexes owned outputs so users can retrieve them across devices.
create table if not exists public.library_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('video', 'audio')),
  provider text not null check (provider in ('r2', 'supabase')),
  storage_path text not null unique check (length(storage_path) between 1 and 400),
  title text not null check (length(title) between 1 and 160),
  mime_type text not null check (mime_type in ('video/mp4', 'audio/mpeg', 'audio/wav')),
  size_bytes bigint not null check (size_bytes > 0),
  duration_seconds numeric(12, 3) check (duration_seconds > 0),
  status text not null default 'uploading' check (status in ('uploading', 'ready', 'deleted')),
  request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint library_assets_provider_kind_check check (
    (kind = 'video' and provider = 'r2' and mime_type = 'video/mp4') or
    (kind = 'audio' and provider = 'supabase' and mime_type in ('audio/mpeg', 'audio/wav'))
  ),
  constraint library_assets_owner_path_check check (storage_path like user_id::text || '/%'),
  constraint library_assets_expiry_check check (expires_at > created_at)
);

create unique index if not exists library_assets_user_request_idx
  on public.library_assets (user_id, request_id) where request_id is not null;
create index if not exists library_assets_owner_created_idx
  on public.library_assets (user_id, status, created_at desc);
create index if not exists library_assets_expiry_idx
  on public.library_assets (expires_at) where status in ('uploading', 'ready');

alter table public.library_assets enable row level security;
revoke all on public.library_assets from public, anon, authenticated;
grant select on public.library_assets to authenticated;
grant select, insert, update, delete on public.library_assets to service_role;
drop policy if exists library_assets_owner_read on public.library_assets;
create policy library_assets_owner_read on public.library_assets
  for select to authenticated
  using (user_id = (select auth.uid()) and (select studio_private.is_enabled()));

-- Register only completed standalone voice-over files that still exist. The
-- other narration files may be temporary Studio segments and must not be
-- exposed as completed assets or deleted by the library cleanup job.
insert into public.library_assets
  (user_id, kind, provider, storage_path, title, mime_type, size_bytes,
   duration_seconds, status, request_id, created_at, updated_at, expires_at)
select op.user_id, 'audio', 'supabase', object.name,
       'Lời đọc ' || to_char(op.created_at at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY'),
       op.provider_usage->>'audioMime',
       (object.metadata->>'size')::bigint,
       (op.provider_usage->>'duration')::numeric(12, 3),
       'ready', op.request_id, op.created_at, op.updated_at,
       op.created_at + interval '30 days'
from public.studio_credit_operations op
join storage.objects object
  on object.bucket_id = 'studio-media'
 and object.name = op.provider_usage->>'audioPath'
where op.kind = 'tts' and op.status = 'settled'
  and object.name like op.user_id::text || '/narration/%'
  and op.provider_usage->>'audioMime' in ('audio/mpeg', 'audio/wav')
  and object.metadata->>'size' ~ '^[0-9]+$'
  and (object.metadata->>'size')::bigint > 0
  and op.provider_usage->>'duration' ~ '^[0-9]+(\.[0-9]+)?$'
  and (op.provider_usage->>'duration')::numeric > 0
on conflict (storage_path) do nothing;
