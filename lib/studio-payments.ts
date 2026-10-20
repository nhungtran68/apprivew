import "server-only";

import { createHash } from "node:crypto";
import { PayOS } from "@payos/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { StudioError } from "./studio-contract";
import { createStudioSupabaseServer } from "./studio-supabase";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LINK_ID = /^[a-zA-Z0-9_-]{16,200}$/;
const PAYOS_CHECKOUT_ORIGIN = "https://pay.payos.vn";
const PAYOS_WEBHOOK_ORIGIN = "https://apprivew.vercel.app";
const PAYOS_RETURN_ORIGIN = "https://ibeetool.com";
const PAYOS_CHECKOUT_LIFETIME_SECONDS = 15 * 60;
export const PAYOS_PRODUCTION_WEBHOOK = `${PAYOS_WEBHOOK_ORIGIN}/api/payments/payos/webhook`;

export type PaymentPack = {
  id: string;
  name: string;
  credits: number;
  priceVnd: number;
  description: string;
};
export type PaymentOrder = {
  created?: boolean;
  orderId: string;
  userId: string;
  orderCode: string;
  packId: string;
  credits: number;
  priceVnd: number;
  status: "pending" | "paid" | "cancelled" | "expired";
  checkoutUrl: string | null;
  paymentLinkId: string | null;
  credited: boolean;
  updatedAt?: string;
};

let privilegedClient: SupabaseClient | undefined;
let payosClient: PayOS | undefined;

function paymentCredentialsReady(): boolean {
  return Boolean(process.env.PAYOS_CLIENT_ID && process.env.PAYOS_API_KEY && process.env.PAYOS_CHECKSUM_KEY);
}

function paymentCredentialFingerprint(): string {
  return createHash("sha256").update(JSON.stringify([
    process.env.PAYOS_CLIENT_ID, process.env.PAYOS_API_KEY, process.env.PAYOS_CHECKSUM_KEY,
  ])).digest("hex");
}

export async function paymentReady(): Promise<boolean> {
  if (!paymentCredentialsReady()) return false;
  try {
    const { data, error } = await paymentDb().from("studio_payment_gateway")
      .select("webhook_url,webhook_confirmed_at,credential_fingerprint").eq("provider", "payos").maybeSingle();
    return !error && data?.webhook_url === PAYOS_PRODUCTION_WEBHOOK && Boolean(data.webhook_confirmed_at) &&
      data.credential_fingerprint === paymentCredentialFingerprint();
  } catch { return false; }
}

export async function recordWebhookConfirmation(webhookUrl: string): Promise<void> {
  if (webhookUrl !== PAYOS_PRODUCTION_WEBHOOK) throw new StudioError("PAYMENT_WEBHOOK_MISMATCH", "Đường dẫn webhook chưa hợp lệ.", 502);
  const { data, error } = await paymentDb().from("studio_payment_gateway")
    .update({ webhook_url: webhookUrl, credential_fingerprint: paymentCredentialFingerprint(), webhook_confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("provider", "payos").select("provider").maybeSingle();
  if (error) return databaseError(error);
  if (!data) throw new StudioError("PAYMENT_DB_UNAVAILABLE", "Chưa lưu được trạng thái webhook payOS.", 503);
}

function paymentDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new StudioError("PAYMENT_DB_NOT_CONFIGURED", "Hệ thống thanh toán chưa kết nối Supabase.", 503, "contact_admin");
  if (!privilegedClient) privilegedClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { "X-Client-Info": "apprivew-payos-payments" } },
  });
  return privilegedClient;
}

export function payos(): PayOS {
  if (!paymentCredentialsReady()) throw new StudioError("PAYMENT_NOT_CONFIGURED", "Thanh toán payOS đang được kích hoạt. Vui lòng quay lại sau.", 503, "contact_admin");
  if (!payosClient) payosClient = new PayOS({
    clientId: process.env.PAYOS_CLIENT_ID!,
    apiKey: process.env.PAYOS_API_KEY!,
    checksumKey: process.env.PAYOS_CHECKSUM_KEY!,
    baseURL: "https://api-merchant.payos.vn",
    maxRetries: 0,
    timeout: 15_000,
  });
  return payosClient;
}

