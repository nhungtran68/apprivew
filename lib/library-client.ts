export type LibraryAsset = {
  id: string;
  kind: "video" | "audio";
  title: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  created_at: string;
  expires_at: string;
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : "Kho tệp chưa phản hồi. Hãy thử lại.";
    throw new Error(message);
  }
  return body;
}

export async function saveLibraryVideo(blob: Blob, title: string, durationSeconds: number, requestId: string): Promise<void> {
  if (!blob.size) throw new Error("Video chưa có dữ liệu để lưu.");
  const mimeType = "video/mp4";
  const prepared = await readJson(await fetch("/api/library/videos/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, mimeType, sizeBytes: blob.size, durationSeconds, requestId }),
  }));
  if (prepared.alreadySaved === true) return;
  const asset = prepared.asset as { id?: unknown } | undefined;
  if (!asset || typeof asset.id !== "string" || typeof prepared.uploadUrl !== "string")
    throw new Error("Chưa nhận được địa chỉ lưu video. Hãy thử lưu lại.");
  let upload: Response;
  try {
    upload = await fetch(prepared.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: blob,
    });
  } catch {
    throw new Error("Chưa kết nối được kho video. Kiểm tra mạng rồi bấm Thử lưu vào Thư viện; MP4 vẫn có thể tải về máy.");
  }
  if (!upload.ok) throw new Error("Chưa tải được video lên Thư viện. Video vẫn có thể tải về máy; hãy thử lưu lại khi mạng ổn định.");
  await readJson(await fetch(`/api/library/videos/${encodeURIComponent(asset.id)}/complete`, { method: "POST" }));
}

export async function getLibraryAssets(): Promise<LibraryAsset[]> {
  const body = await readJson(await fetch("/api/library", { cache: "no-store" }));
  return Array.isArray(body.assets) ? body.assets as LibraryAsset[] : [];
}

export async function getLibraryAssetUrl(id: string, download = false): Promise<string> {
  const suffix = download ? "?download=1" : "";
  const body = await readJson(await fetch(`/api/library/${encodeURIComponent(id)}/url${suffix}`, { cache: "no-store" }));
  if (typeof body.url !== "string" || !body.url) throw new Error("Chưa lấy được liên kết tệp. Hãy thử lại.");
  return body.url;
}

export async function deleteLibraryAsset(id: string): Promise<void> {
  await readJson(await fetch(`/api/library/${encodeURIComponent(id)}`, { method: "DELETE" }));
}
