import { apiError, json, providerKey, requestUser, requireAdmin } from "@/lib/studio-server";
import { createStudioSupabaseServer } from "@/lib/studio-supabase";
import { fetchVoiceCatalogSnapshot } from "@/lib/studio-maziao";
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
    const voices = await fetchVoiceCatalogSnapshot(key);
    const client = await createStudioSupabaseServer();
    const now = new Date().toISOString();
    const rows = voices.map(v => ({
      voice_id: v.voiceId, name: v.name, kind: v.kind,
      preview_url: v.previewUrl, gender: v.gender, status: "active",
      updated_at: now, last_seen_at: now
    }));
    // Each page is upserted by primary key. Never delete cached rows on an
    // incomplete API response, and never replace member-specific grants.
    for (let start=0; start<rows.length; start+=100) {
      const { error } = await client.from("studio_voice_cache")
        .upsert(rows.slice(start,start+100),{ onConflict:"voice_id" });
      if (error) throw new StudioError("VOICE_SYNC_STORAGE", "Chưa lưu được dữ liệu đồng bộ.",503);
    }
    return json({ synced: rows.length, adminClones: rows.filter(row=>row.kind==="admin_clone").length, completedAt:now });
  } catch (error) { return apiError(error); }
}
