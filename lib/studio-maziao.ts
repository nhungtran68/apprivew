import "server-only";
import { StudioError, cleanText, type StudioSegment } from "./studio-contract";
import { MAZIAO_MODELS, authorizedVoiceRows, consumeAiUnits, maziaoModel, providerKey, saveAuthorizedVoice, saveSharedVoiceList, type MaziaoModel } from "./studio-server";
import { shortenSegment } from "./studio-deepseek";
import { removeOwnedMedia, storeNarration } from "./studio-supabase";
import { inspectWav } from "./studio-wav";
import type { StudioVoice } from "./studio-eleven";

const BASE = "https://app.maziao.com/api";
const MEDIA_HOST = "r2-storage.maziao.com";
const MAX_AUDIO = 12 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
type ProviderVoice = { id?: unknown; name?: unknown; userId?: unknown; user_id?: unknown; language?: unknown; gender?: unknown; modelId?: unknown; model_id?: unknown; previewUrl?: unknown; preview_url?: unknown; refFile?: unknown; ref_file?: unknown; refText?: unknown; ref_text?: unknown };
type ProviderModel = { id?: unknown; support_cloning?: unknown; supported_languages?: unknown };
type SpeechJob = { id?: unknown; status?: unknown; resultUrl?: unknown; resultUrls?: unknown; totalTasks?: unknown; completedTasks?: unknown };
type Audio = { wav: Uint8Array; duration: number; sampleRate: number; channels: number };

const invalidResponse = () => new StudioError("MAZIAO_INVALID_RESPONSE", "Maziao trả kết quả chưa hợp lệ. Vui lòng thử lại sau.", 502);
const rawId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const scopedId = (model: MaziaoModel, id: string) => `maziao:${model}:${id}`;
export function parseMaziaoVoiceId(value: string) {
  const [provider, model, id, extra] = value.split(":");
  if (provider !== "maziao" || extra !== undefined || !MAZIAO_MODELS.some(item => item === model) || !rawId(id)) throw new StudioError("INVALID_VOICE", "Chọn một giọng Maziao trong danh sách của bạn.");
  return { model: model as MaziaoModel, id };
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") || 0) > maximum) { await response.body?.cancel(); throw invalidResponse(); }
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw invalidResponse(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function api(key: string, path: string, init: RequestInit = {}, deadline = Date.now() + 30000): Promise<Record<string, unknown>> {
  if (Date.now() >= deadline) throw new StudioError("MAZIAO_TIMEOUT", "Maziao đang xử lý lâu. Kiểm tra tác vụ trong Maziao trước khi tạo lại để tránh tốn credit hai lần.", 504);
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}) }, redirect: "error", signal: AbortSignal.timeout(Math.min(30000, Math.max(1, deadline - Date.now()))) });
  } catch { throw new StudioError("MAZIAO_UNAVAILABLE", "Chưa nhận được phản hồi từ Maziao. Nếu vừa tạo lời đọc, kiểm tra tác vụ Maziao trước khi tạo lại để tránh trừ credit lặp.", 502); }
  if ([401, 403].includes(response.status)) {
    await response.body?.cancel();
    throw new StudioError("MAZIAO_AUTH", "Maziao từ chối kết nối. Quản trị viên cần kiểm tra MAZIAO_API_KEY và quyền API của gói trả phí.", 422, "contact_admin");
  }
  if (response.status === 402) { await response.body?.cancel(); throw new StudioError("MAZIAO_BALANCE", "Tài khoản Maziao chưa đủ credit hoặc chưa có quyền API. Quản trị viên cần kiểm tra gói và số dư.", 422, "contact_admin"); }
  if (response.status === 429) { await response.body?.cancel(); throw new StudioError("MAZIAO_LIMIT", "Maziao đang giới hạn số tác vụ cùng lúc. Hãy chờ tác vụ hiện tại xong rồi thử lại.", 429); }
  if (response.status === 404) { await response.body?.cancel(); throw new StudioError("MAZIAO_NOT_FOUND", "Giọng Maziao này không còn tồn tại. Hãy tải lại danh sách và chọn giọng khác.", 422); }
  if (!response.ok) { await response.body?.cancel(); throw new StudioError("MAZIAO_REJECTED", response.status >= 500 ? "Maziao đang gián đoạn. Vui lòng thử lại sau." : "Maziao chưa chấp nhận dữ liệu. Kiểm tra giọng, model và mẫu thu 3–8 giây.", response.status >= 500 ? 502 : 422); }
  let result: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await boundedBytes(response, MAX_JSON)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    result = parsed;
  } catch { throw invalidResponse(); }
  // Never reflect provider messages: they can include the submitted text, file URL or token.
  if (Array.isArray(result.errors) && result.errors.length) {
    if (result.errors.some(item => item === "errors.limit.modelPaidOnly")) throw new StudioError("MAZIAO_PLAN_REQUIRED", "Model Maziao này cần gói trả phí có API. Quản trị viên cần kiểm tra tài khoản.", 422, "contact_admin");
    if (result.errors.some(item => item === "errors.limit.concurrency")) throw new StudioError("MAZIAO_LIMIT", "Maziao đang có tác vụ chưa xong. Vui lòng chờ rồi thử lại.", 429);
    throw new StudioError("MAZIAO_REJECTED", "Maziao chưa chấp nhận yêu cầu. Kiểm tra hạn mức tài khoản, giọng và model đang dùng.", 422);
  }
  return result;
}

