"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { videoDownloadName, supportsVideoSave, saveVideoFile, canShareVideoFile, shareVideoFile } from "@/lib/video-download";

type Step = 0 | 1 | 2 | 3 | 4;
type View = "studio" | "projects" | "voices" | "profile" | "guide";
type Profile = { name: string; channel: string; brand: string; audience: string; topic: string; tone: string; pronoun: string; cta: string; facts: string; customPrompt: string };
type VideoFormat = "review" | "story" | "tips" | "sales";
type Angle = { id: string; title: string; format: VideoFormat; purpose: string; hook: string; reason: string };
type Segment = { start: number; end: number; text: string; audioBase64?: string; audioMime?: string; mimeType?: string; duration?: number };
type Project = {
  id: string; userId: string; title: string; createdAt: number; updatedAt: number;
  source?: Blob; sourceName?: string; duration: number; width: number; height: number;
  intent: string; profile: Profile; analysis?: Record<string, unknown>; summary: string;
  format: VideoFormat; angleId: string;
  segments: Segment[]; narration?: Blob; narrationName?: string; narrationDuration?: number; voiceId: string;
  mode: "scenery" | "talking" | "face"; keepAmbient: boolean; step: Step;
};
type Voice = { voice_id?: string; id?: string; name: string; category?: string; preview_url?: string; labels?: Record<string, string>; group?: string; language?: string; accent?: string; gender?: string; description?: string; users?: number; freeAllowed?: boolean };
type Configuration = { userId: string; deepseek: boolean; eleven: boolean; authenticated?: boolean; displayName?: string; authReady?: boolean; isAdmin?: boolean; quota?: { used: number; limit: number } };
type Notice = { text: string; type: "success" | "error" | "info" };
type BrowserRecognition = { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: { results: { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } } }) => void) | null; onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null; start: () => void; stop: () => void; abort: () => void };

const EMPTY_PROFILE: Profile = { name: "", channel: "", brand: "", audience: "", topic: "", tone: "Gần gũi, tự nhiên", pronoun: "", cta: "", facts: "", customPrompt: "" };
const FORMATS: { id: VideoFormat; name: string; note: string }[] = [{id:"review",name:"Review, trải nghiệm",note:"Nhận xét có ích cho người xem"},{id:"story",name:"Kể chuyện",note:"Một câu chuyện, một thông điệp"},{id:"tips",name:"Chia sẻ mẹo",note:"Giải thích một điều hữu ích"},{id:"sales",name:"Giới thiệu sản phẩm",note:"Nêu giá trị, mời tìm hiểu"}];
const VOICE_GROUPS = [{id:"vietnamese",name:"Tiếng Việt · hợp review"},{id:"popular",name:"Được nhiều người thêm"},{id:"personal",name:"Giọng cá nhân"},{id:"default",name:"Giọng có sẵn"}];
const STEPS = ["Quay video", "Ý muốn chia sẻ", "Kịch bản", "Giọng đọc", "Xuất video"];
const NAV_ITEMS: {view:View;label:string;short:string;icon:string}[] = [{view:"studio",label:"Tạo video",short:"Tạo video",icon:"camera"},{view:"projects",label:"Video của tôi",short:"Video của tôi",icon:"grid"},{view:"voices",label:"Giọng của tôi",short:"Giọng đọc",icon:"mic"},{view:"profile",label:"Hiểu về tôi",short:"Hiểu về tôi",icon:"settings"}];
const DB_NAME = "loike-studio-v1";
const ICONS: Record<string, string> = {
  camera: "M14.5 4h-5L8 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-4l-1.5-3ZM16 14a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  studio: "m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z",
  grid: "M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z",
  mic: "M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3Zm-7-4v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm7.5 4a7.5 7.5 0 0 0-.1-1.1l1.6-1.3-1.5-2.6-1.9.7A7.7 7.7 0 0 0 15.7 6l-.3-2h-3l-.4 2a7.7 7.7 0 0 0-1.9 1.1l-1.9-.7-1.5 2.6 1.6 1.3a7.5 7.5 0 0 0 0 2.2l-1.6 1.3 1.5 2.6 1.9-.7a7.7 7.7 0 0 0 1.9 1.1l.4 2h3l.3-2a7.7 7.7 0 0 0 1.9-1.1l1.9.7 1.5-2.6-1.6-1.3a7.5 7.5 0 0 0 .1-1.1Z",
  upload: "M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  chevron: "m9 5 7 7-7 7",
  check: "m5 12 4 4L19 6",
  download: "M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M6 18 18 6",
  refresh: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2",
  help: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3m.1 4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  play: "m8 4 13 8-13 8V4Z",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  clock: "M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  lock: "M6 10V7a6 6 0 0 1 12 0v3M4 10h16v12H4V10Zm8 5v3",
  sound: "m11 5-6 4H2v6h3l6 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
  file: "M14 2H4v20h16V8l-6-6Zm0 0v6h6M8 13h8m-8 4h5",
  info: "M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  eye: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
};

function Icon({ name, size = 20, className = "" }: { name: string; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d={ICONS[name] || ICONS.studio} /></svg>;
}
function uid() { return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function freshProject(userId: string, profile = EMPTY_PROFILE): Project {
  return { id: uid(), userId, title: "Câu chuyện chưa đặt tên", createdAt: Date.now(), updatedAt: Date.now(), duration: 0, width: 0, height: 0, intent: "", profile: { ...profile }, summary: "", format:"review",angleId:"",segments: [], voiceId: "", mode: "scenery", keepAmbient: false, step: 0 };
}
function time(seconds: number) { const value = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`; }
function fileSize(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`; }
function errorText(error: unknown) { return error instanceof Error ? error.message : "Có lỗi xảy ra. Vui lòng thử lại."; }
function useBlobUrl(blob?: Blob) {
  const [url, setUrl] = useState("");
  useEffect(() => { if (!blob) { setUrl(""); return; } const next = URL.createObjectURL(blob); setUrl(next); return () => URL.revokeObjectURL(next); }, [blob]);
  return url;
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => { const request = indexedDB.open(DB_NAME, 2); request.onupgradeneeded = () => { const store = request.result.objectStoreNames.contains("projects") ? request.transaction!.objectStore("projects") : request.result.createObjectStore("projects", { keyPath: "id" }); if (!store.indexNames.contains("userId")) store.createIndex("userId", "userId"); }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Hãy đóng tab Lời Kể cũ để cập nhật bộ nhớ dự án.")); });
}
async function readProjects(userId: string): Promise<Project[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => { const request = db.transaction("projects").objectStore("projects").index("userId").getAll(IDBKeyRange.only(userId)); request.onsuccess = () => { db.close(); resolve((request.result as Project[]).sort((a, b) => b.updatedAt - a.updatedAt)); }; request.onerror = () => { db.close(); reject(request.error); }; });
}
async function persistProject(project: Project) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => { const tx = db.transaction("projects", "readwrite"); tx.objectStore("projects").put(project); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); }; });
}
async function removeProject(id: string, userId: string) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => { const tx = db.transaction("projects", "readwrite"), store = tx.objectStore("projects"), request = store.get(id); request.onsuccess = () => { if (request.result && request.result.userId !== userId) { tx.abort(); return; } store.delete(id); }; tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error("Không thể xóa dự án của không gian khác.")); }; });
}
async function requestJson(path: string, init?: RequestInit): Promise<Record<string, any>> {
  const response = await fetch(path, init);
  const result = await response.json().catch(() => ({})) as Record<string, any>;
  if (response.status === 401) throw new Error("Đăng nhập vào tài khoản của bạn để tiếp tục (401).");
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : result.error?.message || result.message || `Yêu cầu chưa hoàn thành (${response.status}).`);
  return result;
}
function configurationFrom(data: Record<string, any>, fallbackId: string): Configuration {
  return { userId: data.userId || data.user?.id || fallbackId, deepseek: Boolean(data.deepseekConfigured ?? data.configured?.deepseek ?? data.providers?.deepseek?.configured), eleven: Boolean(data.elevenLabsConfigured ?? data.elevenConfigured ?? data.configured?.elevenLabs ?? data.configured?.elevenlabs ?? data.providers?.elevenlabs?.configured), authenticated: Boolean(data.authenticated || data.userId || data.user?.id), displayName: data.memberName || data.user?.displayName || data.displayName, authReady: data.authReady, isAdmin: Boolean(data.isAdmin), quota: data.quota && Number.isFinite(data.quota.used) && Number.isFinite(data.quota.limit) ? { used: data.quota.used, limit: data.quota.limit } : undefined };
}
function normalizeSegments(value: unknown, duration: number): Segment[] {
  const data = value as Record<string, any>;
  const segments: Record<string, any>[] | undefined = Array.isArray(value) ? value : data?.segments;
  if (Array.isArray(segments)) return segments.map((segment, index) => ({ ...segment, start: Number(segment.start ?? index * duration / segments.length), end: Number(segment.end ?? (index + 1) * duration / segments.length), text: String(segment.text ?? segment.narration ?? ""), mimeType: segment.mimeType || segment.audioMime || "audio/mpeg" }));
  const script = typeof value === "string" ? value : data?.script || data?.text || "";
  return script ? [{ start: 0, end: duration, text: String(script) }] : [];
}
function summaryFrom(data: Record<string, any>) { return String(data.intentSummary || data.suggestedIntent || ""); }
function downloadBlob(blob: Blob, filename: string) { const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 5000); }
function blobBase64(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(blob); }); }
function fromBase64(base64: string, type: string) { const binary = atob(base64); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); return new Blob([bytes], { type }); }
function safeProfile(value: unknown): Profile {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (name: keyof Profile) => typeof data[name] === "string" && (name !== "tone" || (data[name] as string).trim()) ? (data[name] as string).slice(0, name === "facts" || name === "customPrompt" ? 4000 : 800) : EMPTY_PROFILE[name];
  return Object.fromEntries(Object.keys(EMPTY_PROFILE).map(key => [key,text(key as keyof Profile)])) as Profile;
}
function applySavedProfile(current: Profile, previous: Profile, saved: Profile): Profile {
  return safeProfile(Object.fromEntries(Object.keys(EMPTY_PROFILE).map(key => [key, !Object.hasOwn(current,key) || current[key as keyof Profile] === previous[key as keyof Profile] ? saved[key as keyof Profile] : current[key as keyof Profile]])));
}
function scriptKey(project: Project) { return JSON.stringify({ id: project.id, duration: project.duration, segments: project.segments.map(({ start, end, text }) => ({ start, end, text })) }); }
function intentKey(project: Project) { return JSON.stringify({ id: project.id, intent: project.intent, profile: project.profile, mode: project.mode, format:project.format,angleId:project.angleId,sourceName: project.sourceName, sourceSize: project.source?.size, duration: project.duration }); }
function affectsExport(changes: Partial<Project>) { return ["id","source","duration","segments","narration","voiceId","keepAmbient"].some(key => Object.hasOwn(changes,key)); }
function applyProjectChanges(current: Project, changes: Partial<Project>): Project {
  const next = { ...changes };
  if ("narration" in next && !next.narration) { next.narrationName = undefined; next.narrationDuration = undefined; }
  if (next.voiceId !== undefined && next.voiceId !== current.voiceId) next.segments = (next.segments || current.segments).map(({ audioBase64: _audio, audioMime: _audioMime, mimeType: _mime, duration: _duration, ...segment }) => segment);
  return { ...current, ...next, updatedAt: Date.now() };
}
function applySegmentChange(segment: Segment, changes: Partial<Segment>): Segment {
  const next = { ...segment, ...changes };
  if (changes.text !== undefined && changes.text !== segment.text) { delete next.audioBase64; delete next.audioMime; delete next.mimeType; delete next.duration; }
  return next;
}
function safeAnalysis(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  const text = (value: unknown, maximum = 5000) => typeof value === "string" ? value.slice(0, maximum) : "";
  const list = (value: unknown, maximum: number) => Array.isArray(value) ? value.filter(item => typeof item === "string").slice(0, maximum).map(item => text(item, 1000)) : [];
  const observations = Array.isArray(data.observations) ? data.observations.filter(item => item && typeof item === "object" && Number.isFinite(Number(item.start)) && Number.isFinite(Number(item.end)) && typeof item.description === "string").slice(0, 32).map(item => ({ start: Math.max(0, Math.min(90, Number(item.start))), end: Math.max(0, Math.min(90, Number(item.end))), description: text(item.description, 1500) })) : [];
  const suggestedAngles = Array.isArray(data.suggestedAngles) ? data.suggestedAngles.filter(item=>item && typeof item === "object" && FORMATS.some(format=>format.id===item.format)).slice(0,3).map(item=>({id:text(item.id,80),title:text(item.title,180),format:item.format,purpose:text(item.purpose,600),hook:text(item.hook,600),reason:text(item.reason,600)})) : [];
  return { summary: text(data.summary), intentSummary: text(data.intentSummary), observations, facts: list(data.facts, 30), unknowns: list(data.unknowns, 30), questions: list(data.questions, 8), suggestedAngles, recommendedAngleId:text(data.recommendedAngleId,80) };
}
function restoreArchive(data: unknown, userId: string): Project {
  if (!data || typeof data !== "object") throw new Error("Tệp dự án không hợp lệ.");
  const archive = data as Record<string, any>, raw = archive.project;
  if (archive.format !== "loike-project-v1" || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Tệp này không phải bản sao dự án Lời Kể.");
  const text = (value: unknown, limit = 5000) => typeof value === "string" ? value.slice(0, limit) : "";
  const duration = Number(raw.duration || 0);
  if (!Number.isFinite(duration) || duration < 0 || duration > 90) throw new Error("Thời lượng trong dự án không hợp lệ hoặc quá 90 giây.");
  const decode = (value: unknown, kind: "video" | "audio", maximum: number): Blob | undefined => {
    if (value === undefined) return;
    const file = value as Record<string, unknown>;
    if (!file || typeof file.data !== "string" || typeof file.type !== "string" || !file.type.startsWith(`${kind}/`) || file.data.length > Math.ceil(maximum * 4 / 3) + 8) throw new Error("Tệp đi kèm trong dự án không hợp lệ hoặc quá lớn.");
    const result = fromBase64(file.data, file.type);
    if (!result.size || result.size > maximum) throw new Error("Tệp đi kèm trong dự án trống hoặc quá lớn.");
    return result;
  };
  if (raw.segments !== undefined && (!Array.isArray(raw.segments) || raw.segments.length > 16)) throw new Error("Dự án chỉ hỗ trợ tối đa 16 đoạn lời.");
  let audioBytes = 0;
  const segments: Segment[] = (raw.segments || []).map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Đoạn lời thoại trong dự án không hợp lệ.");
    const item = value as Record<string, unknown>, start = Number(item.start), end = Number(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > duration + 0.001 || typeof item.text !== "string" || item.text.length > 2400) throw new Error("Mốc thời gian hoặc nội dung lời thoại trong dự án không hợp lệ.");
    const segment: Segment = { start, end, text: item.text };
    if (item.audioBase64) {
      const audio = decode({ data: item.audioBase64, type: item.audioMime || item.mimeType || "audio/mpeg" }, "audio", 32 * 1024 * 1024)!;
      audioBytes += audio.size;
      if (audioBytes > 32 * 1024 * 1024) throw new Error("Tổng lời thoại trong dự án vượt 32 MB.");
      segment.audioBase64 = String(item.audioBase64); segment.mimeType = audio.type;
      if (Number.isFinite(Number(item.duration))) segment.duration = Number(item.duration);
    }
    return segment;
  });
  const source = decode(archive.video, "video", 60 * 1024 * 1024), narration = decode(archive.narration, "audio", 32 * 1024 * 1024);
  const project = freshProject(userId, safeProfile(raw.profile));
  return { ...project, title: text(raw.title, 200) || project.title, source, sourceName: text(raw.sourceName, 300), duration, width: Math.max(0, Math.min(16384, Number(raw.width) || 0)), height: Math.max(0, Math.min(16384, Number(raw.height) || 0)), intent: text(raw.intent), summary: text(raw.summary), format: FORMATS.some(format=>format.id===raw.format) ? raw.format : "review", angleId:text(raw.angleId,80), analysis: safeAnalysis(raw.analysis), segments, narration, narrationName: narration ? text(raw.narrationName, 300) : undefined, narrationDuration: narration && Number.isFinite(Number(raw.narrationDuration)) ? Number(raw.narrationDuration) : undefined, voiceId: text(raw.voiceId, 300), mode: ["scenery", "talking", "face"].includes(raw.mode) ? raw.mode : "scenery", keepAmbient: Boolean(raw.keepAmbient), step: source ? Math.max(0, Math.min(4, Math.floor(Number(raw.step) || 0))) as Step : 0 };
}
function audioMetadata(file: Blob): Promise<number | undefined> {
  return new Promise(resolve => {
    const audio = document.createElement("audio"), url = URL.createObjectURL(file);
    let finished = false;
    const finish = (duration?: number) => { if (finished) return; finished = true; clearTimeout(timer); audio.removeAttribute("src"); audio.load(); URL.revokeObjectURL(url); resolve(duration); };
    const timer = window.setTimeout(() => finish(), 8000);
    audio.preload = "metadata"; audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined); audio.onerror = () => finish(); audio.src = url;
  });
}

