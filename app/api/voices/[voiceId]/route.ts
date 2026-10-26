import { apiError, json, providerKey, requestUser, voiceProvider } from "@/lib/studio-server";
import { deleteMemberVoice } from "@/lib/studio-voice-delete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: { params: Promise<{ voiceId: string }> }) {
  try {
    const userId = await requestUser(request, true);
    const { voiceId } = await params;
    if (voiceProvider() === "saydi") {
      const { key } = await providerKey(userId, "saydi");
      return json(await (await import("@/lib/studio-saydi-service")).deleteSaydiClone(key, userId, voiceId));
    }
    return json(await deleteMemberVoice(userId, voiceId));
  } catch (error) { return apiError(error); }
}
