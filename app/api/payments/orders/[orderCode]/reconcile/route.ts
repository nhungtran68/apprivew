import { parseOrderCode, reconcilePaymentOrder } from "@/lib/studio-payments";
import { apiError, json, requestUser } from "@/lib/studio-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ orderCode: string }> }) {
  try {
    const userId = await requestUser(request, true);
    const { orderCode } = await params;
    return json(await reconcilePaymentOrder(userId, parseOrderCode(orderCode)));
  } catch (error) { return apiError(error); }
}
