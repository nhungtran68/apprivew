import "server-only";

import { parseBuffer } from "music-metadata";
import { StudioError } from "./studio-contract";

export type TranscriptWord = { text: string; start: number; end: number };
export type AudioTranscript = {
  text: string;
  words: TranscriptWord[];
  duration: number;
  languageCode: string;
};

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 90;
const TRANSCRIPTION_TIMEOUT_MS = 120_000;

export function transcriptionPath(userId: string, value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(`${userId}/video-transcriptions/`)
    || value.length > 400 || value.includes("..")
    || !/^[a-zA-Z0-9_./-]+\.(mp3|wav|m4a)$/i.test(value)) {
    throw new StudioError("INVALID_TRANSCRIPTION_FILE", "Hãy chọn lại tệp MP3, WAV hoặc M4A trong tài khoản của bạn.", 400);
  }
  return value;
}

/** Measure the stored bytes on the server; a browser-supplied duration cannot set the bill. */
export async function measureTranscriptionAudio(file: File): Promise<number> {
  if (!file.size || file.size > MAX_AUDIO_BYTES)
    throw new StudioError("INVALID_TRANSCRIPTION_FILE", "Tệp lời thoại phải có dữ liệu và không quá 32 MB.", 413);
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (!extension || !["mp3", "wav", "m4a"].includes(extension))
    throw new StudioError("INVALID_TRANSCRIPTION_FILE", "Chỉ hỗ trợ lời thoại MP3, WAV hoặc M4A.", 400);
  let duration: number | undefined;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const metadata = await parseBuffer(bytes, { mimeType: file.type || undefined, size: bytes.byteLength }, { duration: true, skipCovers: true });
    duration = metadata.format.duration;
    if (!metadata.format.codec || !metadata.format.sampleRate || !metadata.format.numberOfChannels) duration = undefined;
  } catch { /* Invalid media is reported below without exposing parser details. */ }
  if (!duration || !Number.isFinite(duration) || duration < 2 || duration > MAX_AUDIO_SECONDS)
    throw new StudioError("INVALID_TRANSCRIPTION_DURATION", "Bản lời thoại cần dài từ 2 đến 90 giây và phát được. Hãy chọn tệp khác.", 422);
  return Math.round(duration * 1000) / 1000;
}

export function parseTranscriptionResult(value: unknown, duration: number): AudioTranscript {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new StudioError("TRANSCRIPTION_INVALID", "Dịch vụ chưa trả về bản chép lời hợp lệ. Vui lòng thử lại sau.", 502);
  const result = value as Record<string, unknown>;
  const text = typeof result.text === "string" ? result.text.trim() : "";
  if (text.length < 12 || text.length > 6000 || !Array.isArray(result.words))
    throw new StudioError("TRANSCRIPTION_INVALID", "Chưa nhận diện được lời nói rõ ràng hoặc bản chép lời quá dài. Hãy kiểm tra file âm thanh.", 422);
  const words: TranscriptWord[] = [];
  for (const item of result.words) {
    if (!item || typeof item !== "object") continue;
    const word = item as Record<string, unknown>;
    if (word.type !== "word") continue;
    const start = Number(word.start), end = Number(word.end);
    if (typeof word.text !== "string" || !word.text.trim() || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end <= start || end > duration + 1) continue;
    words.push({ text: word.text, start, end });
  }
  if (!words.length)
    throw new StudioError("TRANSCRIPTION_INVALID", "Chưa nhận được mốc thời gian lời nói. Hãy thử một tệp có tiếng nói rõ hơn.", 422);
  return {
    text,
    words,
    duration,
    languageCode: typeof result.language_code === "string" ? result.language_code : "vie",
  };
}

/** The server sends a private file to Scribe. The API key never reaches the browser. */
export async function transcribeAudio(file: File, key: string, duration: number): Promise<AudioTranscript> {
  const form = new FormData();
  form.set("model_id", "scribe_v2");
  form.set("language_code", "vie");
  form.set("timestamps_granularity", "word");
  form.set("tag_audio_events", "false");
  form.set("file", file, file.name);
  let response: Response;
  try {
    response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    });
  } catch {
    throw new StudioError("TRANSCRIPTION_UNAVAILABLE", "Dịch vụ nhận diện giọng nói chưa phản hồi. Vui lòng kiểm tra lại sau; đừng gửi liên tiếp cùng một tệp.", 503);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new StudioError("TRANSCRIPTION_PERMISSION", "Khóa ElevenLabs chưa có quyền Speech to Text. Quản trị viên cần bật quyền này.", 503, "contact_admin");
    if (response.status === 402)
      throw new StudioError("TRANSCRIPTION_QUOTA", "Tài khoản ElevenLabs đã hết hạn mức nhận diện giọng nói.", 503, "contact_admin");
    if (response.status === 413 || response.status === 422)
      throw new StudioError("TRANSCRIPTION_REJECTED", "Dịch vụ chưa đọc được tệp lời thoại này. Hãy thử tệp MP3, WAV hoặc M4A khác.", 422);
    if (response.status === 429)
      throw new StudioError("TRANSCRIPTION_RATE_LIMIT", "Dịch vụ đang giới hạn lượt xử lý. Vui lòng thử lại sau ít phút.", 429);
    throw new StudioError("TRANSCRIPTION_UNAVAILABLE", "Dịch vụ nhận diện giọng nói đang gặp lỗi. Vui lòng thử lại sau.", 502);
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new StudioError("TRANSCRIPTION_INVALID", "Dịch vụ chưa trả về bản chép lời hợp lệ. Vui lòng thử lại sau.", 502); }
  return parseTranscriptionResult(data, duration);
}
