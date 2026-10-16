import { apiError, consumeAiUnits, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";
import { cleanText, sanitizeProfile, validDuration } from "@/lib/studio-contract";
import { analyzeFrames, validateFrames } from "@/lib/studio-deepseek";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true), body = await limitedJson(request, 3 * 1024 * 1024), duration = validDuration(body.duration), frames = validateFrames(body.frames, duration);
    const { key } = await providerKey(userId, "deepseek");
    return json({ analysis: await analyzeFrames(key, { frames, duration, intent: cleanText(body.intent, 5000), profile: sanitizeProfile(body.profile), transcript: cleanText(body.transcript, 10000) }, () => consumeAiUnits(userId, 1)) });
  } catch (error) { return apiError(error); }
}