function databaseError(error: { message?: string } | null): never {
  const message = error?.message || "";
  if (message.includes("PAYMENT_PACK_MISMATCH")) throw new StudioError("PAYMENT_PACK_CHANGED", "Gói credit vừa thay đổi. Hãy tải lại trang trước khi thanh toán.", 409);
  if (message.includes("PAYMENT_ORDER_CODE_CONFLICT") || message.includes("PAYMENT_ORDER_CONFLICT")) throw new StudioError("PAYMENT_ORDER_CONFLICT", "Đơn thanh toán bị trùng. Hãy thử lại bằng yêu cầu mới.", 409);
  if (message.includes("PAYMENT_AMOUNT_MISMATCH") || message.includes("PAYMENT_LINK_CONFLICT") || message.includes("PAYMENT_REFERENCE_CONFLICT")) throw new StudioError("PAYMENT_MISMATCH", "Giao dịch cần được đối soát. Vui lòng giữ mã đơn và liên hệ quản trị viên.", 409);
  if (message.includes("PAYMENT_ORDER_MISSING")) throw new StudioError("PAYMENT_ORDER_NOT_FOUND", "Không tìm thấy đơn thanh toán.", 404);
  if (message.includes("MEMBER_DISABLED")) throw new StudioError("MEMBER_DISABLED", "Tài khoản hiện chưa được phép sử dụng.", 403);
  if (message.includes("PAYMENT_RATE_LIMIT")) throw new StudioError("PAYMENT_RATE_LIMIT", "Bạn đã tạo nhiều đơn trong một giờ. Hãy thử lại sau.", 429);
  throw new StudioError("PAYMENT_DB_UNAVAILABLE", "Chưa ghi được đơn thanh toán. Vui lòng thử lại sau.", 503);
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new StudioError("INVALID_PAYMENT_DATA", "Dữ liệu thanh toán không hợp lệ.", 502);
  return number;
}

export function parseOrderCode(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") throw new StudioError("INVALID_ORDER_CODE", "Mã đơn thanh toán không hợp lệ.", 400);
  const text = String(value);
  if (!/^[1-9]\d{0,15}$/.test(text)) throw new StudioError("INVALID_ORDER_CODE", "Mã đơn thanh toán không hợp lệ.", 400);
  return safeInteger(text, 1, Number.MAX_SAFE_INTEGER);
}

export function paymentOrderCode(requestId: string): number {
  if (!UUID.test(requestId)) throw new StudioError("INVALID_PAYMENT_REQUEST", "Mã yêu cầu thanh toán không hợp lệ.", 400);
  // Stable across browser retries, well below the JavaScript safe-integer limit.
  return 100_000_000_000_000 + createHash("sha256").update(requestId.toLowerCase()).digest().readUIntBE(0, 6);
}

function parsePack(row: Record<string, unknown>): PaymentPack {
  const id = String(row.id || ""), name = String(row.name || "");
  if (!/^pack_[a-z0-9_]{1,40}$/.test(id) || !name) throw new StudioError("PAYMENT_DB_UNAVAILABLE", "Danh sách gói credit chưa hợp lệ.", 503);
  const credits = safeInteger(row.credits, 1, 1_000_000);
  const priceVnd = safeInteger(row.price_vnd, 1_000, 2_000_000_000);
  return { id, name, credits, priceVnd, description: "Dùng cho các công cụ AI; credit được cộng ngay sau khi thanh toán được xác nhận." };
}

export async function listPaymentPacks(): Promise<PaymentPack[]> {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_payment_packs")
    .select("id,name,credits,price_vnd").eq("enabled", true)
    .order("sort_order", { ascending: true }).limit(20);
  if (error) return databaseError(error);
  return (data || []).map((row) => parsePack(row));
}

