import { apiError, consumeAiUnits, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";
import { cleanText, validDuration, validFormat } from "@/lib/studio-contract";
import { analyzeFrames, validateFrames } from "@/lib/studio-deepseek";
import { projectProfile } from "@/lib/studio-profile";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true), body = await limitedJson(request, 3 * 1024 * 1024), duration = validDuration(body.duration), frames = validateFrames(body.frames, duration);
    const { key } = await providerKey(userId, "deepseek");
    const observationsOnly = body.observationsOnly === true;
    return json({ analysis: await analyzeFrames(key, {
      frames, duration, intent: cleanText(body.intent, 5000), profile: await projectProfile(userId, body.profile),
      format: observationsOnly ? undefined : validFormat(body.format),
      transcript: cleanText(body.transcript, 10000), observationsOnly,
    }, () => consumeAiUnits(userId, 1)) });
  } catch (error) { return apiError(error); }
}
