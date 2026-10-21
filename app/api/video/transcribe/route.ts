import { StudioError } from "@/lib/studio-contract";
import { creditRequestId, runWithCredits } from "@/lib/studio-credit-operation";
import { creditsForTranscription, settleCredits } from "@/lib/studio-credits";
import { downloadOwnedMedia } from "@/lib/studio-supabase";
import { apiError, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";
import { measureTranscriptionAudio, transcribeAudio, transcriptionPath } from "@/lib/studio-transcription";
import { readSavedTranscription, saveTranscription, transcriptionRequestStatus } from "@/lib/studio-transcription-result";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Uploaded audio goes directly to private Supabase Storage, never through a Vercel request body. */
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    const requestId = creditRequestId(request);
    const body = await limitedJson(request, 1000);
    const path = transcriptionPath(userId, body.storagePath);
    // Check the saved result first: the source may already have been removed
    // after a provider success whose HTTP response never reached the browser.
    const saved = await readSavedTranscription(userId, requestId, path);
    if (saved) {
      await settleCredits(userId, requestId);
      return json(saved);
    }
    const status = await transcriptionRequestStatus(userId, requestId);
    if (status === "reserved") return json({ pending: true }, 202);
    if (status === "refunded") throw new StudioError("TRANSCRIPTION_RETRY_NEW_REQUEST", "Lượt nhận diện trước không hoàn tất và đã hoàn credit. Bấm thử lại để gửi tác vụ mới.", 409);
    if (status === "settled") throw new StudioError("TRANSCRIPTION_RESULT_UNAVAILABLE", "Lượt nhận diện đã tính credit nhưng kết quả chưa đọc được. Vui lòng liên hệ quản trị viên; đừng gửi tác vụ mới.", 503, "contact_admin");
    const file = await downloadOwnedMedia(userId, path);
    const duration = await measureTranscriptionAudio(file);
    const { key } = await providerKey(userId, "eleven");
    if (!key.trim()) throw new StudioError("TRANSCRIPTION_NOT_CONFIGURED", "Quản trị viên chưa kết nối dịch vụ nhận diện giọng nói.", 503, "contact_admin");
    const credits = creditsForTranscription(duration);
    return json(await runWithCredits(request, userId, "transcribe", credits,
      async () => {
        const result = await transcribeAudio(file, key, duration);
        await saveTranscription(userId, requestId, path, result);
        return result;
      },
      { model: "scribe_v2", durationSeconds: duration, fileBytes: file.size }));
  } catch (error) { return apiError(error); }
}
