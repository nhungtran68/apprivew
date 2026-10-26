import "server-only";
import { StudioError } from "./studio-contract";

const BASE = "https://voice.saydi.ai/api";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_RETRY_WAIT_MS = 60_000;
const OPENAI_VOICE_ALIASES = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"]);

export type SaydiSample = {
  voice_id: string;
  display_name: string;
  language?: string;
  gender?: string;
  locale?: string;
  featured?: boolean;
};
export type SaydiVoiceStatus = "ready" | "processing" | "failed";

export class SaydiApiError extends StudioError {
  constructor(
    code: string,
    message: string,
    status: number,
    public retryAfter?: string,
    public limit?: string,
    public providerCode?: string,
  ) {
    super(code, message, status);
    this.name = "SaydiApiError";
  }
}

function invalidResponse(): StudioError {
  return new StudioError("SAYDI_INVALID_RESPONSE", "SaydiVoice trả về dữ liệu chưa hợp lệ. Nếu vừa tạo audio, hãy kiểm tra kết quả trước khi thử lại để tránh tính phí hai lần.", 502);
}

function configuredKey(key: string): string {
  if (typeof key !== "string" || !key.startsWith("sv_live_") || key.length <= "sv_live_".length) {
    throw new StudioError("SAYDI_KEY_MISSING", "Chưa cấu hình khóa SAYDI_API_KEY trên máy chủ.", 503, "contact_admin");
  }
  return key;
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function safeProviderMessage(value: unknown, key: string, submittedText?: string): string | undefined {
  if (typeof value !== "string") return;
  let message = value.replace(/[\r\n\t\u0000-\u001f]+/g, " ").trim();
  if (!message) return;
  message = message.split(key).join("[redacted]").replace(/sv_live_[A-Za-z0-9_-]+/g, "[redacted]");
  if (submittedText) message = message.split(submittedText).join("[text]");
  return message.slice(0, 300);
}

async function limitedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw invalidResponse();
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw invalidResponse();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function jsonBody(response: Response): Promise<unknown> {
  const bytes = await limitedBytes(response, MAX_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalidResponse();
  }
}

async function rejected(response: Response, key: string, submittedText?: string): Promise<never> {
  let error: unknown;
  try { error = await jsonBody(response); } catch { /* Keep the documented HTTP status even if the error body is malformed. */ }
  const body = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const envelope = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
  const providerCode = typeof envelope.code === "string" ? envelope.code : typeof body.code === "string" ? body.code : undefined;
  const providerMessage = safeProviderMessage(envelope.message ?? body.detail, key, submittedText);
  const message = providerMessage ?? (response.status === 429
    ? "SaydiVoice đang giới hạn yêu cầu. Vui lòng chờ rồi thử lại."
    : "SaydiVoice chưa chấp nhận yêu cầu. Vui lòng kiểm tra nội dung hoặc cấu hình dịch vụ.");
  throw new SaydiApiError(
    response.status === 429 ? "SAYDI_RATE_LIMIT" : "SAYDI_REJECTED",
    message,
    response.status,
    response.headers.get("retry-after") ?? undefined,
    response.headers.get("x-ov-limit") ?? undefined,
    providerCode,
  );
}

async function request(
  key: string,
  path: string,
  init: RequestInit,
  options: { timeoutMs: number; retry429: boolean; submittedText?: string },
): Promise<Response> {
  const secret = configuredKey(key);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${secret}`);
  const deadline = Date.now() + options.timeoutMs;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${BASE}${path}`, {
        ...init,
        headers,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch {
      // A POST may have succeeded before its connection failed. Never resubmit it here.
      throw new StudioError("SAYDI_UNAVAILABLE", "Chưa nhận được phản hồi từ SaydiVoice. Nếu vừa tạo audio, hãy kiểm tra kết quả trước khi thử lại để tránh tính phí hai lần.", 502);
    }
    if (response.ok) return response;
    if (response.status !== 429 || !options.retry429 || attempt === 2) {
      return rejected(response, secret, options.submittedText);
    }
    const headerWait = retryAfterMilliseconds(response.headers.get("retry-after"));
    const backoff = 1000 * 2 ** attempt + Math.floor(Math.random() * 250);
    const wait = Math.max(headerWait ?? 0, backoff);
    if (wait > MAX_RETRY_WAIT_MS || Date.now() + wait >= deadline) {
      return rejected(response, secret, options.submittedText);
    }
    await response.body?.cancel();
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }
  throw invalidResponse();
}

function voiceStatus(value: unknown): value is SaydiVoiceStatus {
  return value === "ready" || value === "processing" || value === "failed";
}

export async function listSaydiSamples(key: string): Promise<SaydiSample[]> {
  const response = await request(key, "/samples", {}, { timeoutMs: 30_000, retry429: true });
  const data = await jsonBody(response);
  if (!Array.isArray(data)) throw invalidResponse();
  const samples: SaydiSample[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") throw invalidResponse();
    const voice = item as Record<string, unknown>;
    if (typeof voice.voice_id !== "string" || !voice.voice_id || typeof voice.display_name !== "string") throw invalidResponse();
    samples.push({
      voice_id: voice.voice_id,
      display_name: voice.display_name,
      ...(typeof voice.language === "string" ? { language: voice.language } : {}),
      ...(typeof voice.gender === "string" ? { gender: voice.gender } : {}),
      ...(typeof voice.locale === "string" ? { locale: voice.locale } : {}),
      ...(typeof voice.featured === "boolean" ? { featured: voice.featured } : {}),
    });
  }
  return samples;
}

export async function synthesizeSaydi(
  key: string,
  input: { text: string; voiceId: string; speed?: number },
): Promise<{ audio: Uint8Array; mime: string; chars: number }> {
  const text = input.text?.trim();
  if (!text || Array.from(text).length > 4096) throw new StudioError("SAYDI_INVALID_TEXT", "Nhập văn bản từ 1 đến 4096 ký tự để tạo giọng nói.", 422);
  const voiceId = input.voiceId?.trim();
  if (!voiceId || OPENAI_VOICE_ALIASES.has(voiceId.toLowerCase())) throw new StudioError("SAYDI_INVALID_VOICE", "Chọn voice_id của SaydiVoice trong danh sách giọng.", 422);
  if (input.speed !== undefined && (!Number.isFinite(input.speed) || input.speed < 0.25 || input.speed > 4)) {
    throw new StudioError("SAYDI_INVALID_SPEED", "Tốc độ đọc cần từ 0,25 đến 4.", 422);
  }
  const response = await request(key, "/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tts-1", voice: voiceId, input: text, response_format: "mp3", ...(input.speed !== undefined ? { speed: input.speed } : {}) }),
  }, { timeoutMs: 180_000, retry429: true, submittedText: text });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "audio/mpeg" && contentType !== "audio/mp3") {
    await response.body?.cancel();
    throw invalidResponse();
  }
  const audio = await limitedBytes(response, MAX_AUDIO_BYTES);
  if (!audio.length || audio[0] === 0x7b || audio[0] === 0x5b) throw invalidResponse();
  const rawChars = response.headers.get("x-ov-chars");
  const chars = rawChars === null ? NaN : Number(rawChars);
  if (!Number.isSafeInteger(chars) || chars < 1) throw invalidResponse();
  const actualVoice = response.headers.get("x-ov-voice");
  if (actualVoice !== voiceId) throw invalidResponse();
  return { audio, mime: "audio/mpeg", chars };
}

