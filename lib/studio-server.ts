import "server-only";
import { StudioError, bytesToBase64, base64ToBytes, sanitizeProfile, type StudioProfile } from "./studio-contract";
import { createStudioSupabaseServer, supabaseConfigured } from "./studio-supabase";

// Model names are returned to members and sent in provider bodies. Never echo an
// arbitrary environment value: an administrator may accidentally paste a key here.
// The app's DeepSeek model must support images as well as JSON/text generation.
const deepseekVisionModels = ["deepseek-flash"] as const;
const vietnameseSpeechModels = ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_v3", "eleven_v4"] as const;
export const MAZIAO_MODELS = ["vieten_speech", "lingual_speech_v2"] as const;
export type MaziaoModel = typeof MAZIAO_MODELS[number];
export function maziaoModel(): MaziaoModel { return MAZIAO_MODELS.find(model => model === process.env.MAZIAO_MODEL) ?? "vieten_speech"; }
export function voiceProvider(): "maziao" | "eleven" {
  if (process.env.STUDIO_VOICE_PROVIDER === "maziao" || process.env.STUDIO_VOICE_PROVIDER === "eleven") return process.env.STUDIO_VOICE_PROVIDER;
  return process.env.MAZIAO_API_KEY ? "maziao" : "eleven";
}
function approvedModel(value: string | undefined, allowed: readonly string[], fallback: string): string {
  return allowed.find((model) => model === value) ?? fallback;
}
export const modelNames = () => ({
  deepseekModel: approvedModel(process.env.DEEPSEEK_MODEL, deepseekVisionModels, "deepseek-flash"),
  voiceModel: approvedModel(process.env.ELEVENLABS_MODEL, vietnameseSpeechModels, "eleven_flash_v2_5"),
});
export function json(data: unknown, status = 200): Response { return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
export function apiError(error: unknown): Response {
  if (error instanceof StudioError) return json({ error: error.message, code: error.code, action: error.action, ...(error.code === "AUTH_NOT_CONFIGURED" ? { authReady: false } : {}) }, error.status);
  return json({ error: "Chưa hoàn tất xử lý. Vui lòng thử lại.", code: "INTERNAL_ERROR" }, 500);
}
export type StudioMember = { user_id: string; email: string; display_name: string; role: "admin" | "member"; enabled: boolean; ai_units_limit: number; ai_units_used: number; voice_clone_limit: number; voice_clone_used: number };
function storageError(): never { throw new StudioError("STORAGE_UNAVAILABLE", "Chưa đọc được dữ liệu thành viên. Quản trị viên cần chạy migration Supabase và kiểm tra kết nối.", 503); }
export async function getMember(userId: string): Promise<StudioMember> {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_members").select("user_id,email,display_name,role,enabled,ai_units_limit,ai_units_used,voice_clone_limit,voice_clone_used").eq("user_id", userId).maybeSingle();
  if (error) return storageError();
  if (!data) throw new StudioError("MEMBERSHIP_REQUIRED", "Tài khoản chưa được cấp quyền thành viên. Hãy liên hệ quản trị viên.", 403, "contact_admin");
  return data as StudioMember;
}
export async function requestUser(request: Request, mutation = false): Promise<string> {
  if (mutation && (!request.headers.get("origin") || request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site")) throw new StudioError("INVALID_ORIGIN", "Yêu cầu phải được gửi từ cửa sổ app đang mở.", 403);
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new StudioError("SIGN_IN_REQUIRED", "Đăng nhập tài khoản thành viên để sử dụng app.", 401, "/dang-nhap");
  const member = await getMember(data.user.id);
  if (!member.enabled) throw new StudioError("MEMBER_DISABLED", "Tài khoản thành viên đang bị khóa.", 403, "contact_admin");
  return data.user.id;
}
export async function requireAdmin(userId: string) {
  const member = await getMember(userId);
  if (member.role !== "admin" || !member.enabled) throw new StudioError("ADMIN_REQUIRED", "Chỉ quản trị viên được quản lý thành viên và hạn mức.", 403);
  return member;
}
export async function readSettings(userId: string) {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_settings").select("profile_json").eq("user_id", userId).maybeSingle();
  if (error) return storageError();
  let profile: StudioProfile = {};
  try { profile = sanitizeProfile(typeof data?.profile_json === "string" ? JSON.parse(data.profile_json) : data?.profile_json); } catch { /* old profile */ }
  return { profile };
}
export async function getConfig(userId: string) {
  const [{ profile }, member] = await Promise.all([readSettings(userId), getMember(userId)]);
  const provider = voiceProvider();
  return { userId, authReady: supabaseConfigured(), isAdmin: member.role === "admin", memberName: profile.name || member.display_name || member.email, deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY), elevenConfigured: Boolean(process.env.ELEVENLABS_API_KEY), maziaoConfigured: Boolean(process.env.MAZIAO_API_KEY), voiceProvider: provider, voiceConfigured: Boolean(provider === "maziao" ? process.env.MAZIAO_API_KEY : process.env.ELEVENLABS_API_KEY), ...modelNames(), maziaoModel: maziaoModel(), profile, quota: { limit: member.ai_units_limit, used: member.ai_units_used, reserved: 0, remaining: Math.max(0, member.ai_units_limit - member.ai_units_used) }, voiceCloning: { used: member.voice_clone_used, limit: member.voice_clone_limit, remaining: member.role === "admin" ? null : Math.max(0, member.voice_clone_limit - member.voice_clone_used), unlimited: member.role === "admin" } };
}
export async function providerKey(_userId: string, provider: "deepseek" | "eleven" | "maziao"): Promise<{ key: string; personal: boolean }> {
  const key = provider === "deepseek" ? process.env.DEEPSEEK_API_KEY : provider === "maziao" ? process.env.MAZIAO_API_KEY : process.env.ELEVENLABS_API_KEY;
  if (!key) throw new StudioError("API_KEY_REQUIRED", `Quản trị viên chưa kết nối ${provider === "deepseek" ? "dịch vụ viết nội dung" : "dịch vụ giọng nói"} cho app.`, 503, "contact_admin");
  return { key, personal: false };
}
export async function saveSettings(userId: string, body: Record<string, unknown>) {
  if (Object.keys(body).some((field) => /api.?key/i.test(field))) {
    const member = await getMember(userId);
    throw new StudioError("SHARED_KEYS_MANAGED", member.role === "admin" ? "Khóa AI dùng chung được cấu hình trong biến môi trường Vercel, không nhập hoặc lưu qua giao diện." : "Kết nối AI dùng chung do quản trị viên quản lý.", member.role === "admin" ? 422 : 403);
  }
  const profile = "profile" in body ? sanitizeProfile(body.profile) : (await readSettings(userId)).profile;
  const client = await createStudioSupabaseServer();
  const { error } = await client.from("studio_settings").upsert({ user_id: userId, profile_json: profile, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) return storageError();
}
export async function consumeAiUnits(userId: string, units: number) {
  if (!userId) throw new StudioError("SIGN_IN_REQUIRED", "Cần đăng nhập.", 401, "/dang-nhap");
  if (!Number.isInteger(units) || units < 1 || units > 10000) throw new StudioError("INVALID_AI_UNITS", "Số lượt xử lý không hợp lệ.");
  const client = await createStudioSupabaseServer();
  const { error } = await client.rpc("consume_studio_ai_units", { p_units: units });
  if (error) {
    if (error.message?.includes("QUOTA_EXCEEDED")) throw new StudioError("QUOTA_EXCEEDED", "Bạn đã hết lượt xử lý AI. Hãy liên hệ quản trị viên để được cấp thêm.", 429, "contact_admin");
    if (error.message?.includes("MEMBER_DISABLED")) throw new StudioError("MEMBER_DISABLED", "Tài khoản chưa được cấp quyền xử lý AI.", 403, "contact_admin");
    return storageError();
  }
  // The RPC uses auth.uid(), so passing another userId cannot charge a different account.
}

type VoiceRow = { voice_id: string; name: string; source: string; authorization_tag: string };
async function signingKey() {
  const secret = process.env.STUDIO_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) throw new StudioError("SIGNING_NOT_CONFIGURED", "Quản trị viên cần cấu hình khóa bảo vệ giọng cá nhân của thành viên.", 503);
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const voiceMessage = (userId: string, voiceId: string, source: string) => new TextEncoder().encode(JSON.stringify([userId, voiceId, source]));
async function voiceTag(userId: string, voiceId: string, source: string) { return bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(), voiceMessage(userId, voiceId, source)))); }
async function validVoiceTag(userId: string, row: VoiceRow) {
  try { return await crypto.subtle.verify("HMAC", await signingKey(), base64ToBytes(row.authorization_tag), voiceMessage(userId, row.voice_id, row.source)); } catch { return false; }
}
export async function consumeVoiceClone(userId: string, units = 10) {
  if (!userId) throw new StudioError("SIGN_IN_REQUIRED", "Cần đăng nhập.", 401, "/dang-nhap");
  if (!Number.isInteger(units) || units < 1 || units > 10000) throw new StudioError("INVALID_AI_UNITS", "Số lượt xử lý không hợp lệ.");
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.rpc("consume_studio_voice_clone", { p_units: units });
  if (error) {
    if (error.message?.includes("VOICE_CLONE_LIMIT")) throw new StudioError("VOICE_CLONE_LIMIT", "Bạn đã dùng hết 3 lượt nhân bản giọng được cấp. Hãy liên hệ quản trị viên nếu cần thêm.", 429, "contact_admin");
    if (error.message?.includes("QUOTA_EXCEEDED")) throw new StudioError("QUOTA_EXCEEDED", "Bạn đã hết lượt xử lý AI. Hãy liên hệ quản trị viên để được cấp thêm.", 429, "contact_admin");
    if (error.message?.includes("MEMBER_DISABLED")) throw new StudioError("MEMBER_DISABLED", "Tài khoản chưa được cấp quyền xử lý AI.", 403, "contact_admin");
    return storageError();
  }
  return Array.isArray(data) ? data[0] : data;
}

