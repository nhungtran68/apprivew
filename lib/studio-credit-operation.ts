import "server-only";

import { StudioError } from "./studio-contract";
import { refundCredits, reserveCredits, settleCredits } from "./studio-credits";

export function creditRequestId(request: Request): string {
  const id = request.headers.get("Idempotency-Key")?.trim() || "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new StudioError("CREDIT_REQUEST_ID_REQUIRED", "Vui lòng tải lại trang rồi thử thao tác này.", 400);
  return id;
}

/** Each paid UI action is one immutable billing operation. A replay never
 * reaches a provider, even if its earlier result is no longer in the browser. */
export async function runWithCredits<T>(
  request: Request,
  userId: string,
  kind: string,
  credits: number,
  run: () => Promise<T>,
  metadata?: Record<string, unknown>,
): Promise<T> {
  const id = creditRequestId(request);
  const reserved = await reserveCredits(userId, id, kind, credits, metadata);
  if (!reserved.created)
    throw new StudioError("CREDIT_REQUEST_REUSED", "Yêu cầu này đã được xử lý hoặc đang chờ. Hãy kiểm tra kết quả trước khi tạo lại.", 409);
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await refundCredits(userId, id).catch(() => {});
    throw error;
  }
  // Once the provider succeeded, a ledger outage must retain the reservation
  // for reconciliation rather than issue a refund and permit free retries.
  await settleCredits(userId, id);
  return result;
}