export async function getPaymentPack(packId: string): Promise<PaymentPack> {
  if (!/^pack_[a-z0-9_]{1,40}$/.test(packId)) throw new StudioError("INVALID_PAYMENT_PACK", "Chọn một gói credit hợp lệ.", 400);
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_payment_packs")
    .select("id,name,credits,price_vnd").eq("id", packId).eq("enabled", true).maybeSingle();
  if (error) return databaseError(error);
  if (!data) throw new StudioError("PAYMENT_PACK_NOT_FOUND", "Gói credit này hiện không còn mở bán.", 404);
  return parsePack(data);
}

function parseOrder(row: Record<string, unknown>): PaymentOrder {
  const status = String(row.status);
  if (!["pending", "paid", "cancelled", "expired"].includes(status)) throw new StudioError("PAYMENT_DB_UNAVAILABLE", "Trạng thái thanh toán không hợp lệ.", 503);
  const code = parseOrderCode(row.orderCode ?? row.order_code);
  const priceVnd = safeInteger(row.priceVnd ?? row.price_vnd, 1_000, 2_000_000_000);
  const credits = safeInteger(row.credits, 1, 1_000_000);
  return {
    created: typeof row.created === "boolean" ? row.created : undefined,
    orderId: String(row.orderId ?? row.request_id ?? ""),
    userId: String(row.userId ?? row.user_id ?? ""),
    orderCode: String(code),
    packId: String(row.packId ?? row.pack_id ?? ""),
    credits, priceVnd,
    status: status as PaymentOrder["status"],
    checkoutUrl: typeof (row.checkoutUrl ?? row.checkout_url) === "string" ? String(row.checkoutUrl ?? row.checkout_url) : null,
    paymentLinkId: typeof (row.paymentLinkId ?? row.provider_payment_link_id) === "string" ? String(row.paymentLinkId ?? row.provider_payment_link_id) : null,
    credited: status === "paid",
    updatedAt: typeof (row.updatedAt ?? row.updated_at) === "string" ? String(row.updatedAt ?? row.updated_at) : undefined,
  };
}

export async function getPaymentOrderForUser(userId: string, code: number): Promise<PaymentOrder> {
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_payment_orders")
    .select("request_id,user_id,order_code,pack_id,credits,price_vnd,status,checkout_url,provider_payment_link_id")
    .eq("order_code", code).eq("user_id", userId).maybeSingle();
  if (error) return databaseError(error);
  if (!data) throw new StudioError("PAYMENT_ORDER_NOT_FOUND", "Không tìm thấy đơn thanh toán của bạn.", 404);
  return parseOrder(data);
}

export async function getPaymentOrderForWebhook(code: number): Promise<PaymentOrder | null> {
  const { data, error } = await paymentDb().from("studio_payment_orders")
    .select("request_id,user_id,order_code,pack_id,credits,price_vnd,status,checkout_url,provider_payment_link_id")
    .eq("order_code", code).maybeSingle();
  if (error) return databaseError(error);
  return data ? parseOrder(data) : null;
}

async function getPaymentOrderByRequest(userId: string, requestId: string): Promise<PaymentOrder | null> {
  const { data, error } = await paymentDb().from("studio_payment_orders")
    .select("request_id,user_id,order_code,pack_id,credits,price_vnd,status,checkout_url,provider_payment_link_id,updated_at")
    .eq("request_id", requestId).maybeSingle();
  if (error) return databaseError(error);
  if (!data) return null;
  const order = parseOrder(data);
  if (order.userId !== userId) throw new StudioError("PAYMENT_ORDER_CONFLICT", "Mã yêu cầu đã được dùng cho tài khoản khác.", 409);
  return order;
}