export type SharedVoiceCatalogRow = { voice_id: string; name: string; enabled: boolean; sort_order: number; kind: "system" | "admin_clone" };
export async function sharedVoiceCatalog(userId: string): Promise<SharedVoiceCatalogRow[]> {
  const member = await getMember(userId);
  const client = await createStudioSupabaseServer();
  let query = client.from("studio_voice_catalog").select("voice_id,name,enabled,sort_order,kind");
  if (member.role !== "admin") query = query.eq("enabled", true);
  const { data, error } = await query.order("sort_order", { ascending: true }).order("name", { ascending: true });
  if (error) return storageError();
  return (data || []) as SharedVoiceCatalogRow[];
}
export async function setSharedVoiceCatalog(userId: string, voiceId: string, name: string, enabled: boolean, kind: "system" | "admin_clone" = "system") {
  await requireAdmin(userId);
  if (!/^maziao:(vieten_speech|lingual_speech_v2):[a-zA-Z0-9_-]{1,100}$/.test(voiceId)) throw new StudioError("INVALID_VOICE", "Chọn một giọng hợp lệ.");
  if (kind !== "system" && kind !== "admin_clone") throw new StudioError("INVALID_VOICE", "Loại giọng chia sẻ chưa hợp lệ.");
  const safeName = name.trim().slice(0, 200) || "Giọng tiếng Việt";
  const client = await createStudioSupabaseServer();
  if (enabled) {
    const { data: owned, error: lookupError } = await client.from("studio_voice_cache")
      .select("voice_id,kind,status").eq("voice_id",voiceId).maybeSingle();
    if (lookupError || !owned || owned.status !== "active" || owned.kind !== kind)
      throw new StudioError("VOICE_NOT_AUTHORIZED", "Giọng chưa được đồng bộ hợp lệ. Hãy đồng bộ lại trước khi chia sẻ.", 403);
  }
  const { data, error } = await client.from("studio_voice_catalog").upsert({ voice_id: voiceId, name: safeName, enabled, kind, updated_at: new Date().toISOString() }, { onConflict: "voice_id" }).select("voice_id,name,enabled,sort_order,kind").single();
  if (error) return storageError();
  return data as SharedVoiceCatalogRow;
}

