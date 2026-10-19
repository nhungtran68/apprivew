import { getPaymentOrderForUser, parseOrderCode } from "@/lib/studio-payments";
import { apiError, json, requestUser } from "@/lib/studio-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ orderCode: string }> }) {
  try {
    const userId = await requestUser(request);
    const { orderCode } = await params;
    return json(await getPaymentOrderForUser(userId, parseOrderCode(orderCode)));
  } catch (error) { return apiError(error); }
}