function validCheckoutUrl(checkoutUrl: string, linkId: string): string {
  if (!LINK_ID.test(linkId)) throw new StudioError("PAYMENT_PROVIDER_INVALID", "payOS trả về liên kết thanh toán không hợp lệ.", 502);
  let url: URL;
  try { url = new URL(checkoutUrl); } catch { throw new StudioError("PAYMENT_PROVIDER_INVALID", "payOS trả về liên kết thanh toán không hợp lệ.", 502); }
  if (url.origin !== PAYOS_CHECKOUT_ORIGIN || url.pathname !== `/web/${linkId}` || url.username || url.password || url.search || url.hash)
    throw new StudioError("PAYMENT_PROVIDER_INVALID", "payOS trả về liên kết thanh toán không hợp lệ.", 502);
  return url.href;
}

function providerUnavailable(): never {
  throw new StudioError("PAYMENT_PROVIDER_UNAVAILABLE", "Chưa kết nối được payOS. Đơn vẫn được giữ; hãy bấm lại để kiểm tra hoặc liên hệ quản trị viên.", 503);
}

async function setPaymentLink(requestId: string, checkoutUrl: string, paymentLinkId: string): Promise<PaymentOrder> {
  const { data, error } = await paymentDb().rpc("studio_payment_set_link", {
    p_request_id: requestId, p_checkout_url: checkoutUrl, p_payment_link_id: paymentLinkId,
  });
  if (error) return databaseError(error);
  return parseOrder(data as Record<string, unknown>);
}

export async function markPaymentPaid(code: number, amountVnd: number, paymentLinkId: string): Promise<PaymentOrder> {
  if (!LINK_ID.test(paymentLinkId)) throw new StudioError("INVALID_PAYMENT_DATA", "Mã thanh toán payOS không hợp lệ.", 400);
  const { data, error } = await paymentDb().rpc("studio_payment_mark_paid", {
    p_order_code: code, p_amount_vnd: amountVnd, p_reference: paymentLinkId,
  });
  if (error) return databaseError(error);
  return parseOrder(data as Record<string, unknown>);
}

export async function markPaymentClosed(code: number, status: "cancelled" | "expired"): Promise<PaymentOrder> {
  const { data, error } = await paymentDb().rpc("studio_payment_mark_closed", { p_order_code: code, p_status: status });
  if (error) return databaseError(error);
  return parseOrder(data as Record<string, unknown>);
}