export async function authorizedVoiceRows(userId: string): Promise<VoiceRow[]> {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_voices").select("voice_id,name,source,authorization_tag").eq("user_id", userId);
  if (error) return storageError();
  const rows = (data || []) as VoiceRow[], verified = await Promise.all(rows.map((row) => validVoiceTag(userId, row)));
  return rows.filter((_, i) => verified[i]);
}

export async function adminCloneCandidates(userId: string) {
  await requireAdmin(userId);
  const rows = await authorizedVoiceRows(userId);
  return rows
    .filter(row => row.source === "personal" && /^maziao:(vieten_speech|lingual_speech_v2):[a-zA-Z0-9_-]{1,100}$/.test(row.voice_id))
    .map(row => ({ voice_id: row.voice_id, name: row.name, enabled: false, sort_order: 0, kind: "admin_clone" as const }));
}
export async function saveAuthorizedVoice(userId: string, voiceId: string, name: string, source: string) {
  const authorization_tag = await voiceTag(userId, voiceId, source), client = await createStudioSupabaseServer();
  const { error } = await client.from("studio_voices").upsert({ user_id: userId, voice_id: voiceId, name, source, authorization_tag, verified_at: new Date().toISOString() }, { onConflict: "user_id,voice_id" });
  if (error) return storageError();
}
export async function saveSharedVoiceList(userId: string, voices: { voiceId: string; name: string }[]) {
  if (!voices.length) return;
  const rows = await Promise.all(voices.map(async (voice) => ({ user_id: userId, voice_id: voice.voiceId, name: voice.name, source: "shared", authorization_tag: await voiceTag(userId, voice.voiceId, "shared"), verified_at: new Date().toISOString() })));
  const client = await createStudioSupabaseServer();
  const { error } = await client.from("studio_voices").upsert(rows, { onConflict: "user_id,voice_id" });
  if (error) return storageError();
}
export async function listMembers(userId: string) {
  await requireAdmin(userId);
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_members").select("user_id,email,display_name,role,enabled,ai_units_limit,ai_units_used,voice_clone_limit,voice_clone_used,created_at").order("created_at", { ascending: false }).limit(250);
  if (error) return storageError();
  return data || [];
}
export async function updateMember(userId: string, body: Record<string, unknown>) {
  await requireAdmin(userId);
  if (typeof body.userId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.userId)) throw new StudioError("INVALID_MEMBER", "Chọn thành viên hợp lệ.");
  const changes: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("enabled" in body) { if (typeof body.enabled !== "boolean") throw new StudioError("INVALID_MEMBER", "Trạng thái không hợp lệ."); changes.enabled = body.enabled; }
  if ("aiUnitsLimit" in body) { const limit = body.aiUnitsLimit; if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > 100000) throw new StudioError("INVALID_QUOTA", "Hạn mức cần là số nguyên từ 0 đến 100.000."); changes.ai_units_limit = limit; }
  if ("voiceCloneLimit" in body) { const limit = body.voiceCloneLimit; if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > 100) throw new StudioError("INVALID_CLONE_LIMIT", "Hạn mức nhân bản giọng cần là số nguyên từ 0 đến 100."); changes.voice_clone_limit = limit; }
  if (body.resetUsage === true) changes.ai_units_used = 0;
  if (body.resetVoiceClones === true) changes.voice_clone_used = 0;
  if (body.userId === userId && changes.enabled === false) throw new StudioError("ADMIN_SELF_DISABLE", "Không thể tự khóa quản trị viên đang đăng nhập.");
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_members").update(changes).eq("user_id", body.userId).select("user_id,email,display_name,role,enabled,ai_units_limit,ai_units_used,voice_clone_limit,voice_clone_used").maybeSingle();
  if (error) return storageError();
  if (!data) throw new StudioError("MEMBER_NOT_FOUND", "Không tìm thấy thành viên.", 404);
  return data;
}

