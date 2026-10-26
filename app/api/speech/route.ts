import { apiError, json, limitedJson, providerKey, requestUser, voiceProvider } from "@/lib/studio-server";
import { StudioError, cleanText, validDuration, validateSegments } from "@/lib/studio-contract";
import { creditRequestId } from "@/lib/studio-credit-operation";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true), requestId = creditRequestId(request), body = await limitedJson(request, 30000), duration = validDuration(body.duration), segments = validateSegments(body.segments, duration), voiceId = cleanText(body.voiceId, 160);
    if (segments.reduce((sum, s) => sum + s.text.length, 0) > 6000 || segments.some((s) => s.text.split(/\s+/).length > (s.end - s.start) * 8 + 20)) throw new StudioError("SCRIPT_TOO_LONG", "Kịch bản quá dài so với video. Hãy rút gọn trước khi tạo giọng.");
    if (voiceProvider() === "saydi") {
      const { key } = await providerKey(userId, "saydi");
      return json(await (await import("@/lib/studio-saydi-service")).generateSaydiSpeech({ key, userId, requestId, voiceId, segments, duration }));
    }
    if (voiceId.startsWith("maziao:")) {
      const maziao = await import("@/lib/studio-maziao");
      const resolvedVoiceId = await maziao.authorizeMaziaoVoice(userId, voiceId), { key } = await providerKey(userId, "maziao");
      return json(await maziao.generateMaziaoSpeech({ key, userId, requestId, voiceId: resolvedVoiceId, segments, duration }));
    }
    throw new StudioError("VOICE_PRICING_UNAVAILABLE", "Tạm thời chỉ hỗ trợ tạo lời đọc bằng giọng đã kết nối. Quản trị viên cần cấu hình bảng giá trước khi bật nhà cung cấp khác.", 503, "contact_admin");
  } catch (error) { return apiError(error); }
}
