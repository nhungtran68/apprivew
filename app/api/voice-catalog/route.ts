import { apiError, json, limitedJson, requestUser, setSharedVoiceCatalog, sharedVoiceCatalog } from "@/lib/studio-server";
import { StudioError } from "@/lib/studio-contract";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const userId = await requestUser(request);
    return json({ voices: await sharedVoiceCatalog(userId) });
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request) {
  try {
    const userId = await requestUser(request, true);
    const body = await limitedJson(request, 3000);
    if (typeof body.voiceId !== "string" || typeof body.name !== "string" || typeof body.enabled !== "boolean") throw new StudioError("INVALID_VOICE", "Chọn giọng và trạng thái hợp lệ.");
    return json({ voice: await setSharedVoiceCatalog(userId, body.voiceId, body.name, body.enabled) });
  } catch (error) { return apiError(error); }
}
