import { apiError, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";
import { StudioError, cleanText } from "@/lib/studio-contract";
import { authorizeMaziaoVoice, generateMaziaoVoiceOver } from "@/lib/studio-maziao";
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
    if (!text.trim() || text.length > 6000) throw new StudioError("SCRIPT_REQUIRED", "Nhập lời thoại tối đa 6.000 ký tự.");
    if (!voiceId) throw new StudioError("INVALID_VOICE", "Chọn một giọng hợp lệ để tạo lời đọc.");
    const controls = { speed: Number(body.speed), volume: Number(body.volume), pitch: Number(body.pitch) };
    if (!Number.isFinite(controls.speed) || controls.speed < 0.8 || controls.speed > 1.2 || !Number.isFinite(controls.volume) || controls.volume < 0.5 || controls.volume > 1.5 || !Number.isFinite(controls.pitch) || controls.pitch < 0.8 || controls.pitch > 1.2) throw new StudioError("INVALID_AUDIO_SETTINGS", "Cấu hình âm thanh chưa hợp lệ.");
    if (voiceId.startsWith("maziao:")) {
      await authorizeMaziaoVoice(userId, voiceId);
      const { key } = await providerKey(userId, "maziao");
      return json(await generateMaziaoVoiceOver({ key, userId, requestId, voiceId, text, ...controls }));
    }
    throw new StudioError("VOICE_PRICING_UNAVAILABLE", "Tạm thời chỉ hỗ trợ tạo lời đọc bằng giọng đã kết nối. Quản trị viên cần cấu hình bảng giá trước khi bật nhà cung cấp khác.", 503, "contact_admin");
  } catch (error) { return apiError(error); }
}
