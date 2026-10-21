-- A paid speech transcription can finish after the browser connection closes.
-- Keep its result under the original credit request ID so replay never calls
-- the provider or charges a second time. Only the server-side service role can
-- read or write transcripts; ordinary clients have no table privileges/policy.
create table if not exists public.studio_video_transcriptions (
  request_id uuid primary key references public.studio_credit_operations(request_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null check (length(storage_path) between 1 and 400),
  transcript jsonb not null check (jsonb_typeof(transcript) = 'object' and octet_length(transcript::text) <= 65536),
  created_at timestamptz not null default now()
);

create index if not exists studio_video_transcriptions_owner_idx
  on public.studio_video_transcriptions (user_id, created_at desc);

alter table public.studio_video_transcriptions enable row level security;
revoke all on table public.studio_video_transcriptions from public, anon, authenticated;
grant select, insert on table public.studio_video_transcriptions to service_role;
