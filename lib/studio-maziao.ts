import "server-only";
import { StudioError, cleanText, type StudioSegment } from "./studio-contract";
import { MAZIAO_MODELS, authorizedVoiceRows, getMember, sharedVoiceCatalog, maziaoModel, providerKey, saveAuthorizedVoice, savePersonalVoicePreview, saveSharedVoiceList, type MaziaoModel } from "./studio-server";
import { shortenSegment } from "./studio-deepseek";
import { creditsForSpeech, deriveCreditRequestId, markCreditProviderTask, refundCredits, reserveCredits, settleCredits } from "./studio-credits";
import { createStudioSupabaseServer, removeOwnedMedia, storeNarration } from "./studio-supabase";
import { inspectWav } from "./studio-wav";
import { inspectMp3 } from "./studio-mp3";
import type { StudioVoice } from "./studio-eleven";

const BASE = "https://app.maziao.com/api";
const MEDIA_HOST = "r2-storage.maziao.com";
const MAX_AUDIO = 12 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
const CLONE_CREDITS = 50;
const SHORTEN_CREDITS = 10;

async function payloadHash(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), byte => byte.toString(16).padStart(2, "0")).join("");
}

function reusedCreditRequest(): never {
  throw new StudioError("CREDIT_REQUEST_REUSED", "Tác vụ này đã được gửi hoặc đang xử lý. Hãy kiểm tra kết quả trước khi tạo lại.", 409);
}

/** Rejected requests and confirmed failed jobs did not deliver paid output.
 * Network failures and malformed successful responses may still have created a
 * provider job, so their reservations stay locked for reconciliation. */
function definitivelyNotDelivered(error: unknown): boolean {
  return error instanceof StudioError && (
    error.code === "MAZIAO_TASK_FAILED" ||
    error.status < 500 && ["MAZIAO_AUTH", "MAZIAO_BALANCE", "MAZIAO_LIMIT", "MAZIAO_NOT_FOUND", "MAZIAO_REJECTED", "MAZIAO_PLAN_REQUIRED"].includes(error.code)
  );
}
type ProviderVoice = { id?: unknown; name?: unknown; userId?: unknown; user_id?: unknown; language?: unknown; gender?: unknown; modelId?: unknown; model_id?: unknown; previewUrl?: unknown; preview_url?: unknown; refFile?: unknown; ref_file?: unknown; refText?: unknown; ref_text?: unknown };
type ProviderModel = { id?: unknown; support_cloning?: unknown; supported_languages?: unknown };
type SpeechJob = { id?: unknown; status?: unknown; resultUrl?: unknown; resultUrls?: unknown; result_url?: unknown; result_urls?: unknown; totalTasks?: unknown; completedTasks?: unknown };
type Audio = { bytes: Uint8Array; mime: "audio/wav" | "audio/mpeg"; duration: number; sampleRate: number; channels: number };

const invalidResponse = () => new StudioError("MAZIAO_INVALID_RESPONSE", "Chưa đọc được kết quả giọng nói. Nếu vừa bấm tạo, hãy dùng Lấy lại lời đọc trước khi tạo mới.", 502);
const rawId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const scopedId = (model: MaziaoModel, id: string) => `maziao:${model}:${id}`;
const belowObservedMinimum = (model: MaziaoModel, segments: StudioSegment[]) => model === "vieten_speech" && segments.reduce((sum, segment) => sum + segment.text.length, 0) < 100;
const minimumTimingError = () => new StudioError("TIMING_NEEDS_EDIT", "Hệ thống giọng nói cần ít nhất 100 ký tự cho lần tạo lại với model tiếng Việt này. Hãy chỉnh kịch bản để khớp cảnh rồi tạo lại; app không tự thêm lời.", 422, "script");
export function parseMaziaoVoiceId(value: string) {
  const [provider, model, id, extra] = value.split(":");
  if (provider !== "maziao" || extra !== undefined || !MAZIAO_MODELS.some(item => item === model) || !rawId(id)) throw new StudioError("INVALID_VOICE", "Chọn một giọng trong danh sách của bạn.");
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

async function providerJson(key: string, path: string, init: RequestInit = {}, deadline = Date.now() + 30000): Promise<unknown> {
  if (Date.now() >= deadline) throw new StudioError("MAZIAO_TIMEOUT", "Hệ thống giọng nói đang xử lý lâu. Kiểm tra tác vụ hiện tại trước khi tạo lại để tránh tốn credit hai lần.", 504);
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}) }, redirect: "error", signal: AbortSignal.timeout(Math.min(30000, Math.max(1, deadline - Date.now()))) });
  } catch { throw new StudioError("MAZIAO_UNAVAILABLE", "Chưa nhận được phản hồi từ hệ thống giọng nói. Nếu vừa tạo lời đọc, kiểm tra tác vụ hiện tại trước khi tạo lại để tránh trừ credit lặp.", 502); }
  if ([401, 403].includes(response.status)) {
    await response.body?.cancel();
    const message = response.status === 401 ? "Dịch vụ giọng nói chưa chấp nhận khóa API. Quản trị viên cần kiểm tra kết nối dịch vụ." :
      path.startsWith("/voices") ? "Dịch vụ chưa cấp quyền truy cập giọng đã chọn. Quản trị viên cần đồng bộ lại giọng và kiểm tra quyền API của tài khoản chủ." :
      path === "/configs" ? "Dịch vụ chưa cho phép đọc cấu hình model. Quản trị viên cần kiểm tra quyền API của gói đang dùng." :
      path === "/tts/submit" ? "Dịch vụ chưa cấp quyền tạo lời đọc với giọng hoặc model đang chọn. Quản trị viên cần kiểm tra quyền sử dụng trên tài khoản chủ." :
      "Dịch vụ chưa cấp quyền xử lý tác vụ này. Quản trị viên cần kiểm tra quyền API của tài khoản chủ.";
    throw new StudioError("MAZIAO_AUTH", message, 422, "contact_admin");
  }
  if (response.status === 402) { await response.body?.cancel(); throw new StudioError("MAZIAO_BALANCE", "Tài khoản dịch vụ giọng nói chưa đủ credit hoặc chưa có quyền API. Quản trị viên cần kiểm tra gói và số dư.", 422, "contact_admin"); }
  if (response.status === 429) { await response.body?.cancel(); throw new StudioError("MAZIAO_LIMIT", "Hệ thống đang giới hạn số tác vụ cùng lúc. Hãy chờ tác vụ hiện tại xong rồi thử lại.", 429); }
  if (response.status === 404) { await response.body?.cancel(); throw new StudioError("MAZIAO_NOT_FOUND", "Giọng này không còn tồn tại. Hãy tải lại danh sách và chọn giọng khác.", 422); }
  if (!response.ok) { await response.body?.cancel(); throw new StudioError("MAZIAO_REJECTED", response.status >= 500 ? "Hệ thống giọng nói đang gián đoạn. Vui lòng thử lại sau." : "Hệ thống chưa chấp nhận dữ liệu. Kiểm tra giọng, model và mẫu thu 3–8 giây.", response.status >= 500 ? 502 : 422); }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await boundedBytes(response, MAX_JSON)));
  } catch { throw invalidResponse(); }
  if (!parsed || typeof parsed !== "object") throw invalidResponse();
  // Never reflect provider messages: they can include submitted text, file URLs or secrets.
  if (!Array.isArray(parsed)) {
    const result = parsed as Record<string, unknown>;
    if (Array.isArray(result.errors) && result.errors.length) {
      if (result.errors.some(item => item === "errors.limit.modelPaidOnly")) throw new StudioError("MAZIAO_PLAN_REQUIRED", "Model giọng nói này cần gói trả phí có API. Quản trị viên cần kiểm tra tài khoản.", 422, "contact_admin");
      if (result.errors.some(item => item === "errors.limit.concurrency")) throw new StudioError("MAZIAO_LIMIT", "Hệ thống đang có tác vụ chưa xong. Vui lòng chờ rồi thử lại.", 429);
      throw new StudioError("MAZIAO_REJECTED", "Hệ thống chưa chấp nhận yêu cầu. Kiểm tra hạn mức tài khoản, giọng và model đang dùng.", 422);
    }
  }
  return parsed;
}

