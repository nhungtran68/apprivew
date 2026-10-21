import { apiError, json, requestUser } from "@/lib/studio-server";
import { StudioError } from "@/lib/studio-contract";
import { deleteVideoObject, libraryDatabase, ownedLibraryAsset } from "@/lib/r2";
import { STUDIO_MEDIA_BUCKET } from "@/lib/studio-supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, { params }: Context) {
  try {
    const userId = await requestUser(request, true);
    const asset = await ownedLibraryAsset(userId, (await params).id);
    if (asset.provider === "r2") {
      try { await deleteVideoObject(asset.storage_path); }
      catch { throw new StudioError("LIBRARY_DELETE_FAILED", "Chưa xóa được video trên kho lưu. Hãy thử lại.", 503); }
    } else {
      const removed = await libraryDatabase().storage.from(STUDIO_MEDIA_BUCKET).remove([asset.storage_path]);
      if (removed.error) throw new StudioError("LIBRARY_DELETE_FAILED", "Chưa xóa được file giọng nói trên kho lưu. Hãy thử lại.", 503);
    }
    const deleted = await libraryDatabase().from("library_assets").delete().eq("id", asset.id).eq("user_id", userId);
    if (deleted.error) throw new StudioError("LIBRARY_DELETE_FAILED", "Đã xóa tệp nhưng chưa cập nhật được Thư viện. Hãy tải lại trang.", 503);
    return json({ deleted: true });
  } catch (error) { return apiError(error); }
}
