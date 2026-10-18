import { apiError, json, providerKey, requestUser, requireAdmin } from "@/lib/studio-server";
import { createStudioSupabaseServer } from "@/lib/studio-supabase";
import { syncProviderVoices } from "@/lib/studio-voice-sync";
import { StudioError } from "@/lib/studio-contract";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Admin-only: never run provider sync on ordinary page loads.
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    await requireAdmin(userId);
    const { key } = await providerKey(userId,"maziao");
    const client = await createStudioSupabaseServer();
    return json(await syncProviderVoices(client,key));
  } catch (error) { return apiError(error); }
}
