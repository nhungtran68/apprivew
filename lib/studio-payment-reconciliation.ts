import "server-only";

import { createClient } from "@supabase/supabase-js";
import { StudioError } from "./studio-contract";
import { markPaymentClosed, markPaymentPaid, parseOrderCode, payos } from "./studio-payments";

// Keep the run comfortably below the Function limit even when payOS times out.
// The next run starts with orders that have waited longest since the last check.
const PENDING_BATCH_SIZE = 18;
const CLOSED_BATCH_SIZE = 6;
const CONCURRENCY = 3;
const MINIMUM_AGE_MS = 2 * 60_000;
const CLOSED_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

type ReconcilableOrder = {
  request_id: string;
  order_code: number | string;
  price_vnd: number;
  provider_payment_link_id: string;
  status: "pending" | "cancelled" | "expired";
};

type ReconciliationResult = "credited" | "closed" | "pending" | "unchanged";

export type PaymentReconciliationSummary = {
  scanned: number;
  credited: number;
  closed: number;
  pending: number;
  unchanged: number;
  failed: number;
};

function paymentDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new StudioError("PAYMENT_DB_NOT_CONFIGURED", "Hệ thống thanh toán chưa kết nối Supabase.", 503);
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function verifyProviderIdentity(
  provider: Awaited<ReturnType<ReturnType<typeof payos>["paymentRequests"]["get"]>>,
  code: number,
  order: ReconcilableOrder,
): void {
  if (provider.orderCode !== code || provider.amount !== order.price_vnd ||
      provider.id !== order.provider_payment_link_id) {
    throw new StudioError("PAYMENT_MISMATCH", "Dữ liệu payOS không khớp với đơn cần đối soát.", 409);
  }
}

async function reconcileOne(
  db: ReturnType<typeof paymentDb>,
  gateway: ReturnType<typeof payos>,
  order: ReconcilableOrder,
): Promise<ReconciliationResult> {
  // This timestamp rotates unresolved orders through subsequent bounded runs.
  // It never changes the payment state or the customer's credit balance.
  const { error } = await db.from("studio_payment_orders")
    .update({ last_reconciled_at: new Date().toISOString() })
    .eq("request_id", order.request_id).neq("status", "paid");
  if (error) throw new StudioError("PAYMENT_DB_UNAVAILABLE", "Không ghi được thời điểm đối soát.", 503);

  const code = parseOrderCode(order.order_code);
  const provider = await gateway.paymentRequests.get(code);
  verifyProviderIdentity(provider, code, order);

  if (provider.status === "PAID") {
    if (provider.amountPaid !== order.price_vnd)
      throw new StudioError("PAYMENT_MISMATCH", "payOS chưa xác nhận đủ số tiền của đơn.", 409);
    const result = await markPaymentPaid(code, order.price_vnd, provider.id);
    return result.created ? "credited" : "unchanged";
  }
  if (provider.status === "CANCELLED" || provider.status === "EXPIRED") {
    if (provider.amountPaid !== 0)
      throw new StudioError("PAYMENT_PARTIAL", "Đơn đã đóng nhưng payOS ghi nhận tiền; cần kiểm tra thủ công.", 409);
    if (order.status !== "pending") return "unchanged";
    const result = await markPaymentClosed(code, provider.status === "CANCELLED" ? "cancelled" : "expired");
    // A concurrent signed webhook can credit this order before the close RPC.
    return result.credited ? "unchanged" : "closed";
  }
  // PENDING, UNDERPAID, PROCESSING and FAILED are not proof of full payment.
  return order.status === "pending" ? "pending" : "unchanged";
}

export async function reconcilePendingPayments(): Promise<PaymentReconciliationSummary> {
  const db = paymentDb();
  const gateway = payos();
  const cutoff = new Date(Date.now() - MINIMUM_AGE_MS).toISOString();
  const [pending, recentlyClosed] = await Promise.all([
    db.from("studio_payment_orders")
    .select("request_id,order_code,price_vnd,provider_payment_link_id,status")
    .eq("provider", "payos").eq("status", "pending")
    .not("provider_payment_link_id", "is", null)
    .lte("created_at", cutoff)
    .order("last_reconciled_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(PENDING_BATCH_SIZE),
    // A delayed bank transfer can turn a previously expired/cancelled link
    // into PAID. Only the provider's full-payment proof may upgrade it.
    db.from("studio_payment_orders")
    .select("request_id,order_code,price_vnd,provider_payment_link_id,status")
    .eq("provider", "payos").in("status", ["cancelled", "expired"])
    .not("provider_payment_link_id", "is", null)
    .gte("created_at", new Date(Date.now() - CLOSED_LOOKBACK_MS).toISOString())
    .lte("created_at", cutoff)
    .order("last_reconciled_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(CLOSED_BATCH_SIZE),
  ]);
  if (pending.error || recentlyClosed.error)
    throw new StudioError("PAYMENT_DB_UNAVAILABLE", "Không tải được đơn chờ đối soát.", 503);

  // The two reads can straddle a status transition; never query one order twice.
  const orders = [...new Map(([
    ...(pending.data ?? []), ...(recentlyClosed.data ?? []),
  ] as ReconcilableOrder[]).map((order) => [order.request_id, order])).values()];
  const summary: PaymentReconciliationSummary = {
    scanned: orders.length, credited: 0, closed: 0, pending: 0, unchanged: 0, failed: 0,
  };
  for (let start = 0; start < orders.length; start += CONCURRENCY) {
    const batch = orders.slice(start, start + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((order) => reconcileOne(db, gateway, order)));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") summary[result.value] += 1;
      else {
        summary.failed += 1;
        console.error("payOS scheduled reconciliation failed", {
          orderCode: batch[index].order_code,
          reason: result.reason instanceof Error ? result.reason.message : "Unknown error",
        });
      }
    });
  }
  return summary;
}
