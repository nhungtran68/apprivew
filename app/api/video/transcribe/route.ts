import { StudioError } from "@/lib/studio-contract";
import { creditRequestId, runWithCredits } from "@/lib/studio-credit-operation";
import { creditsForTranscription } from "@/lib/studio-credits";
import { downloadOwnedMedia } from "@/lib/studio-supabase";
import { apiError, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";
import { measureTranscriptionAudio, transcribeAudio, transcriptionPath } from "@/lib/studio-transcription";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Uploaded audio goes directly to private Supabase Storage, never through a Vercel request body. */
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    creditRequestId(request);
    const body = await limitedJson(request, 1000);
    const path = transcriptionPath(userId, body.storagePath);
    const file = await downloadOwnedMedia(userId, path);
    const duration = await measureTranscriptionAudio(file);
    const { key } = await providerKey(userId, "eleven");
    if (!key.trim()) throw new StudioError("TRANSCRIPTION_NOT_CONFIGURED", "Quản trị viên chưa kết nối dịch vụ nhận diện giọng nói.", 503, "contact_admin");
    const credits = creditsForTranscription(duration);
    return json(await runWithCredits(request, userId, "transcribe", credits,
      () => transcribeAudio(file, key, duration),
      { model: "scribe_v2", durationSeconds: duration, fileBytes: file.size }));
  } catch (error) { return apiError(error); }
}
