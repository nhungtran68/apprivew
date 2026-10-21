import { apiError, json, limitedJson, requestUser } from "@/lib/studio-server";
import { StudioError } from "@/lib/studio-contract";
import {
  LIBRARY_VIDEO_MAX_BYTES, assertOwnedLibraryAsset, assertR2Configured, libraryDatabase, signedVideoUpload,
  validLibraryRequestId, type LibraryAsset,
} from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function inputVideo(body: Record<string, unknown>) {
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 160) : "";
  const mimeType = body.mimeType;
  const sizeBytes = body.sizeBytes;
  const durationSeconds = body.durationSeconds;
  if (!title) throw new StudioError("INVALID_LIBRARY_TITLE", "Hãy đặt tên video trước khi lưu.", 400);
  if (mimeType !== "video/mp4") throw new StudioError("INVALID_LIBRARY_VIDEO", "Thư viện chỉ nhận video MP4 đã xuất từ app.", 415);
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 12 || sizeBytes > LIBRARY_VIDEO_MAX_BYTES)
    throw new StudioError("LIBRARY_VIDEO_TOO_LARGE", "Video cần có dung lượng không quá 500 MB để lưu vào Thư viện.", 413);
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds < 0.1 || durationSeconds > 3600)
    throw new StudioError("INVALID_LIBRARY_VIDEO", "Không xác định được thời lượng video hoàn chỉnh.", 400);
  return { title, sizeBytes, durationSeconds, requestId: validLibraryRequestId(body.requestId) };
}

export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    const { title, sizeBytes, durationSeconds, requestId } = inputVideo(await limitedJson(request, 3000));
    // Missing R2 configuration must not consume a quota reservation.
    assertR2Configured();
    // The RPC locks this user's video quota for the full check-and-insert
    // transaction. A route-level SELECT followed by INSERT can overbook R2
    // when multiple browser tabs start uploading at the same time.
    const reserved = await libraryDatabase().rpc("reserve_library_video_upload", {
      p_user_id: userId,
      p_title: title,
      p_size_bytes: sizeBytes,
      p_duration_seconds: durationSeconds,
      p_request_id: requestId,
    });
    if (reserved.error) {
      if (reserved.error.code === "PGRST202")
        throw new StudioError("LIBRARY_NOT_CONFIGURED", "Cơ sở dữ liệu Thư viện chưa được cập nhật. Quản trị viên cần áp dụng bản cập nhật mới.", 503, "contact_admin");
      throw new StudioError("LIBRARY_SAVE_FAILED", "Chưa chuẩn bị được nơi lưu video. Vui lòng thử lại.", 503);
    }
    const result = reserved.data as { outcome?: unknown; asset?: unknown } | null;
    if (result?.outcome === "invalid")
      throw new StudioError("INVALID_LIBRARY_VIDEO", "Thông tin video chưa hợp lệ. Hãy thử xuất video lại.", 400);
    if (result?.outcome === "conflict")
      throw new StudioError("LIBRARY_REQUEST_CONFLICT", "Yêu cầu lưu video này đã được dùng cho tệp khác.", 409);
    if (result?.outcome === "file_limit")
      throw new StudioError("LIBRARY_FILE_LIMIT", "Thư viện đã có quá nhiều video. Hãy tải về hoặc xóa bớt video cũ.", 429);
    if (result?.outcome === "quota_exceeded")
      throw new StudioError("LIBRARY_QUOTA_EXCEEDED", "Thư viện video của bạn đã đạt giới hạn 1 GB. Hãy tải về hoặc xóa bớt video cũ.", 413);
    if (!result?.asset || typeof result.asset !== "object" || !["ready", "uploading", "created"].includes(String(result.outcome)))
      throw new StudioError("LIBRARY_SAVE_FAILED", "Chưa xác nhận được nơi lưu video. Vui lòng thử lại.", 503);
    const asset = assertOwnedLibraryAsset(userId, result.asset as LibraryAsset);
    if (asset.kind !== "video" || asset.provider !== "r2" || asset.size_bytes !== sizeBytes)
      throw new StudioError("LIBRARY_SAVE_FAILED", "Thông tin video đã lưu chưa hợp lệ. Vui lòng thử lại.", 503);
    if (result.outcome === "ready") return json({ asset, alreadySaved: true });
    const uploadUrl = await signedVideoUpload(asset.storage_path, sizeBytes);
    return json({ asset, uploadUrl, headers: { "Content-Type": "video/mp4" } }, result.outcome === "created" ? 201 : 200);
  } catch (error) { return apiError(error); }
}
