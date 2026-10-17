import "server-only";
import { cleanText, StudioError } from "./studio-contract";
import { providerResponse } from "./studio-server";

export type LibraryVoice = { voiceId: string; ownerId: string; name: string; category: string; previewUrl?: string; language: string; accent: string; gender: string; description: string; useCase: string; users: number; freeAllowed: boolean; group: "vietnamese" | "popular" };
type RawVoice = Record<string, unknown>;
const BASE = "https://api.elevenlabs.io/v1";
const validId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{5,100}$/.test(value);
const safeUrl = (value: unknown) => typeof value === "string" && value.startsWith("https://") ? value : undefined;
const caches = new Map<string, { until: number; voices: LibraryVoice[] }>();

export function curateLibraryVoices(vi: RawVoice[], popular: RawVoice[]): LibraryVoice[] {
  const convert = (row: RawVoice, group: LibraryVoice["group"]): LibraryVoice | undefined => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return;
    if (!validId(row.voice_id) || !validId(row.public_owner_id)) return;
    const verified = Array.isArray(row.verified_languages) ? row.verified_languages.filter(item => item && typeof item === "object" && !Array.isArray(item)) as RawVoice[] : [];
    if (group === "vietnamese" && row.language !== "vi" && !verified.some(item => item.language === "vi")) return;
    const number = Number(row.cloned_by_count);
    const vietnamese = verified.find(item => item.language === "vi");
    return { voiceId: String(row.voice_id), ownerId: String(row.public_owner_id), name: cleanText(row.name, 200) || "Giọng đọc", category: "library", previewUrl: safeUrl(vietnamese?.preview_url) || safeUrl(row.preview_url), language: group === "vietnamese" ? "vi" : cleanText(row.language, 30), accent: cleanText(group === "vietnamese" ? vietnamese?.accent || row.accent : row.accent, 80), gender: cleanText(row.gender, 30), description: cleanText(row.description, 600), useCase: cleanText(row.use_case, 100), users: Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0, freeAllowed: row.free_users_allowed === true, group };
  };
  const reviewScore = (voice: LibraryVoice) => /social|narrat|convers|advert|tiktok|youtube|review/i.test(`${voice.useCase} ${voice.description}`) ? 1 : 0;
  const distinct = (voices: LibraryVoice[]) => { const seen = new Set<string>(); return voices.filter(voice => { if (seen.has(voice.voiceId)) return false; seen.add(voice.voiceId); return true; }); };
  const vietnamese = distinct(vi.map(row => convert(row, "vietnamese")).filter((voice): voice is LibraryVoice => Boolean(voice)).sort((a,b) => reviewScore(b) - reviewScore(a) || b.users - a.users)).slice(0,10);
  const seen = new Set(vietnamese.map(voice => voice.voiceId));
  const top = distinct(popular.map(row => convert(row, "popular")).filter((voice): voice is LibraryVoice => Boolean(voice) && !seen.has(voice!.voiceId)).sort((a,b) => b.users - a.users)).slice(0,5);
  return [...vietnamese,...top];
}

export async function libraryCatalog(key: string): Promise<LibraryVoice[]> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2,"0")).join("");
  const cached = caches.get(fingerprint);
  if (cached && cached.until > Date.now()) return cached.voices;
  const get = async (language?: string) => {
    const query = new URLSearchParams({ page_size: language ? "100" : "20", sort: "cloned_by_count", include_custom_rates: "false", include_live_moderated: "false", ...(language ? {language} : {}) });
    const response = await providerResponse(await fetch(`${BASE}/shared-voices?${query}`, { headers: {"xi-api-key":key}, signal:AbortSignal.timeout(20000), cache:"no-store" }),"ElevenLabs","voices_read");
    const data = await response.json() as { voices?: RawVoice[] };
    return Array.isArray(data.voices) ? data.voices.slice(0,100) : [];
  };
  const results = await Promise.all([get("vi"),get()]);
  const voices = curateLibraryVoices(results[0],results[1]);
  if (caches.size >= 4) caches.delete(caches.keys().next().value!);
  caches.set(fingerprint,{until:Date.now()+5*60*1000,voices});
  return voices;
}

export async function cloningEntitlement(key: string) {
  const response = await providerResponse(await fetch(`${BASE}/user/subscription`,{headers:{"xi-api-key":key},signal:AbortSignal.timeout(15000),cache:"no-store"}),"ElevenLabs");
  const data = await response.json() as {tier?:string;can_use_instant_voice_cloning?:boolean;voice_slots_used?:number;voice_limit?:number};
  return { tier:cleanText(data.tier,50), canClone:typeof data.can_use_instant_voice_cloning === "boolean" ? data.can_use_instant_voice_cloning : null, used:Number(data.voice_slots_used)||0, limit:Number(data.voice_limit)||0 };
}
export async function assertCloningEntitlement(key: string) {
  const plan = await cloningEntitlement(key);
  if (plan.canClone === null) throw new StudioError("CLONING_ENTITLEMENT_UNKNOWN","Chưa xác nhận được quyền nhân bản giọng từ ElevenLabs. Hãy thử lại hoặc nhờ quản trị viên kiểm tra kết nối.",502,"contact_admin");
  if (!plan.canClone) throw new StudioError("CLONING_PLAN_REQUIRED","Nhân bản giọng cần gói ElevenLabs Starter trở lên. Tài khoản ElevenLabs đang kết nối chưa có quyền này; quản trị viên cần kiểm tra gói thuê bao.",422,"contact_admin");
  if (plan.limit > 0 && plan.used >= plan.limit) throw new StudioError("VOICE_SLOTS_FULL","Tài khoản ElevenLabs đã dùng hết chỗ lưu giọng. Quản trị viên cần kiểm tra các giọng đã lưu hoặc gói thuê bao.",422,"contact_admin");
}
export async function assertLibraryEntitlement(key: string) {
  const plan = await cloningEntitlement(key);
  // free_users_allowed in a public voice describes web-library access. It is not
  // permission to synthesize Voice Library voices through the Free-tier API.
  if (!plan.tier) throw new StudioError("LIBRARY_ENTITLEMENT_UNKNOWN","Chưa xác nhận được quyền dùng thư viện giọng qua API ElevenLabs. Hãy thử lại hoặc nhờ quản trị viên kiểm tra kết nối.",502,"contact_admin");
  if (plan.tier === "free") throw new StudioError("LIBRARY_PLAN_REQUIRED","Giọng tiếng Việt và giọng cộng đồng trong thư viện cần tài khoản ElevenLabs trả phí để dùng qua app. Quản trị viên cần nâng gói ElevenLabs đang kết nối lên Starter trở lên; thành viên không cần mua riêng.",422,"contact_admin");
}
