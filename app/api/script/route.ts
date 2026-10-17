import { apiError, consumeAiUnits, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";
import { StudioError, cleanText, validDuration, validFormat } from "@/lib/studio-contract";
import { createScript } from "@/lib/studio-deepseek";
import { projectProfile } from "@/lib/studio-profile";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true), body = await limitedJson(request);
    if (!body.analysis || typeof body.analysis !== "object" || Array.isArray(body.analysis)) throw new StudioError("ANALYSIS_REQUIRED", "Phân tích ảnh video trước khi viết kịch bản.");
    const intent = cleanText(body.intent, 5000), duration = validDuration(body.duration);
    if (!intent) throw new StudioError("INTENT_REQUIRED", "Cho AI biết điều bạn muốn người xem hiểu hoặc làm.");
    const { key } = await providerKey(userId, "deepseek");
    return json(await createScript(key, { analysis: body.analysis, intent, duration, profile: await projectProfile(userId, body.profile), format: validFormat(body.format), angleId: cleanText(body.angleId, 60), instruction: cleanText(body.instruction, 3000) }, () => consumeAiUnits(userId, 1)));
  } catch (error) { return apiError(error); }
}