export async function limitedJson(request: Request, maxBytes = 100_000): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") || 0) > maxBytes) throw new StudioError("PAYLOAD_TOO_LARGE", "Nội dung gửi lên quá lớn.", 413);
  const reader = request.body?.getReader(), decoder = new TextDecoder(); let size = 0, text = "";
  if (reader) { try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new StudioError("PAYLOAD_TOO_LARGE", "Nội dung gửi lên quá lớn.", 413); } text += decoder.decode(value, { stream: true }); } text += decoder.decode(); } finally { reader.releaseLock(); } }
  try { const body = JSON.parse(text); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(); return body; } catch { throw new StudioError("INVALID_JSON", "Dữ liệu gửi lên không hợp lệ."); }
}
export async function limitedFormData(request: Request, maxBytes: number): Promise<FormData> {
  if (!request.body || Number(request.headers.get("content-length") || 0) > maxBytes) throw new StudioError("PAYLOAD_TOO_LARGE", "Tệp gửi lên vượt giới hạn dung lượng.", 413);
  let size = 0, oversized = false;
  const stream = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { size += chunk.byteLength; if (size > maxBytes) { oversized = true; throw new Error("Upload exceeds limit"); } controller.enqueue(chunk); } }));
  try { return await new Response(stream, { headers: { "Content-Type": request.headers.get("content-type") || "" } }).formData(); } catch { throw new StudioError(oversized ? "PAYLOAD_TOO_LARGE" : "INVALID_UPLOAD", oversized ? "Tệp gửi lên vượt giới hạn dung lượng." : "Dữ liệu tải lên không hợp lệ. Hãy chọn lại tệp.", oversized ? 413 : 400); }
}
async function providerErrorStatus(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const maxBytes = 32 * 1024, decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    if (Number(response.headers.get("content-length") || 0) > maxBytes) { await reader.cancel().catch(() => {}); return; }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); return; }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    const detail = (body as Record<string, unknown>).detail;
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return;
    const status = (detail as Record<string, unknown>).status;
    return typeof status === "string" ? status : undefined;
  } catch {
    await reader.cancel().catch(() => {});
    return;
  } finally { reader.releaseLock(); }
}
type ProviderPermission = "voices_read" | "voices_write" | "text_to_speech";
const elevenPermissionMessages: Record<ProviderPermission, string> = {
  voices_read: "Khóa ElevenLabs đang kết nối chưa có quyền đọc giọng (Voices: Read). Quản trị viên cần bật Voices → Read cho đúng khóa này trong ElevenLabs rồi lưu.",
  voices_write: "Khóa ElevenLabs đang kết nối chưa có quyền tạo giọng cá nhân (Voices: Write). Quản trị viên cần bật Voices → Write cho đúng khóa này trong ElevenLabs rồi lưu.",
  text_to_speech: "Khóa ElevenLabs đang kết nối chưa có quyền tạo lời đọc (Text to Speech). Quản trị viên cần bật quyền Text to Speech cho đúng khóa này trong ElevenLabs rồi lưu.",
};
export async function providerResponse(response: Response, provider: string, permission?: ProviderPermission): Promise<Response> {
  if (response.ok) return response;
  // Only exact machine codes influence the response. Provider messages may contain
  // credentials or user text, so never return or log the parsed body.
  const status = await providerErrorStatus(response);
  if (provider === "ElevenLabs") {
    if (status === "api_key_id_used_as_api_key") throw new StudioError("PROVIDER_KEY_ID", "ElevenLabs nhận được Key ID thay cho khóa API bí mật. Quản trị viên cần đặt giá trị Secret API key vào ELEVENLABS_API_KEY trên Vercel rồi triển khai lại.", 422, "contact_admin");
    if (status === "invalid_api_key") throw new StudioError("PROVIDER_AUTH", "ElevenLabs không chấp nhận khóa API. Quản trị viên cần kiểm tra Secret API key và trạng thái khóa.", 422, "contact_admin");
    if (status === "missing_permissions") throw new StudioError("PROVIDER_PERMISSION", permission ? elevenPermissionMessages[permission] : "Khóa ElevenLabs chưa có quyền cho chức năng này. Quản trị viên cần kiểm tra quyền đọc giọng (Voices: Read), tạo lời đọc (Text to Speech) hoặc tạo giọng tương ứng với thao tác đang dùng.", 422, "contact_admin");
    if (status === "quota_exceeded") throw new StudioError("PROVIDER_LIMIT", "ElevenLabs đã hết hạn mức sử dụng. Quản trị viên cần kiểm tra gói và hạn mức của tài khoản.", 429, "contact_admin");
  }
  if (provider === "DeepSeek" && response.status === 402) throw new StudioError("PROVIDER_BALANCE", "Tài khoản DeepSeek không đủ số dư. Quản trị viên cần kiểm tra số dư và nạp tiền trước khi thử lại.", 422, "contact_admin");
  if ([401, 403].includes(response.status)) throw new StudioError("PROVIDER_AUTH", `${provider} từ chối kết nối. Quản trị viên cần kiểm tra API key và quyền tài khoản.`, 422, "contact_admin");
  if (response.status === 429) throw new StudioError("PROVIDER_LIMIT", `${provider} đang hết hạn mức hoặc quá nhiều yêu cầu. Quản trị viên cần kiểm tra tài khoản.`, 429, "contact_admin");
  if ([400, 422].includes(response.status)) throw new StudioError("PROVIDER_REJECTED", `${provider} chưa xử lý được dữ liệu hoặc model đã chọn. Hãy kiểm tra tệp và cấu hình.`, 422);
  throw new StudioError("PROVIDER_UNAVAILABLE", `${provider} đang gián đoạn. Vui lòng thử lại.`, 502);
}
