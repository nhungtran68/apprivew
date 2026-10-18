"use client";
import { createStudioBrowser } from "./studio-browser";

const BUCKET = "studio-media";
const MAX_AUDIO = 25 * 1024 * 1024;
export type StoredAudio = { start: number; end: number; text: string; audioUrl?: string; audioPath?: string; audioMime?: string; mimeType?: string; duration?: number; audioBase64?: string };
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

export async function prepareMaziaoVoiceSample(file: File): Promise<File> {
  if (!file.size || file.size > MAX_AUDIO) throw new Error("Chọn bản thu không quá 25 MB để chuẩn hóa giọng.");
  const browser = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  const Context = browser.AudioContext || browser.webkitAudioContext;
  if (!Context || typeof OfflineAudioContext === "undefined") throw new Error("Trình duyệt chưa đọc được mẫu giọng. Hãy dùng Chrome, Safari hoặc Edge mới.");
  const context = new Context();
  try {
    let input: AudioBuffer;
    try { input = await context.decodeAudioData(await file.arrayBuffer()); }
    catch { throw new Error("Chưa đọc được mẫu giọng. Hãy chọn tệp MP3, WAV hoặc M4A khác."); }
    if (!Number.isFinite(input.duration) || input.duration < 3) throw new Error("Mẫu giọng cần ít nhất 3 giây nói liên tục, rõ tiếng.");
    const sampleRate = 24000, frames = Math.floor(Math.min(8, input.duration) * sampleRate);
    const offline = new OfflineAudioContext(1, frames, sampleRate), source = offline.createBufferSource();
    source.buffer = input; source.connect(offline.destination); source.start();
    const output = (await offline.startRendering()).getChannelData(0);
    const bytes = new Uint8Array(44 + output.length * 2), view = new DataView(bytes.buffer);
    const text = (offset: number, value: string) => [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, output.length * 2, true);
    output.forEach((value, index) => { const clamped = Math.max(-1, Math.min(1, value)); view.setInt16(44 + index * 2, clamped < 0 ? clamped * 32768 : clamped * 32767, true); });
    return new File([bytes], "voice-sample.wav", { type: "audio/wav" });
  } finally { await context.close().catch(() => {}); }
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
  if (!Array.isArray(segments) || !segments.length || segments.length > 16 || segments.some(segment => !segment || typeof segment !== "object")) throw new Error("Kết quả lời thoại chưa hợp lệ.");
  const expectedOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "https://unconfigured.invalid").origin;
  const storage = segments.some(segment => !segment.audioBase64) ? await storageUser() : undefined;
  const prefix = `/storage/v1/object/sign/${BUCKET}/`;
  const validateUrl = (value: unknown, path: string): URL => {
    try {
      if (typeof value !== "string") throw new Error();
      const url = new URL(value);
      if (url.origin !== expectedOrigin || url.username || url.password || url.hash
        || !url.pathname.startsWith(prefix) || decodeURIComponent(url.pathname.slice(prefix.length)) !== path) throw new Error();
      return url;
    } catch { throw new Error("Đường dẫn lời thoại không thuộc kho tệp riêng của tài khoản hiện tại."); }
  };
  // Validate the complete batch before signing or fetching anything. Recovery
  // uses owned paths; signed URLs are short-lived and never belong in a project.
  const urls = segments.map(segment => {
    if (segment.audioBase64) return undefined;
    if (!storage || !safePath(storage.userId, segment.audioPath)) throw new Error("Đường dẫn lời thoại không thuộc kho tệp riêng của tài khoản hiện tại.");
    return segment.audioUrl === undefined ? undefined : validateUrl(segment.audioUrl, segment.audioPath);
  });
  const results: (T & { audioBase64: string; mimeType: string })[] = [];
  let total = 0;
  for (const [index, segment] of segments.entries()) {
    const { audioUrl: _url, audioPath: _path, ...rest } = segment;
    const mimeType = segment.audioMime || segment.mimeType || "audio/wav";
    if (segment.audioBase64) {
      results.push({ ...rest, audioBase64: segment.audioBase64, mimeType } as T & { audioBase64: string; mimeType: string });
      continue;
    }
    let url = urls[index];
    if (!url) {
      let signedUrl: string;
      try {
        const { data, error } = await storage!.client.storage.from(BUCKET).createSignedUrl(segment.audioPath!, 300);
        if (error || !data?.signedUrl) throw new Error();
        signedUrl = data.signedUrl;
      } catch { throw new Error("Chưa mở lại được tệp lời đọc. Kiểm tra kết nối hoặc đăng nhập lại rồi bấm Tải lại lời đọc."); }
      url = validateUrl(signedUrl, segment.audioPath!);
    }
    let blob: Blob;
    try {
      const response = await fetch(url.href, { signal: AbortSignal.timeout(60_000), credentials: "omit", redirect: "error" });
      if (!response.ok) throw new Error();
      blob = await response.blob();
    } catch { throw new Error("Chưa tải được lời đọc đã tạo. Kiểm tra kết nối rồi bấm Tải lại lời đọc."); }
    total += blob.size;
    if (!blob.size || total > 16 * 1024 * 1024) throw new Error("Tệp lời thoại trống hoặc quá lớn.");
    results.push({ ...rest, audioBase64: await base64(blob), mimeType } as T & { audioBase64: string; mimeType: string });
  }
  // Downloading never deletes paid audio. The caller may explicitly remove the
  // owned objects only after these bytes have been saved durably on the device.
  return results;
}
