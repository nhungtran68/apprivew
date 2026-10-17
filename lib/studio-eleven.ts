import "server-only";
import { StudioError, cleanText, pcmToWav, type StudioSegment } from "./studio-contract";
import { authorizedVoiceRows, consumeAiUnits, modelNames, providerKey, providerResponse, saveAuthorizedVoice, saveSharedVoiceList } from "./studio-server";
import { shortenSegment } from "./studio-deepseek";
import { removeOwnedMedia, storeNarration } from "./studio-supabase";
import { assertLibraryEntitlement, libraryCatalog, type LibraryVoice } from "./studio-voice-catalog";
const BASE = "https://api.elevenlabs.io/v1";
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
  const form = new FormData(); form.set("name", name); form.set("description", "Giọng cá nhân do chủ tài khoản thành viên xác nhận quyền sử dụng.");
  for (const file of files) form.append("files", file, file.name || "voice-sample.webm");
  await consumeAiUnits(userId, 10);
  const response = await providerResponse(await fetch(`${BASE}/voices/add`, { method: "POST", headers: { "xi-api-key": key }, body: form, signal: AbortSignal.timeout(90000) }), "ElevenLabs", "voices_write");
  const result = await response.json() as { voice_id?: string; requires_verification?: boolean };
  if (!result.voice_id) throw new StudioError("CLONE_FAILED", "ElevenLabs chưa trả mã giọng. Kiểm tra trước khi thử lại.", 502);
  await saveAuthorizedVoice(userId, result.voice_id, name, result.requires_verification ? "needs_verification" : "personal");
  return { voiceId: result.voice_id, name, requiresVerification: Boolean(result.requires_verification) };
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
async function synthesize(key: string, userId: string, voiceId: string, segment: StudioSegment, previousText: string, nextText: string) {
  await consumeAiUnits(userId, Math.max(1, Math.ceil(segment.text.length / 100)));
  const response = await providerResponse(await fetch(`${BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_24000`, { method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/pcm" }, body: JSON.stringify({ text: segment.text, model_id: modelNames().voiceModel, language_code: "vi", previous_text: previousText || undefined, next_text: nextText || undefined, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }), signal: AbortSignal.timeout(90000) }), "ElevenLabs", "text_to_speech");
  const pcm = new Uint8Array(await response.arrayBuffer());
  if (pcm.length < 480 || pcm.length > 12000000 || pcm.length % 2) throw new StudioError("INVALID_AUDIO", "Âm thanh trả về không hợp lệ.", 502);
  return { pcm, duration: pcm.length / 48000 };
}
export async function generateSpeech(input: { key: string; userId: string; voiceId: string; segments: StudioSegment[]; duration: number }) {
  const results: (StudioSegment & { audioUrl: string; audioPath: string; audioMime: "audio/wav"; duration: number; revised: boolean })[] = [];
  const stored: string[] = [];
  try {
    for (let index = 0; index < input.segments.length; index++) {
      let segment = { ...input.segments[index] }, audio: Awaited<ReturnType<typeof synthesize>> | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        audio = await synthesize(input.key, input.userId, input.voiceId, segment, results.at(-1)?.text || "", input.segments[index + 1]?.text || "");
        if (audio.duration <= segment.end - segment.start) break;
        if (attempt === 2) throw new StudioError("TIMING_NEEDS_EDIT", `Lời đoạn ${index + 1} vẫn dài hơn cảnh. Rút gọn rồi tạo lại; app không cắt mất lời.`, 422, "script");
        const { key } = await providerKey(input.userId, "deepseek");
        segment = { ...segment, text: await shortenSegment(key, segment, audio.duration, () => consumeAiUnits(input.userId, 1)) };
      }
      if (!audio) throw new StudioError("EMPTY_AUDIO", "Chưa tạo được âm thanh.", 502);
      const media = await storeNarration(input.userId, pcmToWav(audio.pcm), index); stored.push(media.audioPath);
      results.push({ ...segment, ...media, audioMime: "audio/wav", duration: audio.duration, revised: segment.text !== input.segments[index].text });
    }
    return { segments: results, duration: input.duration, voiceId: input.voiceId, sampleRate: 24000, channels: 1 };
  } catch (error) { await removeOwnedMedia(input.userId, stored).catch(() => {}); throw error; }
}
