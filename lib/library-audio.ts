import "server-only";
import { createClient } from "@supabase/supabase-js";

/** Best-effort index of a completed, paid standalone voice-over.
 * Failure here must never cause the caller to submit another paid TTS job. */
export async function registerLibraryAudio(input: {
  userId: string;
  requestId: string;
  audioPath: string;
  audioMime: "audio/mpeg" | "audio/wav";
  sizeBytes: number;
  durationSeconds: number;
}) {
  if (!input.audioPath.startsWith(`${input.userId}/narration/`) ||
      !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 ||
      !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) return;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return;
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const { error } = await client.from("library_assets").insert({
    user_id: input.userId,
    kind: "audio",
    provider: "supabase",
    storage_path: input.audioPath,
    title: `Lời đọc ${new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short" }).format(now)}`,
    mime_type: input.audioMime,
    size_bytes: input.sizeBytes,
    duration_seconds: input.durationSeconds,
    status: "ready",
    request_id: input.requestId,
    expires_at: expires.toISOString(),
  });
  if (error && error.code !== "23505") throw error;
}
