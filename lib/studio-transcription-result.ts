import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { StudioError } from "./studio-contract";
import type { AudioTranscript } from "./studio-transcription";

type RequestStatus = "reserved" | "settled" | "refunded" | null;

let privilegedClient: SupabaseClient | undefined;

function resultClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new StudioError("TRANSCRIPTION_STORE_UNAVAILABLE", "Kho kết quả nhận diện chưa được cấu hình. Vui lòng liên hệ quản trị viên.", 503, "contact_admin");
  if (!privilegedClient) privilegedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return privilegedClient;
}

function storageError(): never {
  throw new StudioError("TRANSCRIPTION_STORE_UNAVAILABLE", "Chưa lưu hoặc lấy lại được kết quả nhận diện. Quản trị viên cần kiểm tra kho dữ liệu.", 503, "contact_admin");
}

function validResult(value: unknown): value is AudioTranscript {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<AudioTranscript>;
  return typeof row.text === "string" && row.text.length >= 12 && row.text.length <= 6000
    && typeof row.languageCode === "string" && Number.isFinite(row.duration) && Number(row.duration) >= 2 && Number(row.duration) <= 90
    && Array.isArray(row.words) && row.words.length > 0 && row.words.length <= 2000
    && row.words.every(word => typeof word.text === "string" && Number.isFinite(word.start) && Number.isFinite(word.end)
      && word.start >= 0 && word.end > word.start && word.end <= Number(row.duration) + 1);
}

/** Only a server-side service key can read saved transcripts; a request must match its owner and source path. */
export async function readSavedTranscription(userId: string, requestId: string, storagePath: string): Promise<AudioTranscript | null> {
  const { data, error } = await resultClient().from("studio_video_transcriptions")
    .select("transcript").eq("request_id", requestId).eq("user_id", userId).eq("storage_path", storagePath).maybeSingle();
  if (error) return storageError();
  if (!data) return null;
  if (!validResult(data.transcript)) return storageError();
  return data.transcript;
}

/** Save before settling credit so a lost browser response cannot strand a paid result. */
export async function saveTranscription(userId: string, requestId: string, storagePath: string, transcript: AudioTranscript): Promise<void> {
  if (!validResult(transcript)) return storageError();
  const { error } = await resultClient().from("studio_video_transcriptions")
    .insert({ request_id: requestId, user_id: userId, storage_path: storagePath, transcript });
  if (error) return storageError();
}

export async function transcriptionRequestStatus(userId: string, requestId: string): Promise<RequestStatus> {
  const { data, error } = await resultClient().from("studio_credit_operations")
    .select("kind,status").eq("request_id", requestId).eq("user_id", userId).maybeSingle();
  if (error) return storageError();
  if (!data) return null;
  if (data.kind !== "transcribe" || !["reserved", "settled", "refunded"].includes(data.status))
    throw new StudioError("TRANSCRIPTION_REQUEST_CONFLICT", "Mã tác vụ đã dùng cho việc khác. Hãy tải lại trang.", 409);
  return data.status as RequestStatus;
}
