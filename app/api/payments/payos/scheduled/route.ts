import { timingSafeEqual } from "node:crypto";
import { StudioError } from "@/lib/studio-contract";
import { reconcilePendingPayments } from "@/lib/studio-payment-reconciliation";
import { apiError, json } from "@/lib/studio-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: Request, secret: string): boolean {
  const supplied = request.headers.get("authorization") || "";
  const expected = `Bearer ${secret}`;
  const receivedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}

export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || secret.length < 24)
      throw new StudioError("PAYMENT_CRON_NOT_CONFIGURED", "Lịch đối soát chưa được cấu hình.", 503);
    if (!authorized(request, secret))
      throw new StudioError("FORBIDDEN", "Không có quyền đối soát thanh toán.", 403);
    const summary = await reconcilePendingPayments();
    // Vercel does not retry failed cron invocations. The next daily run will
    // recheck failures; surface this run as unhealthy for operator alerting.
    return json(summary, summary.failed ? 503 : 200);
  } catch (error) {
    console.error("payOS scheduled reconciliation unavailable", error instanceof Error ? error.message : "Unknown error");
    return apiError(error);
  }
}