async function assertModel(key: string, model: MaziaoModel, deadline?: number) {
  const result = await api(key, "/configs", {}, deadline), data = result.data as { ttsModels?: ProviderModel[] } | undefined;
  const config = Array.isArray(data?.ttsModels) ? data.ttsModels.find(item => item?.id === model) : undefined;
  const languages = config?.supported_languages;
  if (!config || config.support_cloning !== true || !Array.isArray(languages) || !languages.includes("vi")) throw new StudioError("MAZIAO_MODEL_UNAVAILABLE", "Model Maziao đang chọn chưa hỗ trợ nhân bản tiếng Việt trong tài khoản này. Quản trị viên cần kiểm tra MAZIAO_MODEL.", 422, "contact_admin");
}

function safeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== MEDIA_HOST || url.port || url.username || url.password || url.hash) return;
    return url.href;
  } catch { return; }
}
function publicVoice(voice: ProviderVoice) {
  // Missing ownership metadata is not proof that a shared-account voice is public.
  return Object.hasOwn(voice, "userId") ? voice.userId === null : Object.hasOwn(voice, "user_id") && voice.user_id === null;
}
const voiceModel = (voice: ProviderVoice) => voice.modelId ?? voice.model_id;
const compatible = (voice: ProviderVoice, model: MaziaoModel) => (!voiceModel(voice) || voiceModel(voice) === model) && (voice.language === "vi" || voice.language === "vi-VN") && typeof (voice.refFile ?? voice.ref_file) === "string" && Boolean(voice.refFile ?? voice.ref_file);
function presentVoice(voice: ProviderVoice, id: string, personal: boolean, fallback: string): StudioVoice {
  return { voiceId: id, name: cleanText(voice.name, 200) || fallback, category: personal ? "cloned" : "library", group: personal ? "personal" : "vietnamese", language: "vi", gender: voice.gender === "male" || voice.gender === "female" ? voice.gender : undefined, previewUrl: safeMediaUrl(voice.previewUrl ?? voice.preview_url) };
}
async function getVoice(key: string, id: string, deadline?: number): Promise<ProviderVoice> {
  const result = await api(key, `/voices/${encodeURIComponent(id)}`, {}, deadline);
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) throw invalidResponse();
  const voice = result.data as ProviderVoice;
  if (voice.id !== id) throw invalidResponse();
  return voice;
}

