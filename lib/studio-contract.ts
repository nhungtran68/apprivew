export type StudioProfile = { name?: string; audience?: string; tone?: string; brand?: string; facts?: string; cta?: string; mode?: "scenery" | "talking" | "face" };
export type StudioSegment = { start: number; end: number; text: string };
export type StudioAnalysis = { duration: number; summary: string; intentSummary: string; observations: { start: number; end: number; description: string }[]; facts: string[]; unknowns: string[]; questions: string[] };

export class StudioError extends Error {
  constructor(public code: string, message: string, public status = 400, public action?: string) { super(message); this.name = "StudioError"; }
}
export function cleanText(value: unknown, maxLength = 4000): string { return typeof value === "string" ? value.trim().slice(0, maxLength) : ""; }
export function validDuration(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 2 || n > 90) throw new StudioError("INVALID_DURATION", "Bản đầu hỗ trợ video từ 2 đến 90 giây.");
  return Math.round(n * 1000) / 1000;
}
export function sanitizeProfile(value: unknown): StudioProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const fields = Object.fromEntries(["name", "audience", "tone", "brand", "facts", "cta"].map((key) => [key, cleanText(raw[key], key === "facts" ? 4000 : 800)]));
  return { ...fields, mode: raw.mode === "talking" || raw.mode === "face" ? raw.mode : "scenery" };
}
export function validateSegments(value: unknown, duration: number): StudioSegment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new StudioError("INVALID_SEGMENTS", "Kịch bản cần từ 1 đến 16 đoạn lời thoại.");
  let lastEnd = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new StudioError("INVALID_SEGMENTS", "Đoạn lời thoại không hợp lệ.");
    const { start, end, text } = item as Record<string, unknown>;
    if (typeof text === "string" && text.trim().length > 2400) throw new StudioError("SCRIPT_TOO_LONG", `Đoạn ${index + 1} quá dài. Hãy rút gọn lời trước khi tạo giọng.`);
    const a = Number(start), b = Number(end), t = cleanText(text, 2400);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < lastEnd - 0.001 || a < 0 || b > duration + 0.001 || b - a < 0.5 || !t) throw new StudioError("INVALID_TIMELINE", `Đoạn ${index + 1} cần có lời thoại và thời gian liên tiếp trong video.`);
    lastEnd = b;
    return { start: Math.round(a * 1000) / 1000, end: Math.round(b * 1000) / 1000, text: t };
  });
}
export function pcmToWav(pcm: Uint8Array, sampleRate = 24000): Uint8Array {
  if (pcm.length % 2 !== 0) throw new StudioError("INVALID_AUDIO", "Dữ liệu âm thanh từ nhà cung cấp bị lỗi.", 502);
  const wav = new Uint8Array(44 + pcm.length), view = new DataView(wav.buffer);
  const put = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  put(0, "RIFF"); view.setUint32(4, 36 + pcm.length, true); put(8, "WAVE"); put(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); put(36, "data"); view.setUint32(40, pcm.length, true); wav.set(pcm, 44);
  return wav;
}
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), (c) => c.charCodeAt(0)); }
