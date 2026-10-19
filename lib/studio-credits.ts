import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { StudioError } from "./studio-contract";
import { createStudioSupabaseServer } from "./studio-supabase";

/** Application credits are retail units, not Maziao provider credits or
 * DeepSeek tokens. One application credit is currently priced at 100 VND. */
export const creditRates = Object.freeze({
  script: 10,
  analyze: 15,
  scenePlan: 10,
  ttsPer100Chars: 1,
  clone: 50,
  stockPer2MiB: 1,
});

export type CreditKind = "script" | "analyze" | "scenePlan" | "tts" | "clone" | "stockVideo";
export type CreditBalance = { balance: number; reserved: number; available: number };
export type CreditReservation = CreditBalance & {
  created: boolean;
  status: "reserved" | "settled" | "refunded";
  chargedCredits: number;
  providerTaskId?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DB_KIND: Record<CreditKind, string> = {
  script: "script", analyze: "analyze", scenePlan: "scene_plan",
  tts: "tts", clone: "clone", stockVideo: "stock_video",
};
let privilegedClient: SupabaseClient | undefined;

function creditClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new StudioError("CREDIT_SYSTEM_NOT_CONFIGURED", "Hệ thống credit chưa được kết nối. Quản trị viên cần cấu hình khóa Supabase phía máy chủ.", 503, "contact_admin");
  if (!privilegedClient) privilegedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "X-Client-Info": "apprivew-credit-ledger" } },
  });
  return privilegedClient;
}

function validId(value: string): string {
  if (!UUID.test(value)) throw new StudioError("INVALID_CREDIT_REQUEST", "Mã yêu cầu credit không hợp lệ.", 400);
  return value;
}

function providerError(error: { message?: string } | null): never {
  const message = error?.message || "";
  if (message.includes("INSUFFICIENT_CREDITS"))
    throw new StudioError("INSUFFICIENT_CREDITS", "Số credit hiện có không đủ cho tác vụ này. Hãy nạp thêm để tiếp tục.", 402, "/ca-nhan");
  if (message.includes("MEMBER_DISABLED"))
    throw new StudioError("MEMBER_DISABLED", "Tài khoản chưa được cấp quyền sử dụng.", 403, "contact_admin");
  if (message.includes("ADMIN_REQUIRED"))
    throw new StudioError("ADMIN_REQUIRED", "Chỉ quản trị viên được cấp hoặc thu hồi credit.", 403);
  if (message.includes("CREDIT_REQUEST_CONFLICT") || message.includes("CREDIT_REQUEST_SETTLED") ||
      message.includes("CREDIT_REQUEST_REFUNDED") || message.includes("CREDIT_REQUEST_FINISHED"))
    throw new StudioError("CREDIT_REQUEST_CONFLICT", "Yêu cầu này đã được xử lý hoặc đang đối soát.", 409);
  if (message.includes("INVALID_CREDIT_") || message.includes("CREDIT_REQUEST_MISSING"))
    throw new StudioError("INVALID_CREDIT_REQUEST", "Yêu cầu credit không hợp lệ.", 400);
  throw new StudioError("CREDIT_LEDGER_UNAVAILABLE", "Chưa ghi được giao dịch credit. Quản trị viên cần kiểm tra kết nối Supabase và migration credit.", 503, "contact_admin");
}

function parseBalance(value: unknown): CreditBalance {
  if (!value || typeof value !== "object") throw new StudioError("CREDIT_LEDGER_UNAVAILABLE", "Không đọc được số dư credit.", 503);
  const row = value as Record<string, unknown>;
  const balance = Number(row.balance), reserved = Number(row.reserved);
  if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(reserved) || balance < 0 || reserved < 0 || reserved > balance)
    throw new StudioError("CREDIT_LEDGER_UNAVAILABLE", "Số dư credit không hợp lệ.", 503);
  return { balance, reserved, available: balance - reserved };
}

function parseOperation(value: unknown): CreditReservation {
  const amount = parseBalance(value);
  const row = value as Record<string, unknown>;
  if (typeof row.created !== "boolean" || !["reserved", "settled", "refunded"].includes(String(row.status)))
    throw new StudioError("CREDIT_LEDGER_UNAVAILABLE", "Trạng thái giao dịch credit không hợp lệ.", 503);
  const chargedCredits = Number(row.chargedCredits);
  if (!Number.isSafeInteger(chargedCredits) || chargedCredits < 0)
    throw new StudioError("CREDIT_LEDGER_UNAVAILABLE", "Mức trừ credit không hợp lệ.", 503);
  return { ...amount, created: row.created, status: row.status as CreditReservation["status"],
    chargedCredits, providerTaskId: typeof row.providerTaskId === "string" ? row.providerTaskId : null };
}

/** Visible balance, including credits reserved by in-flight tasks. */
export async function getCreditBalance(userId: string): Promise<CreditBalance> {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_credit_accounts")
    .select("balance,reserved").eq("user_id", userId).maybeSingle();
  if (error || !data) return providerError(error);
  return parseBalance(data);
}

