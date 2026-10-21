import { apiError, json, requestUser } from "@/lib/studio-server";
import { StudioError } from "@/lib/studio-contract";
import { libraryDatabase, ownedLibraryAsset, signedVideoDownload } from "@/lib/r2";
import { STUDIO_MEDIA_BUCKET } from "@/lib/studio-supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const userId = await requestUser(request);
    const asset = await ownedLibraryAsset(userId, (await params).id);
    if (asset.status !== "ready" || new Date(asset.expires_at) <= new Date())
      throw new StudioError("LIBRARY_ITEM_EXPIRED", "Tệp này đã hết hạn lưu trong Thư viện.", 410);
    const download = new URL(request.url).searchParams.get("download") === "1";
    if (asset.provider === "r2") {
      const url = await signedVideoDownload(asset.storage_path, download ? `video-${asset.id}.mp4` : undefined);
      return json({ url });
    }
    const fileName = `giong-noi-${asset.id}.${asset.mime_type === "audio/wav" ? "wav" : "mp3"}`;
    const signed = await libraryDatabase().storage.from(STUDIO_MEDIA_BUCKET)
      .createSignedUrl(asset.storage_path, download ? 300 : 3600, download ? { download: fileName } : {});
    if (signed.error || !signed.data?.signedUrl)
      throw new StudioError("LIBRARY_FILE_UNAVAILABLE", "Chưa mở được file giọng nói. Vui lòng thử lại.", 503);
    return json({ url: signed.data.signedUrl });
  } catch (error) { return apiError(error); }
}
