import { StudioError } from "@/lib/studio-contract";
import { getPaymentOrderForWebhook, markPaymentPaid, parseOrderCode, payos } from "@/lib/studio-payments";
import { apiError, json, limitedJson } from "@/lib/studio-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    // payOS calls this endpoint directly, so browser cookies and Origin are not
    // credentials. The provider's signed payload is verified before any lookup.
    const body = await limitedJson(request, 12_000);
    let event: Awaited<ReturnType<ReturnType<typeof payos>["webhooks"]["verify"]>>;
    try {
      event = await payos().webhooks.verify(body as Parameters<ReturnType<typeof payos>["webhooks"]["verify"]>[0]);
    } catch {
      throw new StudioError("INVALID_PAYMENT_SIGNATURE", "Chữ ký payOS không hợp lệ.", 400);
    }
    if (body.success !== true || body.code !== "00" || event.code !== "00") return json({ ok: true });
    const code = parseOrderCode(event.orderCode);
    const order = await getPaymentOrderForWebhook(code);
    // payOS sends a signed sample while confirming the webhook URL. There is
    // no matching local order, so acknowledge it without granting anything.
    if (!order) return json({ ok: true });
    if (event.currency !== "VND" || !Number.isSafeInteger(event.amount) ||
        event.amount !== order.priceVnd || !event.reference ||
        !event.paymentLinkId || (order.paymentLinkId && event.paymentLinkId !== order.paymentLinkId))
      throw new StudioError("PAYMENT_MISMATCH", "Thanh toán cần được đối soát.", 409);
    await markPaymentPaid(code, event.amount, event.paymentLinkId);
    return json({ ok: true });
  } catch (error) { return apiError(error); }
}