async function api(key: string, path: string, init: RequestInit = {}, deadline = Date.now() + 30000): Promise<Record<string, unknown>> {
  const parsed = await providerJson(key, path, init, deadline);
  if (Array.isArray(parsed)) throw invalidResponse();
  return parsed as Record<string, unknown>;
}

async function assertModel(key: string, model: MaziaoModel, deadline?: number) {
  const result = await api(key, "/configs", {}, deadline), data = result.data as { ttsModels?: ProviderModel[] } | undefined;
  const config = Array.isArray(data?.ttsModels) ? data.ttsModels.find(item => item?.id === model) : undefined;
  const languages = config?.supported_languages;
  if (!config || config.support_cloning !== true || !Array.isArray(languages) || !languages.includes("vi")) throw new StudioError("MAZIAO_MODEL_UNAVAILABLE", "Model đang chọn chưa hỗ trợ nhân bản tiếng Việt trong tài khoản này. Quản trị viên cần kiểm tra cấu hình model.", 422, "contact_admin");
}

function safeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== MEDIA_HOST || url.port || url.username || url.password || url.hash) return;
    return url.href;
  } catch { return; }
}
function catalogOwnership(voice: ProviderVoice) {
  // Normalized system-catalog responses omit owner fields. Missing ownership
  // is allowed only together with verified membership in that public catalog;
  // an arbitrary voice-detail response never establishes a shared grant.
  return ["userId", "user_id"].every(field => !Object.hasOwn(voice, field) || (voice as Record<string, unknown>)[field] === null);
}
const voiceModel = (voice: ProviderVoice) => voice.modelId ?? voice.model_id;
const compatible = (voice: ProviderVoice) => {
  // Maziao's client matches clone-capable engines using language and reference
  // audio + transcript. A voice's original modelId is a preference, not a lock.
  const refFile = voice.refFile ?? voice.ref_file, refText = voice.refText ?? voice.ref_text;
  return (voice.language === "vi" || voice.language === "vi-VN") && typeof refFile === "string" && Boolean(refFile.trim()) && typeof refText === "string" && Boolean(refText.trim());
};
function presentVoice(voice: ProviderVoice, id: string, personal: boolean, fallback: string): StudioVoice {
  return { voiceId: id, name: cleanText(voice.name, 200) || fallback, category: personal ? "cloned" : "library", group: personal ? "personal" : "vietnamese", language: "vi", gender: voice.gender === "male" || voice.gender === "female" ? voice.gender : undefined, previewUrl: safeMediaUrl(voice.previewUrl ?? voice.preview_url) || safeMediaUrl(voice.refFile ?? voice.ref_file) };
}
async function getVoice(key: string, id: string, deadline?: number): Promise<ProviderVoice> {
  const result = await api(key, `/voices/${encodeURIComponent(id)}`, {}, deadline);
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) throw invalidResponse();
  const voice = result.data as ProviderVoice;
  if (voice.id !== id) throw invalidResponse();
  return voice;
}

