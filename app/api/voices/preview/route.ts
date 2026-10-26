import { apiError, providerKey, requestUser, voiceProvider } from "@/lib/studio-server";
import { StudioError } from "@/lib/studio-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const userId = await requestUser(request);
    if (voiceProvider() !== "saydi") throw new StudioError("VOICE_PREVIEW_UNAVAILABLE", "Bản nghe thử này chưa sẵn sàng.", 404);
    const voiceId = new URL(request.url).searchParams.get("voiceId") || "";
    const { key } = await providerKey(userId, "saydi");
    const { audio, mime } = await (await import("@/lib/studio-saydi-service")).saydiPreview(key, userId, voiceId);
    return new Response(new Uint8Array(audio), { status: 200, headers: {
      "Content-Type": mime, "Content-Length": String(audio.length), "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return apiError(error); }
}
