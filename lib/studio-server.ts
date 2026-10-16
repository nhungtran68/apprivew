import "server-only";
import { StudioError, bytesToBase64, base64ToBytes, sanitizeProfile, type StudioProfile } from "./studio-contract";
import { createStudioSupabaseServer, supabaseConfigured } from "./studio-supabase";

export const modelNames = () => ({ deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-flash", voiceModel: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5" });
export function json(data: unknown, status = 200): Response { return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
export function apiError(error: unknown): Response {
  if (error instanceof StudioError) return json({ error: error.message, code: error.code, action: error.action, ...(error.code === "AUTH_NOT_CONFIGURED" ? { authReady: false } : {}) }, error.status);
  return json({ error: "Chưa hoàn tất xử lý. Vui lòng thử lại.", code: "INTERNAL_ERROR" }, 500);
}
export type StudioMember = { user_id: string; email: string; display_name: string; role: "admin" | "member"; enabled: boolean; ai_units_limit: number; ai_units_used: number };
function storageError(): never { throw new StudioError("STORAGE_UNAVAILABLE", "Chưa đọc được dữ liệu thành viên. Quản trị viên cần chạy migration Supabase và kiểm tra kết nối.", 503); }
export async function getMember(userId: string): Promise<StudioMember> {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_members").select("user_id,email,display_name,role,enabled,ai_units_limit,ai_units_used").eq("user_id", userId).maybeSingle();
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
  if (!member.enabled) throw new StudioError("MEMBER_DISABLED", "Tài khoản đang chờ quản trị viên cấp quyền hoặc đã tạm khóa.", 403, "contact_admin");
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
  return { userId, authReady: supabaseConfigured(), isAdmin: member.role === "admin", memberName: profile.name || member.display_name || member.email, deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY), elevenConfigured: Boolean(process.env.ELEVENLABS_API_KEY), ...modelNames(), profile, quota: { limit: member.ai_units_limit, used: member.ai_units_used, reserved: 0, remaining: Math.max(0, member.ai_units_limit - member.ai_units_used) } };
}
export async function providerKey(_userId: string, provider: "deepseek" | "eleven"): Promise<{ key: string; personal: boolean }> {
  const key = provider === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.ELEVENLABS_API_KEY;
  if (!key) throw new StudioError("API_KEY_REQUIRED", provider === "deepseek" ? "Quản trị viên chưa kết nối DeepSeek cho app." : "Quản trị viên chưa kết nối ElevenLabs cho app.", 503, "contact_admin");
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
export async function authorizedVoiceRows(userId: string): Promise<VoiceRow[]> {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_voices").select("voice_id,name,source,authorization_tag").eq("user_id", userId);
  if (error) return storageError();
  const rows = (data || []) as VoiceRow[], verified = await Promise.all(rows.map((row) => validVoiceTag(userId, row)));
  return rows.filter((_, i) => verified[i]);
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
  const { data, error } = await client.from("studio_members").select("user_id,email,display_name,role,enabled,ai_units_limit,ai_units_used,created_at").order("created_at", { ascending: false }).limit(250);
  if (error) return storageError();
  return data || [];
}
export async function updateMember(userId: string, body: Record<string, unknown>) {
  await requireAdmin(userId);
  if (typeof body.userId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.userId)) throw new StudioError("INVALID_MEMBER", "Chọn thành viên hợp lệ.");
  const changes: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("enabled" in body) { if (typeof body.enabled !== "boolean") throw new StudioError("INVALID_MEMBER", "Trạng thái không hợp lệ."); changes.enabled = body.enabled; }
  if ("aiUnitsLimit" in body) { const limit = body.aiUnitsLimit; if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > 100000) throw new StudioError("INVALID_QUOTA", "Hạn mức cần là số nguyên từ 0 đến 100.000."); changes.ai_units_limit = limit; }
  if (body.resetUsage === true) changes.ai_units_used = 0;
  if (body.userId === userId && changes.enabled === false) throw new StudioError("ADMIN_SELF_DISABLE", "Không thể tự khóa quản trị viên đang đăng nhập.");
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_members").update(changes).eq("user_id", body.userId).select("user_id,email,display_name,role,enabled,ai_units_limit,ai_units_used").maybeSingle();
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
export async function providerResponse(response: Response, provider: string): Promise<Response> {
  if (response.ok) return response; await response.body?.cancel();
  if ([401, 403].includes(response.status)) throw new StudioError("PROVIDER_AUTH", `${provider} từ chối kết nối. Quản trị viên cần kiểm tra API key và quyền tài khoản.`, 422, "contact_admin");
  if (response.status === 429) throw new StudioError("PROVIDER_LIMIT", `${provider} đang hết hạn mức hoặc quá nhiều yêu cầu. Quản trị viên cần kiểm tra tài khoản.`, 429, "contact_admin");
  if ([400, 422].includes(response.status)) throw new StudioError("PROVIDER_REJECTED", `${provider} chưa xử lý được dữ liệu hoặc model đã chọn. Hãy kiểm tra tệp và cấu hình.`, 422);
  throw new StudioError("PROVIDER_UNAVAILABLE", `${provider} đang gián đoạn. Vui lòng thử lại.`, 502);
}
