import { apiError, json } from "@/lib/studio-server";
import { StudioError } from "@/lib/studio-contract";
import { STUDIO_MEDIA_BUCKET } from "@/lib/studio-supabase";
import { assertOwnedLibraryAsset, deleteVideoObject, libraryDatabase, type LibraryAsset } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BATCH_SIZE = 100;
const MAX_ROWS_PER_RUN = 5000;
// Hobby Functions can run for less than the configured 300 seconds. Leave
// headroom so the route can return a useful report before the platform limit.
const WORK_BUDGET_MS = 40_000;
const DELETE_CONCURRENCY = 8;

type CleanupKind = "expired" | "abandoned";
type CleanupStats = { scanned: number; removed: number; failed: number; partial: boolean };
const fields = "id,user_id,kind,provider,storage_path,title,mime_type,size_bytes,duration_seconds,status,request_id,created_at,expires_at";

async function deleteOne(asset: LibraryAsset): Promise<boolean> {
  const database = libraryDatabase();
  try {
    assertOwnedLibraryAsset(asset.user_id, asset);
    if (asset.provider === "r2" && asset.kind === "video") {
      await deleteVideoObject(asset.storage_path);
    } else if (asset.provider === "supabase" && asset.kind === "audio") {
      const removed = await database.storage.from(STUDIO_MEDIA_BUCKET).remove([asset.storage_path]);
      if (removed.error) throw removed.error;
    } else {
      throw new Error("Invalid asset provider");
    }
    const deleted = await database.from("library_assets").delete().eq("id", asset.id).eq("user_id", asset.user_id);
    if (deleted.error) throw deleted.error;
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "library_cleanup_failed", assetId: asset.id,
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN",
    }));
    return false;
  }
}

async function deleteBatch(assets: LibraryAsset[]): Promise<boolean[]> {
  const results = new Array<boolean>(assets.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, assets.length) }, async () => {
    while (cursor < assets.length) {
      const index = cursor++;
      results[index] = await deleteOne(assets[index]);
    }
  }));
  return results;
}

async function drain(kind: CleanupKind, now: string, abandonedBefore: string, deadline: number, stats: CleanupStats) {
  const database = libraryDatabase();
  // Successful deletes disappear from the query. Offset only past failures so
  // a permanently failing oldest row cannot starve newer expired objects.
  let failedOffset = 0;
  while (stats.scanned < MAX_ROWS_PER_RUN && Date.now() < deadline) {
    const count = Math.min(BATCH_SIZE, MAX_ROWS_PER_RUN - stats.scanned);
    let query = database.from("library_assets").select(fields).in("status", ["uploading", "ready"]);
    if (kind === "expired") {
      query = query.lte("expires_at", now).order("expires_at", { ascending: true });
    } else {
      // The two passes are disjoint: abandoned uploads that have not yet expired.
      query = query.eq("status", "uploading")
        .gt("expires_at", now).lte("created_at", abandonedBefore)
        .order("created_at", { ascending: true });
    }
    const batch = await query.order("id", { ascending: true })
      .range(failedOffset, failedOffset + count - 1);
    if (batch.error) throw new StudioError("LIBRARY_CLEANUP_QUERY_FAILED", "Chưa đọc được tệp cần dọn.", 503);
    const assets = (batch.data || []) as LibraryAsset[];
    if (!assets.length) break;
    const results = await deleteBatch(assets);
    const removed = results.filter(Boolean).length;
    const failed = assets.length - removed;
    stats.scanned += assets.length;
    stats.removed += removed;
    stats.failed += failed;
    failedOffset += failed;
    if (assets.length < count) break;
  }
  if (stats.scanned >= MAX_ROWS_PER_RUN || Date.now() >= deadline) stats.partial = true;
}

/** Daily cleanup. R2's seven-day lifecycle is a second line of protection;
 * this job also clears the database and actually removes expired Supabase MP3s. */
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || secret.length < 24) throw new StudioError("LIBRARY_CLEANUP_NOT_CONFIGURED", "Lịch dọn Thư viện chưa được cấu hình.", 503);
    if (request.headers.get("authorization") !== `Bearer ${secret}`) throw new StudioError("FORBIDDEN", "Không có quyền dọn Thư viện.", 403);
    const now = new Date();
    const stats: CleanupStats = { scanned: 0, removed: 0, failed: 0, partial: false };
    const deadline = Date.now() + WORK_BUDGET_MS;
    const abandonedBefore = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    await drain("expired", now.toISOString(), abandonedBefore, deadline, stats);
    if (Date.now() < deadline && stats.scanned < MAX_ROWS_PER_RUN) {
      await drain("abandoned", now.toISOString(), abandonedBefore, deadline, stats);
    } else stats.partial = true;
    return json(stats);
  } catch (error) { return apiError(error); }
}
