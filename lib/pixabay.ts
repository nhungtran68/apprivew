import "server-only";

import { StudioError } from "./studio-contract";

const API_URL = "https://pixabay.com/api/videos/";
const CACHE_SECONDS = 24 * 60 * 60;
const PAGE_SIZE = 12;
const MAX_RESULTS = 64;
const MAX_RESPONSE_BYTES = 1_000_000;

type PixabayRendition = { url?: unknown; width?: unknown; height?: unknown; size?: unknown; thumbnail?: unknown };
type PixabayHit = {
  id?: unknown;
  pageURL?: unknown;
  tags?: unknown;
  duration?: unknown;
  user?: unknown;
  videos?: Record<string, PixabayRendition>;
};

export type StockVideo = {
  id: number;
  tags: string;
  duration: number;
  width: number;
  height: number;
  size: number;
  thumbnail: string;
  videoUrl: string;
  pageUrl: string;
  user: string;
};

type PixabayResult = { total: number; totalHits: number; hits: PixabayHit[] };
type CachedResult = { expiresAt: number; value: PixabayResult };
const resultCache = new Map<string, CachedResult>();
let cacheKey = "";

function apiKey(): string {
  const key = process.env.PIXABAY_API_KEY?.trim();
  if (!key) throw new StudioError("PIXABAY_NOT_CONFIGURED", "Quản trị viên cần thêm PIXABAY_API_KEY vào cấu hình Vercel để dùng kho video Pixabay.", 503, "contact_admin");
  return key;
}

function finiteNonnegative(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function allowedUrl(value: unknown, host: string): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === host && !url.username && !url.password && (!url.port || url.port === "443") ? url.toString() : "";
  } catch { return ""; }
}

function rendition(hit: PixabayHit, quality: "medium" | "small" | "tiny"): PixabayRendition | null {
  const item = hit.videos?.[quality];
  return item && allowedUrl(item.url, "cdn.pixabay.com") ? item : null;
}

function normalize(hit: PixabayHit | null): StockVideo | null {
  if (!hit || typeof hit !== "object") return null;
  const id = Number(hit.id);
  const video = rendition(hit, "medium") ?? rendition(hit, "small") ?? rendition(hit, "tiny");
  const pageUrl = allowedUrl(hit.pageURL, "pixabay.com");
  if (!Number.isSafeInteger(id) || id < 1 || !video || !pageUrl) return null;
  return {
    id,
    tags: typeof hit.tags === "string" ? hit.tags.slice(0, 240) : "",
    duration: finiteNonnegative(hit.duration),
    width: finiteNonnegative(video.width),
    height: finiteNonnegative(video.height),
    size: finiteNonnegative(video.size),
    thumbnail: allowedUrl(video.thumbnail, "cdn.pixabay.com"),
    videoUrl: allowedUrl(video.url, "cdn.pixabay.com"),
    pageUrl,
    user: typeof hit.user === "string" ? hit.user.slice(0, 100) : "",
  };
}

function validateQuery(query: string): string {
  const cleaned = query.trim().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
  if (cleaned.length < 2 || cleaned.length > 100) throw new StudioError("INVALID_PIXABAY_QUERY", "Nhập từ khóa tìm video từ 2 đến 100 ký tự.");
  return cleaned;
}

function validatePage(page: number): number {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10) throw new StudioError("INVALID_PIXABAY_PAGE", "Trang kết quả Pixabay không hợp lệ.");
  return page;
}