export async function listMaziaoVoices(key: string, userId: string): Promise<StudioVoice[]> {
  const model = maziaoModel();
  await assertModel(key, model);
  const grants = (await authorizedVoiceRows(userId)).filter(row => row.voice_id.startsWith("maziao:"));
  const owned = grants.filter(row => row.source === "personal");
  const ownedIds = new Set(owned.map(row => row.voice_id));
  const query = new URLSearchParams({ language: "vi", modelId: model, type: "system", limit: "100", offset: "0" });
  const result = await api(key, `/voices?${query}`), data = result.data as { items?: ProviderVoice[] } | undefined;
  if (!Array.isArray(data?.items)) throw invalidResponse();
  const seen = new Set<string>();
  const shared = data.items.filter(voice => {
    if (!voice || !rawId(voice.id) || !publicVoice(voice) || !compatible(voice, model)) return false;
    const id = scopedId(model, voice.id);
    if (seen.has(id) || ownedIds.has(id)) return false;
    seen.add(id); return true;
  }).slice(0, 20).map(voice => presentVoice(voice, scopedId(model, voice.id as string), false, "Giọng tiếng Việt"));
  // Resolve only the current member's signed grants. Never return the Maziao
  // account's /my-voices list, which would mix every app member's private voices.
  const personal: StudioVoice[] = [];
  for (const row of owned.slice(0, 25)) {
    const parsed = parseMaziaoVoiceId(row.voice_id);
    try {
      const voice = await getVoice(key, parsed.id);
      personal.push(presentVoice(voice, row.voice_id, true, row.name));
    } catch (error) {
      // A member can delete their clone directly in Maziao. Keep the public
      // catalog usable, but do not hide permission, network or provider errors.
      if (!(error instanceof StudioError) || error.code !== "MAZIAO_NOT_FOUND") throw error;
    }
  }
  await saveSharedVoiceList(userId, shared);
  return [...personal, ...shared];
}

export async function cloneMaziaoVoice(key: string, userId: string, name: string, files: File[], gender: "male" | "female") {
  if (files.length !== 1 || files[0].size > 1024 * 1024) throw new StudioError("MAZIAO_SAMPLE_REQUIRED", "Maziao cần một bản thu WAV 3–8 giây, tối đa 1 MB.", 422);
  const sample = files[0], info = inspectWav(new Uint8Array(await sample.arrayBuffer()));
  if (info.duration < 2.8 || info.duration > 8.2 || info.channels !== 1 || info.encoding !== 1 || info.bits !== 16) throw new StudioError("MAZIAO_SAMPLE_DURATION", "Mẫu giọng Maziao cần 3–8 giây. Hãy chọn tệp khác để app chuẩn hóa lại.", 422);
  if (gender !== "male" && gender !== "female") throw new StudioError("INVALID_GENDER", "Chọn giọng nam hoặc nữ để nhân bản.");
  const model = maziaoModel();
  await assertModel(key, model);
  const form = new FormData();
  form.set("name", name); form.set("gender", gender); form.set("model", model); form.set("language", "vi");
  form.set("previewText", ""); form.set("removeNoise", "0"); form.set("refFile", sample, "voice-sample.wav");
  await consumeAiUnits(userId, 10);
  const result = await api(key, "/voices", { method: "POST", body: form }, Date.now() + 90000);
  const voice = result.data as ProviderVoice | undefined;
  if (!voice || !rawId(voice.id)) throw invalidResponse();
  const id = scopedId(model, voice.id);
  await saveAuthorizedVoice(userId, id, name, "personal");
  return { voiceId: id, name, requiresVerification: false };
}