export async function cloneSaydi(
  key: string,
  input: { file: File; name: string; consent: boolean; idempotencyKey?: string },
): Promise<{ id: string; status: SaydiVoiceStatus }> {
  if (!input.file || !(input.file instanceof Blob) || input.file.size === 0) throw new StudioError("SAYDI_INVALID_SAMPLE", "Chọn một tệp ghi âm để nhân bản giọng.", 422);
  const name = input.name?.trim();
  if (!name) throw new StudioError("SAYDI_INVALID_NAME", "Nhập tên cho giọng được nhân bản.", 422);
  if (input.consent !== true) throw new StudioError("SAYDI_CONSENT_REQUIRED", "Cần xác nhận quyền sử dụng giọng nói trước khi nhân bản.", 422);
  const form = new FormData();
  form.append("file", input.file);
  form.append("name", name);
  form.append("language", "vi");
  form.append("consent", "true");
  const headers = new Headers();
  if (input.idempotencyKey) headers.set("Idempotency-Key", input.idempotencyKey);
  const response = await request(key, "/v1/voices", { method: "POST", headers, body: form }, {
    timeoutMs: 300_000,
    retry429: !!input.idempotencyKey,
  });
  if (response.status !== 200 && response.status !== 201) throw invalidResponse();
  const data = await jsonBody(response);
  if (!data || typeof data !== "object") throw invalidResponse();
  const voice = data as Record<string, unknown>;
  if (typeof voice.id !== "string" || !/^vc_[A-Za-z0-9_-]+$/.test(voice.id) || !voiceStatus(voice.status)) throw invalidResponse();
  return { id: voice.id, status: voice.status };
}