async function resolveExistingCheckout(order: PaymentOrder, gateway: PayOS): Promise<PaymentOrder> {
  const code = parseOrderCode(order.orderCode);
  let provider: Awaited<ReturnType<typeof gateway.paymentRequests.get>>;
  try { provider = await gateway.paymentRequests.get(code); } catch { return providerUnavailable(); }
  if (provider.orderCode !== code || provider.amount !== order.priceVnd ||
      !order.paymentLinkId || provider.id !== order.paymentLinkId)
    throw new StudioError("PAYMENT_MISMATCH", "Thông tin thanh toán cần được đối soát. Vui lòng giữ mã đơn và liên hệ quản trị viên.", 409);
  if (!Number.isSafeInteger(provider.amountPaid) || provider.amountPaid < 0 || provider.amountPaid > order.priceVnd)
    throw new StudioError("PAYMENT_MISMATCH", "Số tiền payOS báo về chưa khớp đơn. Vui lòng giữ mã đơn và liên hệ quản trị viên.", 409);

  if (provider.status === "PAID") {
    if (provider.amountPaid !== order.priceVnd) throw new StudioError("PAYMENT_MISMATCH", "Số tiền payOS xác nhận chưa khớp đơn. Vui lòng liên hệ quản trị viên.", 409);
    return markPaymentPaid(code, order.priceVnd, provider.id);
  }
  if ((provider.status === "CANCELLED" || provider.status === "EXPIRED" || provider.status === "FAILED") && provider.amountPaid > 0)
    throw new StudioError("PAYMENT_UNDERPAID", `Đơn ${order.orderCode} có khoản chuyển tiền chưa đủ. Vui lòng giữ mã đơn và liên hệ quản trị viên để đối soát.`, 409);
  if (provider.status === "CANCELLED" || provider.status === "EXPIRED" || provider.status === "FAILED")
    return markPaymentClosed(code, provider.status === "EXPIRED" ? "expired" : "cancelled");

  const recordedAt = order.updatedAt ? Date.parse(order.updatedAt) : NaN;
  // The link is stored after payOS creates it, so at this age its 15-minute
  // checkout period has definitely ended. Close it at payOS before allowing a
  // different request ID to create another payable order.
  if (!Number.isFinite(recordedAt) || Date.now() - recordedAt >= PAYOS_CHECKOUT_LIFETIME_SECONDS * 1000) {
    if (provider.status === "PENDING" && provider.amountPaid === 0) {
      let cancelled: typeof provider;
      try { cancelled = await gateway.paymentRequests.cancel(provider.id); } catch { return providerUnavailable(); }
      if (cancelled.orderCode !== code || cancelled.amount !== order.priceVnd || cancelled.id !== provider.id)
        throw new StudioError("PAYMENT_MISMATCH", "Thông tin thanh toán cần được đối soát. Vui lòng giữ mã đơn và liên hệ quản trị viên.", 409);
      if (cancelled.status === "CANCELLED" || cancelled.status === "EXPIRED")
        return markPaymentClosed(code, cancelled.status === "EXPIRED" ? "expired" : "cancelled");
      if (cancelled.status === "PAID" && cancelled.amountPaid === order.priceVnd)
        return markPaymentPaid(code, order.priceVnd, cancelled.id);
    }
    throw new StudioError("PAYMENT_IN_PROGRESS", `Đơn ${order.orderCode} đang được payOS xử lý. Hãy kiểm tra trạng thái đơn trước khi tạo đơn mới.`, 409);
  }
  if (provider.status !== "PENDING" && provider.status !== "UNDERPAID" && provider.status !== "PROCESSING")
    throw new StudioError("PAYMENT_MISMATCH", "Trạng thái thanh toán chưa xác định. Vui lòng giữ mã đơn và liên hệ quản trị viên.", 409);
  return order;
}

export async function createPaymentOrder(userId: string, packId: string, requestId: string): Promise<PaymentOrder> {
  if (!(await paymentReady())) throw new StudioError("PAYMENT_NOT_READY", "Thanh toán payOS chưa hoàn tất kích hoạt. Vui lòng quay lại sau.", 503, "contact_admin");
  const gateway = payos(); // Fail before inserting an order if credentials are absent.
  if (!UUID.test(requestId)) throw new StudioError("INVALID_PAYMENT_REQUEST", "Mã yêu cầu thanh toán không hợp lệ.", 400);
  const previous = await getPaymentOrderByRequest(userId, requestId);
  if (previous && previous.packId !== packId) throw new StudioError("PAYMENT_ORDER_CONFLICT", "Mã yêu cầu đã được dùng cho gói khác.", 409);
  if (previous && previous.status !== "pending") return previous;
  if (previous?.checkoutUrl) return resolveExistingCheckout(previous, gateway);
  const pack = previous ? { id: previous.packId, credits: previous.credits, priceVnd: previous.priceVnd } : await getPaymentPack(packId);
  const code = paymentOrderCode(requestId);
  const { data, error } = await paymentDb().rpc("studio_payment_create", {
    p_user_id: userId, p_request_id: requestId, p_order_code: code,
    p_pack_id: pack.id, p_credits: pack.credits, p_price_vnd: pack.priceVnd,
  });
  if (error) return databaseError(error);
  const order = parseOrder(data as Record<string, unknown>);
  if (order.checkoutUrl || order.status !== "pending") return order;

  const returnUrl = `${PAYOS_RETURN_ORIGIN}/nap-credit?orderCode=${code}`;
  const cancelUrl = `${PAYOS_RETURN_ORIGIN}/nap-credit?orderCode=${code}&cancelled=1`;
  const description = `CR${String(code).slice(-7)}`; // <= 9 ASCII characters for bank compatibility.
  const payload = {
    orderCode: code, amount: order.priceVnd, description,
    items: [{ name: order.credits + " credit Apprivew", quantity: 1, price: order.priceVnd }],
    returnUrl, cancelUrl,
    expiredAt: Math.floor(Date.now() / 1000) + PAYOS_CHECKOUT_LIFETIME_SECONDS,
  };

  let link: { orderCode: number; amount: number; paymentLinkId: string; checkoutUrl: string; currency?: string };
  try {
    link = await gateway.paymentRequests.create(payload);
  } catch {
    // A timeout or duplicate order response is ambiguous. Query the same
    // provider order code instead of creating a different payment request.
    try {
      const existing = await gateway.paymentRequests.get(code);
      if (existing.orderCode !== code || existing.amount !== order.priceVnd || !LINK_ID.test(existing.id)) providerUnavailable();
      link = { orderCode: code, amount: existing.amount, paymentLinkId: existing.id,
        checkoutUrl: `${PAYOS_CHECKOUT_ORIGIN}/web/${existing.id}` };
    } catch { return providerUnavailable(); }
  }
  if (link.orderCode !== code || link.amount !== order.priceVnd || (link.currency && link.currency !== "VND"))
    throw new StudioError("PAYMENT_PROVIDER_INVALID", "Thông tin đơn payOS không khớp. Vui lòng liên hệ quản trị viên.", 502);
  return setPaymentLink(requestId, validCheckoutUrl(link.checkoutUrl, link.paymentLinkId), link.paymentLinkId);
}