async function systemVoices(key: string, search?: string): Promise<ProviderVoice[]> {
  const query = new URLSearchParams({ language: "vi", type: "system", limit: "100", offset: "0", sort_field: "total_used" });
  if (search) query.set("search", cleanText(search, 200));
  const result = await api(key, `/voices?${query}`), data = result.data as { items?: ProviderVoice[] } | undefined;
  if (!Array.isArray(data?.items)) throw invalidResponse();
  return data.items.filter(voice => Boolean(voice && typeof voice === "object" && !Array.isArray(voice)));
}

export async function adminAccountVoices(key: string): Promise<ProviderVoice[]> {
  const collected = new Map<string, ProviderVoice>();
  const add = (rows: unknown) => {
    if (!Array.isArray(rows)) return false;
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const voice = row as ProviderVoice;
      if (rawId(voice.id)) collected.set(voice.id, voice);
    }
    return true;
  };
  // The account endpoint may return a list, data.items, or paginated items.
  // Missing or malformed pages fail closed rather than silently declaring the
  // catalog complete and revoking existing voices.
  const shapes = (result: unknown) => {
    if (Array.isArray(result)) return { items: result, meta: {} as Record<string,unknown> };
    if (!result || typeof result !== "object") return null;
    const root = result as Record<string,unknown>;
    const nested = root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? root.data as Record<string,unknown> : null;
    const items = Array.isArray(root.data) ? root.data :
      Array.isArray(nested?.items) ? nested.items :
      Array.isArray(root.items) ? root.items : null;
    return items ? { items, meta: { ...root, ...(nested || {}) } } : null;
  };
  const fetchPages = async (path: string) => {
    let offset = 0; let total: number | undefined; let previous = "";
    for (let page = 0; page < 100; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const target = path + separator + "limit=100&offset=" + offset;
      const result = await providerJson(key, target);
      const parsed = shapes(result);
      if (!parsed || !add(parsed.items)) throw invalidResponse();
      const ids = parsed.items.map(item => (item && typeof item === "object" ? (item as ProviderVoice).id : null)).join(",");
      if (ids === previous && parsed.items.length > 0) throw new StudioError("VOICE_SYNC_PAGINATION", "API lặp lại trang giọng. Chưa thể xác nhận đã lấy đủ dữ liệu.", 502);
      previous = ids;
      const count = parsed.meta.total ?? parsed.meta.totalCount ?? parsed.meta.total_count;
      if (count !== undefined) {
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 10000) throw invalidResponse();
        total = count;
      }
      offset += parsed.items.length;
      const more = parsed.meta.hasMore ?? parsed.meta.has_more;
      if ((total !== undefined && (offset > total || (more === false && offset < total))) ||
          (parsed.items.length === 0 && (more === true || (total !== undefined && offset < total))) ||
          (more === true && total !== undefined && offset >= total))
        throw new StudioError("VOICE_SYNC_PAGINATION", "API chưa trả đủ danh sách giọng cá nhân. Dữ liệu trước đó được giữ nguyên; hãy thử đồng bộ lại.", 502);
      if (more === false || (total !== undefined && offset >= total) || (more === undefined && total === undefined && parsed.items.length < 100)) return;
      if (parsed.items.length === 0) return;
    }
    throw new StudioError("VOICE_SYNC_PAGINATION", "API có quá nhiều trang giọng, đồng bộ chưa hoàn tất.", 502);
  };
  // This documented endpoint establishes account ownership. Generic /voices
  // types may be ignored by the provider and must never establish that proof.
  // An error is not an empty account and must not become a successful sync.
  await fetchPages("/voices/my-voices");
  return [...collected.values()];
}

export async function fetchVoiceCatalogSnapshot(key: string) {
  const model = maziaoModel();
  const [publicRows, ownedRows] = await Promise.all([systemVoices(key), adminAccountVoices(key)]);
  const system = publicRows.filter(v => rawId(v.id) && catalogOwnership(v) && compatible(v))
    .map(v => ({ voiceId: scopedProviderVoiceId(v, model), name: cleanText(v.name, 200) || "Giọng thư viện",
      kind: "system" as const, previewUrl: safeMediaUrl(v.previewUrl ?? v.preview_url) || safeMediaUrl(v.refFile ?? v.ref_file) || null,
      gender: v.gender === "male" || v.gender === "female" ? v.gender : null }));
  const personal = ownedRows.map(v => normalizeAdminVoice(v, model)).filter((v): v is NonNullable<typeof v> => Boolean(v))
    .map(v => ({ ...v, kind: "admin_clone" as const }));
  const byId = new Map<string, typeof system[number] | typeof personal[number]>();
  for (const voice of system) byId.set(voice.voiceId, voice);
  for (const voice of personal) byId.set(voice.voiceId, voice);
  return [...byId.values()];
}

export function normalizeAdminVoice(voice: ProviderVoice, defaultModel: MaziaoModel) {
  const model = voiceModel(voice);
  if (!rawId(voice.id) || !compatible(voice) || (model !== undefined && !MAZIAO_MODELS.some(item => item === model))) return null;
  const voiceId = scopedProviderVoiceId(voice, defaultModel);
  return { voiceId, name: cleanText(voice.name,200) || "Giọng của tôi",
    // Account owners explicitly choose which clone samples to share. Maziao's
    // own player uses the reference recording when no separate preview exists.
    previewUrl: safeMediaUrl(voice.previewUrl ?? voice.preview_url) || safeMediaUrl(voice.refFile ?? voice.ref_file) || null,
    gender: voice.gender === "male" || voice.gender === "female" ? voice.gender : null };
}

function scopedProviderVoiceId(voice: ProviderVoice, fallback: MaziaoModel) {
  const candidate = voiceModel(voice);
  const model = typeof candidate === "string" && MAZIAO_MODELS.some(item => item === candidate) ? candidate as MaziaoModel : fallback;
  return scopedId(model, voice.id as string);
}

