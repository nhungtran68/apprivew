import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchVoiceCatalogSnapshot } from "./studio-maziao";
import { StudioError } from "./studio-contract";

// Caller chooses an authenticated admin-scoped client or a server-only
// service-role client. No private access key is ever serialized to a response.
export async function syncProviderVoices(client: SupabaseClient, key: string) {
  const voices = await fetchVoiceCatalogSnapshot(key);
  const now = new Date().toISOString();
  const rows = voices.map(v => ({
    voice_id:v.voiceId, name:v.name, kind:v.kind,
    preview_url:v.previewUrl, gender:v.gender,
    status:"active", updated_at:now, last_seen_at:now
  }));
  for (let i=0;i<rows.length;i+=100) {
    const { error } = await client.from("studio_voice_cache")
      .upsert(rows.slice(i,i+100),{onConflict:"voice_id"});
    if (error) throw new StudioError("VOICE_SYNC_STORAGE","Chưa lưu được giọng từ API.",503);
  }
  // A partial provider result must never mark older voices deleted: the
  // provider may paginate inconsistently or omit voices by access scope.
  return { synced:rows.length, adminClones:rows.filter(v=>v.kind==="admin_clone").length, completedAt:now };
}
