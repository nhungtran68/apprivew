import { listPaymentPacks, paymentReady } from "@/lib/studio-payments";
import { apiError, json, requestUser } from "@/lib/studio-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requestUser(request);
    const [packs, ready] = await Promise.all([listPaymentPacks(), paymentReady()]);
    return json({ packs, paymentReady: ready });
  } catch (error) { return apiError(error); }
}