export async function listMaziaoVoices(key: string, userId: string): Promise<StudioVoice[]> {
  const model = maziaoModel();
  await assertModel(key, model);
  const member = await getMember(userId);
  const curated = member.role === "admin" ? [] : await sharedVoiceCatalog(userId);
  const approvedSystem = new Set(curated.filter(row => row.enabled && row.kind === "system").map(row => row.voice_id));
  const approvedAdminClones = curated.filter(row => row.enabled && row.kind === "admin_clone");
  const grants = (await authorizedVoiceRows(userId)).filter(row => row.voice_id.startsWith("maziao:"));
  const owned = grants.filter(row => row.source === "personal");
  const ownedIds = new Set(owned.map(row => row.voice_id));
  const items = await systemVoices(key);
  if (member.role === "admin") {
    const providerClones = await adminAccountVoices(key);
    for (const voice of providerClones) {
      const id = scopedProviderVoiceId(voice, model);
      if (!ownedIds.has(id)) {
        await saveAuthorizedVoice(userId, id, cleanText(voice.name, 200) || "Giọng của tôi", "personal");
        owned.push({ voice_id: id, name: cleanText(voice.name, 200) || "Giọng của tôi", source: "personal", authorization_tag: "" });
        ownedIds.add(id);
      }
    }
  }
  const seen = new Set<string>();
  const sharedSystem = items.filter(voice => {
    if (!rawId(voice.id) || !catalogOwnership(voice) || !compatible(voice)) return false;
    const id = scopedId(model, voice.id);
    if ((member.role !== "admin" && !approvedSystem.has(id)) || seen.has(id) || ownedIds.has(id)) return false;
    seen.add(id); return true;
  }).slice(0, 20).map(voice => presentVoice(voice, scopedId(model, voice.id as string), false, "Giọng tiếng Việt"));

  // Admin may explicitly publish one of their private clones to every member.
  // The catalog row is the authorization boundary; we still resolve the live
  // provider voice on every listing so deleted/incompatible clones disappear.
  const sharedAdminClones: StudioVoice[] = [];
  if (member.role !== "admin") {
    for (const row of approvedAdminClones.slice(0, 25)) {
      if (ownedIds.has(row.voice_id) || seen.has(row.voice_id)) continue;
      const parsed = parseMaziaoVoiceId(row.voice_id);
      try {
        const voice = await getVoice(key, parsed.id);
        if (!compatible(voice) || (voiceModel(voice) && voiceModel(voice) !== parsed.model)) continue;
        seen.add(row.voice_id);
        sharedAdminClones.push(presentVoice(voice, row.voice_id, false, row.name || "Giọng dùng chung"));
      } catch (error) {
        if (!(error instanceof StudioError) || error.code !== "MAZIAO_NOT_FOUND") throw error;
      }
    }
  }

  // Resolve only the current member's signed personal grants. Other members'
  // clones never become visible unless the administrator explicitly publishes
  // their own clone through studio_voice_catalog.
  const personal: StudioVoice[] = [];
  for (const row of owned.slice(0, 25)) {
    const parsed = parseMaziaoVoiceId(row.voice_id);
    try {
      const voice = await getVoice(key, parsed.id);
      personal.push(presentVoice(voice, row.voice_id, true, row.name));
    } catch (error) {
      if (!(error instanceof StudioError) || error.code !== "MAZIAO_NOT_FOUND") throw error;
    }
  }
  const shared = [...sharedAdminClones, ...sharedSystem];
  await saveSharedVoiceList(userId, shared);
  return [...personal, ...shared];
}

export async function cloneMaziaoVoice(key: string, userId: string, name: string, files: File[], gender: "male" | "female", requestId: string) {
  if (files.length !== 1 || files[0].size > 1024 * 1024) throw new StudioError("MAZIAO_SAMPLE_REQUIRED", "Hệ thống cần một bản thu WAV 3–8 giây, tối đa 1 MB.", 422);
  const sample = files[0], info = inspectWav(new Uint8Array(await sample.arrayBuffer()));
  if (info.duration < 2.8 || info.duration > 8.2 || info.channels !== 1 || info.encoding !== 1 || info.bits !== 16) throw new StudioError("MAZIAO_SAMPLE_DURATION", "Mẫu giọng cần 3–8 giây. Hãy chọn tệp khác để app chuẩn hóa lại.", 422);
  if (gender !== "male" && gender !== "female") throw new StudioError("INVALID_GENDER", "Chọn giọng nam hoặc nữ để nhân bản.");
  const model = maziaoModel();
  await assertModel(key, model);
  const form = new FormData();
  form.set("name", name); form.set("gender", gender); form.set("model", model); form.set("language", "vi");
  form.set("previewText", ""); form.set("removeNoise", "0"); form.set("refFile", sample, "voice-sample.wav");
  const requestHash = await payloadHash(JSON.stringify({ name, gender, model, sampleHash: await payloadHash(new Uint8Array(await sample.arrayBuffer())) }));
  const reservation = await reserveCredits(userId, requestId, "clone", CLONE_CREDITS, { provider: "maziao", requestHash });
  if (!reservation.created) return reusedCreditRequest();
  try {
    const result = await api(key, "/voices", { method: "POST", body: form }, Date.now() + 90000);
    const voice = result.data as ProviderVoice | undefined;
    if (!voice || !rawId(voice.id)) throw invalidResponse();
    await markCreditProviderTask(userId, requestId, voice.id);
    const id = scopedId(model, voice.id);
    const previewUrl = safeMediaUrl(voice.previewUrl ?? voice.preview_url) || safeMediaUrl(voice.refFile ?? voice.ref_file);
    await saveAuthorizedVoice(userId, id, name, "personal", previewUrl);
    await settleCredits(userId, requestId);
    return { voiceId: id, name, previewUrl, requiresVerification: false };
  } catch (error) {
    if (definitivelyNotDelivered(error)) await refundCredits(userId, requestId).catch(() => {});
    throw error;
  }
}

