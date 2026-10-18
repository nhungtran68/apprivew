import { apiError, json, limitedJson, providerKey, requestUser, voiceProvider } from "@/lib/studio-server";
import { StudioError, cleanText } from "@/lib/studio-contract";
import { cloneVoice, listVoices } from "@/lib/studio-eleven";
import { assertOwnedMediaPath, downloadOwnedMedia, removeOwnedMedia } from "@/lib/studio-supabase";
import { assertCloningEntitlement } from "@/lib/studio-voice-catalog";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  try {
    const userId = await requestUser(request), provider = voiceProvider();
    if (provider === "maziao") {
      const { cachedVoiceList } = await import("@/lib/studio-voice-cache");
      const result = await cachedVoiceList(userId);
      return json({ provider, ...result, voices: result.voices.map(voice => ({ ...voice, voice_id: voice.voiceId, preview_url: voice.previewUrl })) });
    }
    const { key } = await providerKey(userId, provider);
    const voices = await listVoices(key, userId);
    return json({ provider, voices: voices.map(voice => ({ ...voice, voice_id: voice.voiceId, preview_url: voice.previewUrl })) });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  let userId = "", paths: string[] = [];
  try {
    userId = await requestUser(request, true);
    const body = await limitedJson(request, 10000), name = cleanText(body.name, 100);
    if (body.consent !== true) throw new StudioError("CONSENT_REQUIRED", "Xác nhận đây là giọng của bạn và đồng ý tạo bản sao.");
    if (!name || !Array.isArray(body.samplePaths) || !body.samplePaths.length || body.samplePaths.length > 8) throw new StudioError("VOICE_SAMPLE_REQUIRED", "Đặt tên và thêm 1–8 mẫu giọng sạch.");
    paths = body.samplePaths.map((path) => assertOwnedMediaPath(userId, path));
    const files: File[] = [];
    for (const path of paths) files.push(await downloadOwnedMedia(userId, path));
    if (files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) throw new StudioError("VOICE_SAMPLE_TOO_LARGE", "Tổng mẫu giọng tối đa 25 MB.", 413);
    if (files.some((file) => !file.type.startsWith("audio/") && !["video/webm", "video/mp4"].includes(file.type.split(";")[0]))) throw new StudioError("INVALID_VOICE_SAMPLE", "Chọn tệp âm thanh hoặc bản ghi giọng.");
    const provider = voiceProvider(), { key } = await providerKey(userId, provider);
    if (provider === "maziao") {
      if (body.gender !== "male" && body.gender !== "female") throw new StudioError("INVALID_GENDER", "Chọn giọng nam hoặc nữ để nhân bản.");
      return json(await (await import("@/lib/studio-maziao")).cloneMaziaoVoice(key, userId, name, files, body.gender), 201);
    }
    await assertCloningEntitlement(key);
    return json(await cloneVoice(key, userId, name, files), 201);
  } catch (error) { return apiError(error); }
  finally { if (userId && paths.length) await removeOwnedMedia(userId, paths).catch(() => {}); }
}
