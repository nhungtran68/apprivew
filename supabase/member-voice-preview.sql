-- Add member-owned sample metadata. Existing studio_voices RLS keeps these
-- columns scoped to the signed-in owner; no URL is written to the shared cache.
alter table public.studio_voices
  add column if not exists preview_url text,
  add column if not exists preview_checked_at timestamptz;