/** Fill old personal grants only when their own sample is missing. A failed
 * provider lookup never hides an already usable voice list or charges a clone. */
export async function backfillMaziaoPersonalPreviews(userId: string) {
  if ((await getMember(userId)).role !== "member") return;
  const rows = await authorizedVoiceRows(userId);
  const due = rows.filter(row => row.source === "personal" && row.voice_id.startsWith("maziao:")
    && !safeMediaUrl(row.preview_url)
    && (!row.preview_checked_at || !Number.isFinite(Date.parse(row.preview_checked_at)) || Date.now() - Date.parse(row.preview_checked_at) >= 24 * 60 * 60 * 1000));
  if (!due.length) return;
  const { key } = await providerKey(userId, "maziao");
  const deadline = Date.now() + 10000;
  for (const row of due.slice(0, 3)) {
    let parsed: ReturnType<typeof parseMaziaoVoiceId>;
    try { parsed = parseMaziaoVoiceId(row.voice_id); } catch { continue; }
    try {
      const voice = await getVoice(key, parsed.id, deadline);
      if (voiceModel(voice) && voiceModel(voice) !== parsed.model) continue;
      const previewUrl = safeMediaUrl(voice.previewUrl ?? voice.preview_url) || safeMediaUrl(voice.refFile ?? voice.ref_file);
      await savePersonalVoicePreview(userId, row.voice_id, row.authorization_tag, previewUrl);
    } catch { /* the cached voice list remains available if Maziao is slow */ }
  }
}

export async function authorizeMaziaoVoice(userId: string, voiceId: string) {
  const parsed = parseMaziaoVoiceId(voiceId);
  const [member, grants, catalog] = await Promise.all([
    getMember(userId), authorizedVoiceRows(userId), sharedVoiceCatalog(userId)
  ]);
  const personal = grants.some(row => row.voice_id === voiceId && row.source === "personal");
  const shared = catalog.find(row => row.voice_id === voiceId && row.enabled);
  let adminCached = false;
  if (member.role === "admin" && !personal && !grants.some(row => row.voice_id === voiceId && row.source === "shared")) {
    const { createStudioSupabaseServer } = await import("./studio-supabase");
    const client = await createStudioSupabaseServer();
    const { data, error } = await client.from("studio_voice_cache").select("status").eq("voice_id",voiceId).maybeSingle();
    if (error) throw new StudioError("VOICE_CACHE_UNAVAILABLE", "Chưa kiểm tra được trạng thái giọng.",503);
    adminCached = data?.status === "active";
  }
  if (!personal && !shared && !adminCached && !(member.role === "admin" && grants.some(row => row.voice_id === voiceId && row.source === "shared")) )
    throw new StudioError("VOICE_NOT_AUTHORIZED", "Giọng này chưa được cấp quyền. Hãy tải lại danh sách.", 403);

  // Re-check the live catalog before every paid synthesis. Never let an old
  // shared grant bypass a revoked authorization.
  const { key } = await providerKey(userId, "maziao");
  // The account-owned list is the authority for a shared administrator clone.
  // Some provider scopes allow this documented listing but deny the individual
  // detail endpoint. Re-read ownership for every request; cached approval alone
  // never grants access to a deleted or foreign clone.
  const voice = shared?.kind === "admin_clone"
    ? (await adminAccountVoices(key)).find(item => item.id === parsed.id)
    : await getVoice(key, parsed.id);
  if (!voice) throw new StudioError("VOICE_NOT_AUTHORIZED", "Giọng này không còn trong tài khoản dịch vụ đã kết nối. Quản trị viên cần đồng bộ lại danh sách.", 403);
  if (!compatible(voice)) throw new StudioError("VOICE_NOT_AUTHORIZED", "Giọng hiện không đủ điều kiện sử dụng.", 403);
  if (personal || (adminCached && !shared)) {
    if (voiceModel(voice) && voiceModel(voice) !== parsed.model) throw new StudioError("MAZIAO_VOICE_MODEL", "Giọng thuộc model khác.", 422);
  } else if (shared?.kind === "admin_clone") {
    if (voiceModel(voice) && voiceModel(voice) !== parsed.model) throw new StudioError("MAZIAO_VOICE_MODEL", "Giọng thuộc model khác.", 422);
  } else {
    if (!catalogOwnership(voice)) throw new StudioError("VOICE_NOT_AUTHORIZED", "Giọng đã bị thu hồi quyền chia sẻ.", 403);
    const current = await systemVoices(key, cleanText(voice.name, 200) || undefined);
    if (!current.some(item => item.id === parsed.id && catalogOwnership(item) && compatible(item)))
      throw new StudioError("VOICE_NOT_AUTHORIZED", "Giọng đã bị rút khỏi thư viện.", 403);
  }
  return voiceId;
}