export async function reconcilePaymentOrder(userId: string, code: number): Promise<PaymentOrder> {
  const order = await getPaymentOrderForUser(userId, code);
  if (order.credited) return order;
  const { data: shouldCheck, error } = await paymentDb().rpc("studio_payment_begin_reconcile", {
    p_order_code: code, p_user_id: userId,
  });
  if (error) return databaseError(error);
  if (shouldCheck !== true) return getPaymentOrderForUser(userId, code);
  const gateway = payos();
  let provider: Awaited<ReturnType<typeof gateway.paymentRequests.get>>;
  try { provider = await gateway.paymentRequests.get(code); } catch { return providerUnavailable(); }
  if (provider.orderCode !== code || provider.amount !== order.priceVnd ||
      (order.paymentLinkId && provider.id !== order.paymentLinkId))
    throw new StudioError("PAYMENT_MISMATCH", "Thông tin thanh toán cần được đối soát. Vui lòng giữ mã đơn và liên hệ quản trị viên.", 409);
  if (!Number.isSafeInteger(provider.amountPaid) || provider.amountPaid < 0 || provider.amountPaid > order.priceVnd)
    throw new StudioError("PAYMENT_MISMATCH", "Số tiền payOS báo về chưa khớp đơn. Vui lòng giữ mã đơn và liên hệ quản trị viên.", 409);
  if (provider.status === "PAID") {
    if (provider.amountPaid !== order.priceVnd || !LINK_ID.test(provider.id))
      throw new StudioError("PAYMENT_MISMATCH", "Số tiền payOS xác nhận chưa khớp đơn. Vui lòng liên hệ quản trị viên.", 409);
    return markPaymentPaid(code, order.priceVnd, provider.id);
  }
  if ((provider.status === "CANCELLED" || provider.status === "EXPIRED") && provider.amountPaid > 0)
    throw new StudioError("PAYMENT_UNDERPAID", `Đơn ${order.orderCode} có khoản chuyển tiền chưa đủ. Vui lòng giữ mã đơn và liên hệ quản trị viên để đối soát.`, 409);
  if (provider.status === "CANCELLED" || provider.status === "EXPIRED")
    return markPaymentClosed(code, provider.status === "CANCELLED" ? "cancelled" : "expired");
  return getPaymentOrderForUser(userId, code);
}
