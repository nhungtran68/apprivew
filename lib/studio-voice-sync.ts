import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchVoiceCatalogSnapshot } from "./studio-maziao";
import { StudioError } from "./studio-contract";

// Caller chooses an authenticated admin-scoped client or a server-only
// service-role client. No private access key is ever serialized to a response.
export async function syncProviderVoices(client: SupabaseClient, key: string) {
  const startedAt = new Date().toISOString();
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
  // Only a completely read account-owned snapshot reaches this point. Retire
  // old misclassified clones without deleting grants or approved catalog rows.
  // A later concurrent sync must never be retired by this older snapshot.
  const { error: retirementError } = await client.from("studio_voice_cache")
    .update({ status: "unavailable", updated_at: now }).eq("kind", "admin_clone")
    .eq("status", "active").lt("last_seen_at", startedAt);
  if (retirementError) throw new StudioError("VOICE_SYNC_STORAGE", "Chưa cập nhật được trạng thái thư viện giọng. Hãy đồng bộ lại.", 503);
  return { synced:rows.length, adminClones:rows.filter(v=>v.kind==="admin_clone").length, completedAt:now };
}
