import "server-only";
import { createStudioSupabaseServer } from "./studio-supabase";
import { StudioError } from "./studio-contract";
import { authorizedVoiceRows, getMember, sharedVoiceCatalog, type SharedVoiceCatalogRow } from "./studio-server";
import { publishableAdminVoiceIds } from "./studio-voice-guard";

export type CachedVoiceRow = {
  voice_id: string; name: string; kind: "system" | "admin_clone";
  preview_url: string | null; gender: string | null;
  status: "active" | "unavailable"; updated_at: string; last_seen_at: string;
};
export type DisplayVoice = {
  voiceId: string; name: string; category: "cloned" | "library";
  group: "personal" | "vietnamese"; language: "vi";
  previewUrl?: string; gender?: string; isPersonalClone?: boolean;
};
const safeId = (s: string) => /^maziao:(vieten_speech|lingual_speech_v2):[a-zA-Z0-9_-]{1,100}$/.test(s);
const safePreview = (url: string | null | undefined) => {
  if (!url || url.length > 4096) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "r2-storage.maziao.com" && !parsed.username && !parsed.password && !parsed.port && !parsed.hash ? parsed.href : undefined;
  } catch { return undefined; }
};
const present = (row: CachedVoiceRow, personal: boolean): DisplayVoice =>
  ({ voiceId: row.voice_id, name: row.name, category: personal ? "cloned" : "library",
     group: personal ? "personal" : "vietnamese", language: "vi",
     ...(safePreview(row.preview_url) ? { previewUrl: safePreview(row.preview_url) } : {}),
     ...(row.gender === "female" || row.gender === "male" ? { gender: row.gender } : {}) });

/** The normal page load never contacts the third-party provider. Every query uses
 * the viewer's Supabase JWT and RLS, not a service-role bypass. */
export async function cachedVoiceList(userId: string): Promise<{ voices: DisplayVoice[]; syncedAt: string | null }> {
  const [member, catalog, grants] = await Promise.all([
    getMember(userId), sharedVoiceCatalog(userId), authorizedVoiceRows(userId)
  ]);
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_voice_cache")
    .select("voice_id,name,kind,preview_url,gender,status,updated_at,last_seen_at")
    .order("name", { ascending: true }).limit(1000);
  if (error) throw new StudioError("VOICE_CACHE_UNAVAILABLE", "Chưa tải được thư viện giọng đã lưu.", 503);
  const known = ((data || []) as CachedVoiceRow[]).filter(row => safeId(row.voice_id));
  const active = known.filter(row => row.status === "active");
  const allowedClones = member.role === "admin" ? new Set(await publishableAdminVoiceIds(userId, active.filter(row => row.kind === "admin_clone").map(row => row.voice_id))) : null;
  const rows = active.filter(row => row.kind !== "admin_clone" || !allowedClones || allowedClones.has(row.voice_id));
  const approved = new Set(catalog.filter((item: SharedVoiceCatalogRow) => item.enabled).map(item => item.voice_id));
  const personal = new Map(grants.filter(g => g.source === "personal" && safeId(g.voice_id)).map(g => [g.voice_id, g]));
  const visible = new Map<string, DisplayVoice>();
  for (const row of rows) {
    if (personal.has(row.voice_id) && (member.role !== "admin" || row.kind === "admin_clone")) {
      const voice = present(row, true), privatePreview = safePreview(personal.get(row.voice_id)?.preview_url);
      if (privatePreview) voice.previewUrl = privatePreview;
      if (member.role === "member") voice.isPersonalClone = true;
      visible.set(row.voice_id, voice);
    }
    else if (member.role === "admin" || approved.has(row.voice_id)) visible.set(row.voice_id, present(row, row.kind === "admin_clone"));
  }
  // A member-created clone appears immediately, even before the next provider sync.
  for (const grant of personal.values()) {
    // Known retired entries must not reappear through historical grants.
    if (!visible.has(grant.voice_id) && !known.some(row => row.voice_id === grant.voice_id)) visible.set(grant.voice_id, {
      voiceId: grant.voice_id, name: grant.name, category: "cloned", group: "personal", language: "vi",
      ...(member.role === "member" ? { isPersonalClone: true } : {}),
      ...(safePreview(grant.preview_url) ? { previewUrl: safePreview(grant.preview_url) } : {})
    });
  }
  return { voices: [...visible.values()], syncedAt: rows.reduce<string | null>((max,row) =>
    !max || row.last_seen_at > max ? row.last_seen_at : max, null) };
}

export async function cachedAdminCandidates(userId: string) {
  await getMember(userId).then(m => {
    if (m.role !== "admin") throw new StudioError("ADMIN_REQUIRED", "Chỉ quản trị viên có thể đồng bộ giọng.", 403);
  });
  const client = await createStudioSupabaseServer();
  const { data, error } = await client.from("studio_voice_cache")
    .select("voice_id,name,kind,preview_url,gender,status,updated_at,last_seen_at")
    .eq("kind","admin_clone").eq("status","active").order("name",{ascending:true}).limit(1000);
  if (error) throw new StudioError("VOICE_CACHE_UNAVAILABLE", "Chưa tải được giọng của quản trị viên.", 503);
  const rows = ((data || []) as CachedVoiceRow[]).filter(row=>safeId(row.voice_id));
  const allowed = new Set(await publishableAdminVoiceIds(userId, rows.map(row => row.voice_id)));
  return rows.filter(row => allowed.has(row.voice_id)).map(row => ({
    voice_id: row.voice_id, name: row.name, kind: "admin_clone" as const,
    previewUrl: safePreview(row.preview_url), enabled: false
  }));
}