async function fetchAudio(value: unknown, deadline: number): Promise<Audio> {
  const url = safeMediaUrl(value);
  if (!url) throw new StudioError("MAZIAO_AUDIO_URL", "Đường dẫn âm thanh chưa hợp lệ.", 502);
  let response: Response;
  try {
    // No Authorization header or cookies leave the provider API origin.
    response = await fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(30000, deadline - Date.now()))) });
  } catch { throw new StudioError("MAZIAO_AUDIO_DOWNLOAD", "Chưa tải được lời đọc. Kiểm tra kết nối và tác vụ trước khi tạo lại.", 502); }
  if (!response.ok) { await response.body?.cancel(); throw new StudioError("MAZIAO_AUDIO_DOWNLOAD", "Hệ thống chưa cho tải tệp lời đọc. Kiểm tra tác vụ trước khi tạo lại.", 502); }
  const bytes = await boundedBytes(response, MAX_AUDIO);
  const isWav = new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF";
  let info: { duration: number; sampleRate: number; channels: number };
  try {
    info = isWav ? inspectWav(bytes) : await inspectMp3(bytes);
    if (info.duration > 180) throw invalidResponse();
  } catch {
    // This is a paid job's output, not a member's recording sample. Keep the
    // recovery guidance distinct so a parser failure does not invite a new job.
    throw new StudioError("INVALID_AUDIO", "Hệ thống đã nhận tác vụ nhưng tệp lời đọc chưa hợp lệ. Liên hệ quản trị viên kiểm tra tác vụ trước khi tạo lại.", 422, "contact_admin");
  }
  return { bytes, mime: isWav ? "audio/wav" : "audio/mpeg", duration: info.duration, sampleRate: info.sampleRate, channels: info.channels };
}

function resultUrls(job: SpeechJob, count: number): string[] | undefined {
  // Status can report completion before the output is attached. The detail
  // endpoint may also use database-style snake_case keys; Maziao's own client
  // normalizes those keys after fetching /tts/:id.
  let result: unknown = job.resultUrls ?? job.result_urls;
  if (result === null || result === "" || (Array.isArray(result) && result.length === 0)) result = undefined;
  if (result === undefined) result = job.resultUrl ?? job.result_url;
  if (result == null || result === "") return;
  if (typeof result === "string") {
    if (result.trim().startsWith("[")) { try { result = JSON.parse(result); } catch { throw invalidResponse(); } }
    else if (count === 1) result = [result];
  }
  if (!Array.isArray(result) || result.length !== count || result.some(item => !safeMediaUrl(item))) throw invalidResponse();
  return result as string[];
}

async function taskDetail(key: string, taskId: string, deadline: number): Promise<SpeechJob> {
  const response = await api(key, `/tts/${encodeURIComponent(taskId)}`, {}, deadline);
  const job = response.data;
  if (!job || typeof job !== "object" || Array.isArray(job) || (job as SpeechJob).id !== taskId) throw invalidResponse();
  return job as SpeechJob;
}

async function completedAudio(key: string, taskId: string, count: number, deadline: number): Promise<Audio[]> {
  let missingRows = 0;
  while (Date.now() < deadline) {
    const polled = await api(key, "/tts/status", { method: "POST", body: JSON.stringify({ ids: [taskId] }) }, deadline);
    const job = Array.isArray(polled.data) ? (polled.data as SpeechJob[]).find(item => item?.id === taskId) : undefined;
    if (job?.status === "failed") throw new StudioError("MAZIAO_TASK_FAILED", "Hệ thống không tạo được lời đọc. Kiểm tra giọng và trạng thái tác vụ trước khi thử lại.", 422);
    if (job && !["pending", "processing", "saving", "exportingSrt", "completed"].includes(String(job.status))) throw invalidResponse();
    missingRows = job ? 0 : missingRows + 1;
    if (job?.status === "completed" || missingRows >= 2) {
      let urls = job ? resultUrls(job, count) : undefined;
      // A missing status row is transient shortly after submit. After another
      // poll, or when /status marks completion without an URL, read the detail.
      if (!urls) {
        const detail = await taskDetail(key, taskId, deadline);
        if (detail.status === "failed") throw new StudioError("MAZIAO_TASK_FAILED", "Hệ thống không tạo được lời đọc. Kiểm tra giọng và trạng thái tác vụ trước khi thử lại.", 422);
        if (!["pending", "processing", "saving", "exportingSrt", "completed"].includes(String(detail.status))) throw invalidResponse();
        if (detail.status === "completed") urls = resultUrls(detail, count);
      }
      if (urls) {
        const audio: Audio[] = [];
        for (const url of urls) audio.push(await fetchAudio(url, deadline));
        return audio;
      }
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(6000, Math.max(0, deadline - Date.now()))));
  }
  throw new StudioError("MAZIAO_TIMEOUT", "Hệ thống chưa xử lý xong trong thời gian chờ. Kiểm tra tác vụ hiện tại trước khi tạo lại để tránh trừ credit lặp.", 504);
}
async function synthesizeBatch(key: string, userId: string, requestId: string, voiceId: string, segments: StudioSegment[], deadline: number, costs: (number | null)[], settings = { speed: 1, pitch: 1, volume: 1 }, mode: "multiParts" | "paragraph" = "multiParts", beforeSettle?: (audio: Audio[]) => Promise<Record<string, unknown>>): Promise<Audio[]> {
  const parsed = parseMaziaoVoiceId(voiceId);
  if (mode === "paragraph" && segments.length !== 1) throw invalidResponse();
  const started = Date.now();
  // A standalone narration uses Maziao's paragraph mode and one voice for the
  // whole text. Video segments continue to use multiParts for separate files.
  const payload = mode === "paragraph"
    ? { mode, parts: [{ text: segments[0].text }], voiceId: parsed.id, config: { speed: settings.speed, volume: settings.volume, pitch: settings.pitch, export_srt: false }, modelId: parsed.model }
    : { mode, parts: segments.map(segment => ({ text: segment.text, voiceId: parsed.id, speed: settings.speed, pitch: settings.pitch })), config: { volume: settings.volume, pitch: settings.pitch, export_srt: false }, modelId: parsed.model };
  const characters = segments.reduce((sum, segment) => sum + segment.text.length, 0);
  const reservation = await reserveCredits(userId, requestId, "tts", creditsForSpeech(characters), {
    provider: "maziao", model: parsed.model, requestHash: await payloadHash(JSON.stringify(payload))
  });
  if (!reservation.created && (reservation.status !== "reserved" || !rawId(reservation.providerTaskId))) return reusedCreditRequest();
  let submitted = !reservation.created;
  try {
    let taskId = reservation.providerTaskId as string | undefined;
    let providerCredits: number | null = null;
    if (reservation.created) {
      const result = await api(key, "/tts/submit", { method: "POST", body: JSON.stringify(payload) }, deadline);
      const data = result.data as { taskId?: unknown; totalCost?: unknown } | undefined;
      if (!data || !rawId(data.taskId)) throw invalidResponse();
      taskId = data.taskId;
      submitted = true;
      await markCreditProviderTask(userId, requestId, taskId);
      providerCredits = typeof data.totalCost === "number" && Number.isFinite(data.totalCost) && data.totalCost >= 0 && data.totalCost <= 1000000000 ? data.totalCost : null;
      console.info(JSON.stringify({ event: "studio_voice_usage", provider: "maziao", model: parsed.model, taskId, characters, credits: providerCredits, segments: segments.length, elapsedMs: Date.now() - started }));
    }
    if (!taskId) throw invalidResponse();
    // Provider credits are recorded for cost accounting, distinct from the
    // app's published credits (one per 100 text characters).
    costs.push(providerCredits);
    const audio = await completedAudio(key, taskId, segments.length, deadline);
    const output = beforeSettle ? await beforeSettle(audio) : {};
    await settleCredits(userId, requestId, undefined, { provider: "maziao", providerCredits, providerTaskId: taskId, characters, model: parsed.model, ...output });
    return audio;
  } catch (error) {
    if (error instanceof StudioError && (error.code === "MAZIAO_TASK_FAILED" || !submitted && definitivelyNotDelivered(error)))
      await refundCredits(userId, requestId).catch(() => {});
    throw error;
  }
}

