import "server-only";
import { StudioError, cleanText, type StudioSegment } from "./studio-contract";
import { authorizedVoiceRows, providerKey, providerResponse, saveAuthorizedVoice, saveSharedVoiceList } from "./studio-server";
import { assertLibraryEntitlement, libraryCatalog, type LibraryVoice } from "./studio-voice-catalog";
const BASE = "https://api.elevenlabs.io/v1";
const paidElevenUnavailable = () => new StudioError("VOICE_PRICING_UNAVAILABLE", "Tạm thời chưa mở tính phí giọng ElevenLabs. Quản trị viên cần cấu hình bảng giá trước khi bật dịch vụ này.", 503, "contact_admin");
export type StudioVoice = { voiceId: string; name: string; category: string; previewUrl?: string; group?: "vietnamese" | "popular" | "personal" | "default"; language?: string; accent?: string; gender?: string; description?: string; users?: number; freeAllowed?: boolean };
type ProviderVoice = { voice_id?: string; name?: string; category?: string; preview_url?: string; sharing?: { original_voice_id?: string; public_owner_id?: string; status?: string } };
const sharedVoiceIds = () => new Set((process.env.STUDIO_SHARED_VOICE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
export async function listVoices(key: string, userId: string): Promise<StudioVoice[]> {
  const owned = await authorizedVoiceRows(userId), ownedIds = new Set(owned.filter((row) => row.source !== "shared").map((row) => row.voice_id)), shared = sharedVoiceIds();
  const response = await providerResponse(await fetch(`${BASE}/voices`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(30000) }), "ElevenLabs", "voices_read");
  const result = await response.json() as { voices?: ProviderVoice[] };
  let catalog: LibraryVoice[] = [];
  try { catalog = await libraryCatalog(key); } catch { /* Default and personal voices remain available if the public library is temporarily unavailable. */ }
  // A signed historical public grant is not proof that a voice is still public.
  // Library originals come from the current catalog; do not expose stale grants
  // or duplicate account aliases (including their names and preview URLs).
  const allowed = (result.voices || []).slice(0, 500).filter((voice) => voice.voice_id && (voice.category === "premade" || shared.has(voice.voice_id) || ownedIds.has(voice.voice_id)));
  const catalogIds = new Set(catalog.map(voice => voice.voiceId));
  const account: StudioVoice[] = allowed.filter(voice => !catalogIds.has(voice.voice_id!)).map((voice) => ({ voiceId: voice.voice_id!, name: cleanText(voice.name, 200) || "Giọng đọc", category: ownedIds.has(voice.voice_id!) ? "cloned" : cleanText(voice.category, 100), group: ownedIds.has(voice.voice_id!) ? "personal" : "default", previewUrl: voice.preview_url?.startsWith("https://") ? voice.preview_url : undefined }));
  const voices: StudioVoice[] = [...catalog.map(({ownerId:_owner,useCase:_use,...voice}) => voice),...account];
  await saveSharedVoiceList(userId, voices.filter((voice) => !ownedIds.has(voice.voiceId)));
  return voices;
}
export async function cloneVoice(key: string, userId: string, name: string, files: File[]) {
  // Paid ElevenLabs calls must not fall through to the old, non-credit quota.
  throw paidElevenUnavailable();
}
export async function authorizeVoice(userId: string, voiceId: string) {
  if (!/^[a-zA-Z0-9_-]{5,100}$/.test(voiceId)) throw new StudioError("INVALID_VOICE", "Chọn một giọng trong danh sách của bạn.");
  const voice = (await authorizedVoiceRows(userId)).find((row) => row.voice_id === voiceId);
  if (!voice) throw new StudioError("VOICE_NOT_AUTHORIZED", "Tải lại danh sách và chọn giọng bạn được cấp quyền.", 403);
  if (voice.source === "shared" && !sharedVoiceIds().has(voiceId)) {
    const { key } = await providerKey(userId, "eleven");
    // Only the curated, provider-verified public library may be imported. The member
    // supplies an id, never a provider URL, owner id or arbitrary access grant.
    const catalog = await libraryCatalog(key).catch(() => [] as LibraryVoice[]);
    const library = catalog.find(item => item.voiceId === voiceId);
    if (library) {
      await assertLibraryEntitlement(key);
      const response = await providerResponse(await fetch(`${BASE}/voices`,{headers:{"xi-api-key":key},signal:AbortSignal.timeout(30000)}),"ElevenLabs","voices_read");
      const account = await response.json() as {voices?:ProviderVoice[]};
      const existing = (account.voices || []).find(item => item.voice_id === voiceId || (item.sharing?.original_voice_id === voiceId && item.sharing.public_owner_id === library.ownerId));
      if (existing?.voice_id) return existing.voice_id;
      const imported = await providerResponse(await fetch(`${BASE}/voices/add/${encodeURIComponent(library.ownerId)}/${encodeURIComponent(voiceId)}`,{method:"POST",headers:{"xi-api-key":key,"Content-Type":"application/json"},body:JSON.stringify({new_name:library.name,bookmarked:false}),signal:AbortSignal.timeout(30000)}),"ElevenLabs","voices_write");
      const added = await imported.json() as {voice_id?:string};
      if (!added.voice_id || !/^[a-zA-Z0-9_-]{5,100}$/.test(added.voice_id)) throw new StudioError("VOICE_IMPORT_FAILED","Chưa thêm được giọng thư viện. Hãy chọn giọng khác hoặc thử lại.",502);
      await saveAuthorizedVoice(userId,added.voice_id,library.name,"shared");
      return added.voice_id;
    }
    const response = await providerResponse(await fetch(`${BASE}/voices/${encodeURIComponent(voiceId)}`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(30000) }), "ElevenLabs", "voices_read");
    const current = await response.json() as ProviderVoice;
    const publicOriginal = catalog.find(item => item.voiceId === current.sharing?.original_voice_id && item.ownerId === current.sharing.public_owner_id);
    if (current.category !== "premade" && !publicOriginal) throw new StudioError("VOICE_NOT_AUTHORIZED", "Giọng này không còn được chia sẻ cho tài khoản. Hãy tải lại danh sách để chọn giọng khác.", 403);
    if (publicOriginal && current.category !== "premade") await assertLibraryEntitlement(key);
  }
  // The provider remains the authority for voice verification before generation.
  return voiceId;
}
/** A continuous voice-over keeps the approved script intact; video timing is set afterwards. */
export async function generateElevenVoiceOver(input: { key: string; userId: string; voiceId: string; text: string }) {
  throw paidElevenUnavailable();
}

export async function generateSpeech(input: { key: string; userId: string; voiceId: string; segments: StudioSegment[]; duration: number }) {
  throw paidElevenUnavailable();
}
