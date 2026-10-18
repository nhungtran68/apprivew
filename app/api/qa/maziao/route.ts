import { apiError, json, providerKey, requestUser } from "@/lib/studio-server";
import { StudioError, bytesToBase64 } from "@/lib/studio-contract";

// TEMPORARY recovery of one exact QA job. Never submits or recreates speech.
export const runtime = "nodejs";
export const maxDuration = 180;
export const dynamic = "force-dynamic";
const QA_USER = "3181829e-9928-4c43-8cb3-2eb18ce59890";
const EXPECTED = "Xin chào, đây là lời đọc tiếng Việt thử nghiệm của ứng dụng Lời Kể. Chúc bạn có một ngày vui vẻ nhé!";
const SINCE = Date.parse("2026-10-17T14:27:00Z");
const UNTIL = Date.parse("2026-10-17T14:28:30Z");
const BASE = "https://app.maziao.com/api";
const STATUSES = ["pending", "processing", "saving", "exportingSrt", "completed", "failed"];
type Row = Record<string, unknown>;
const failure = () => new StudioError("QA_RECOVERY_FAILED", "Chưa đọc được tác vụ thử nghiệm chính xác. Không tạo lại lời đọc.", 502);
const record = (value: unknown): Row | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return; }
}
async function bounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok || Number(response.headers.get("content-length") || 0) > maximum) { await response.body?.cancel(); throw failure(); }
  const reader = response.body?.getReader();
  if (!reader) throw failure();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length;
      if (length > maximum) { await reader.cancel(); throw failure(); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function readApi(key: string, path: string, body?: { ids: string[] }): Promise<Row> {
  const response = await fetch(`${BASE}${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${key}`, ...body ? { "Content-Type": "application/json" } : {} }, body: body ? JSON.stringify(body) : undefined, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30000) });
  const result = record(JSON.parse(new TextDecoder().decode(await bounded(response, 1024 * 1024))));
  if (!result || (Array.isArray(result.errors) && result.errors.length)) throw failure();
  return result;
}
function matches(row: Row) {
  const parts = parsed(row.parts), created = row.createdAt ?? row.created_at;
  const time = typeof created === "string" || typeof created === "number" ? new Date(created).getTime() : NaN;
  return Number.isFinite(time) && time >= SINCE && time <= UNTIL && typeof row.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(row.id)
    && Array.isArray(parts) && (parts.length === 1 && record(parts[0])?.text === EXPECTED || parts.length === 0 && row.mode === "multiParts" && row.previewText === EXPECTED);
}
function audioUrl(row: Row): string | undefined {
  let value = row.resultUrls ?? row.result_urls ?? row.resultUrl ?? row.result_url;
  if (typeof value === "string" && value.trim().startsWith("[")) value = parsed(value);
  if (Array.isArray(value)) value = value.length === 1 ? value[0] : undefined;
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "r2-storage.maziao.com" && !url.port && !url.username && !url.password && !url.hash) return url.href;
  } catch { /* A provider URL must meet the fixed allowlist. */ }
}
function credits(row: Row): number | null {
  const metadata = record(parsed(row.metadata));
  const value = row.totalCost ?? row.total_cost ?? row.credits ?? metadata?.totalCost ?? metadata?.credits;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000000000 ? value : null;
}
const status = (row: Row) => typeof row.status === "string" && STATUSES.includes(row.status) ? row.status : "unknown";

export async function POST(request: Request) {
  try {
    // Both origin protection and the exact QA identity precede every provider read.
    const userId = await requestUser(request, true);
    if (userId !== QA_USER) throw new StudioError("QA_FORBIDDEN", "Tài khoản này không được dùng công cụ khôi phục thử nghiệm.", 403);
    const { key } = await providerKey(userId, "maziao");
    const observed: Row[] = []; let match: Row | undefined;
    for (const path of ["/tts/list?limit=10&offset=0&type=text", "/tts/list?limit=10&offset=0&mode=multiParts"]) {
      const result = await readApi(key, path), data = record(result.data);
      if (!Array.isArray(data?.items)) throw failure();
      const rows = data.items.map(record).filter((row): row is Row => Boolean(row)).slice(0, 10);
      observed.push(...rows);
      match = rows.filter(matches).sort((a, b) => new Date(String(b.createdAt ?? b.created_at)).getTime() - new Date(String(a.createdAt ?? a.created_at)).getTime())[0];
      if (match) break;
    }
    if (!match) {
      const knownPrefix = observed.filter(row => typeof row.previewText === "string" && row.previewText.startsWith(EXPECTED.slice(0, 40)));
      return json({ found: false, received: observed.length, statusCounts: Object.fromEntries([...STATUSES, "unknown"].map(name => [name, observed.filter(row => status(row) === name).length])), fieldNames: [...new Set(observed.flatMap(row => Object.keys(row)))].filter(name => /^[a-zA-Z_]{1,40}$/.test(name)).slice(0, 40), knownQaShape: knownPrefix.map(row => {
        const parts = parsed(row.parts), created = row.createdAt ?? row.created_at;
        return { mode: row.mode === "multiParts" ? "multiParts" : "other", createdType: typeof created, created: typeof created === "number" && Number.isFinite(created) || typeof created === "string" && /^[0-9T:. +Z-]{10,40}$/.test(created) ? created : undefined, partsType: typeof row.parts, parsedPartsType: Array.isArray(parts) ? "array" : typeof parts, parts: Array.isArray(parts) ? parts.slice(0, 5).map(value => { const part = record(value); return { fields: part ? Object.keys(part).filter(name => /^[a-zA-Z_]{1,40}$/.test(name)).slice(0, 20) : [], textType: typeof part?.text, textLength: typeof part?.text === "string" ? part.text.length : undefined, exactExpected: part?.text === EXPECTED }; }) : undefined };
      }) });
    }
    const id = match.id as string, cost = credits(match);
    let current = match, url = audioUrl(current);
    if (!url || status(current) !== "completed") {
      const result = await readApi(key, "/tts/status", { ids: [id] });
      const update = Array.isArray(result.data) ? result.data.map(record).find(row => row?.id === id) : undefined;
      if (!update) throw failure();
      current = update; url = audioUrl(current);
    }
    if (!url || status(current) !== "completed") return json({ found: true, id, status: status(current), credits: cost, audioAvailable: false });
    const response = await fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30000) });
    const mime = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].slice(0, 80);
    const bytes = await bounded(response, 2 * 1024 * 1024);
    return json({ found: true, id, status: status(current), credits: cost, mime, bytes: bytes.length, header64hex: Array.from(bytes.subarray(0, 64), byte => byte.toString(16).padStart(2, "0")).join(""), audioBase64: bytesToBase64(bytes) });
  } catch (error) { return apiError(error instanceof StudioError ? error : failure()); }
}