async function limitedResponseText(response: Response): Promise<string> {
  if (!response.body) throw new Error("empty body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let value = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("oversized body");
      value += decoder.decode(chunk.value, { stream: true });
    }
    return value + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

async function pixabayRequest(params: URLSearchParams): Promise<PixabayResult> {
  const key = apiKey();
  // Search responses must be cached for 24 hours under Pixabay's API terms.
  // The Next data cache survives serverless invocations; the bounded memory
  // cache avoids duplicate requests within one running instance.
  if (cacheKey !== key) { resultCache.clear(); cacheKey = key; }
  params.set("key", key);
  const cacheId = params.toString();
  const cached = resultCache.get(cacheId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const url = `${API_URL}?${params}`;
  let response: Response;
  try {
    response = await fetch(url, { cache: "force-cache", next: { revalidate: CACHE_SECONDS }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new StudioError("PIXABAY_UNAVAILABLE", "Chưa kết nối được Pixabay. Vui lòng thử lại sau.", 503);
  }
  if (response.status === 429) throw new StudioError("PIXABAY_RATE_LIMIT", "Pixabay đang giới hạn lượt tìm kiếm. Vui lòng thử lại sau.", 429);
  if (response.status === 401 || response.status === 403) throw new StudioError("PIXABAY_KEY_REJECTED", "Pixabay từ chối khóa API. Quản trị viên cần kiểm tra PIXABAY_API_KEY.", 503, "contact_admin");
  if (!response.ok) throw new StudioError("PIXABAY_UNAVAILABLE", "Pixabay chưa trả được kết quả. Vui lòng thử lại sau.", 502);
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > MAX_RESPONSE_BYTES) throw new StudioError("PIXABAY_INVALID_RESPONSE", "Dữ liệu Pixabay quá lớn. Vui lòng thử lại.", 502);
  let data: unknown;
  try {
    data = JSON.parse(await limitedResponseText(response));
  } catch {
    throw new StudioError("PIXABAY_INVALID_RESPONSE", "Pixabay trả về dữ liệu không hợp lệ. Vui lòng thử lại.", 502);
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as PixabayResult).hits)) throw new StudioError("PIXABAY_INVALID_RESPONSE", "Pixabay trả về dữ liệu không hợp lệ. Vui lòng thử lại.", 502);
  const result = data as PixabayResult;
  if (resultCache.size >= MAX_RESULTS) resultCache.delete(resultCache.keys().next().value!);
  resultCache.set(cacheId, { value: result, expiresAt: Date.now() + CACHE_SECONDS * 1000 });
  return result;
}

export async function searchPixabayVideos(query: string, page = 1, lang: "vi" | "en" = "vi") {
  const q = validateQuery(query);
  const currentPage = validatePage(page);
  const params = new URLSearchParams({ q, lang, video_type: "film", safesearch: "true", order: "popular", page: String(currentPage), per_page: String(PAGE_SIZE) });
  const result = await pixabayRequest(params);
  const videos = result.hits.slice(0, PAGE_SIZE).map(normalize).filter((video): video is StockVideo => Boolean(video));
  const totalHits = finiteNonnegative(result.totalHits);
  return {
    videos,
    total: finiteNonnegative(result.total),
    totalHits,
    page: currentPage,
    hasMore: currentPage < 10 && currentPage * PAGE_SIZE < totalHits,
    source: "Pixabay" as const,
  };
}

export async function getPixabayVideo(id: number, quality: "medium" | "small" | "tiny") {
  if (!Number.isSafeInteger(id) || id < 1 || id > 9_999_999_999) throw new StudioError("INVALID_PIXABAY_ID", "Video Pixabay không hợp lệ.");
  const params = new URLSearchParams({ id: String(id) });
  const result = await pixabayRequest(params);
  const hit = result.hits.find(item => item && typeof item === "object" && Number(item.id) === id);
  const selected = hit && rendition(hit, quality);
  if (!selected) throw new StudioError("PIXABAY_VIDEO_NOT_FOUND", "Video Pixabay đã chọn không còn khả dụng. Hãy chọn video khác.", 404);
  const url = allowedUrl(selected.url, "cdn.pixabay.com");
  if (!url) throw new StudioError("PIXABAY_VIDEO_NOT_FOUND", "Video Pixabay đã chọn không còn khả dụng. Hãy chọn video khác.", 404);
  return { url, size: finiteNonnegative(selected.size) };
}
