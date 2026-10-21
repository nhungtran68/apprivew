import { apiError, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";
import { listPendingMaziaoVoiceOvers, recoverMaziaoVoiceOver, pendingMaziaoVoiceOver, recoverableVoiceError, voiceRequestSliceMs } from "@/lib/studio-maziao";
import { StudioError } from "@/lib/studio-contract";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const userId = await requestUser(request);
    return json({ tasks: await listPendingMaziaoVoiceOvers(userId) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    const body = await limitedJson(request, 1000);
    const { key } = await providerKey(userId, "maziao");
    try {
      return json(await recoverMaziaoVoiceOver({ key, userId, requestId: body.requestId, requestSliceMs: voiceRequestSliceMs() }));
    } catch (error) {
      if (recoverableVoiceError(error) && typeof body.requestId === "string" && await pendingMaziaoVoiceOver(userId, body.requestId)) {
        console.warn(JSON.stringify({ event: "studio_voice_pending", phase: "recover", code: error instanceof StudioError ? error.code : "UNKNOWN" }));
        return json({ pending: true, requestId: body.requestId, reason: error instanceof StudioError ? error.code : "UNKNOWN", message: "Lời đọc vẫn đang xử lý. Có thể kiểm tra lại mà không tốn thêm lượt tạo." }, 202);
      }
      throw error;
    }
  } catch (error) { return apiError(error); }
}
