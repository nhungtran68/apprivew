import { StudioError } from "@/lib/studio-contract";
import { createPaymentOrder } from "@/lib/studio-payments";
import { apiError, json, limitedJson, requestUser } from "@/lib/studio-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    const body = await limitedJson(request, 2_000);
    if (typeof body.packId !== "string" || typeof body.requestId !== "string")
      throw new StudioError("INVALID_PAYMENT_REQUEST", "Chọn gói credit rồi thử lại.", 400);
    const order = await createPaymentOrder(userId, body.packId, body.requestId);
    return json(order, order.created ? 201 : 200);
  } catch (error) { return apiError(error); }
}
