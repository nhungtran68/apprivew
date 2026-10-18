import { adminCloneCandidates, apiError, getMember, json, limitedJson, requestUser, setSharedVoiceCatalog, sharedVoiceCatalog } from "@/lib/studio-server";
import { StudioError } from "@/lib/studio-contract";
import { cachedAdminCandidates } from "@/lib/studio-voice-cache";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const userId = await requestUser(request);
    const [voices, member] = await Promise.all([sharedVoiceCatalog(userId), getMember(userId)]);
    const candidates = member.role === "admin" ? await cachedAdminCandidates(userId) : [];
    return json({ voices, candidates });
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request) {
  try {
    const userId = await requestUser(request, true);
    const body = await limitedJson(request, 3000);
    if (typeof body.voiceId !== "string" || typeof body.name !== "string" || typeof body.enabled !== "boolean") throw new StudioError("INVALID_VOICE", "Chọn giọng và trạng thái hợp lệ.");
    const kind = body.kind === "admin_clone" ? "admin_clone" : "system";
    return json({ voice: await setSharedVoiceCatalog(userId, body.voiceId, body.name, body.enabled, kind) });
  } catch (error) { return apiError(error); }
}
