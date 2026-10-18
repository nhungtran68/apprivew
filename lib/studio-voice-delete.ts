import "server-only";
import { StudioError } from "./studio-contract";
import { authorizedVoiceRows, getMember, providerKey, sharedVoiceCatalog, voiceProvider } from "./studio-server";
import { parseMaziaoVoiceId } from "./studio-maziao";
import { createStudioSupabaseServer } from "./studio-supabase";

/** Delete only a member's HMAC-verified personal clone. The provider owns the
 * audio model; the local grant and saved-voice slot are removed only after the
 * provider confirms deletion (or reports that it is already gone). */
export async function deleteMemberVoice(userId: string, voiceId: string): Promise<{ success: true }> {
  if (voiceProvider() !== "maziao") throw new StudioError("VOICE_DELETE_UNAVAILABLE", "Hiện chỉ có thể xóa giọng cá nhân Maziao trong app.", 422);
  const { id } = parseMaziaoVoiceId(voiceId);
  const member = await getMember(userId);
  if (member.role !== "member" || !member.enabled) throw new StudioError("MEMBER_VOICE_ONLY", "Chỉ thành viên có thể xóa giọng cá nhân của chính mình tại đây.", 403);
  const [grants, catalog] = await Promise.all([authorizedVoiceRows(userId), sharedVoiceCatalog(userId)]);
  if (!grants.some(row => row.voice_id === voiceId && row.source === "personal"))
    throw new StudioError("VOICE_NOT_AUTHORIZED", "Giọng này không thuộc tài khoản của bạn hoặc đã được xóa.", 403);
  if (catalog.some(row => row.voice_id === voiceId && row.enabled))
    throw new StudioError("VOICE_SHARED", "Giọng đang được chia sẻ cho thành viên. Hãy liên hệ quản trị viên.", 403);

  const { key } = await providerKey(userId, "maziao");
  let response: Response;
  try {
    response = await fetch(`https://app.maziao.com/api/voices/${encodeURIComponent(id)}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${key}` },
      redirect: "error", signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new StudioError("MAZIAO_UNAVAILABLE", "Chưa kết nối được dịch vụ để xóa giọng. Vui lòng thử lại.", 502);
  }
  // A prior deletion may have succeeded at Maziao while the local cleanup
  // failed. In that case a retry must still release the old grant and slot.
  if (response.status !== 404 && !response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new StudioError("MAZIAO_AUTH", "Dịch vụ chưa cấp quyền xóa giọng. Quản trị viên cần kiểm tra khóa API.", 422, "contact_admin");
    if (response.status === 429) throw new StudioError("MAZIAO_LIMIT", "Dịch vụ đang bận. Vui lòng thử lại sau.", 429);
    throw new StudioError("MAZIAO_DELETE_FAILED", "Chưa xóa được giọng khỏi dịch vụ. Vui lòng thử lại.", response.status >= 500 ? 502 : 422);
  }
  if (response.status !== 404 && response.status !== 204) {
    const raw = await response.text();
    if (raw.length > 65536) throw new StudioError("MAZIAO_DELETE_FAILED", "Chưa xác nhận được kết quả xóa giọng. Vui lòng thử lại.", 502);
    let result: Record<string, unknown>;
    try { result = JSON.parse(raw); } catch { throw new StudioError("MAZIAO_DELETE_FAILED", "Chưa xác nhận được kết quả xóa giọng. Vui lòng thử lại.", 502); }
    const data = result?.data;
    if (!result || typeof result !== "object" || Array.isArray(result) || result.success === false ||
        typeof result.error === "string" || (Array.isArray(result.errors) && result.errors.length) ||
        !data || typeof data !== "object" || Array.isArray(data) ||
        typeof (data as Record<string, unknown>).message !== "string")
      throw new StudioError("MAZIAO_DELETE_FAILED", "Dịch vụ chưa xác nhận xóa giọng. Vui lòng thử lại.", 502);
  } else {
    await response.body?.cancel();
  }

  const client = await createStudioSupabaseServer();
  const { error } = await client.rpc("release_studio_voice_clone", { p_voice_id: voiceId });
  if (error) throw new StudioError("VOICE_DELETE_SYNC_FAILED", "Giọng đã xóa tại dịch vụ nhưng chưa cập nhật tài khoản. Hãy bấm xóa lại để đồng bộ.", 503);
  return { success: true };
}