async function billedShorten(key: string, userId: string, requestId: string, segment: StudioSegment, spokenDuration: number, timeoutMs: number) {
  const reservation = await reserveCredits(userId, requestId, "script", SHORTEN_CREDITS, {
    provider: "deepseek", source: "speech_timing", requestHash: await payloadHash(JSON.stringify({ segment, spokenDuration }))
  });
  if (!reservation.created) return reusedCreditRequest();
  try {
    const text = await shortenSegment(key, segment, spokenDuration, async () => {}, timeoutMs);
    await settleCredits(userId, requestId);
    return text;
  } catch (error) {
    await refundCredits(userId, requestId).catch(() => {});
    throw error;
  }
}

export async function generateMaziaoSpeech(input: { key: string; userId: string; requestId: string; voiceId: string; segments: StudioSegment[]; duration: number }) {
  const parsed = parseMaziaoVoiceId(input.voiceId), deadline = Date.now() + 240000;
  // Live vieten_speech requests reject short totals. Keep this observed limit
  // scoped to that engine; never pad the member's script or assume other models.
  if (belowObservedMinimum(parsed.model, input.segments)) throw new StudioError("MAZIAO_TEXT_TOO_SHORT", "Model tiếng Việt này cần ít nhất 100 ký tự cho mỗi lần tạo lời đọc. Hãy chỉnh kịch bản; app không tự thêm lời.", 422, "script");
  await assertModel(input.key, parsed.model, deadline);
  const segments = input.segments.map(segment => ({ ...segment }));
  const costs: (number | null)[] = [];
  const audio = await synthesizeBatch(input.key, input.userId, await deriveCreditRequestId(input.requestId, "tts-0"), input.voiceId, segments, deadline, costs);
  // Recreate only overlong segments. Never truncate paid speech to force a fit.
  for (let attempt = 0; attempt < 2; attempt++) {
    const indexes = segments.flatMap((segment, index) => audio[index].duration > segment.end - segment.start ? [index] : []);
    if (!indexes.length) break;
    // Shortening cannot rescue a replacement batch already below the minimum.
    // Stop before spending on either rewriting or another Maziao submission.
    if (belowObservedMinimum(parsed.model, indexes.map(index => segments[index]))) throw minimumTimingError();
    if (Date.now() + 30000 >= deadline) throw new StudioError("TIMING_NEEDS_EDIT", "Lời đọc dài hơn cảnh. Rút gọn kịch bản rồi tạo lại; app không cắt mất lời.", 422, "script");
    const { key } = await providerKey(input.userId, "deepseek");
    for (const index of indexes) {
      if (Date.now() + 30000 >= deadline) throw new StudioError("TIMING_NEEDS_EDIT", "Cần rút gọn thêm lời thoại để khớp cảnh. Chỉnh kịch bản rồi tạo lại.", 422, "script");
      segments[index].text = await billedShorten(key, input.userId, await deriveCreditRequestId(input.requestId, `shorten-${attempt}-${index}`), segments[index], audio[index].duration, Math.min(30000, deadline - Date.now() - 30000));
    }
    const replacementSegments = indexes.map(index => segments[index]);
    if (belowObservedMinimum(parsed.model, replacementSegments)) throw minimumTimingError();
    const replacements = await synthesizeBatch(input.key, input.userId, await deriveCreditRequestId(input.requestId, `tts-${attempt + 1}`), input.voiceId, replacementSegments, deadline, costs);
    indexes.forEach((index, offset) => { audio[index] = replacements[offset]; });
  }
  const overlong = segments.findIndex((segment, index) => audio[index].duration > segment.end - segment.start);
  if (overlong !== -1) throw new StudioError("TIMING_NEEDS_EDIT", `Lời đoạn ${overlong + 1} vẫn dài hơn cảnh. Rút gọn rồi tạo lại; app không cắt mất lời.`, 422, "script");
  const stored: string[] = [];
  try {
    const results = [];
    for (const [index, segment] of segments.entries()) {
      const media = await storeNarration(input.userId, audio[index].bytes, index, audio[index].mime); stored.push(media.audioPath);
      results.push({ ...segment, ...media, audioMime: audio[index].mime, duration: audio[index].duration, revised: segment.text !== input.segments[index].text });
    }
    return { segments: results, duration: input.duration, voiceId: input.voiceId, sampleRate: audio[0].sampleRate, channels: audio[0].channels, provider: "maziao", usage: { credits: costs.every(cost => cost !== null) ? costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0) : null, jobs: costs.length } };
  } catch (error) { await removeOwnedMedia(input.userId, stored).catch(() => {}); throw error; }
}

