import { createClient } from "@supabase/supabase-js";
import { syncProviderVoices } from "@/lib/studio-voice-sync";
import { apiError, json } from "@/lib/studio-server";
import { StudioError } from "@/lib/studio-contract";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  try {
    const expected = process.env.CRON_SECRET;
    if (!expected || expected.length < 24) throw new StudioError("SYNC_NOT_CONFIGURED","Lịch đồng bộ chưa được cấu hình.",503);
    if (request.headers.get("authorization") !== "Bearer " + expected) throw new StudioError("FORBIDDEN","Không có quyền đồng bộ.",403);
    // Payment reconciliation shares CRON_SECRET. Keep voice synchronization
    // opt-in so activating payments cannot change the existing voice catalog.
    if (process.env.VOICE_SYNC_CRON_ENABLED !== "true") return json({ skipped: true });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const key = process.env.MAZIAO_API_KEY;
    if (!url || !serviceRole || !key) throw new StudioError("SYNC_NOT_CONFIGURED","Lịch đồng bộ chưa đủ cấu hình server.",503);
    const client = createClient(url,serviceRole,{auth:{autoRefreshToken:false,persistSession:false}});
    const result = await syncProviderVoices(client,key);
    return json(result);
  } catch(error) { return apiError(error); }
}
