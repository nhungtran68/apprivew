"use client";
import { createStudioBrowser } from "./studio-browser";

const BUCKET = "studio-media";
const MAX_AUDIO = 25 * 1024 * 1024;
type StoredAudio = { start: number; end: number; text: string; audioUrl?: string; audioPath?: string; audioMime?: string; duration?: number; audioBase64?: string };
function safePath(userId: string, value: unknown): value is string {
  return typeof value === "string" && value.length <= 400 && value.startsWith(`${userId}/`)
    && !value.includes("..") && /^[a-zA-Z0-9_./-]+$/.test(value);
}
async function storageUser() {
  const client = createStudioBrowser();
  try {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) throw new Error();
    return { client, userId: data.user.id };
  } catch { throw new Error("Chưa xác thực được tài khoản để xử lý tệp riêng. Hãy đăng nhập lại rồi thử lại."); }
}

export async function uploadVoiceSamples(files: File[]) {
  if (!files.length || files.length > 5 || files.reduce((sum, file) => sum + file.size, 0) > MAX_AUDIO) throw new Error("Chọn 1–5 bản thu, tổng dung lượng tối đa 25 MB.");
  const client = createStudioBrowser();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error("Đăng nhập trước khi tải mẫu giọng.");
  const paths: string[] = [];
  try {
    for (const file of files) {
      if (!file.size || !/^(audio|video)\//.test(file.type)) throw new Error("Mẫu giọng cần là tệp âm thanh.");
      const extension = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "webm";
      const objectPath = `${data.user.id}/voice-samples/${crypto.randomUUID()}.${extension}`;
      const result = await client.storage.from(BUCKET).upload(objectPath, file, { contentType: file.type, upsert: false });
      if (result.error) throw new Error("Chưa tải được mẫu giọng. Kiểm tra kết nối và kho tệp Supabase.");
      paths.push(objectPath);
    }
    return { samplePaths: paths };
  } catch (error) {
    if (paths.length) await client.storage.from(BUCKET).remove(paths);
    throw error;
  }
}

export async function cleanupAnalysisMedia(input: { paths?: string[]; samplePaths?: string[] } | string[]) {
  const paths = Array.isArray(input) ? input : input.paths || input.samplePaths || [];
  if (!paths.length) return;
  const { client, userId } = await storageUser();
  const own = [...new Set(paths.filter((path) => safePath(userId, path)))];
  if (!own.length) return;
  try {
    const { error } = await client.storage.from(BUCKET).remove(own);
    if (error) throw new Error();
  } catch { throw new Error("Chưa xóa được tệp âm thanh tạm. Hãy kiểm tra kết nối rồi thử dọn lại."); }
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Chưa đọc được tệp lời thoại."));
    reader.readAsDataURL(blob);
  });
}

export async function downloadSpeechSegments<T extends StoredAudio>(segments: T[]): Promise<(T & { audioBase64: string; mimeType: string })[]> {
  if (!Array.isArray(segments) || !segments.length || segments.length > 16) throw new Error("Kết quả lời thoại chưa hợp lệ.");
  const expectedOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "https://unconfigured.invalid").origin;
  let paths: string[] = [];
  let total = 0;
  try {
    const needsStorage = segments.some((segment) => !segment.audioBase64 || segment.audioPath);
    const userId = needsStorage ? (await storageUser()).userId : "";
    // Collect every owned object before any fetch. A failed first download must
    // still remove that object and the later segments that were never fetched.
    paths = [...new Set(segments.map((segment) => segment.audioPath).filter((path) => safePath(userId, path)))];
    const prefix = `/storage/v1/object/sign/${BUCKET}/`;
    const urls = segments.map((segment) => {
      if (segment.audioBase64) return undefined;
      try {
        const url = new URL(segment.audioUrl || "");
        if (!safePath(userId, segment.audioPath) || url.origin !== expectedOrigin || url.username || url.password
          || !url.pathname.startsWith(prefix) || decodeURIComponent(url.pathname.slice(prefix.length)) !== segment.audioPath) throw new Error();
        return url;
      } catch { throw new Error("Đường dẫn lời thoại không thuộc kho tệp riêng của tài khoản hiện tại."); }
    });
    const results: (T & { audioBase64: string; mimeType: string })[] = [];
    for (const [index, segment] of segments.entries()) {
      if (segment.audioBase64) { results.push({ ...segment, audioBase64: segment.audioBase64, mimeType: segment.audioMime || "audio/wav" }); continue; }
      const response = await fetch(urls[index]!.href, { signal: AbortSignal.timeout(60_000), credentials: "omit", redirect: "error" });
      if (!response.ok) throw new Error("Chưa tải được lời thoại. Hãy tạo lại hoặc thử lại kết nối.");
      const blob = await response.blob();
      total += blob.size;
      if (!blob.size || total > 16 * 1024 * 1024) throw new Error("Tệp lời thoại trống hoặc quá lớn.");
      const { audioUrl: _url, audioPath: _path, ...rest } = segment;
      results.push({ ...rest, audioBase64: await base64(blob), mimeType: segment.audioMime || "audio/wav" } as T & { audioBase64: string; mimeType: string });
    }
    return results;
  // Preserve paid audio if a temporary Storage cleanup fails; explicit cleanup
  // calls reject so callers can retry. All download failure paths still try cleanup.
  } finally { await cleanupAnalysisMedia(paths).catch(() => {}); }
}
