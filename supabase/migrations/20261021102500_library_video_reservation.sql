-- Reserve video-library capacity in one database transaction. An advisory
-- transaction lock serializes uploads for one user, including concurrent
-- requests that would otherwise all observe the same free quota.
create or replace function public.reserve_library_video_upload(
  p_user_id uuid,
  p_title text,
  p_size_bytes bigint,
  p_duration_seconds numeric,
  p_request_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_asset public.library_assets%rowtype;
  v_count bigint;
  v_used bigint;
  v_id uuid;
begin
  if p_user_id is null or p_title is null or length(p_title) not between 1 and 160
     or p_size_bytes is null or p_size_bytes < 12 or p_size_bytes > 524288000
     or p_duration_seconds is null or p_duration_seconds < 0.1 or p_duration_seconds > 3600 then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(842104, pg_catalog.hashtext(p_user_id::text));
  v_now := clock_timestamp();

  if p_request_id is not null then
    select * into v_asset
    from public.library_assets
    where user_id = p_user_id and request_id = p_request_id
    for update;
    if found then
      if v_asset.kind <> 'video' or v_asset.provider <> 'r2' or v_asset.size_bytes <> p_size_bytes then
        return jsonb_build_object('outcome', 'conflict');
      end if;
      if v_asset.status = 'ready' and v_asset.expires_at > v_now then
        return jsonb_build_object('outcome', 'ready', 'asset', to_jsonb(v_asset));
      end if;
      if v_asset.status = 'uploading' and v_asset.expires_at > v_now then
        return jsonb_build_object('outcome', 'uploading', 'asset', to_jsonb(v_asset));
      end if;
    end if;
  end if;

  select count(*), coalesce(sum(size_bytes), 0)
  into v_count, v_used
  from public.library_assets
  where user_id = p_user_id and kind = 'video'
    and status in ('ready', 'uploading') and expires_at > v_now;

  if v_count >= 500 then
    return jsonb_build_object('outcome', 'file_limit');
  end if;
  if v_used + p_size_bytes > 1073741824 then
    return jsonb_build_object('outcome', 'quota_exceeded');
  end if;

  v_id := coalesce(v_asset.id, gen_random_uuid());
  if v_asset.id is null then
    insert into public.library_assets (
      id, user_id, kind, provider, storage_path, title, mime_type,
      size_bytes, duration_seconds, status, request_id,
      created_at, updated_at, expires_at
    ) values (
      v_id, p_user_id, 'video', 'r2', p_user_id::text || '/videos/' || v_id::text || '.mp4',
      p_title, 'video/mp4', p_size_bytes, p_duration_seconds, 'uploading', p_request_id,
      v_now, v_now, v_now + interval '7 days'
    ) returning * into v_asset;
  else
    update public.library_assets
    set title = p_title, duration_seconds = p_duration_seconds,
        status = 'uploading', created_at = v_now, updated_at = v_now,
        expires_at = v_now + interval '7 days'
    where id = v_id and user_id = p_user_id
    returning * into v_asset;
  end if;

  return jsonb_build_object('outcome', 'created', 'asset', to_jsonb(v_asset));
end;
$$;

revoke all on function public.reserve_library_video_upload(uuid, text, bigint, numeric, uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_library_video_upload(uuid, text, bigint, numeric, uuid)
  to service_role;