/**
 * Standalone voice-over is not tied to a video timeline. It preserves the
 * complete script and never shortens/retries a paid result to fit a scene.
 */
export async function generateMaziaoVoiceOver(input: { key: string; userId: string; requestId: string; voiceId: string; text: string; speed: number; volume: number; pitch: number }) {
  const parsed = parseMaziaoVoiceId(input.voiceId);
  if (parsed.model === "vieten_speech" && input.text.length < 100) throw new StudioError("MAZIAO_TEXT_TOO_SHORT", "Model này yêu cầu tối thiểu 100 ký tự. Hãy nhập thêm lời thoại trước khi tạo.", 422, "script");
  const deadline = Date.now() + 240000;
  await assertModel(input.key, parsed.model, deadline);
  const segments: StudioSegment[] = [{ start: 0, end: 180, text: input.text }];
  const costs: (number | null)[] = [];
  let media: Awaited<ReturnType<typeof storeNarration>> | undefined;
  const [audio] = await synthesizeBatch(input.key, input.userId, input.requestId, input.voiceId, segments, deadline, costs, { speed: input.speed, pitch: input.pitch, volume: input.volume }, "paragraph", async ([spoken]) => {
    media = await storeNarration(input.userId, spoken.bytes, 0, spoken.mime);
    return { audioPath: media.audioPath, audioMime: spoken.mime, duration: spoken.duration, voiceId: input.voiceId };
  });
  if (!media) throw invalidResponse();
  return { ...media, audioMime: audio.mime, duration: audio.duration, voiceId: input.voiceId, provider: "maziao", usage: { credits: costs[0] ?? null, jobs: costs.length } };
}

type PendingVoiceOperation = { request_id: string; created_at: string; provider_task_id: string | null; metadata: unknown };
const creditId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
// Video segment jobs use deterministic UUIDv8 children; standalone voice-over
// uses the browser's UUIDv4. Do not offer a multi-part video job as one MP3.
const standaloneCreditId = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const voiceOperation = (row: PendingVoiceOperation) => {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
  return standaloneCreditId(row.request_id) && metadata.provider === "maziao" && MAZIAO_MODELS.some(model => model === metadata.model) && rawId(row.provider_task_id);
};

/** Existing paid jobs are visible only to their owner. Listing does not poll or submit. */
export async function listPendingMaziaoVoiceOvers(userId: string) {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_credit_operations")
    .select("request_id,created_at,provider_task_id,metadata")
    .eq("user_id", userId).eq("kind", "tts").eq("status", "reserved")
    .not("provider_task_id", "is", null).order("created_at", { ascending: false }).limit(10);
  if (error) throw new StudioError("CREDIT_LEDGER_UNAVAILABLE", "Chưa xem được tác vụ giọng đang xử lý.", 503);
  return ((data || []) as PendingVoiceOperation[]).filter(voiceOperation).map(row => ({ requestId: row.request_id, createdAt: row.created_at }));
}

/** Reuse a previously submitted Maziao job, never spending on another submit. */
export async function recoverMaziaoVoiceOver(input: { key: string; userId: string; requestId: unknown }) {
  if (!creditId(input.requestId)) throw new StudioError("INVALID_CREDIT_REQUEST", "Mã tác vụ chưa hợp lệ.", 400);
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_credit_operations")
    .select("request_id,created_at,provider_task_id,metadata,status")
    .eq("user_id", input.userId).eq("request_id", input.requestId).eq("kind", "tts").maybeSingle();
  if (error) throw new StudioError("CREDIT_LEDGER_UNAVAILABLE", "Chưa xem được tác vụ giọng đang xử lý.", 503);
  if (!data || data.status !== "reserved" || !voiceOperation(data as PendingVoiceOperation))
    throw new StudioError("CREDIT_REQUEST_REUSED", "Tác vụ này không còn chờ khôi phục. Hãy tải lại trang để xem kết quả mới nhất.", 409);
  const taskId = data.provider_task_id as string;
  let audio: Audio;
  try {
    [audio] = await completedAudio(input.key, taskId, 1, Date.now() + 240000);
  } catch (error) {
    if (error instanceof StudioError && error.code === "MAZIAO_TASK_FAILED")
      await refundCredits(input.userId, input.requestId).catch(() => {});
    throw error;
  }
  const media = await storeNarration(input.userId, audio.bytes, 0, audio.mime);
  await settleCredits(input.userId, input.requestId, undefined, {
    provider: "maziao", providerCredits: null, providerTaskId: taskId,
    model: (data.metadata as Record<string, unknown>).model,
    audioPath: media.audioPath, audioMime: audio.mime, duration: audio.duration,
  });
  return { ...media, audioMime: audio.mime, duration: audio.duration, provider: "maziao", usage: { credits: null, jobs: 1 } };
}