export async function getSaydiVoice(key: string, id: string): Promise<{ id: string; status: SaydiVoiceStatus }> {
  if (!/^vc_[A-Za-z0-9_-]+$/.test(id)) throw new StudioError("SAYDI_INVALID_VOICE", "Mã giọng SaydiVoice không hợp lệ.", 422);
  const response = await request(key, `/v1/voices/${encodeURIComponent(id)}`, {}, { timeoutMs: 30_000, retry429: true });
  const data = await jsonBody(response);
  if (!data || typeof data !== "object") throw invalidResponse();
  const voice = data as Record<string, unknown>;
  if (!voiceStatus(voice.status) || voice.id !== undefined && voice.id !== id) throw invalidResponse();
  return { id, status: voice.status };
}

/** A provider preview is returned through our authenticated same-origin route. */
export async function previewSaydiVoice(key: string, id: string, clone: boolean): Promise<{ audio: Uint8Array; mime: string }> {
  if (typeof id !== "string" || !id || id.length > 160 || /[\u0000-\u001f\u007f]/.test(id)
    || (clone && !/^vc_[A-Za-z0-9_-]+$/.test(id)))
    throw new StudioError("SAYDI_INVALID_VOICE", "Mã giọng SaydiVoice không hợp lệ.", 422);
  const path = clone ? `/v1/voices/${encodeURIComponent(id)}/preview` : `/samples/${encodeURIComponent(id)}/audio`;
  const response = await request(key, path, {}, { timeoutMs: 60_000, retry429: true });
  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() || "";
  if (!mime.startsWith("audio/")) { await response.body?.cancel(); throw invalidResponse(); }
  const audio = await limitedBytes(response, 10 * 1024 * 1024);
  if (!audio.length) throw invalidResponse();
  return { audio, mime };
}

export async function deleteSaydiVoice(key: string, id: string): Promise<void> {
  if (!/^vc_[A-Za-z0-9_-]+$/.test(id)) throw new StudioError("SAYDI_INVALID_VOICE", "Mã giọng SaydiVoice không hợp lệ.", 422);
  try {
    const response = await request(key, `/v1/voices/${encodeURIComponent(id)}`, { method: "DELETE" },
      { timeoutMs: 30_000, retry429: true });
    await response.body?.cancel();
  } catch (error) {
    // A previous delete may have reached the provider before local cleanup failed.
    if (error instanceof SaydiApiError && error.status === 404) return;
    throw error;
  }
}