/** Admin list helper; never call from a browser component. */
export async function getCreditBalances(userIds: string[]): Promise<Record<string, CreditBalance>> {
  if (!userIds.length) return {};
  const { data, error } = await creditClient().from("studio_credit_accounts")
    .select("user_id,balance,reserved").in("user_id", userIds.slice(0, 250));
  if (error) return providerError(error);
  return Object.fromEntries((data || []).map((row) => [row.user_id, parseBalance(row)]));
}

export function creditsForSpeech(textOrCharacters: string | number): number {
  const chars = typeof textOrCharacters === "number" ? textOrCharacters : textOrCharacters.trim().length;
  if (!Number.isSafeInteger(chars) || chars < 1 || chars > 100000)
    throw new StudioError("INVALID_CREDIT_REQUEST", "Độ dài lời thoại không hợp lệ.", 400);
  return Math.max(1, Math.ceil(chars / 100)) * creditRates.ttsPer100Chars;
}

export function creditsForStockBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 60 * 1024 * 1024)
    throw new StudioError("INVALID_CREDIT_REQUEST", "Dung lượng video thư viện không hợp lệ.", 400);
  return Math.ceil(bytes / (2 * 1024 * 1024)) * creditRates.stockPer2MiB;
}

/** Deterministic child UUID for a provider job within one user action. */
export async function deriveCreditRequestId(parentId: string, label: string): Promise<string> {
  validId(parentId);
  if (!/^[a-z0-9_-]{1,64}$/i.test(label)) throw new StudioError("INVALID_CREDIT_REQUEST", "Nhãn tác vụ credit không hợp lệ.", 400);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${parentId.toLowerCase()}:${label}`)));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // custom deterministic UUIDv8
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function reserveCredits(userId: string, requestId: string, kind: string,
  credits: number, metadata: Record<string, unknown> = {}): Promise<CreditReservation> {
  validId(requestId);
  if (!Object.hasOwn(DB_KIND, kind) || !Number.isSafeInteger(credits) || credits < 1 || credits > 10000)
    throw new StudioError("INVALID_CREDIT_REQUEST", "Loại tác vụ hoặc mức credit không hợp lệ.", 400);
  const { data, error } = await creditClient().rpc("studio_credit_reserve", {
    p_user_id: userId, p_request_id: requestId, p_kind: DB_KIND[kind as CreditKind],
    p_credits: credits, p_metadata: metadata,
  });
  if (error) return providerError(error);
  return parseOperation(data);
}

export async function settleCredits(userId: string, requestId: string,
  actualCredits?: number, providerUsage: Record<string, unknown> = {}): Promise<CreditReservation> {
  validId(requestId);
  if (actualCredits !== undefined && (!Number.isSafeInteger(actualCredits) || actualCredits < 1))
    throw new StudioError("INVALID_CREDIT_REQUEST", "Mức trừ credit không hợp lệ.", 400);
  const { data, error } = await creditClient().rpc("studio_credit_settle", {
    p_user_id: userId, p_request_id: requestId,
    p_charge_credits: actualCredits ?? null, p_provider_usage: providerUsage,
  });
  if (error) return providerError(error);
  return parseOperation(data);
}

export async function refundCredits(userId: string, requestId: string): Promise<CreditReservation> {
  validId(requestId);
  const { data, error } = await creditClient().rpc("studio_credit_refund", {
    p_user_id: userId, p_request_id: requestId,
  });
  if (error) return providerError(error);
  return parseOperation(data);
}

/** Save the provider task ID before long polling; an ambiguous result can then
 * be reconciled without resubmitting a potentially paid Maziao job. */
export async function markCreditProviderTask(userId: string, requestId: string,
  providerTaskId: string): Promise<void> {
  validId(requestId);
  if (!providerTaskId || providerTaskId.length > 200)
    throw new StudioError("INVALID_CREDIT_REQUEST", "Mã tác vụ nhà cung cấp không hợp lệ.", 400);
  const { error } = await creditClient().rpc("studio_credit_mark_provider_task", {
    p_user_id: userId, p_request_id: requestId, p_provider_task_id: providerTaskId,
  });
  if (error) return providerError(error);
}

export async function adjustCredits(adminId: string, userId: string, delta: number,
  reason: string, requestId: string): Promise<CreditBalance & { created: boolean }> {
  validId(requestId);
  if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000 ||
      reason.length < 3 || reason.length > 300)
    throw new StudioError("INVALID_CREDIT_REQUEST", "Số credit hoặc lý do điều chỉnh không hợp lệ.", 400);
  const { data, error } = await creditClient().rpc("studio_credit_adjust", {
    p_actor_id: adminId, p_user_id: userId, p_request_id: requestId,
    p_delta: delta, p_reason: reason,
  });
  if (error) return providerError(error);
  return { ...parseBalance(data), created: Boolean((data as Record<string, unknown>).created) };
}
