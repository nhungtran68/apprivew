import { apiError, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";
import { listPendingMaziaoVoiceOvers, recoverMaziaoVoiceOver } from "@/lib/studio-maziao";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const userId = await requestUser(request);
    return json({ tasks: await listPendingMaziaoVoiceOvers(userId) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    const body = await limitedJson(request, 1000);
    const { key } = await providerKey(userId, "maziao");
    return json(await recoverMaziaoVoiceOver({ key, userId, requestId: body.requestId }));
  } catch (error) { return apiError(error); }
}
