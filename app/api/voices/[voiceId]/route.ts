import { apiError, json, requestUser } from "@/lib/studio-server";
import { deleteMemberVoice } from "@/lib/studio-voice-delete";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: { params: Promise<{ voiceId: string }> }) {
  try {
    const userId = await requestUser(request, true);
    const { voiceId } = await params;
    return json(await deleteMemberVoice(userId, voiceId));
  } catch (error) { return apiError(error); }
}