export default function Studio() {
  const [view, setView] = useState<View>("studio");
  const [project, setProject] = useState<Project>(() => freshProject("local"));
  const [projects, setProjects] = useState<Project[]>([]);
  const [accountProfile,setAccountProfile] = useState<Profile>({...EMPTY_PROFILE});
  const [config, setConfig] = useState<Configuration>({ userId: "local", deepseek: false, eleven: false });
  const [configError, setConfigError] = useState("");
  const [configRefreshing, setConfigRefreshing] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState("Sẵn sàng lưu");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [busy, setBusy] = useState<"analyze" | "script" | "speech" | "export" | "clone" | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [ratio, setRatio] = useState("9:16");
  const [intentRecording, setIntentRecording] = useState(false);
  const [intentInterim, setIntentInterim] = useState("");
  const [speechSupported, setSpeechSupported] = useState(true);
  const [analysisProgress, setAnalysisProgress] = useState("");
  const [narrationChecking, setNarrationChecking] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voiceFilter,setVoiceFilter] = useState("vietnamese");
  const [cloneName, setCloneName] = useState("");
  const [cloneFiles, setCloneFiles] = useState<File[]>([]);
  const [cloneConsent, setCloneConsent] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exported, setExported] = useState<Blob>();
  const [loginRequired, setLoginRequired] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scriptInstruction, setScriptInstruction] = useState("");
  const [keyboardOpen,setKeyboardOpen] = useState(false);
  const previousScreen = useRef("");
  const cameraVideo = useRef<HTMLVideoElement>(null);
  const previewVideo = useRef<HTMLVideoElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recognition = useRef<BrowserRecognition | null>(null);
  const startedAt = useRef(0);
  const uploadInput = useRef<HTMLInputElement>(null);
  const narrationInput = useRef<HTMLInputElement>(null);
  const projectRef = useRef(project);
  const accountDefaultsRef = useRef<Profile>({...EMPTY_PROFILE});
  const streamRef = useRef<MediaStream | null>(null);
  const uploadToken = useRef(0);
  const narrationToken = useRef(0);
  const pendingWrites = useRef(new Set<Promise<void>>());
  const deletedProjectIds = useRef(new Set<string>());
  const mounted = useRef(true);
  const sourceUrl = useBlobUrl(project.source);
  const narrationUrl = useBlobUrl(project.narration);
  const exportedUrl = useBlobUrl(exported);
  const step = project.step;
  const hasClip = Boolean(project.source);
  const words = project.segments.reduce((total, segment) => total + segment.text.trim().split(/\s+/).filter(Boolean).length, 0);
  const spokenSegments = project.segments.filter(segment => segment.text.trim());
  const narrationReady = Boolean(project.narration || (spokenSegments.length > 0 && spokenSegments.every(segment => segment.audioBase64)));
  const narrationTooLong = Boolean(project.narration && project.narrationDuration && project.duration && project.narrationDuration > project.duration + 0.001);
  const update = useCallback((changes: Partial<Project>) => {
    setProject(current => applyProjectChanges(current, changes));
    if (affectsExport(changes)) setExported(undefined);
  }, []);
  const updateProfile = (changes: Partial<Profile>) => update({ profile: { ...project.profile, ...changes } });
  const notify = (text: string, type: Notice["type"] = "info") => setNotice({ text, type });
  function storeProject(target: Project): Promise<void> {
    if (deletedProjectIds.current.has(target.id)) return Promise.resolve();
    const write = persistProject(target);
    pendingWrites.current.add(write);
    void write.finally(() => pendingWrites.current.delete(write)).catch(() => {});
    return write;
  }

  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const changed = () => setKeyboardOpen(window.innerWidth <= 700 && Math.abs(viewport.scale-1)<0.02 && Boolean(document.activeElement?.matches('input:not([type="file"]),textarea,[contenteditable="true"]')) && window.innerHeight - viewport.height > 140);
    viewport.addEventListener("resize",changed);
    window.addEventListener("resize",changed);
    return () => { viewport.removeEventListener("resize",changed); window.removeEventListener("resize",changed); };
  },[]);
  useEffect(() => {
    if (!ready) return;
    const screen = `${view}:${view === "studio" ? step : ""}`;
    if (!previousScreen.current) { previousScreen.current = screen; return; }
    if (previousScreen.current === screen) return;
    previousScreen.current = screen;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({top:0,behavior:"instant"});
      const heading = document.querySelector<HTMLElement>(".workspace h1");
      if (heading) { heading.tabIndex = -1; heading.focus({preventScroll:true}); }
    });
    return () => cancelAnimationFrame(frame);
  }, [view,step,ready]);
  useEffect(() => { recognition.current?.abort(); setIntentInterim(""); }, [project.id, project.source]);
  useEffect(() => { mounted.current = true; const scope = window as typeof window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }; setSpeechSupported(Boolean(scope.SpeechRecognition || scope.webkitSpeechRecognition)); return () => { mounted.current = false; streamRef.current?.getTracks().forEach(track => track.stop()); recognition.current?.abort(); }; }, []);
  useEffect(() => {
    let live = true;
    (async () => {
      let visitor = "local";
      try { visitor = localStorage.getItem("loike-visitor-id") || uid(); localStorage.setItem("loike-visitor-id", visitor); } catch { visitor = uid(); }
      let nextConfig: Configuration = { userId: visitor, deepseek: false, eleven: false };
      let profile = { ...EMPTY_PROFILE };
      try { const data = await requestJson("/api/config"); nextConfig = configurationFrom(data, visitor); if (data.profile) profile = safeProfile(data.profile); setLoginRequired(false); setConfigError(""); } catch (error) { if (errorText(error).includes("401") || /đăng nhập|sign in|unauthorized/i.test(errorText(error))) setLoginRequired(true); else setConfigError(errorText(error)); }
      if (!live) return;
      setConfig(nextConfig);
      setAccountProfile(profile);
      accountDefaultsRef.current = profile;
      try {
        const stored = await readProjects(nextConfig.userId);
        if (!live) return;
        setProjects(stored);
        if (stored[0]) { setProject({ ...freshProject(nextConfig.userId, profile), ...stored[0], profile: { ...profile, ...stored[0].profile } }); setSaveState("Đã khôi phục dự án"); }
        else setProject(freshProject(nextConfig.userId, profile));
      } catch { setProject(freshProject(nextConfig.userId, profile)); setNotice({ type: "info", text: "Trình duyệt chưa cho phép lưu dự án. Bạn vẫn có thể làm việc và tải bản sao dự án về máy." }); }
      if (live) setReady(true);
    })();
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!ready || (!project.source && !project.intent && !project.segments.length)) return;
    setSaveState("Đang lưu…");
    const timer = window.setTimeout(() => { if (deletedProjectIds.current.has(project.id)) return; storeProject(project).then(() => { if (!mounted.current || deletedProjectIds.current.has(project.id)) return; setSaveState("Đã lưu trên thiết bị"); setProjects(current => [project, ...current.filter(item => item.id !== project.id)].sort((a, b) => b.updatedAt - a.updatedAt)); }).catch(() => { if (mounted.current) setSaveState("Chưa lưu được · hãy tải dự án"); }); }, 700);
    return () => window.clearTimeout(timer);
  }, [project, ready]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), notice.type === "error" ? 10000 : 6000); return () => window.clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (!settingsOpen && !deleteTarget) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea, select, [tabindex="0"]') || []);
    focusable()[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !settingsSaving) { setSettingsOpen(false); setDeleteTarget(null); }
      if (event.key !== "Tab") return;
      const elements = focusable(), first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", handleKey); previous?.focus(); };
  }, [settingsOpen, deleteTarget, settingsSaving]);
  useEffect(() => { if (cameraVideo.current && stream) { cameraVideo.current.srcObject = stream; cameraVideo.current.play().catch(() => {}); } }, [stream, step, view]);
  useEffect(() => { if (!recording) return; const timer = window.setInterval(() => setRecordSeconds((Date.now() - startedAt.current) / 1000), 250); return () => window.clearInterval(timer); }, [recording]);
  useEffect(() => { if (recording && recordSeconds >= 89.5 && recorder.current?.state === "recording") { recorder.current.stop(); setNotice({ type: "info", text: "Đã dừng để giữ video trong giới hạn 90 giây và xuất ổn định trên thiết bị." }); } }, [recordSeconds, recording]);

  const stopCamera = () => { streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null; setStream(null); };
  async function camera(targetFacing = facing) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera cần kết nối HTTPS hoặc localhost và trình duyệt hỗ trợ quay video. Bạn có thể tải video có sẵn lên.");
    streamRef.current?.getTracks().forEach(track => track.stop());
    const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: targetFacing }, width: { ideal: ratio === "9:16" ? 1080 : 1920 }, height: { ideal: ratio === "9:16" ? 1920 : 1080 } }, audio: { echoCancellation: true, noiseSuppression: true } });
    streamRef.current = next; setStream(next); return next;
  }
  async function startRecording() {
    if (busy || recording) return;
    ++uploadToken.current;
    try {
      if (typeof MediaRecorder === "undefined") throw new Error("Trình duyệt này chưa hỗ trợ quay trực tiếp. Hãy quay bằng camera điện thoại và chọn Tải video lên.");
      const active = streamRef.current?.active ? streamRef.current : await camera();
      const supported = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
      const next = new MediaRecorder(active, supported ? { mimeType: supported, videoBitsPerSecond: 4_000_000 } : undefined);
      const chunks: BlobPart[] = [];
      next.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      next.onstop = () => {
        const duration = Math.max(0.1, (Date.now() - startedAt.current) / 1000);
        const blob = new Blob(chunks, { type: next.mimeType || "video/webm" });
        const settings = active.getVideoTracks()[0]?.getSettings();
        if (duration < 2 || !blob.size) { setRecording(false); stopCamera(); notify("Hãy quay ít nhất 2 giây để có đủ một khoảnh khắc cho câu chuyện."); return; }
        update({ source: blob, sourceName: `Quay-${new Date().toISOString().slice(0, 10)}.${blob.type.includes("mp4") ? "mp4" : "webm"}`, duration, width: settings?.width || 0, height: settings?.height || 0, step: 1, analysis: undefined, summary: "", segments: [], narration: undefined });
        setRecording(false); stopCamera(); notify("Đã giữ lại khoảnh khắc của bạn. Bây giờ, hãy cho AI biết điều bạn muốn chia sẻ.", "success");
      };
      next.onerror = () => { setRecording(false); stopCamera(); notify("Camera bị gián đoạn. Hãy kiểm tra quyền camera rồi thử lại.", "error"); };
      recorder.current = next; startedAt.current = Date.now(); setRecordSeconds(0); next.start(1000); setRecording(true);
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      notify(name === "NotAllowedError" ? "Bạn cần cho phép camera và micro trong trình duyệt để quay. Hoặc chọn video có sẵn." : name === "NotFoundError" ? "Không tìm thấy camera hoặc micro. Bạn có thể tải video từ thiết bị." : errorText(error), "error");
    }
  }
  function stopRecording() { if (recorder.current?.state === "recording") recorder.current.stop(); }
  async function switchCamera() { if (recording) return; const nextFacing = facing === "user" ? "environment" : "user"; setFacing(nextFacing); if (stream) try { await camera(nextFacing); } catch (error) { notify(errorText(error), "error"); } }
  async function ingestFile(file?: File) {
    if (!file) return;
    if (busy) { notify("Hãy chờ thao tác hiện tại hoàn tất trước khi đổi video."); return; }
    if (recording) { notify("Hãy dừng quay trước khi chọn video khác."); return; }
    const token = ++uploadToken.current;
    if (file.name.endsWith(".loike") || file.name.endsWith(".json")) {
      try {
        if (file.size > 180 * 1024 * 1024) throw new Error("Bản sao dự án quá lớn. Giới hạn tệp nhập là 180 MB.");
        const data = JSON.parse(await file.text());
        const restored = restoreArchive(data, config.userId);
        if (restored.narration) restored.narrationDuration = await audioMetadata(restored.narration);
        if (token !== uploadToken.current) return;
        flushCurrentProject();
        stopCamera();
        setProject(restored); setExported(undefined); setView("studio"); notify("Đã nhập dự án và các tệp đi kèm.", "success");
      } catch (error) { notify(errorText(error), "error"); }
      return;
    }
    if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|m4v|avi)$/i.test(file.name)) { notify("Hãy chọn một tệp video MP4, MOV hoặc WebM.", "error"); return; }
    if (file.size > 60 * 1024 * 1024) { notify("Bản đầu hỗ trợ video tối đa 60 MB. Hãy chọn hoặc cắt một đoạn ngắn hơn trước khi tải lên.", "error"); return; }
    stopCamera();
    const metadataVideo = document.createElement("video"); const url = URL.createObjectURL(file);
    metadataVideo.preload = "metadata"; metadataVideo.src = url;
    metadataVideo.onloadedmetadata = () => {
      if (token !== uploadToken.current) { URL.revokeObjectURL(url); return; }
      const duration = Number.isFinite(metadataVideo.duration) ? metadataVideo.duration : 0;
      if (duration > 90 || (duration > 0 && duration < 2)) { URL.revokeObjectURL(url); notify("Hãy chọn một video dài từ 2 đến 90 giây cho câu chuyện này.", "error"); return; }
      const source = file.type ? file : new File([file], file.name, { type: /\.webm$/i.test(file.name) ? "video/webm" : /\.mov$/i.test(file.name) ? "video/quicktime" : "video/mp4" });
      update({ source, sourceName: file.name, title: projectRef.current.title === "Câu chuyện chưa đặt tên" ? file.name.replace(/\.[^.]+$/, "") : projectRef.current.title, duration, width: metadataVideo.videoWidth, height: metadataVideo.videoHeight, step: 1, analysis: undefined, summary: "", segments: [], narration: undefined });
      setView("studio"); URL.revokeObjectURL(url);
      if (!duration) notify("Đã mở video. Chưa đọc được thời lượng; hãy nhập số giây ở phần thông tin video."); else notify("Video đã sẵn sàng. Câu chuyện của bạn bắt đầu từ đây.", "success");
    };
    metadataVideo.onerror = () => { URL.revokeObjectURL(url); notify("Trình duyệt chưa đọc được video này. Hãy thử bản MP4 H.264.", "error"); };
  }
  async function toggleIntentRecording() {
    if (intentRecording) { recognition.current?.stop(); return; }
    try {
      const scope = window as typeof window & { SpeechRecognition?: new () => BrowserRecognition; webkitSpeechRecognition?: new () => BrowserRecognition };
      const Constructor = scope.SpeechRecognition || scope.webkitSpeechRecognition;
      if (!Constructor) { setSpeechSupported(false); throw new Error("Trình duyệt này chưa chuyển giọng nói thành chữ. Hãy gõ ý tưởng vào ô phía trên."); }
      const next = new Constructor(), projectId = project.id, initial = project.intent.trim();
      next.lang = "vi-VN"; next.continuous = true; next.interimResults = true;
      next.onresult = event => {
        if (projectRef.current.id !== projectId) return;
        let confirmed = "", interim = "";
        for (let index = 0; index < event.results.length; index++) { const result = event.results[index]; if (result.isFinal) confirmed += `${result[0].transcript} `; else interim += `${result[0].transcript} `; }
        if (confirmed.trim()) update({ intent: `${initial}${initial ? " " : ""}${confirmed.trim()}` });
        setIntentInterim(interim.trim());
      };
      next.onerror = event => { setIntentRecording(false); setIntentInterim(""); notify(event.error === "not-allowed" ? "Hãy cho phép micro để nói ý tưởng, hoặc gõ trực tiếp vào ô lời dặn." : "Chưa nghe rõ lời dặn. Bạn có thể thử lại hoặc gõ trực tiếp.", "error"); };
      next.onend = () => { setIntentRecording(false); setIntentInterim(""); };
      recognition.current = next; next.start(); setIntentRecording(true);
    } catch (error) { notify(errorText(error), "error"); }
  }
  async function ingestNarration(file?: File) {
    if (!file) return;
    if (busy) { notify("Hãy chờ thao tác hiện tại hoàn tất trước khi đổi lời thoại."); return; }
    if (!file.size || file.size > 32 * 1024 * 1024) { notify("Chọn bản thu có âm thanh, tối đa 32 MB.", "error"); return; }
    if (!file.type.startsWith("audio/") && !/\.(mp3|wav|m4a|aac|ogg|webm|flac)$/i.test(file.name)) { notify("Hãy chọn một tệp âm thanh MP3, WAV, M4A hoặc WebM.", "error"); return; }
    const token = ++narrationToken.current, projectId = project.id;
    const narration = file.type ? file : new File([file], file.name, { type: /\.wav$/i.test(file.name) ? "audio/wav" : /\.m4a$/i.test(file.name) ? "audio/mp4" : /\.webm$/i.test(file.name) ? "audio/webm" : "audio/mpeg" });
    setNarrationChecking(true);
    try {
      const duration = await audioMetadata(narration);
      if (token !== narrationToken.current || projectRef.current.id !== projectId) return;
      update({ narration, narrationName: file.name, narrationDuration: duration });
      notify(duration && duration > project.duration + 0.001 ? `Bản thu dài ${duration.toFixed(1)} giây, vượt video ${project.duration.toFixed(1)} giây. Hãy chọn bản thu ngắn hơn để giữ trọn lời.` : duration ? `Đã thêm bản thu ${duration.toFixed(1)} giây. Lời thoại bắt đầu từ đầu video.` : "Đã thêm bản thu. Chưa đọc được thời lượng trên trình duyệt; bộ xuất sẽ kiểm tra lại trước khi ghép.", duration && duration > project.duration + 0.001 ? "error" : "success");
    } finally { if (token === narrationToken.current) setNarrationChecking(false); }
  }
  async function analyze() {
    if (!project.source) { notify("Quay hoặc chọn video trước để AI hiểu cảnh."); return; }
    if (!project.intent.trim()) { notify("Hãy nói hoặc viết một câu về điều bạn muốn người xem hiểu."); return; }
    if (!config.deepseek) { notify("AI chưa sẵn sàng. Bạn có thể tự viết lời thoại hoặc xem trạng thái trong Cài đặt."); return; }
    const expected = intentKey(project);
    setBusy("analyze");
    try {
      setAnalysisProgress("Đang lấy các cảnh trong video…");
      const { sampleVideoFrames } = await import("@/lib/studio-frames");
      const frames = await sampleVideoFrames(project.source, project.duration);
      if (intentKey(projectRef.current) !== expected || projectRef.current.source !== project.source) throw new Error("Ý tưởng đã thay đổi. Hãy thử lại để dùng nội dung mới nhất.");
      setAnalysisProgress("AI đang xem ảnh trích và đọc ý tưởng của bạn…");
      const result = await requestJson("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ frames, duration: project.duration, intent: project.intent, format:project.format,profile: { ...project.profile, mode: project.mode } }) });
      if (intentKey(projectRef.current) !== expected || projectRef.current.source !== project.source) { notify("Ý tưởng đã thay đổi trong lúc phân tích. Hãy phân tích lại để dùng đúng lời dặn mới nhất."); return; }
      const data = result.analysis || result;
      const angles = (data.suggestedAngles || []) as Angle[], preferred = angles.find(angle=>angle.id===data.recommendedAngleId) || angles[0];
      update({ analysis: data, summary: summaryFrom(data) || project.intent, angleId:preferred?.id || "", format:preferred?.format || project.format });
      notify("Đã phân tích cảnh. Hãy kiểm tra hướng kể, rồi xác nhận để viết kịch bản.", "success");
    } catch (error) { notify(errorText(error), "error"); } finally { setBusy(null); setAnalysisProgress(""); void refreshUsage(); }
  }
  async function generateScript() {
    if (!project.duration || !project.intent.trim()) { notify("Cần có thời lượng video và một câu mô tả ý muốn chia sẻ."); return; }
    if (!config.deepseek) { notify("AI chưa sẵn sàng. Bạn có thể viết lời thoại trực tiếp."); update({ step: 2 }); return; }
    const expectedIntent = intentKey(project), expectedScript = scriptKey(project), expectedSummary = project.summary;
    setBusy("script");
    try {
      const result = await requestJson("/api/script", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: project.analysis, intent: project.intent, confirmedIntent:project.summary || undefined,format:project.format,angleId:project.angleId || undefined,profile: { ...project.profile, mode: project.mode }, duration: project.duration, instruction: [project.summary ? `Ý định đã xác nhận: ${project.summary}` : "",scriptInstruction].filter(Boolean).join("\n") || undefined }) });
      if (intentKey(projectRef.current) !== expectedIntent || scriptKey(projectRef.current) !== expectedScript || projectRef.current.summary !== expectedSummary) { notify("Nội dung đã được sửa trong lúc AI viết. Đã giữ nguyên thay đổi của bạn; hãy yêu cầu viết lại nếu cần."); return; }
      const segments = normalizeSegments(result, project.duration);
      if (!segments.length) throw new Error("AI chưa trả về lời thoại. Hãy thử lại hoặc viết trực tiếp.");
      update({ segments, title:result.title || project.title,narration: undefined, narrationName: undefined, step: 2 }); notify("Kịch bản đã sẵn sàng để bạn chỉnh thành giọng kể của mình.", "success");
    } catch (error) { notify(errorText(error), "error"); } finally { setBusy(null); void refreshUsage(); }
  }
  async function loadVoices() {
    if (!config.eleven) return;
    setVoicesLoading(true);
    try { const result = await requestJson("/api/voices"); setVoices(Array.isArray(result.voices) ? result.voices : []); } catch (error) { notify(errorText(error), "error"); } finally { setVoicesLoading(false); }
  }
  useEffect(() => { if (config.eleven && (view === "voices" || step === 3)) void loadVoices(); }, [config.eleven, view, step]);
  async function generateSpeech() {
    if (!project.segments.some(segment => segment.text.trim())) { notify("Thêm lời thoại ở bước Kịch bản trước."); return; }
    if (!project.voiceId) { notify("Chọn một giọng đọc trước khi tạo âm thanh."); return; }
    if (project.segments.some(segment => !segment.text.trim())) { notify("Hãy điền hoặc xóa các đoạn lời còn trống trước khi tạo giọng."); return; }
    const expected = scriptKey(project), expectedVoice = project.voiceId, expectedNarration = project.narration;
    setBusy("speech");
    try {
      const result = await requestJson("/api/speech", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ segments: project.segments.map(({ start, end, text }) => ({ start, end, text })), voiceId: project.voiceId, duration: project.duration }) });
      if (scriptKey(projectRef.current) !== expected || projectRef.current.voiceId !== expectedVoice || projectRef.current.narration !== expectedNarration) { notify("Kịch bản hoặc giọng đã thay đổi. Đã giữ nội dung mới; hãy tạo lại lời đọc cho phiên bản này."); return; }
      const downloaded = await (await import("@/lib/studio-upload")).downloadSpeechSegments(result.segments);
      if (scriptKey(projectRef.current) !== expected || projectRef.current.voiceId !== expectedVoice || projectRef.current.narration !== expectedNarration) { notify("Nội dung đã thay đổi trong lúc tải lời đọc. Hãy tạo lại lời đọc cho phiên bản mới."); return; }
      const segments = normalizeSegments(downloaded, project.duration);
      if (!segments.some(segment => segment.audioBase64)) throw new Error("Chưa nhận được âm thanh từ ElevenLabs. Vui lòng thử lại.");
      update({ segments, narration: undefined, narrationName: undefined }); notify("Đã tạo lời đọc. Nghe thử từng đoạn trước khi ghép video.", "success");
    } catch (error) { notify(errorText(error), "error"); } finally { setBusy(null); void refreshUsage(); }
  }
  async function cloneVoice() {
    if (!cloneName.trim() || !cloneFiles.length || !cloneConsent) { notify("Điền tên giọng, chọn bản thu và xác nhận quyền sử dụng giọng."); return; }
    setBusy("clone");
    let uploaded: { samplePaths: string[] } | undefined;
    try { const upload = await import("@/lib/studio-upload"); uploaded = await upload.uploadVoiceSamples(cloneFiles); const result = await requestJson("/api/voices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: cloneName, consent: true, samplePaths: uploaded.samplePaths }) }); await loadVoices(); setCloneName(""); setCloneFiles([]); setCloneConsent(false); notify(result.requiresVerification ? "Đã tạo giọng. Cần xác minh quyền sở hữu trước khi dùng; hãy liên hệ quản trị viên để hoàn tất." : "Đã tạo giọng cá nhân. Giọng khả dụng sẽ xuất hiện trong danh sách.", result.requiresVerification ? "info" : "success"); } catch (error) { notify(errorText(error), "error"); } finally { if (uploaded) await (await import("@/lib/studio-upload")).cleanupAnalysisMedia(uploaded).catch(() => {}); setBusy(null); void refreshUsage(); }
  }
  async function saveSettings() {
    setSettingsSaving(true); setSettingsError("");
    try {
      const previous = accountDefaultsRef.current;
      const result = await requestJson("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: accountProfile }) });
      const data = await requestJson("/api/config").catch(() => null);
      const saved = safeProfile(data?.profile || result.profile);
      if (data) await applyConfiguration(data);
      else { setAccountProfile(saved); accountDefaultsRef.current = saved; }
      if (!data?.userId || data.userId === config.userId) update({profile:applySavedProfile(projectRef.current.profile,previous,saved)});
      setSettingsOpen(false); notify("Đã lưu phong cách riêng. AI sẽ dùng cho những video của bạn.", "success");
    } catch (error) { setSettingsError(errorText(error)); if (errorText(error).includes("401")) setLoginRequired(true); notify(errorText(error), "error"); } finally { setSettingsSaving(false); }
  }
  async function applyConfiguration(data: Record<string, any>) {
    const next = configurationFrom(data, config.userId);
    if (next.userId !== config.userId) {
      ++uploadToken.current; ++narrationToken.current;
      setExported(undefined);
      const current = projectRef.current;
      if (current.source || current.intent || current.segments.length) await storeProject(current).catch(() => {});
      const stored = await readProjects(next.userId).catch(() => [] as Project[]);
      setProjects(stored);
      if (!config.authenticated && (current.source || current.intent || current.segments.length)) {
        setProject({ ...current, id: uid(), userId: next.userId, updatedAt: Date.now() });
      } else setProject(stored[0] || freshProject(next.userId, safeProfile(data.profile)));
    }
    setConfig(next); setConfigError(""); setSettingsError(""); setLoginRequired(false);
    if (data.profile) { const profile=safeProfile(data.profile); setAccountProfile(profile); accountDefaultsRef.current=profile; }
  }
  async function refreshConfiguration() {
    setConfigRefreshing(true);
    try { await applyConfiguration(await requestJson("/api/config")); notify("Đã tải lại kết nối tài khoản.", "success"); }
    catch (error) { if (errorText(error).includes("401")) { setLoginRequired(true); setConfigError(""); } else setConfigError(errorText(error)); }
    finally { setConfigRefreshing(false); }
  }
  async function refreshUsage() {
    try { const data = await requestJson("/api/config"); setConfig(current => data.userId === current.userId ? configurationFrom(data, current.userId) : current); } catch { /* Keep the editing state intact if the usage refresh is temporarily unavailable. */ }
  }
  async function signOut() {
    try { flushCurrentProject(); await Promise.allSettled(Array.from(pendingWrites.current)); await requestJson("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "signout" }) }); window.location.assign("/dang-nhap"); }
    catch (error) { notify(errorText(error), "error"); }
  }
  async function exportVideo() {
    if (!project.source) return;
    if (!narrationReady || narrationChecking) { notify("Hãy tạo lời đọc hoặc tải tệp âm thanh trước khi ghép."); return; }
    if (narrationTooLong) { notify("Bản thu lời thoại dài hơn video. Hãy chọn bản ngắn hơn trước khi ghép để giữ trọn câu.", "error"); return; }
    setBusy("export"); setExportProgress(0); setExportMessage("Đang chuẩn bị bộ xử lý video…");
    try {
      const { exportVideo: render } = await import("@/lib/video-export");
      const speechSegments = project.segments.filter((segment): segment is Segment & { audioBase64: string } => Boolean(segment.audioBase64)).map(segment => ({ ...segment, mimeType: segment.audioMime || segment.mimeType, audioDuration: segment.duration }));
      const blob = await render({ video: project.source, segments: project.narration ? undefined : speechSegments, narration: project.narration, duration: project.duration, keepAmbient: project.keepAmbient, onProgress: (progress: number, message: string) => { setExportProgress(Math.max(0, Math.min(100, progress * 100))); setExportMessage(message); } });
      if (!mounted.current) return;
      const current = projectRef.current;
      if (current.id !== project.id || current.source !== project.source || current.segments !== project.segments || current.narration !== project.narration || current.keepAmbient !== project.keepAmbient) { notify("Dự án đã thay đổi trong lúc ghép. Hãy xuất lại để bản tải xuống đúng nội dung hiện tại."); return; }
      setExported(blob); setExportProgress(100); notify("Video MP4 đã hoàn tất. Bạn có thể xem thử và tải về.", "success");
    } catch (error) { notify(errorText(error), "error"); } finally { setBusy(null); }
  }
  async function exportProject(target = project) {
    try {
      const { source, narration, userId: _userId, id: _id, ...metadata } = target;
      const data = { format: "loike-project-v1", project: metadata, video: source ? { data: await blobBase64(source), type: source.type } : undefined, narration: narration ? { data: await blobBase64(narration), type: narration.type } : undefined };
      downloadBlob(new Blob([JSON.stringify(data)], { type: "application/json" }), `${target.title || "loi-ke"}.loike`); notify("Bản sao dự án gồm video gốc và nội dung đã được tải xuống.", "success");
    } catch (error) { notify(errorText(error), "error"); }
  }
  function flushCurrentProject() {
    const current = projectRef.current;
    if (!current.source && !current.intent && !current.segments.length) return;
    if (deletedProjectIds.current.has(current.id)) return;
    void storeProject(current).then(() => { if (!deletedProjectIds.current.has(current.id)) setProjects(items => [current, ...items.filter(item => item.id !== current.id)].sort((a, b) => b.updatedAt - a.updatedAt)); }).catch(() => {});
  }
  function newProject() { ++uploadToken.current; ++narrationToken.current; setNarrationChecking(false); flushCurrentProject(); stopCamera(); setProject(freshProject(config.userId, accountDefaultsRef.current)); setIntentInterim(""); setExported(undefined); setView("studio"); setSaveState("Sẵn sàng lưu"); }
  function openProject(item: Project) { ++uploadToken.current; ++narrationToken.current; setNarrationChecking(false); flushCurrentProject(); stopCamera(); setProject(item.id === projectRef.current.id ? projectRef.current : item); setView("studio"); if(item.id!==projectRef.current.id) setExported(undefined); }
  async function deleteProject() {
    if (!deleteTarget) return;
    deletedProjectIds.current.add(deleteTarget.id);
    try { await Promise.allSettled(Array.from(pendingWrites.current)); await removeProject(deleteTarget.id, config.userId); setProjects(current => current.filter(item => item.id !== deleteTarget.id)); if (deleteTarget.id === project.id) { ++uploadToken.current; ++narrationToken.current; setNarrationChecking(false); stopCamera(); setProject(freshProject(config.userId, project.profile)); setIntentInterim(""); setExported(undefined); setView("studio"); setSaveState("Sẵn sàng lưu"); } setDeleteTarget(null); notify("Đã xóa dự án khỏi thiết bị.", "success"); } catch (error) { deletedProjectIds.current.delete(deleteTarget.id); notify(errorText(error), "error"); }
  }
  function editSegment(index: number, changes: Partial<Segment>) { update({ segments: project.segments.map((segment, position) => position === index ? applySegmentChange(segment, changes) : segment), narration: undefined, narrationName: undefined }); }
  function addSegment() {
    if (project.segments.length >= 16) { notify("Mỗi video hỗ trợ tối đa 16 đoạn lời."); return; }
    const previous = project.segments.at(-1);
    if (!previous) { update({ segments: [{ start: 0, end: project.duration, text: "" }] }); return; }
    if (previous.end <= project.duration - 0.5) { update({ segments: [...project.segments, { start: previous.end, end: project.duration, text: "" }] }); return; }
    const midpoint = Math.round((previous.start + previous.end) * 50) / 100;
    if (previous.end - previous.start < 1) { notify("Đoạn cuối quá ngắn để chia thêm. Hãy chỉnh mốc thời gian trước."); return; }
    update({ segments: [...project.segments.slice(0, -1), { ...previous, end: midpoint }, { start: midpoint, end: previous.end, text: "" }] });
  }
  function navigateStep(next: number) { if (busy) { notify("Hãy chờ thao tác hiện tại hoàn tất."); return; } if (recording) { notify("Hãy dừng quay để tiếp tục."); return; } if (next > 0 && !hasClip) { notify("Bắt đầu bằng việc quay hoặc tải video lên."); return; } stopCamera(); update({ step: next as Step }); }

  const working = Boolean(busy) || recording || intentRecording;
  const displayName = config.displayName || project.profile.name || "Tài khoản";
  const manualScript = () => update({ step: 2, segments: project.segments.length ? project.segments : [{ start: 0, end: project.duration, text: "" }] });
  const angles = (Array.isArray(project.analysis?.suggestedAngles) ? project.analysis.suggestedAngles : []) as Angle[];
  const selectedVoice = voices.find(voice=>(voice.voice_id || voice.id)===project.voiceId);
  const filteredVoices = voices.filter(voice=>voiceFilter === "all" || (voice.group || (voice.category === "cloned" ? "personal" : "default"))===voiceFilter);
  async function saveExport() { if(!exported)return;try{const result=await saveVideoFile(exported,project.title);if(result==="saved")notify("Đã lưu tệp MP4 vào vị trí bạn chọn.","success");}catch(error){notify(errorText(error),"error");} }
  async function shareExport() { if(!exported)return;try{const result=await shareVideoFile(exported,project.title);if(result==="shared")notify("Đã chuyển video tới ứng dụng bạn chọn.","success");}catch(error){notify(errorText(error),"error");} }

  return <div className={`studio-app view-${view} step-${step}${keyboardOpen ? " keyboard-open" : ""}`}>
    <a className="skip-link" href="#workspace">Đến nội dung chính</a>
    <header className="app-header">
      <div className="header-inner">
        <button className="brand" aria-label="Lời Kể — tạo video" onClick={() => setView("studio")}><span className="brand-symbol"><i /><i /><i /><i /></span>Lời Kể<span className="brand-dot">.</span></button>
        <nav className="main-nav" aria-label="Điều hướng chính">
          {NAV_ITEMS.map(item=><button key={item.view} className={view===item.view ? "active" : ""} aria-label={item.label} aria-current={view===item.view ? "page" : undefined} onClick={()=>setView(item.view)} disabled={working}><Icon name={item.icon} size={21} /><span className="nav-label-full">{item.label}</span><span className="nav-label-short">{item.short}</span></button>)}
        </nav>
        <details className="account-menu">
          <summary aria-label="Tài khoản và cài đặt"><span className="avatar">{displayName.charAt(0).toUpperCase()}</span><Icon name="chevron" size={14} /></summary>
          <div className="account-dropdown"><strong>{config.authenticated ? displayName : "Không gian của bạn"}</strong>{config.quota ? <span className="quota-label">Đã dùng {config.quota.used}/{config.quota.limit} lượt AI</span> : null}<button onClick={() => setSettingsOpen(true)}><Icon name="settings" size={18} />Cài đặt</button><button onClick={() => setView("guide")} disabled={working}><Icon name="help" size={18} />Hướng dẫn</button>{config.isAdmin ? <a href="/quan-tri"><Icon name="grid" size={18} />Quản trị</a> : null}{config.authenticated ? <button onClick={() => void signOut()} disabled={working}>Đăng xuất</button> : <a href="/dang-nhap">Đăng nhập</a>}</div>
        </details>
      </div>
    </header>

    <main className="workspace" id="workspace">
      {loginRequired ? <div className="status-banner"><Icon name="lock" size={19} /><span>Đăng nhập để dùng AI và hồ sơ của bạn.</span><a href="/dang-nhap">Đăng nhập</a></div> : null}
      {configError ? <div className="status-banner warning" role="alert"><Icon name="info" size={19} /><span>Chưa tải được kết nối tài khoản. Bạn vẫn có thể chỉnh video thủ công.</span><button onClick={() => void refreshConfiguration()} disabled={configRefreshing || working}>{configRefreshing ? "Đang thử…" : "Thử lại"}</button></div> : null}

      {view === "studio" ? <>
        <div className="project-bar">
          <div>{hasClip ? <input className="project-name" aria-label="Tên dự án" value={project.title} onChange={event => update({ title: event.target.value })} /> : <span className="project-name-static">Video mới</span>}<span className="save-label"><Icon name="check" size={13} />{saveState}</span></div>
          <details className="project-menu"><summary aria-label="Tùy chọn dự án">···</summary><div><button onClick={newProject} disabled={working}><Icon name="plus" size={18} />Tạo video mới</button><button onClick={() => void exportProject()} disabled={!hasClip || working}><Icon name="folder" size={18} />Tải bản sao dự án</button><button onClick={() => uploadInput.current?.click()} disabled={working}><Icon name="upload" size={18} />Nhập dự án</button></div></details>
        </div>

        <div className="mobile-progress"><span>Bước {step+1} / 5</span><strong>{STEPS[step]}</strong></div>
        <nav className="workflow" aria-label="Tiến trình tạo video">
          {STEPS.map((label, index) => <button key={label} className={`workflow-step ${step === index ? "current" : ""} ${step > index ? "complete" : ""}`} aria-label={`Bước ${index+1}: ${label}`} aria-current={step === index ? "step" : undefined} onClick={() => navigateStep(index)} disabled={working || (index>0 && !hasClip)}><span className="step-number">{step > index ? <Icon name="check" size={15} /> : index + 1}</span><span className="step-label">{label}</span></button>)}
        </nav>

        {step === 0 ? <section className="step-card capture-card" aria-labelledby="capture-title">
          <div className="step-heading"><span className="step-kicker">BƯỚC 1 / 5</span><h1 id="capture-title">Thêm video của bạn</h1><p>Quay một khoảnh khắc hoặc chọn video có sẵn.</p></div>
          <div className="capture-actions">
            {recording ? <button className="button primary large recording-button" onClick={stopRecording}><span className="stop-square" />Dừng quay</button> : hasClip ? <><button className="button primary large" onClick={() => navigateStep(1)}>Dùng video này<Icon name="arrow" /></button><button className="button secondary large" onClick={() => void startRecording()} disabled={Boolean(busy) || !ready}><Icon name="camera" />Quay lại</button></> : <><button className="button primary large" onClick={() => void startRecording()} disabled={Boolean(busy) || !ready}><span className="record-circle" />Quay video</button><button className="button secondary large" onClick={() => uploadInput.current?.click()}><Icon name="upload" />Tải video lên</button></>}
          </div>
          <div className={`camera-stage ${stream ? "camera-live" : ""} ${dragging ? "dragging" : ""}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); void ingestFile(event.dataTransfer.files[0]); }}>
            {stream ? <video ref={cameraVideo} className={`live-camera ${facing === "user" ? "mirrored" : ""}`} autoPlay muted playsInline /> : hasClip ? <video className="source-preview" src={sourceUrl} controls playsInline preload="metadata" /> : <div className="camera-empty"><div className="camera-orbit"><Icon name="camera" size={44} /><span>✦</span></div><strong>Sẵn sàng khi bạn muốn quay.</strong><p>Giữ máy vững và quay thật tự nhiên.</p></div>}
            {recording ? <div className="recording-timer"><span />{time(recordSeconds)}</div> : null}
            <span className="canvas-note">{recording ? "Đang thu hình và tiếng" : hasClip ? `${time(project.duration)} · ${project.sourceName || "Video của bạn"}` : "2–90 giây · tối đa 60 MB"}</span>
          </div>
          {hasClip && !recording ? <button className="text-button centered" onClick={() => uploadInput.current?.click()}>Chọn video khác</button> : null}
          <details className="quiet-details camera-options"><summary>Tùy chọn camera<Icon name="chevron" size={16} /></summary><div className="camera-option-fields"><label>Tỷ lệ quay<select value={ratio} onChange={event => setRatio(event.target.value)} disabled={recording}><option value="9:16">Dọc · 9:16</option><option value="16:9">Ngang · 16:9</option></select></label><button className="button secondary" onClick={() => void switchCamera()} disabled={recording}><Icon name="refresh" size={18} />{facing === "environment" ? "Đổi sang camera trước" : "Đổi sang camera sau"}</button></div></details>
        </section> : null}

        {step === 1 ? <section className="step-card" aria-labelledby="intent-title">
          <div className="step-heading"><span className="step-kicker">BƯỚC 2 / 5</span><h1 id="intent-title">Video này cần nói điều gì?</h1><p>Hình ảnh là tư liệu. Ý muốn chia sẻ và phong cách của bạn quyết định kịch bản.</p></div>
          <div className="creator-context"><span><Icon name="studio" size={17} />{accountProfile.channel || accountProfile.audience || accountProfile.customPrompt ? `Phong cách: ${accountProfile.channel || accountProfile.name || "của bạn"}` : "Thêm phong cách để AI hiểu bạn hơn"}</span><button className="text-button" onClick={()=>setView("profile")} disabled={working}>Hiểu về tôi<Icon name="arrow" size={15} /></button></div>

          <details className="clip-details"><summary><Icon name="play" size={16} /><span>Video của bạn · {time(project.duration)}</span><span>Xem lại</span></summary><video ref={previewVideo} src={sourceUrl} controls playsInline preload="metadata" />{!project.duration ? <label className="field-label">Thời lượng video (giây)<input type="number" min="2" max="90" value={project.duration || ""} onChange={event => update({ duration: Number(event.target.value) })} /></label> : null}</details>
          {!project.analysis ? <div className="intent-input"><label className="field-label" htmlFor="story-intent">Điều bạn muốn người xem hiểu</label><textarea id="story-intent" className="intent-textarea" value={project.intent} onChange={event => update({ intent: event.target.value })} disabled={intentRecording} placeholder="Ví dụ: Tôi muốn kể cảm giác vui khi thấy chùm nho đầu tiên trong vườn…" rows={4} /><div className="intent-record-row"><button className={`button secondary ${intentRecording ? "listening" : ""}`} onClick={() => void toggleIntentRecording()} disabled={recording || Boolean(busy) || !speechSupported}><Icon name={intentRecording ? "close" : "mic"} size={19} />{intentRecording ? "Dừng nghe" : "Nói ý tưởng thay vì gõ"}</button>{intentRecording ? <span className="record-label"><i />Đang nghe bạn</span> : null}</div>{intentInterim ? <p className="live-transcript" role="status">{intentInterim}</p> : null}{!speechSupported ? <p className="helper-text">Trình duyệt này chưa nhận giọng nói. Bạn có thể gõ trực tiếp vào ô phía trên.</p> : <p className="helper-text">Giọng nói được trình duyệt chuyển thành chữ. Hãy đọc lại và sửa nếu cần.</p>}</div> : <div className="understood-intent"><label className="field-label" htmlFor="story-summary"><Icon name="studio" size={18} />Thông điệp bạn muốn người xem nhận được</label><textarea id="story-summary" value={project.summary} onChange={event => update({ summary: event.target.value })} rows={3} /><p>Đây là ý định, chưa phải lời thoại. Hãy chỉnh cho đúng rồi chọn một hướng bên dưới.</p><AnalysisEvidence analysis={project.analysis} facts={project.profile.facts} onFacts={facts => updateProfile({ facts })} /><details className="quiet-details original-intent"><summary>Sửa lời dặn ban đầu<Icon name="chevron" size={16} /></summary><textarea aria-label="Lời dặn ban đầu" value={project.intent} onChange={event => update({ intent: event.target.value })} rows={3} /><button className="button secondary" onClick={() => void analyze()} disabled={Boolean(busy)}>{busy === "analyze" ? <Spinner /> : <Icon name="refresh" size={17} />}Hiểu lại video</button></details></div>}
          {project.analysis ? <details className="quiet-details change-format"><summary>Đổi dạng video<Icon name="chevron" size={16} /></summary><fieldset className="format-picker"><legend>Bạn muốn làm video dạng nào?</legend><div>{FORMATS.map(format=><button type="button" key={format.id} className={project.format===format.id ? "active" : ""} aria-pressed={project.format===format.id} disabled={Boolean(busy)} onClick={()=>update({format:format.id,angleId:""})}><strong>{format.name}</strong><span>{format.note}</span></button>)}</div></fieldset></details> : <fieldset className="format-picker"><legend>Bạn muốn làm video dạng nào?</legend><div>{FORMATS.map(format=><button type="button" key={format.id} className={project.format===format.id ? "active" : ""} aria-pressed={project.format===format.id} disabled={Boolean(busy)} onClick={()=>update({format:format.id,angleId:""})}><strong>{format.name}</strong><span>{format.note}</span></button>)}</div></fieldset>}
          {project.analysis && angles.length ? <AngleChoices angles={angles} selected={project.angleId} recommended={String(project.analysis.recommendedAngleId || "")} onSelect={angle=>update({angleId:angle.id,format:angle.format})} disabled={Boolean(busy)} /> : null}
          <details className="quiet-details context-details"><summary>Điều chỉnh riêng cho video này<Icon name="chevron" size={16} /></summary><div className="form-grid"><label className="field-label" htmlFor="audience">Bạn kể cho ai?<input id="audience" value={project.profile.audience} onChange={event => updateProfile({ audience: event.target.value })} placeholder="Ví dụ: người mới trồng nho" /></label><label className="field-label" htmlFor="tone">Bạn thích cách kể nào?<select id="tone" value={project.profile.tone} onChange={event => updateProfile({ tone: event.target.value })}><option>Gần gũi, tự nhiên</option><option>Chân thành, cảm xúc</option><option>Rõ ràng, hướng dẫn</option><option>Vui vẻ, dí dỏm</option><option>Chuyên nghiệp, tin cậy</option></select></label></div><label className="field-label" htmlFor="recording-mode">Trong video có lời nói sẵn không?<select id="recording-mode" value={project.mode} onChange={event => update({ mode: event.target.value as Project["mode"] })}><option value="scenery">Chỉ quay cảnh</option><option value="talking">Tôi vừa quay vừa nói</option><option value="face">Có người nói trước camera</option></select></label>{project.mode !== "scenery" ? <p className="helper-text">AI không nghe tiếng gốc. Hãy ghi lại ý chính hoặc lời cần giữ vào phần ý muốn chia sẻ.</p> : null}{project.mode === "face" ? <p className="inline-note"><Icon name="info" size={18} />Thay lời có thể lệch khẩu hình. Ứng dụng ghép giọng đọc, chưa đồng bộ chuyển động môi.</p> : null}<label className="field-label" htmlFor="facts">Những thông tin cần nói đúng<textarea id="facts" value={project.profile.facts} onChange={event => updateProfile({ facts: event.target.value })} placeholder="Tên, địa điểm, giá hoặc điều AI không được đoán…" rows={3} /></label><label className="field-label" htmlFor="cta">Cuối video, bạn muốn nhắn điều gì?<input id="cta" value={project.profile.cta} onChange={event => updateProfile({ cta: event.target.value })} placeholder="Có thể để trống" /></label></details>
          {analysisProgress ? <p className="working-note" role="status"><Spinner />{analysisProgress}</p> : null}<p className="helper-text analysis-disclosure">AI xem ảnh trích từ video. Hãy xác nhận lại cảnh và ý định trước khi viết lời thoại.</p><div className="step-actions"><button className="text-button" onClick={() => navigateStep(0)}>Quay lại</button><button className="button primary large" onClick={() => void (project.analysis ? generateScript() : analyze())} disabled={Boolean(busy) || intentRecording}>{busy === "analyze" || busy === "script" ? <Spinner /> : <Icon name={project.analysis ? "check" : "studio"} size={19} />}{busy === "analyze" ? "Đang xem video…" : busy === "script" ? "Đang viết lời thoại…" : project.analysis ? "Viết kịch bản này" : "Phân tích và gợi ý"}{!busy ? <Icon name="arrow" size={19} /> : null}</button></div>
          <button className="text-button manual-link" onClick={manualScript} disabled={Boolean(busy)}>Tôi muốn tự viết lời thoại</button>
        </section> : null}

        {step === 2 ? <section className="step-card" aria-labelledby="script-title">
          <div className="step-heading"><span className="step-kicker">BƯỚC 3 / 5</span><h1 id="script-title">Đọc lại lời kể của bạn</h1><p>Sửa những từ chưa giống mình. Bạn có thể viết trực tiếp vào từng đoạn.</p></div>
          <p className="script-purpose">{FORMATS.find(format=>format.id===project.format)?.name}{angles.find(angle=>angle.id===project.angleId)?.title ? ` · ${angles.find(angle=>angle.id===project.angleId)?.title}` : ""}</p><div className="script-summary"><span><Icon name="clock" size={17} />Video {time(project.duration)}</span><span>{words} từ</span></div>
          <div className="segments-list">{project.segments.length ? project.segments.map((segment, index) => <div className="segment-editor" key={`${project.id}-${index}`}><div className="segment-top"><label className="field-label" htmlFor={`segment-${index}`}>Đoạn {index + 1}</label><button className="icon-button" aria-label={`Xóa đoạn ${index + 1}`} onClick={() => update({ segments: project.segments.filter((_, position) => position !== index), narration: undefined })}><Icon name="trash" size={18} /></button></div><textarea id={`segment-${index}`} placeholder="Viết lời thoại ở đây…" value={segment.text} onChange={event => editSegment(index, { text: event.target.value })} rows={4} /><details className="segment-timing"><summary><Icon name="clock" size={15} />{time(segment.start)} – {time(segment.end)}<span>Chỉnh thời gian</span></summary><div><label>Bắt đầu (giây)<input type="number" step="0.1" min="0" max={project.duration} value={segment.start} onChange={event => editSegment(index, { start: Number(event.target.value) })} /></label><label>Kết thúc (giây)<input type="number" step="0.1" min="0" max={project.duration} value={segment.end} onChange={event => editSegment(index, { end: Number(event.target.value) })} /></label></div></details></div>) : <div className="empty-small"><Icon name="file" size={32} /><p>Thêm một đoạn để bắt đầu viết lời kể.</p></div>}</div>
          <button className="text-button add-segment" onClick={addSegment}><Icon name="plus" size={18} />Thêm đoạn lời</button>
          <details className="quiet-details rewrite-details"><summary>Nhờ AI viết lại<Icon name="chevron" size={16} /></summary><label className="field-label" htmlFor="rewrite-instruction">Bạn muốn sửa thế nào?<input id="rewrite-instruction" disabled={Boolean(busy)} value={scriptInstruction} onChange={event => setScriptInstruction(event.target.value)} placeholder="Ví dụ: ngắn hơn, kể gần gũi hơn…" /></label><button className="button secondary" onClick={() => void generateScript()} disabled={Boolean(busy) || !config.deepseek || !project.analysis}>{busy === "script" ? <Spinner /> : <Icon name="studio" size={17} />}{busy === "script" ? "Đang viết lại…" : "Viết lại lời thoại"}</button>{!project.analysis ? <p className="helper-text">Hiểu video ở bước trước để AI có đủ ngữ cảnh.</p> : null}</details>
          <div className="step-actions"><button className="text-button" onClick={() => navigateStep(1)}>Quay lại</button><button className="button primary large" onClick={() => navigateStep(3)} disabled={!project.segments.some(segment => segment.text.trim()) || Boolean(busy)}>Chọn giọng đọc<Icon name="arrow" size={19} /></button></div>
        </section> : null}

        {step === 3 ? <section className="step-card" aria-labelledby="voice-title">
          <div className="step-heading"><span className="step-kicker">BƯỚC 4 / 5</span><h1 id="voice-title">Để giọng nói kể câu chuyện</h1><p>Chọn một giọng, tạo lời đọc rồi nghe thử trước khi ghép video.</p></div>
          {config.eleven ? <div className="voice-selection"><div className="field-row"><label className="field-label" htmlFor="voice-selection">Giọng đọc</label><button className="text-button" onClick={() => void loadVoices()} disabled={voicesLoading}><Icon name="refresh" size={16} />{voicesLoading ? "Đang tải…" : "Làm mới"}</button></div><VoiceFilter value={voiceFilter} onChange={setVoiceFilter} voices={voices} /><select id="voice-selection" value={project.voiceId} disabled={busy === "speech"} onChange={event => update({ voiceId: event.target.value })}><option value="">Chọn giọng bạn muốn dùng</option>{selectedVoice && !filteredVoices.includes(selectedVoice) ? <option value={project.voiceId}>{selectedVoice.name} · đang chọn</option> : null}{filteredVoices.map(voice => <option key={voice.voice_id || voice.id} value={voice.voice_id || voice.id}>{voice.name}{voice.category === "cloned" ? " · Giọng cá nhân" : ""}</option>)}</select>{selectedVoice ? <div className="selected-voice-preview"><VoiceDetail voice={selectedVoice} /></div> : null}{!voicesLoading && voiceFilter === "vietnamese" && !filteredVoices.length ? <p className="helper-text">Chưa tải được thư viện tiếng Việt. Bấm Làm mới hoặc xem nhóm Giọng có sẵn.</p> : null}<p className="voice-plan-note">Giọng thư viện qua app cần gói ElevenLabs Starter trở lên của quản trị viên.</p><p className="helper-text">Nghe mẫu để chọn chất giọng. Nhóm phổ biến có thể gồm giọng quốc tế; lời đọc mới luôn dùng tiếng Việt.</p><button className="text-button voice-library-link" onClick={() => setView("voices")} disabled={working}>Xem thư viện và giọng cá nhân<Icon name="arrow" size={16} /></button></div> : <div className="inline-note"><Icon name="info" size={20} /><span>Giọng đọc AI chưa sẵn sàng. Bạn có thể dùng một bản thu lời thoại có sẵn.</span></div>}
          {!project.narration && project.segments.some(segment => segment.audioBase64) ? <div className="speech-previews"><h2>Nghe thử lời đọc</h2>{project.segments.map((segment, index) => segment.audioBase64 ? <div className="speech-preview" key={index}><span>Đoạn {index + 1} · {time(segment.start)} – {time(segment.end)}</span><p>{segment.text}</p><audio controls src={`data:${segment.mimeType || segment.audioMime || "audio/mpeg"};base64,${segment.audioBase64}`} /></div> : null)}<button className="text-button" onClick={() => void generateSpeech()} disabled={Boolean(busy)}><Icon name="refresh" size={16} />Tạo lại giọng đọc</button></div> : null}
          <details className="quiet-details manual-narration" open={project.narration ? true : undefined}><summary>Đã có bản thu lời thoại?<Icon name="chevron" size={16} /></summary><p className="helper-text">Tải bản thu của bạn để dùng thay lời đọc AI. Bản thu bắt đầu từ đầu video.</p><button className="button secondary" onClick={() => narrationInput.current?.click()} disabled={Boolean(busy) || narrationChecking}>{narrationChecking ? <Spinner /> : <Icon name="upload" size={18} />}{narrationChecking ? "Đang kiểm tra bản thu…" : project.narration ? "Chọn bản thu khác" : "Tải bản thu lời thoại"}</button>{narrationUrl ? <div className="narration-preview"><div><strong>{project.narrationName}</strong><button className="icon-button" aria-label="Xóa bản thu lời thoại" onClick={() => update({ narration: undefined })}><Icon name="trash" size={18} /></button></div><audio controls src={narrationUrl} /><NarrationTiming duration={project.narrationDuration} videoDuration={project.duration} /></div> : null}</details>
          <div className="step-actions"><button className="text-button" onClick={() => navigateStep(2)}>Quay lại</button>{narrationReady ? <button className="button primary large" onClick={() => navigateStep(4)} disabled={narrationTooLong || narrationChecking || Boolean(busy)}>Dùng lời đọc này<Icon name="arrow" size={19} /></button> : <button className="button primary large" onClick={() => void generateSpeech()} disabled={!config.eleven || !project.voiceId || Boolean(busy)}>{busy === "speech" ? <Spinner /> : <Icon name="sound" size={19} />}{busy === "speech" ? "Đang tạo giọng đọc…" : "Tạo giọng đọc"}</button>}</div>
        </section> : null}

        {step === 4 ? <section className="step-card" aria-labelledby="export-title">
          <div className="step-heading"><span className="step-kicker">BƯỚC 5 / 5</span><h1 id="export-title">Video sẵn sàng để chia sẻ</h1><p>{exported ? "Xem lại một lần rồi tải câu chuyện của bạn về máy." : "Ghép giọng đọc vào video để có một tệp hoàn chỉnh."}</p></div>
          <div className="export-preview"><video src={exportedUrl || sourceUrl} controls playsInline preload="metadata" /></div><p className="preview-caption">{exported ? <><Icon name="check" size={16} />Đã ghép lời đọc · MP4 · {fileSize(exported.size)}</> : "Đang xem video gốc. Bấm Ghép video để thêm lời đọc."}</p>
          {project.narration ? <NarrationTiming duration={project.narrationDuration} videoDuration={project.duration} /> : null}
          <details className="quiet-details export-options"><summary>Tùy chọn âm thanh<Icon name="chevron" size={16} /></summary><label className="checkbox-row"><input type="checkbox" checked={project.keepAmbient} disabled={busy === "export"} onChange={event => update({ keepAmbient: event.target.checked })} /><span><strong>Giữ nhẹ tiếng môi trường</strong><span>Trộn tiếng gốc nhỏ dưới giọng đọc.</span></span></label>{project.mode !== "scenery" && project.keepAmbient ? <p className="inline-note"><Icon name="info" size={18} />Video gốc có lời nói. Giữ âm thanh có thể làm chồng hai giọng.</p> : null}</details>
          {busy === "export" ? <div className="export-progress" role="status"><div><span><Spinner />Đang ghép video…</span><strong>{Math.round(exportProgress)}%</strong></div><progress max={100} value={exportProgress} /><p>{exportMessage || "Giữ trang này mở trong lúc xuất video."}</p></div> : null}
          <div className="step-actions"><button className="text-button" onClick={() => navigateStep(3)} disabled={Boolean(busy)}>Quay lại</button>{exported ? <a className="button primary large" href={exportedUrl} download={videoDownloadName(project.title)}><Icon name="download" size={20} />Tải video MP4</a> : <button className="button primary large" onClick={() => void exportVideo()} disabled={!narrationReady || narrationTooLong || narrationChecking || Boolean(busy)}>{busy === "export" ? <Spinner /> : <Icon name="studio" size={19} />}{busy === "export" ? "Đang ghép…" : "Ghép video"}</button>}</div>
          {exported && exportedUrl ? <div className="download-options">{supportsVideoSave() ? <button className="button secondary" onClick={()=>void saveExport()}><Icon name="folder" size={18} />Lưu vào thư mục…</button> : null}{canShareVideoFile(exported,project.title) ? <button className="button secondary" onClick={()=>void shareExport()}>Chia sẻ tệp video</button> : null}<a className="text-button" href={exportedUrl} target="_blank" rel="noopener">Mở video để lưu<Icon name="arrow" size={16} /></a><p>Nếu trình duyệt chặn tải trực tiếp, mở video rồi dùng menu lưu hoặc chia sẻ. Hãy lưu video trước khi đóng trang.</p></div> : null}
          <p className="export-footnote">Tệp MP4 dùng được với CapCut và Facebook. Hãy xem lại trước khi đăng.</p>
        </section> : null}
      </> : null}

      {view === "profile" ? <section className="step-card creator-page" aria-labelledby="creator-title"><div className="step-heading"><span className="step-kicker">PHONG CÁCH RIÊNG CỦA BẠN</span><h1 id="creator-title">Để AI hiểu bạn hơn</h1><p>Điền một lần, dùng cho nhiều video. Viết bằng cách nói tự nhiên của bạn.</p></div><ProfileEditor profile={accountProfile} onChange={changes=>setAccountProfile(current=>({...current,...changes}))} />{settingsError ? <p className="settings-error" role="alert">{settingsError}</p> : null}<div className="step-actions"><button className="text-button" onClick={()=>setView("studio")}>Quay lại video</button><button className="button primary large" onClick={()=>void saveSettings()} disabled={settingsSaving || !config.authenticated}>{settingsSaving ? <Spinner /> : <Icon name="check" size={18} />}{settingsSaving ? "Đang lưu…" : "Lưu phong cách của tôi"}</button></div>{!config.authenticated ? <p className="helper-text"><a href="/dang-nhap">Đăng nhập</a> để lưu hồ sơ riêng trong tài khoản.</p> : null}</section> : null}

      {view === "projects" ? <section className="library-page"><div className="view-heading"><div><h1>Video của tôi</h1><p>Tiếp tục những câu chuyện bạn đã bắt đầu.</p></div><button className="button primary" onClick={newProject}><Icon name="plus" size={19} />Tạo video</button></div>{projects.length ? <div className="project-grid">{projects.map(item => <ProjectCard key={item.id} project={item} onOpen={() => openProject(item)} onExport={() => void exportProject(item)} onDelete={() => setDeleteTarget(item)} />)}</div> : <div className="large-empty"><span className="empty-icon"><Icon name="folder" size={36} /></span><h2>Chưa có video nào</h2><p>Quay video đầu tiên để bắt đầu câu chuyện của bạn.</p><button className="button primary large" onClick={newProject}><Icon name="camera" size={19} />Tạo video đầu tiên</button></div>}<div className="library-bottom"><p><Icon name="lock" size={16} />Dự án lưu trong trình duyệt này. Tải bản sao để giữ hoặc chuyển thiết bị.</p><button className="text-button" onClick={() => uploadInput.current?.click()}><Icon name="upload" size={17} />Nhập bản sao dự án</button></div></section> : null}

      {view === "voices" ? <section className="library-page"><div className="view-heading"><div><h1>Giọng của tôi</h1><p>Nghe mẫu, rồi chọn giọng hợp câu chuyện.</p></div><button className="button secondary" onClick={() => void loadVoices()} disabled={!config.eleven || voicesLoading}><Icon name="refresh" size={18} />{voicesLoading ? "Đang tải…" : "Làm mới"}</button></div><VoiceFilter value={voiceFilter} onChange={setVoiceFilter} voices={voices} /><p className="voice-plan-note">Giọng thư viện qua app cần gói ElevenLabs Starter trở lên của quản trị viên.</p><p className="voice-library-note">Tiếng Việt được ưu tiên theo mục đích kể chuyện, review và video mạng xã hội. Số người đã thêm lấy từ ElevenLabs, không phải điểm đánh giá chất lượng.</p><div className="step-card voice-library-card">{!config.eleven ? <div className="empty-small"><Icon name="mic" size={36} /><h2>Giọng đọc AI chưa sẵn sàng</h2><p>Quản trị viên sẽ kết nối tính năng này cho tài khoản của bạn.</p></div> : voicesLoading ? <div className="empty-small"><Spinner /><p>Đang tải những giọng bạn có thể dùng…</p></div> : filteredVoices.length ? <div className="voice-list">{filteredVoices.map(voice => <div className="voice-list-item" key={voice.voice_id || voice.id}><span className="voice-avatar"><Icon name="mic" size={22} /></span><div><strong>{voice.name}</strong><VoiceDetail voice={voice} /></div><button className={`button ${project.voiceId === (voice.voice_id || voice.id) ? "selected-voice" : "secondary"}`} onClick={() => { update({ voiceId: voice.voice_id || voice.id || "", step: hasClip && project.segments.some(segment => segment.text.trim()) ? 3 : step }); notify(`Đã chọn giọng ${voice.name}.`, "success"); if(hasClip) setView("studio"); }}>{project.voiceId === (voice.voice_id || voice.id) ? <><Icon name="check" size={17} />Đã chọn</> : "Dùng giọng"}</button></div>)}</div> : <div className="empty-small"><Icon name="mic" size={36} /><h2>Chưa có giọng trong nhóm này</h2><p>Thử làm mới hoặc chọn nhóm Tất cả. Bạn có thể thêm giọng cá nhân ở bên dưới.</p></div>}</div><details className="step-card clone-card"><summary><span><Icon name="plus" size={21} /><strong>Thêm giọng cá nhân</strong></span><Icon name="chevron" size={19} /></summary><div className="clone-form"><p>Chọn bản thu rõ tiếng, tự nhiên và ít tiếng ồn, nên dài 1–2 phút. Nhân bản giọng cần gói ElevenLabs Starter trở lên.</p><label className="field-label" htmlFor="clone-name">Đặt tên giọng<input id="clone-name" value={cloneName} onChange={event => setCloneName(event.target.value)} placeholder="Ví dụ: Giọng kể của tôi" /></label><label className="clone-upload" htmlFor="voice-samples"><Icon name="upload" size={24} /><strong>{cloneFiles.length ? `${cloneFiles.length} bản thu đã chọn` : "Chọn bản thu mẫu"}</strong><span>MP3, WAV hoặc M4A · có thể chọn nhiều tệp</span><input id="voice-samples" type="file" accept="audio/*" multiple onChange={event => setCloneFiles(Array.from(event.target.files || []))} /></label>{cloneFiles.length ? <ul className="sample-files">{cloneFiles.map(file => <li key={`${file.name}-${file.size}`}><Icon name="file" size={16} />{file.name}<span>{fileSize(file.size)}</span></li>)}</ul> : null}<label className="checkbox-row consent-row"><input type="checkbox" checked={cloneConsent} onChange={event => setCloneConsent(event.target.checked)} /><span>Đây là giọng của tôi, hoặc tôi có sự đồng ý của chủ giọng để tạo và sử dụng giọng AI.</span></label><button className="button primary" onClick={() => void cloneVoice()} disabled={!config.eleven || Boolean(busy) || !cloneConsent || !cloneFiles.length || !cloneName.trim()}>{busy === "clone" ? <Spinner /> : <Icon name="mic" size={19} />}{busy === "clone" ? "Đang tạo giọng…" : "Tạo giọng cá nhân"}</button></div></details>{hasClip ? <button className="text-button return-studio" onClick={() => setView("studio")}>Quay lại video đang làm<Icon name="arrow" size={17} /></button> : null}</section> : null}

      {view === "guide" ? <section className="step-card guide-page"><div className="step-heading"><h1>5 bước để kể câu chuyện của bạn</h1><p>Bắt đầu từ một video, rồi làm lần lượt từng bước.</p></div><ol className="guide-list"><li><strong>Thêm video</strong><p>Quay trực tiếp hoặc chọn video dài 2–90 giây từ thiết bị.</p></li><li><strong>Nói ý muốn chia sẻ</strong><p>Gõ hoặc ghi âm điều bạn muốn người xem hiểu. Kiểm tra lại ý mà AI đề xuất.</p></li><li><strong>Chỉnh lời thoại</strong><p>Đọc lại và sửa từ ngữ theo cách nói của mình. Bạn cũng có thể tự viết toàn bộ.</p></li><li><strong>Chọn giọng đọc</strong><p>Dùng giọng AI hoặc tải bản thu có sẵn. Nghe thử trước khi ghép.</p></li><li><strong>Ghép và tải về</strong><p>Tạo tệp MP4 hoàn chỉnh, xem lại và tải về để chia sẻ.</p></li></ol><p className="inline-note"><Icon name="folder" size={20} />Dự án tự lưu trong trình duyệt. Dùng “Tải bản sao dự án” trong menu dấu ba chấm để giữ cả video gốc, lời thoại và giọng đọc.</p><button className="button primary large" onClick={() => setView("studio")}>Bắt đầu tạo video<Icon name="arrow" size={19} /></button></section> : null}
      <footer className="app-footer"><span>Lời Kể<span className="brand-dot">.</span> Câu chuyện của bạn, giọng nói của bạn.</span><button onClick={() => setView("guide")} disabled={working}>Cần hướng dẫn?</button></footer>
    </main>

    <input ref={uploadInput} className="visually-hidden" type="file" accept="video/*,.loike,.json" aria-label="Chọn video hoặc bản sao dự án" onChange={event => { void ingestFile(event.target.files?.[0]); event.target.value = ""; }} />
    <input ref={narrationInput} className="visually-hidden" type="file" accept="audio/*" aria-label="Chọn tệp lời thoại" onChange={event => { void ingestNarration(event.target.files?.[0]); event.target.value = ""; }} />
    {notice ? <div className={`toast ${notice.type}`} role={notice.type === "error" ? "alert" : "status"}><Icon name={notice.type === "success" ? "check" : "info"} size={21} /><p>{notice.text}</p><button className="icon-button" onClick={() => setNotice(null)} aria-label="Đóng thông báo"><Icon name="close" size={19} /></button></div> : null}
    {settingsOpen ? <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !settingsSaving) setSettingsOpen(false); }}><section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-header"><h2 id="settings-title">Hồ sơ và kết nối</h2><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Đóng cài đặt" disabled={settingsSaving}><Icon name="close" size={22} /></button></div><div className="modal-scroll">{settingsError ? <div className="settings-error" role="alert"><p>{settingsError}</p>{loginRequired ? <a href="/dang-nhap">Đăng nhập vào tài khoản của bạn</a> : null}</div> : null}<ProfileEditor profile={accountProfile} onChange={changes=>setAccountProfile(current=>({...current,...changes}))} prefix="settings-profile" /><div className="managed-ai"><h3>AI do quản trị viên kết nối</h3><div><span>Hiểu video và viết lời thoại</span><span className={config.deepseek ? "ready" : ""}>{config.deepseek ? "Sẵn sàng" : "Chưa sẵn sàng"}</span></div><div><span>Tạo giọng đọc</span><span className={config.eleven ? "ready" : ""}>{config.eleven ? "Sẵn sàng" : "Chưa sẵn sàng"}</span></div>{config.quota ? <p>Bạn đã dùng <strong>{config.quota.used}/{config.quota.limit}</strong> lượt AI.</p> : null}{config.isAdmin ? <a className="text-button" href="/quan-tri">Mở trang quản trị<Icon name="arrow" size={17} /></a> : null}</div>{configError ? <div className="settings-error"><p>{configError}</p><button className="text-button" onClick={() => void refreshConfiguration()} disabled={configRefreshing}>{configRefreshing ? "Đang thử…" : "Thử kết nối lại"}</button></div> : null}<p className="helper-text">Hồ sơ lưu trong tài khoản. Video và dự án được giữ trong trình duyệt trên thiết bị này.</p></div><div className="modal-footer"><button className="button secondary" onClick={() => setSettingsOpen(false)} disabled={settingsSaving}>Đóng</button><button className="button primary" onClick={() => void saveSettings()} disabled={settingsSaving}>{settingsSaving ? <Spinner /> : <Icon name="check" size={18} />}{settingsSaving ? "Đang lưu…" : "Lưu hồ sơ"}</button></div></section></div> : null}
    {deleteTarget ? <div className="modal-backdrop"><section className="modal delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><div className="modal-header"><h2 id="delete-title">Xóa video này?</h2><button className="icon-button" onClick={() => setDeleteTarget(null)} aria-label="Đóng"><Icon name="close" /></button></div><div className="modal-scroll"><p>Dự án “{deleteTarget.title}” và video lưu kèm sẽ bị xóa khỏi trình duyệt này. Hãy tải bản sao trước nếu bạn muốn giữ lại.</p></div><div className="modal-footer"><button className="button secondary" onClick={() => setDeleteTarget(null)}>Giữ lại</button><button className="button danger" onClick={() => void deleteProject()}>Xóa dự án</button></div></section></div> : null}
  </div>;
}

function Spinner() { return <span className="spinner" aria-hidden="true" />; }
function ProfileEditor({profile,onChange,prefix="creator"}:{profile:Profile;onChange:(changes:Partial<Profile>)=>void;prefix?:string}) {
  const field = (key:keyof Profile,label:string,placeholder:string,rows?:number) => <label className="field-label" htmlFor={`${prefix}-${key}`} key={key}>{label}{rows ? <textarea id={`${prefix}-${key}`} value={profile[key]} onChange={event=>onChange({[key]:event.target.value})} placeholder={placeholder} rows={rows} maxLength={key==="facts" || key==="customPrompt" ? 4000 : 800} /> : <input id={`${prefix}-${key}`} value={profile[key]} onChange={event=>onChange({[key]:event.target.value})} placeholder={placeholder} maxLength={800} />}</label>;
  return <div className="creator-fields">{field("channel","Tên kênh hoặc thương hiệu","Ví dụ: Vườn nho của Minh")}{field("topic","Bạn thường chia sẻ về điều gì?","Ví dụ: Chuyện làm vườn và kinh nghiệm trồng nho tại nhà.",2)}{field("audience","Bạn muốn chia sẻ với ai?","Ví dụ: Người mới trồng nho tại nhà")}
    {field("tone","Cách nói bạn thích","Ví dụ: Gần gũi, chân thật, câu ngắn")}
    {field("customPrompt","Lời dặn riêng cho AI","Ví dụ: Trò chuyện như với khách quen. Mỗi video có một ý hữu ích, tránh phóng đại và mô tả lại từng cảnh.",3)}
    <details className="quiet-details profile-extras"><summary>Thông tin bổ sung <span>Không bắt buộc</span><Icon name="chevron" size={16} /></summary><div className="creator-fields">{field("name","Tên của bạn","Bạn muốn AI gọi bạn là gì?")}{field("pronoun","Cách xưng hô","Ví dụ: mình – bạn, em – anh chị")}{field("facts","Thông tin nền AI cần biết","Tên sản phẩm, địa điểm và những điều đã được bạn xác nhận.",3)}{field("cta","Lời nhắn cuối video thường dùng","Ví dụ: Bạn đang gặp vấn đề gì khi trồng nho? Có thể để trống.")}</div></details>
    <p className="helper-text">Hồ sơ được lưu riêng trong tài khoản và dùng làm phong cách mặc định. Lời dặn của từng video được ưu tiên hơn.</p></div>;
}
function AngleChoices({angles,selected,recommended,onSelect,disabled}:{angles:Angle[];selected:string;recommended:string;onSelect:(angle:Angle)=>void;disabled:boolean}) {
  return <fieldset className="angle-picker"><legend>Chọn một hướng để AI viết kịch bản</legend><p>Ba ý tưởng từ cùng tư liệu. Bạn chỉ tạo lời đọc cho kịch bản đã chọn.</p><div>{angles.map(angle=><button type="button" key={angle.id} className={selected===angle.id ? "active" : ""} aria-pressed={selected===angle.id} disabled={disabled} onClick={()=>onSelect(angle)}><span className="angle-meta">{FORMATS.find(format=>format.id===angle.format)?.name}{recommended===angle.id ? <em>AI gợi ý</em> : null}</span><strong>{angle.title}</strong><span>{angle.purpose}</span><q>{angle.hook}</q><small>{angle.reason}</small><b>{selected===angle.id ? "Đã chọn hướng này" : "Chọn hướng này"}</b></button>)}</div></fieldset>;
}
function VoiceFilter({value,onChange,voices}:{value:string;onChange:(value:string)=>void;voices:Voice[]}) { return <div className="voice-filters" aria-label="Nhóm giọng đọc">{[...VOICE_GROUPS,{id:"all",name:"Tất cả"}].map(group=><button key={group.id} type="button" aria-pressed={value===group.id} className={value===group.id ? "active" : ""} onClick={()=>onChange(group.id)}>{group.name}<span>{voices.filter(voice=>group.id==="all" || (voice.group || (voice.category==="cloned" ? "personal" : "default"))===group.id).length}</span></button>)}</div>; }
function VoiceDetail({voice}:{voice:Voice}) {
  const accentLabels:Record<string,string> = {northern:"Miền Bắc",southern:"Miền Nam",central:"Miền Trung",standard:"Phổ thông"};
  const accent=voice.accent ? accentLabels[voice.accent.toLowerCase()] || voice.accent : "";
  return <><p className="voice-meta">{voice.group==="vietnamese" ? "Tiếng Việt" : voice.language ? voice.language.toUpperCase() : "Giọng đa ngôn ngữ"}{accent ? ` · ${accent}` : ""}{typeof voice.users==="number" ? <span className="voice-popularity">{new Intl.NumberFormat("vi-VN").format(voice.users)} người đã thêm</span> : null}</p>{voice.preview_url ? <audio aria-label={`Nghe mẫu ${voice.name}`} controls preload="none" src={voice.preview_url} /> : null}{voice.description ? <details className="voice-description-details"><summary>Mô tả chất giọng<Icon name="chevron" size={14} /></summary><p className="voice-description">{voice.description}</p></details> : null}</>;
}
function NarrationTiming({ duration, videoDuration }: { duration?: number; videoDuration: number }) {
  if (!duration) return <p className="narration-timing">Chưa đọc được thời lượng. Bộ xuất sẽ kiểm tra tệp trước khi ghép.</p>;
  const tooLong = duration > videoDuration + 0.001;
  return <p className={`narration-timing ${tooLong ? "too-long" : ""}`}><Icon name={tooLong ? "info" : "clock"} size={13} />{tooLong ? `Bản thu ${duration.toFixed(1)} giây dài hơn video ${videoDuration.toFixed(1)} giây. Chọn bản ngắn hơn để giữ trọn lời.` : `Bản thu ${duration.toFixed(1)} giây · bắt đầu tại 00:00.${videoDuration - duration > 0.5 ? ` Cuối video còn ${(videoDuration - duration).toFixed(1)} giây không có lời đọc.` : ""}`}</p>;
}
function AnalysisEvidence({ analysis, facts, onFacts }: { analysis: Record<string, unknown>; facts: string; onFacts: (value: string) => void }) {
  const questions = Array.isArray(analysis.questions) ? analysis.questions.map(String) : [];
  const observations = Array.isArray(analysis.observations) ? analysis.observations as { start: number; end: number; description: string }[] : [];
  return <><details className="analysis-evidence"><summary><Icon name="eye" size={14} />AI đã nhìn thấy gì?<Icon name="plus" size={13} /></summary><p>{String(analysis.summary || "")}</p>{observations.length ? <ul>{observations.map((item, index) => <li key={index}><span>{time(Number(item.start))} – {time(Number(item.end))}</span>{item.description}</li>)}</ul> : null}</details>{questions.length ? <details className="analysis-questions"><summary>AI cần bạn làm rõ <span>{questions.length} câu hỏi</span><Icon name="chevron" size={15} /></summary><ul>{questions.map((question, index) => <li key={index}>{question}</li>)}</ul><label className="field-label" htmlFor="confirmed-facts">Bổ sung thông tin đúng trước khi viết lời</label><textarea id="confirmed-facts" value={facts} onChange={event => onFacts(event.target.value)} rows={3} placeholder="Trả lời những điều cần thiết. Nếu chưa rõ, hãy yêu cầu AI bỏ chi tiết đó." /></details> : null}</>;
}
function ProjectCard({ project, onOpen, onExport, onDelete }: { project: Project; onOpen: () => void; onExport: () => void; onDelete: () => void }) {
  const url = useBlobUrl(project.source);
  return <article className="project-card"><button className="project-thumbnail" onClick={onOpen} aria-label={`Mở ${project.title}`}>{url ? <video src={url} muted playsInline preload="metadata" /> : <Icon name="file" size={35} />}<span className="project-duration">{time(project.duration)}</span><span className="project-play"><Icon name="play" size={18} /></span></button><div className="project-card-content"><button className="project-title" onClick={onOpen}>{project.title}</button><p>{new Date(project.updatedAt).toLocaleDateString("vi-VN")}<span />{STEPS[project.step]}</p><div className="project-card-actions"><button className="text-button" onClick={onOpen}>Tiếp tục câu chuyện<Icon name="arrow" size={13} /></button><button className="icon-button" onClick={onExport} aria-label={`Tải bản sao ${project.title}`} title="Tải bản sao dự án"><Icon name="download" size={16} /></button><button className="icon-button" onClick={onDelete} aria-label={`Xóa ${project.title}`} title="Xóa dự án"><Icon name="trash" size={16} /></button></div></div></article>;
}
