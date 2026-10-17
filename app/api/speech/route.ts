import { apiError, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";
import { StudioError, cleanText, validDuration, validateSegments } from "@/lib/studio-contract";
import { authorizeVoice, generateSpeech } from "@/lib/studio-eleven";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true), body = await limitedJson(request, 30000), duration = validDuration(body.duration), segments = validateSegments(body.segments, duration), voiceId = cleanText(body.voiceId, 100);
    if (segments.reduce((sum, s) => sum + s.text.length, 0) > 6000 || segments.some((s) => s.text.split(/\s+/).length > (s.end - s.start) * 8 + 20)) throw new StudioError("SCRIPT_TOO_LONG", "Kịch bản quá dài so với video. Hãy rút gọn trước khi tạo giọng.");
    const resolvedVoiceId = await authorizeVoice(userId, voiceId);
    const { key } = await providerKey(userId, "eleven");
    return json(await generateSpeech({ key, userId, voiceId: resolvedVoiceId, segments, duration }));
  } catch (error) { return apiError(error); }
}
