import { apiError, json, requestUser } from "@/lib/studio-server";
import { libraryDatabase, type LibraryAsset } from "@/lib/r2";
import { StudioError } from "@/lib/studio-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const userId = await requestUser(request);
    const { data, error } = await libraryDatabase().from("library_assets")
      .select("id,user_id,kind,provider,storage_path,title,mime_type,size_bytes,duration_seconds,created_at,expires_at,status,request_id")
      .eq("user_id", userId).eq("status", "ready")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }).limit(200);
    if (error) throw new StudioError("LIBRARY_UNAVAILABLE", "Chưa tải được Thư viện. Vui lòng thử lại.", 503);
    const assets = ((data || []) as LibraryAsset[]).map(({ id, kind, title, mime_type, size_bytes, duration_seconds, created_at, expires_at }) => ({
      id, kind, title, mime_type, size_bytes, duration_seconds, created_at, expires_at,
    }));
    return json({ assets });
  } catch (error) { return apiError(error); }
}
