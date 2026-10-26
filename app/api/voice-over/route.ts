import { apiError, json, limitedJson, providerKey, requestUser, voiceProvider } from "@/lib/studio-server";
import { StudioError, cleanText } from "@/lib/studio-contract";
import { authorizeMaziaoVoice, generateMaziaoVoiceOver, pendingMaziaoVoiceOver, recoverableVoiceError, voiceRequestSliceMs } from "@/lib/studio-maziao";
import { creditRequestId } from "@/lib/studio-credit-operation";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    const requestId = creditRequestId(request);
    const body = await limitedJson(request, 30000);
    // The narration must match the script the user approved. Validate its
    // length instead of silently slicing or normalizing the supplied text.
    const text = typeof body.text === "string" ? body.text : "";
    const voiceId = cleanText(body.voiceId, 160);
    if (!text.trim() || text.length > 1200) throw new StudioError("SCRIPT_REQUIRED", "Mỗi tệp giọng hỗ trợ tối đa 1.200 ký tự. Hãy chia kịch bản dài thành các đoạn ngắn hơn.");
    if (!voiceId) throw new StudioError("INVALID_VOICE", "Chọn một giọng hợp lệ để tạo lời đọc.");
    if (voiceProvider() === "saydi") {
      const speed = body.speed === undefined ? 1 : Number(body.speed);
      if (!Number.isFinite(speed) || speed < 0.25 || speed > 4)
        throw new StudioError("INVALID_AUDIO_SETTINGS", "Tốc độ đọc SaydiVoice cần từ 0,25 đến 4.", 422);
      const { key } = await providerKey(userId, "saydi");
      return json(await (await import("@/lib/studio-saydi-service")).generateSaydiVoiceOver({
        key, userId, requestId, voiceId, text, speed,
      }));
    }
    const controls = { speed: Number(body.speed), volume: Number(body.volume), pitch: Number(body.pitch) };
    if (!Number.isFinite(controls.speed) || controls.speed < 0.8 || controls.speed > 1.2 || !Number.isFinite(controls.volume) || controls.volume < 0.5 || controls.volume > 1.5 || !Number.isFinite(controls.pitch) || controls.pitch < 0.8 || controls.pitch > 1.2) throw new StudioError("INVALID_AUDIO_SETTINGS", "Cấu hình âm thanh chưa hợp lệ.");
    if (voiceId.startsWith("maziao:")) {
      await authorizeMaziaoVoice(userId, voiceId);
      const { key } = await providerKey(userId, "maziao");
      try {
        return json(await generateMaziaoVoiceOver({ key, userId, requestId, voiceId, text, ...controls, requestSliceMs: voiceRequestSliceMs() }));
      } catch (error) {
        // The provider has accepted the job and its ID is durable in the
        // ledger. A slow/broken poll must never encourage a second paid submit.
        if (recoverableVoiceError(error) && await pendingMaziaoVoiceOver(userId, requestId)) {
          console.warn(JSON.stringify({ event: "studio_voice_pending", phase: "submit", code: error instanceof StudioError ? error.code : "UNKNOWN" }));
          return json({ pending: true, requestId, reason: error instanceof StudioError ? error.code : "UNKNOWN", message: "Lời đọc đã được gửi và đang xử lý. Ứng dụng sẽ kiểm tra lại tác vụ này mà không tạo thêm lượt mới." }, 202);
        }
        throw error;
      }
    }
    throw new StudioError("VOICE_PRICING_UNAVAILABLE", "Tạm thời chỉ hỗ trợ tạo lời đọc bằng giọng đã kết nối. Quản trị viên cần cấu hình bảng giá trước khi bật nhà cung cấp khác.", 503, "contact_admin");
  } catch (error) { return apiError(error); }
}