export async function authorizeMaziaoVoice(userId: string, voiceId: string) {
  const parsed = parseMaziaoVoiceId(voiceId);
  const grant = (await authorizedVoiceRows(userId)).find(row => row.voice_id === voiceId);
  if (!grant || !["shared", "personal"].includes(grant.source)) throw new StudioError("VOICE_NOT_AUTHORIZED", "Tải lại danh sách và chọn giọng thuộc tài khoản của bạn.", 403);
  const { key } = await providerKey(userId, "maziao");
  const voice = await getVoice(key, parsed.id);
  if (grant.source === "shared" && (!publicVoice(voice) || !compatible(voice, parsed.model))) throw new StudioError("VOICE_NOT_AUTHORIZED", "Giọng này không còn được chia sẻ. Hãy tải lại danh sách để chọn giọng khác.", 403);
  if (voiceModel(voice) && voiceModel(voice) !== parsed.model) throw new StudioError("MAZIAO_VOICE_MODEL", "Giọng này dùng model khác. Hãy tải lại danh sách giọng.", 422);
  return voiceId;
}

async function fetchAudio(value: unknown, deadline: number): Promise<Audio> {
  const url = safeMediaUrl(value);
  if (!url) throw new StudioError("MAZIAO_AUDIO_URL", "Đường dẫn âm thanh Maziao chưa hợp lệ.", 502);
  let response: Response;
  try {
    // No Authorization header or cookies leave the provider API origin.
    response = await fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(30000, deadline - Date.now()))) });
  } catch { throw new StudioError("MAZIAO_AUDIO_DOWNLOAD", "Chưa tải được lời đọc Maziao. Kiểm tra kết nối và tác vụ trước khi tạo lại.", 502); }
  if (!response.ok) { await response.body?.cancel(); throw new StudioError("MAZIAO_AUDIO_DOWNLOAD", "Maziao chưa cho tải tệp lời đọc. Kiểm tra tác vụ trước khi tạo lại.", 502); }
  const wav = await boundedBytes(response, MAX_AUDIO), info = inspectWav(wav);
  if (info.duration > 180) throw invalidResponse();
  return { wav, duration: info.duration, sampleRate: info.sampleRate, channels: info.channels };
}

function resultUrls(job: SpeechJob, count: number): string[] {
  let result: unknown = job.resultUrls;
  if (result === undefined && typeof job.resultUrl === "string") {
    if (job.resultUrl.trim().startsWith("[")) { try { result = JSON.parse(job.resultUrl); } catch { throw invalidResponse(); } }
    else if (count === 1) result = [job.resultUrl];
  }
  if (!Array.isArray(result) || result.length !== count || result.some(item => !safeMediaUrl(item))) throw invalidResponse();
  return result as string[];
}
async function synthesizeBatch(key: string, userId: string, voiceId: string, segments: StudioSegment[], deadline: number): Promise<Audio[]> {
  const parsed = parseMaziaoVoiceId(voiceId);
  await consumeAiUnits(userId, Math.max(1, Math.ceil(segments.reduce((sum, segment) => sum + segment.text.length, 0) / 100)));
  const started = Date.now();
  const result = await api(key, "/tts/submit", { method: "POST", body: JSON.stringify({ mode: "multiParts", parts: segments.map(segment => ({ text: segment.text, voiceId: parsed.id, speed: 1, pitch: 1 })), config: { volume: 1, pitch: 1, export_srt: false }, modelId: parsed.model }) }, deadline);
  const data = result.data as { taskId?: unknown; totalCost?: unknown } | undefined;
  if (!data || !rawId(data.taskId)) throw invalidResponse();
  // Actual provider credits, never estimated as 1 character = 1 credit.
  console.info(JSON.stringify({ event: "studio_voice_usage", provider: "maziao", model: parsed.model, characters: segments.reduce((sum, segment) => sum + segment.text.length, 0), credits: typeof data.totalCost === "number" && Number.isSafeInteger(data.totalCost) && data.totalCost >= 0 && data.totalCost <= 1000000000 ? data.totalCost : null, segments: segments.length, elapsedMs: Date.now() - started }));
  while (Date.now() < deadline) {
    const polled = await api(key, "/tts/status", { method: "POST", body: JSON.stringify({ ids: [data.taskId] }) }, deadline);
    const job = Array.isArray(polled.data) ? (polled.data as SpeechJob[]).find(item => item?.id === data.taskId) : undefined;
    if (!job) throw invalidResponse();
    if (job.status === "completed") {
      const urls = resultUrls(job, segments.length), audio: Audio[] = [];
      for (const url of urls) audio.push(await fetchAudio(url, deadline));
      return audio;
    }
    if (job.status === "failed") throw new StudioError("MAZIAO_TASK_FAILED", "Maziao không tạo được lời đọc. Kiểm tra giọng và trạng thái tác vụ trước khi thử lại.", 422);
    if (!["pending", "processing", "saving", "exportingSrt"].includes(String(job.status))) throw invalidResponse();
    await new Promise(resolve => setTimeout(resolve, Math.min(6000, Math.max(0, deadline - Date.now()))));
  }
  throw new StudioError("MAZIAO_TIMEOUT", "Maziao chưa xử lý xong trong thời gian chờ. Kiểm tra tác vụ trong Maziao trước khi tạo lại để tránh trừ credit lặp.", 504);
}

