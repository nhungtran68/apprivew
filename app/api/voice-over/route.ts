import { apiError, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";
import { StudioError, cleanText } from "@/lib/studio-contract";
import { authorizeMaziaoVoice, generateMaziaoVoiceOver } from "@/lib/studio-maziao";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    const body = await limitedJson(request, 20000);
    const text = cleanText(body.text, 6000);
    const voiceId = cleanText(body.voiceId, 160);
    if (!text.trim() || text.length > 6000) throw new StudioError("SCRIPT_REQUIRED", "Nhập lời thoại tối đa 6.000 ký tự.");
    if (!voiceId.startsWith("maziao:")) throw new StudioError("INVALID_VOICE", "Chọn một giọng hợp lệ để tạo lời đọc.");
    const controls = { speed: Number(body.speed), volume: Number(body.volume), pitch: Number(body.pitch) };
    if (!Number.isFinite(controls.speed) || controls.speed < 0.8 || controls.speed > 1.2 || !Number.isFinite(controls.volume) || controls.volume < 0.5 || controls.volume > 1.5 || !Number.isFinite(controls.pitch) || controls.pitch < 0.8 || controls.pitch > 1.2) throw new StudioError("INVALID_AUDIO_SETTINGS", "Cấu hình âm thanh chưa hợp lệ.");
    await authorizeMaziaoVoice(userId, voiceId);
    const { key } = await providerKey(userId, "maziao");
    return json(await generateMaziaoVoiceOver({ key, userId, voiceId, text, ...controls }));
  } catch (error) { return apiError(error); }
}
