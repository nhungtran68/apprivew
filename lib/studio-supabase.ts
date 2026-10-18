import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { StudioError } from "./studio-contract";

export const STUDIO_MEDIA_BUCKET = "studio-media";
export function supabaseConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY));
}
export async function createStudioSupabaseServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new StudioError("AUTH_NOT_CONFIGURED", "Quản trị viên cần kết nối Supabase trước khi đăng nhập và sử dụng app.", 503, "setup");
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (items) => {
        // Server Components are read-only; route handlers and the auth proxy persist refreshes.
        try { for (const { name, value, options } of items) store.set(name, value, options); } catch { /* refreshed in proxy */ }
      },
    },
  });
}
export const createServerSupabaseClient = createStudioSupabaseServer;

export function assertOwnedMediaPath(userId: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 400 || !value.startsWith(`${userId}/`) || value.includes("..") || !/^[a-zA-Z0-9_./-]+$/.test(value)) {
    throw new StudioError("MEDIA_NOT_AUTHORIZED", "Chỉ được dùng tệp trong thư mục riêng của tài khoản hiện tại.", 403);
  }
  return value;
}

export async function downloadOwnedMedia(userId: string, path: string, mime?: string): Promise<File> {
  assertOwnedMediaPath(userId, path);
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.storage.from(STUDIO_MEDIA_BUCKET).download(path);
  if (error || !data) throw new StudioError("MEDIA_UNAVAILABLE", "Không đọc được tệp riêng. Hãy tải lại tệp và thử lại.", 422);
  if (!data.size || data.size > 60 * 1024 * 1024) throw new StudioError("MEDIA_TOO_LARGE", "Tệp trống hoặc vượt giới hạn 60 MB.", 413);
  return new File([data], path.split("/").at(-1) || "media", { type: mime?.split(";")[0] || data.type });
}

export async function removeOwnedMedia(userId: string, paths: string[]) {
  const safe = [...new Set(paths.map((path) => assertOwnedMediaPath(userId, path)))];
  if (!safe.length) return;
  const client = await createStudioSupabaseServer();
  await client.storage.from(STUDIO_MEDIA_BUCKET).remove(safe);
}

export async function storeNarration(userId: string, audio: Uint8Array, index: number, mime: "audio/wav" | "audio/mpeg" = "audio/wav") {
  const client = await createStudioSupabaseServer();
  const extension = mime === "audio/mpeg" ? "mp3" : "wav";
  const path = `${userId}/narration/${crypto.randomUUID()}-${index}.${extension}`;
  const { error } = await client.storage.from(STUDIO_MEDIA_BUCKET).upload(path, audio, { contentType: mime, upsert: false, cacheControl: "0" });
  if (error) throw new StudioError("AUDIO_STORE_FAILED", "Chưa lưu được lời đọc. Hãy kiểm tra kho tệp của app.", 503);
  const signed = await client.storage.from(STUDIO_MEDIA_BUCKET).createSignedUrl(path, 300);
  if (signed.error || !signed.data?.signedUrl) {
    await client.storage.from(STUDIO_MEDIA_BUCKET).remove([path]);
    throw new StudioError("AUDIO_LINK_FAILED", "Chưa mở được tệp lời đọc riêng.", 503);
  }
  return { audioPath: path, audioUrl: signed.data.signedUrl };
}