export async function generateMaziaoSpeech(input: { key: string; userId: string; voiceId: string; segments: StudioSegment[]; duration: number }) {
  const parsed = parseMaziaoVoiceId(input.voiceId), deadline = Date.now() + 240000;
  await assertModel(input.key, parsed.model, deadline);
  const segments = input.segments.map(segment => ({ ...segment }));
  const audio = await synthesizeBatch(input.key, input.userId, input.voiceId, segments, deadline);
  // Recreate only overlong segments. Never truncate paid speech to force a fit.
  for (let attempt = 0; attempt < 2; attempt++) {
    const indexes = segments.flatMap((segment, index) => audio[index].duration > segment.end - segment.start ? [index] : []);
    if (!indexes.length) break;
    if (Date.now() + 30000 >= deadline) throw new StudioError("TIMING_NEEDS_EDIT", "Lời đọc dài hơn cảnh. Rút gọn kịch bản rồi tạo lại; app không cắt mất lời.", 422, "script");
    const { key } = await providerKey(input.userId, "deepseek");
    for (const index of indexes) {
      if (Date.now() + 30000 >= deadline) throw new StudioError("TIMING_NEEDS_EDIT", "Cần rút gọn thêm lời thoại để khớp cảnh. Chỉnh kịch bản rồi tạo lại.", 422, "script");
      segments[index].text = await shortenSegment(key, segments[index], audio[index].duration, () => consumeAiUnits(input.userId, 1), Math.min(30000, deadline - Date.now() - 30000));
    }
    const replacements = await synthesizeBatch(input.key, input.userId, input.voiceId, indexes.map(index => segments[index]), deadline);
    indexes.forEach((index, offset) => { audio[index] = replacements[offset]; });
  }
  const overlong = segments.findIndex((segment, index) => audio[index].duration > segment.end - segment.start);
  if (overlong !== -1) throw new StudioError("TIMING_NEEDS_EDIT", `Lời đoạn ${overlong + 1} vẫn dài hơn cảnh. Rút gọn rồi tạo lại; app không cắt mất lời.`, 422, "script");
  const stored: string[] = [];
  try {
    const results = [];
    for (const [index, segment] of segments.entries()) {
      const media = await storeNarration(input.userId, audio[index].wav, index); stored.push(media.audioPath);
      results.push({ ...segment, ...media, audioMime: "audio/wav", duration: audio[index].duration, revised: segment.text !== input.segments[index].text });
    }
    return { segments: results, duration: input.duration, voiceId: input.voiceId, sampleRate: audio[0].sampleRate, channels: audio[0].channels, provider: "maziao" };
  } catch (error) { await removeOwnedMedia(input.userId, stored).catch(() => {}); throw error; }
}
