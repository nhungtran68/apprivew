import "server-only";
import { StudioError } from "./studio-contract";
import { requireAdmin } from "./studio-server";
import { createStudioSupabaseServer } from "./studio-supabase";

const validVoiceId = (value: unknown): value is string => typeof value === "string"
  && /^maziao:(vieten_speech|lingual_speech_v2):[a-zA-Z0-9_-]{1,100}$/.test(value);

/** Returns only requested IDs which are not private clones of another member.
 * The RPC checks the session's actual active admin; its parameter contains no
 * caller-selected user ID. HMAC validity is deliberately irrelevant here.
 */
export async function publishableAdminVoiceIds(userId: string, ids: string[]): Promise<string[]> {
  await requireAdmin(userId);
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => !validVoiceId(id))) {
    throw new StudioError("INVALID_VOICE_IDS", "Danh sách giọng cần hợp lệ và có tối đa 1.000 mục.", 422);
  }
  const requested = [...new Set(ids)];
  if (!requested.length) return [];
  const client = await createStudioSupabaseServer(), allowed = new Set<string>();
  for (let offset = 0; offset < requested.length; offset += 100) {
    const chunk = requested.slice(offset, offset + 100);
    const { data, error } = await client.rpc("publishable_studio_admin_voice_ids", { p_voice_ids: chunk });
    if (error?.message?.includes("ADMIN_REQUIRED")) throw new StudioError("ADMIN_REQUIRED", "Chỉ quản trị viên đang hoạt động được kiểm tra giọng dùng chung.", 403);
    if (error || !Array.isArray(data) || data.some(id => typeof id !== "string" || !chunk.includes(id))) {
      throw new StudioError("VOICE_PUBLICATION_CHECK_FAILED", "Chưa kiểm tra được quyền riêng tư của giọng. Hãy kiểm tra kết nối và cấu hình Supabase trước khi chia sẻ.", 503);
    }
    for (const id of data as string[]) allowed.add(id);
  }
  return requested.filter(id => allowed.has(id));
}
