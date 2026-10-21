import "server-only";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { StudioError } from "./studio-contract";

export const LIBRARY_VIDEO_DAYS = 7;
export const LIBRARY_VIDEO_QUOTA_BYTES = 1024 * 1024 * 1024;
export const LIBRARY_VIDEO_MAX_BYTES = 500 * 1024 * 1024;
export const LIBRARY_UPLOAD_URL_SECONDS = 300;

export type LibraryAsset = {
  id: string;
  user_id: string;
  kind: "video" | "audio";
  provider: "r2" | "supabase";
  storage_path: string;
  title: string;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  created_at: string;
  expires_at: string;
  status: "uploading" | "ready" | "deleted";
  request_id: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let s3: S3Client | undefined;
let database: SupabaseClient | undefined;

function r2Config() {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new StudioError("R2_NOT_CONFIGURED", "Kho lưu video chưa được kết nối. Quản trị viên cần hoàn tất cấu hình R2.", 503, "contact_admin");
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new StudioError("R2_NOT_CONFIGURED", "Cấu hình kho lưu video chưa hợp lệ. Quản trị viên cần kiểm tra Account ID và tên bucket.", 503, "contact_admin");
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function assertR2Configured(): void {
  r2Config();
}

function r2Client() {
  if (!s3) {
    const config = r2Config();
    s3 = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }
  return s3;
}

export function libraryDatabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new StudioError("LIBRARY_NOT_CONFIGURED", "Thư viện chưa được kết nối với cơ sở dữ liệu.", 503, "contact_admin");
  if (!database) database = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "X-Client-Info": "ibeetool-private-library" } },
  });
  return database;
}

export function validLibraryId(id: string): string {
  if (!UUID.test(id)) throw new StudioError("INVALID_LIBRARY_ITEM", "Tệp thư viện không hợp lệ.", 400);
  return id;
}

export function validLibraryRequestId(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new StudioError("INVALID_LIBRARY_REQUEST", "Mã yêu cầu lưu video không hợp lệ.", 400);
  }
  return value;
}

export function assertOwnedLibraryAsset(userId: string, asset: LibraryAsset): LibraryAsset {
  if (asset.user_id !== userId || !asset.storage_path.startsWith(`${userId}/`) || asset.storage_path.includes("..")) {
    throw new StudioError("LIBRARY_NOT_AUTHORIZED", "Bạn không có quyền truy cập tệp này.", 403);
  }
  if (asset.kind === "video" && (asset.provider !== "r2" || !asset.storage_path.startsWith(`${userId}/videos/`)))
    throw new StudioError("INVALID_LIBRARY_ITEM", "Thông tin video chưa hợp lệ.", 422);
  if (asset.kind === "audio" && (asset.provider !== "supabase" || !asset.storage_path.startsWith(`${userId}/narration/`)))
    throw new StudioError("INVALID_LIBRARY_ITEM", "Thông tin âm thanh chưa hợp lệ.", 422);
  return asset;
}

export async function ownedLibraryAsset(userId: string, id: string): Promise<LibraryAsset> {
  const { data, error } = await libraryDatabase().from("library_assets").select("*")
    .eq("id", validLibraryId(id)).eq("user_id", userId).maybeSingle();
  if (error) throw new StudioError("LIBRARY_UNAVAILABLE", "Chưa đọc được Thư viện. Vui lòng thử lại.", 503);
  if (!data) throw new StudioError("LIBRARY_ITEM_NOT_FOUND", "Tệp này không còn trong Thư viện.", 404);
  return assertOwnedLibraryAsset(userId, data as LibraryAsset);
}

export async function signedVideoUpload(path: string, sizeBytes: number): Promise<string> {
  const config = r2Config();
  return getSignedUrl(r2Client(), new PutObjectCommand({
    Bucket: config.bucket,
    Key: path,
    ContentType: "video/mp4",
    ContentLength: sizeBytes,
  }), {
    expiresIn: LIBRARY_UPLOAD_URL_SECONDS,
    // The browser sends Content-Length automatically for a Blob. Signing both
    // headers prevents a short-lived URL being used to upload a much larger file.
    signableHeaders: new Set(["content-length", "content-type"]),
  });
}

export async function checkVideoObject(path: string): Promise<{ sizeBytes: number; mimeType: string; mp4: boolean }> {
  const config = r2Config();
  const head = await r2Client().send(new HeadObjectCommand({ Bucket: config.bucket, Key: path }));
  const body = await r2Client().send(new GetObjectCommand({ Bucket: config.bucket, Key: path, Range: "bytes=0-31" }));
  const bytes = await body.Body?.transformToByteArray();
  return {
    sizeBytes: Number(head.ContentLength || 0),
    mimeType: head.ContentType?.split(";")[0]?.trim().toLowerCase() || "",
    mp4: Boolean(bytes && bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(4, 8)) === "ftyp"),
  };
}

export async function signedVideoDownload(path: string, downloadName?: string): Promise<string> {
  const config = r2Config();
  const safeName = downloadName?.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return getSignedUrl(r2Client(), new GetObjectCommand({
    Bucket: config.bucket,
    Key: path,
    ...(safeName ? { ResponseContentDisposition: `attachment; filename="${safeName}"` } : {}),
    ResponseContentType: "video/mp4",
  }), { expiresIn: downloadName ? 300 : 3600 });
}

export async function deleteVideoObject(path: string): Promise<void> {
  const config = r2Config();
  await r2Client().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: path }));
}
