import { apiError, json, requestUser } from "@/lib/studio-server";
import { StudioError } from "@/lib/studio-contract";
import { checkVideoObject, deleteVideoObject, libraryDatabase, ownedLibraryAsset, type LibraryAsset } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    const userId = await requestUser(request, true);
    const asset = await ownedLibraryAsset(userId, (await params).id);
    if (asset.kind !== "video" || asset.provider !== "r2") throw new StudioError("INVALID_LIBRARY_ITEM", "Chỉ video hoàn chỉnh mới cần xác nhận tải lên.", 400);
    if (asset.status === "ready") return json({ asset });
    if (asset.status !== "uploading" || new Date(asset.expires_at) <= new Date())
      throw new StudioError("LIBRARY_UPLOAD_EXPIRED", "Lượt lưu video đã hết hạn. Hãy thử lưu lại.", 409);
    let object;
    try { object = await checkVideoObject(asset.storage_path); }
    catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status === 404) throw new StudioError("LIBRARY_UPLOAD_INCOMPLETE", "Video chưa tải lên kho xong. Hãy thử lưu lại.", 422);
      throw new StudioError("LIBRARY_STORE_UNAVAILABLE", "Kho lưu video chưa phản hồi. Hãy thử lại sau.", 503);
    }
    if (object.sizeBytes !== asset.size_bytes || object.mimeType !== "video/mp4" || !object.mp4) {
      await deleteVideoObject(asset.storage_path).catch(() => {});
      throw new StudioError("LIBRARY_VIDEO_INVALID", "Tệp video chưa hợp lệ hoặc tải lên chưa đủ. Hãy thử lưu lại.", 422);
    }
    const saved = await libraryDatabase().from("library_assets")
      .update({ status: "ready", updated_at: new Date().toISOString() })
      .eq("id", asset.id).eq("user_id", userId).eq("status", "uploading").select("*").maybeSingle();
    if (saved.error) throw new StudioError("LIBRARY_SAVE_FAILED", "Video đã tải lên nhưng chưa ghi được vào Thư viện. Hãy bấm thử lại.", 503);
    if (!saved.data) {
      const latest = await ownedLibraryAsset(userId, asset.id);
      if (latest.status === "ready") return json({ asset: latest });
      throw new StudioError("LIBRARY_SAVE_FAILED", "Chưa xác nhận được video trong Thư viện. Hãy thử lại.", 503);
    }
    return json({ asset: saved.data as LibraryAsset });
  } catch (error) { return apiError(error); }
}
