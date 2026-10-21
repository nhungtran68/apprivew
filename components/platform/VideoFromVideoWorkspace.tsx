"use client";

import { useEffect, useRef, useState } from "react";
import { canShareVideoFile, saveVideoFile, shareVideoFile, supportsVideoSave, videoDownloadName } from "@/lib/video-download";
import type { StockAspectRatio } from "@/lib/video-export";
import styles from "./VideoFromVideoWorkspace.module.css";

type Voice = { voice_id?: string; voiceId?: string; id?: string; name: string; category?: string; preview_url?: string; previewUrl?: string };
type Builtin = { format: "review" | "story" | "tips" | "sales"; title: string; description: string };
type Template = { id: string; title: string; description?: string; scope: "shared" | "personal" };
type Profile = { name?: string; channel?: string; brand?: string; audience?: string; topic?: string; tone?: string; pronoun?: string; cta?: string; facts?: string; customPrompt?: string };
type Busy = "video" | "analyze" | "script" | "voice" | "recover" | "audio" | "export" | null;
type VoiceResult = { audioPath: string; audioUrl?: string; audioMime: string; duration: number; text: string; voiceId: string };
type VoiceTask = { requestId: string; text: string; voiceId: string; createdAt: string };

const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 90;
const MAX_SCRIPT_LENGTH = 1200;
const SESSION_KEY_PREFIX = "ibeetool:video-from-video:draft:v1:";

function errorMessage(value: unknown) { return value instanceof Error ? value.message : "Chưa hoàn tất. Hãy thử lại."; }
function clock(seconds: number) { const whole = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(whole / 60).toString().padStart(2, "0")}:${(whole % 60).toString().padStart(2, "0")}`; }
function voiceKey(voice: Voice) { return voice.voice_id || voice.voiceId || voice.id || ""; }
function useObjectUrl(blob?: Blob) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!blob) { setUrl(""); return; }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

async function readVideo(file: File): Promise<{ duration: number; width: number; height: number }> {
  if (!file.size || file.size > MAX_VIDEO_BYTES) throw new Error("Chọn video có dung lượng tối đa 60 MB.");
  if (!file.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) throw new Error("Chọn tệp video MP4, MOV hoặc WebM.");
  return new Promise((resolve, reject) => {
    const element = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (result?: { duration: number; width: number; height: number }, message?: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      element.removeAttribute("src"); element.load(); URL.revokeObjectURL(url);
      if (result) resolve(result); else reject(new Error(message || "Không đọc được video này. Hãy chọn tệp MP4 khác."));
    };
    const timer = window.setTimeout(() => finish(undefined, "Đọc video quá lâu. Hãy chọn tệp ngắn hơn hoặc thử trên máy tính."), 20000);
    element.preload = "metadata";
    element.muted = true;
    element.playsInline = true;
    element.onloadedmetadata = () => {
      const duration = element.duration, width = element.videoWidth, height = element.videoHeight;
      if (!Number.isFinite(duration) || duration < 2 || duration > MAX_AUDIO_SECONDS || !width || !height) {
        finish(undefined, "Bản thử hỗ trợ video dài từ 2 đến 90 giây, có hình ảnh đọc được.");
      } else finish({ duration, width, height });
    };
    element.onerror = () => finish();
    element.src = url;
    element.load();
  });
}

async function readAudioDuration(blob: Blob, fallback: number): Promise<number> {
  const measured = await new Promise<number | undefined>(resolve => {
    const element = document.createElement("audio");
    const url = URL.createObjectURL(blob);
    let settled = false;
    const finish = (value?: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      element.removeAttribute("src"); element.load(); URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(), 10000);
    element.preload = "metadata";
    element.onloadedmetadata = () => finish(Number.isFinite(element.duration) && element.duration > 0 ? element.duration : undefined);
    element.onerror = () => finish();
    element.src = url;
    element.load();
  });
  const duration = measured || fallback;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Chưa đo được thời lượng lời thoại. Hãy dùng nút lấy lại lời đọc.");
  return duration;
}

async function api(path: string, body: Record<string, unknown>, requestId = crypto.randomUUID()) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestId }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({})) as Record<string, any>;
  if (response.ok && response.status !== 202) window.dispatchEvent(new Event("studio-credits-changed"));
  if (!response.ok) throw Object.assign(new Error(typeof result.error === "string" ? result.error : result.error?.message || result.message || `Yêu cầu chưa hoàn tất (${response.status}).`), { code: result.code, status: response.status });
  return { status: response.status, result };
}

function scriptFrom(value: Record<string, any>): string {
  if (Array.isArray(value.segments)) return value.segments.map((item: Record<string, unknown>) => typeof item?.text === "string" ? item.text.trim() : "").filter(Boolean).join("\n\n");
  if (typeof value.script === "string") return value.script.trim();
  if (typeof value.text === "string") return value.text.trim();
  return "";
}

export default function VideoFromVideoWorkspace({ userId, deepseekReady, voiceReady, voices, voicesLoading, onReloadVoices, onBusyChange, builtins, templates, profile }: {
  userId: string;
  deepseekReady: boolean;
  voiceReady: boolean;
  voices: Voice[];
  voicesLoading: boolean;
  onReloadVoices: () => void;
  onBusyChange: (busy: boolean) => void;
  builtins: Builtin[];
  templates: Template[];
  profile: Profile;
}) {
  const [source, setSource] = useState<File>();
  const [sourceDuration, setSourceDuration] = useState(0);
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });
  const [ratio, setRatio] = useState<StockAspectRatio>("9:16");
  const [scriptType, setScriptType] = useState("builtin:review");
  const [intent, setIntent] = useState("");
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [approvedScript, setApprovedScript] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [pendingTask, setPendingTask] = useState<VoiceTask | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [readyVoice, setReadyVoice] = useState<VoiceResult | null>(null);
  const [generatedAudio, setGeneratedAudio] = useState<Blob>();
  const [generatedDuration, setGeneratedDuration] = useState(0);
  const [generatedText, setGeneratedText] = useState("");
  const [generatedVoiceId, setGeneratedVoiceId] = useState("");
  const [exported, setExported] = useState<Blob>();
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [hydratedUserId, setHydratedUserId] = useState("");
  const busyRef = useRef(false);
  const analysisRef = useRef<{ source: File; value: Record<string, unknown> } | null>(null);
  const voiceRequestRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const recoveryRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const onBusyChangeRef = useRef(onBusyChange);
  const sourceUrl = useObjectUrl(source);
  const audioUrl = useObjectUrl(generatedAudio);
  const exportedUrl = useObjectUrl(exported);
  const audioCurrent = Boolean(generatedAudio && generatedText === approvedScript && generatedVoiceId === voiceId);
  const selectedVoice = voices.find(item => voiceKey(item) === voiceId);

  useEffect(() => { onBusyChangeRef.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => { onBusyChangeRef.current(Boolean(busy)); }, [busy]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; recoveryRef.current?.abort(); onBusyChangeRef.current(false); }; }, []);
  useEffect(() => {
    setHydratedUserId("");
    recoveryRef.current?.abort();
    setSource(undefined); setSourceDuration(0); setSourceSize({ width: 0, height: 0 });
    setGeneratedAudio(undefined); setGeneratedDuration(0); setGeneratedText(""); setGeneratedVoiceId(""); setExported(undefined);
    setReadyVoice(null); setPendingTask(null); setRecoveryBlocked(false); setApprovedScript("");
    setIntent(""); setScriptType("builtin:review"); setScript(""); setTitle(""); setVoiceId("");
    analysisRef.current = null; voiceRequestRef.current = null;
    try {
      const value = JSON.parse(sessionStorage.getItem(`${SESSION_KEY_PREFIX}${userId}`) || "{}") as Record<string, any>;
      if (typeof value.intent === "string") setIntent(value.intent.slice(0, 5000));
      if (typeof value.scriptType === "string") setScriptType(value.scriptType);
      if (typeof value.script === "string") setScript(value.script.slice(0, 6000));
      if (typeof value.approvedScript === "string" && value.approvedScript === value.script?.trim()) setApprovedScript(value.approvedScript);
      if (typeof value.title === "string") setTitle(value.title.slice(0, 120));
      if (typeof value.voiceId === "string") setVoiceId(value.voiceId);
      if (value.pendingTask && typeof value.pendingTask.requestId === "string" && typeof value.pendingTask.text === "string" && typeof value.pendingTask.voiceId === "string") setPendingTask(value.pendingTask as VoiceTask);
    } catch { /* Session drafts are optional; corrupted storage never blocks creating a video. */ }
    setHydratedUserId(userId);
  }, [userId]);
  useEffect(() => {
    if (hydratedUserId !== userId) return;
    try { sessionStorage.setItem(`${SESSION_KEY_PREFIX}${userId}`, JSON.stringify({ intent, scriptType, script, approvedScript, title, voiceId, pendingTask })); }
    catch { /* Some browsers disable session storage. The in-memory draft remains available. */ }
  }, [userId, hydratedUserId, intent, scriptType, script, approvedScript, title, voiceId, pendingTask]);

  function begin(next: Busy) { if (busyRef.current) return false; busyRef.current = true; setBusy(next); setError(""); setNote(""); return true; }
  function end() { busyRef.current = false; if (mountedRef.current) setBusy(null); }

  async function chooseVideo(file?: File) {
    if (!file || !begin("video")) return;
    try {
      const info = await readVideo(file);
      const aspect = info.width / info.height;
      setSource(file); setSourceDuration(info.duration); setSourceSize({ width: info.width, height: info.height });
      setRatio(aspect > 1.2 ? "16:9" : aspect < 0.83 ? "9:16" : "1:1");
      setTitle(file.name.replace(/\.[^.]+$/, "").slice(0, 120));
      if (source) setScript("");
      setApprovedScript(""); setGeneratedAudio(undefined); setGeneratedDuration(0); setExported(undefined);
      analysisRef.current = null;
      setNote(`Đã nhận video ${clock(info.duration)}. Hãy chọn dạng kịch bản và cho AI biết điều muốn chia sẻ.`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { end(); }
  }

  async function analyzeAndWrite() {
    if (!source || !sourceDuration) { setError("Tải video lên trước khi tạo kịch bản."); return; }
    if (!deepseekReady) { setError("AI phân tích và viết kịch bản chưa sẵn sàng."); return; }
    if (!begin("analyze")) return;
    try {
      let analysis = analysisRef.current?.source === source ? analysisRef.current.value : undefined;
      if (!analysis) {
        setProgressText("Đang lấy các khung hình trong video…");
        const { sampleVideoFrames } = await import("@/lib/studio-frames");
        const frames = await sampleVideoFrames(source, sourceDuration, (_fraction, message) => { if (mountedRef.current) setProgressText(message); });
        setProgressText("AI đang xem video làm tư liệu…");
        const analyzed = await api("/api/analyze", { frames, duration: sourceDuration, intent: "", observationsOnly: true, profile: { ...profile, mode: "scenery" } });
        const value = analyzed.result.analysis || analyzed.result;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI chưa trả kết quả phân tích hợp lệ. Hãy thử lại.");
        analysis = value as Record<string, unknown>;
        analysisRef.current = { source, value: analysis };
      }
      setBusy("script"); setProgressText("AI đang viết lời thoại theo dạng kịch bản bạn chọn…");
      const purpose = intent.trim() || "Viết lời thoại có thông điệp hữu ích cho người xem từ tư liệu video. Chỉ dùng điều nhìn thấy; không đoán lời nói, trải nghiệm hoặc kết quả chưa được cung cấp.";
      const style = scriptType.startsWith("custom:") ? { templateId: scriptType.slice(7) } : { format: scriptType.replace(/^builtin:/, "") };
      const written = await api("/api/script", { analysis, intent: purpose, confirmedIntent: purpose, ...style, profile: { ...profile, mode: "scenery" }, duration: sourceDuration, instruction: "Viết lời thoại tự nhiên để đọc thành một tệp âm thanh liên tục. Tổng nội dung không quá 1.100 ký tự. Không thêm nhãn phân cảnh hay lời chỉ dẫn sân khấu." });
      const next = scriptFrom(written.result);
      if (!next) throw new Error("AI chưa viết được kịch bản. Bấm thử lại để dùng phân tích video đã có.");
      setScript(next); setApprovedScript(""); setExported(undefined);
      if (typeof written.result.title === "string" && written.result.title.trim()) setTitle(written.result.title.trim().slice(0, 120));
      setNote("Kịch bản đã sẵn sàng. Hãy đọc, sửa và duyệt trước khi tạo giọng.");
    } catch (cause) { setError(`${errorMessage(cause)} Video và bản nháp hiện có vẫn được giữ để thử lại.`); }
    finally { setProgressText(""); end(); }
  }

  function changeScript(next: string) { setScript(next); setApprovedScript(""); setExported(undefined); }
  function approveScript() {
    const cleaned = script.trim();
    if (cleaned.length < 12 || cleaned.length > MAX_SCRIPT_LENGTH) { setError("Lời thoại cần từ 12 đến 1.200 ký tự để tạo giọng. Hãy chỉnh lại kịch bản."); return; }
    setApprovedScript(cleaned); setError(""); setNote("Đã duyệt lời thoại. Chọn giọng và nghe thử trước khi ghép video.");
  }

  async function receiveVoice(result: VoiceResult) {
    setBusy("audio"); setProgressText("Đang nhận lời đọc đã tạo…");
    const { downloadSpeechSegments } = await import("@/lib/studio-upload");
    const [received] = await downloadSpeechSegments([{ start: 0, end: result.duration || 1, text: result.text, audioPath: result.audioPath, audioUrl: result.audioUrl, audioMime: result.audioMime }]);
    const binary = atob(received.audioBase64);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: received.mimeType });
    const duration = await readAudioDuration(blob, result.duration);
    setGeneratedAudio(blob); setGeneratedDuration(duration); setGeneratedText(result.text); setGeneratedVoiceId(result.voiceId);
    setPendingTask(null); setReadyVoice(null); voiceRequestRef.current = null; setExported(undefined);
    setNote(duration > MAX_AUDIO_SECONDS ? `Đã tạo lời đọc ${clock(duration)}, vượt giới hạn ghép 90 giây. Hãy rút gọn kịch bản và tạo lại giọng.` : `Đã tạo lời đọc ${clock(duration)}. Nghe thử rồi bấm Ghép video.`);
  }

  function validVoiceResult(value: Record<string, any>, task: VoiceTask): VoiceResult {
    if (typeof value.audioPath !== "string" || !value.audioPath || !["audio/mpeg", "audio/wav"].includes(value.audioMime)) throw new Error("Tác vụ đã hoàn tất nhưng chưa có tệp lời đọc hợp lệ. Bấm lấy lại lời đọc.");
    return { audioPath: value.audioPath, audioUrl: typeof value.audioUrl === "string" ? value.audioUrl : undefined, audioMime: value.audioMime, duration: Number(value.duration) || 0, text: task.text, voiceId: task.voiceId };
  }

  async function recoverVoice(task: VoiceTask, poll = false) {
    if (!begin("recover")) return;
    setRecoveryBlocked(false);
    const controller = new AbortController();
    recoveryRef.current = controller;
    try {
      const deadline = Date.now() + (poll ? 8 * 60_000 : 60_000);
      do {
        if (poll) await new Promise(resolve => window.setTimeout(resolve, 4000));
        if (controller.signal.aborted) return;
        const response = await fetch("/api/voice-over/recover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: task.requestId }), signal: controller.signal });
        const result = await response.json().catch(() => ({})) as Record<string, any>;
        if (response.status === 202 && result.pending === true) {
          setNote("Lời đọc vẫn đang được xử lý. Có thể lấy lại cùng tác vụ mà không tạo thêm lượt mới.");
          if (poll) continue;
          return;
        }
        if (!response.ok) {
          if (response.status === 409 || result.code === "MAZIAO_TASK_FAILED") setRecoveryBlocked(true);
          throw new Error(typeof result.error === "string" ? result.error : "Chưa lấy lại được lời đọc. Hãy thử lại sau.");
        }
        const audio = validVoiceResult(result, task);
        setReadyVoice(audio);
        setPendingTask(null);
        await receiveVoice(audio);
        return;
      } while (mountedRef.current && !controller.signal.aborted && Date.now() < deadline);
      if (mountedRef.current) setNote("Lời đọc vẫn đang xử lý. Bấm “Lấy lại lời đọc” sau; không tạo thêm lượt mới.");
    } catch (cause) { if (mountedRef.current && !controller.signal.aborted) setError(`${errorMessage(cause)} Tác vụ cũ vẫn được giữ để lấy lại, không cần tạo mới.`); }
    finally { if (recoveryRef.current === controller) recoveryRef.current = null; setProgressText(""); end(); }
  }

  function stopRecovery() {
    recoveryRef.current?.abort();
    setNote("Đã dừng chờ trên trang. Tác vụ vẫn tiếp tục; bấm Lấy lại lời đọc sau để nhận kết quả, không tạo lượt mới.");
  }

  async function createVoice() {
    if (!approvedScript || approvedScript !== script.trim()) { setError("Hãy duyệt bản kịch bản hiện tại trước khi tạo giọng."); return; }
    if (!voiceId || !voiceReady) { setError("Chọn giọng đọc đang có quyền sử dụng trước khi tạo."); return; }
    if (/^maziao:vieten_speech:[a-zA-Z0-9_-]+$/.test(voiceId) && approvedScript.length < 100) { setError("Giọng này cần lời thoại ít nhất 100 ký tự."); return; }
    if (pendingTask) { await recoverVoice(pendingTask); return; }
    if (!begin("voice")) return;
    let task: VoiceTask | null = null;
    let delivered = false;
    let recoverable = false;
    try {
      const fingerprint = JSON.stringify({ text: approvedScript, voiceId });
      if (voiceRequestRef.current?.fingerprint !== fingerprint) voiceRequestRef.current = { fingerprint, id: crypto.randomUUID() };
      task = { requestId: voiceRequestRef.current.id, text: approvedScript, voiceId, createdAt: new Date().toISOString() };
      const response = await fetch("/api/voice-over", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": task.requestId }, body: JSON.stringify({ text: approvedScript, voiceId, speed: 1, volume: 1, pitch: 1 }) });
      const result = await response.json().catch(() => ({})) as Record<string, any>;
      if (response.status === 202 && result.pending === true) {
        setPendingTask(task); setNote("Lời đọc đã gửi. Đang kiểm tra kết quả mà không tạo thêm lượt mới.");
        end(); await recoverVoice(task, true); return;
      }
      if (!response.ok) {
        const error = Object.assign(new Error(typeof result.error === "string" ? result.error : "Chưa tạo được giọng đọc."), { code: result.code, status: response.status });
        recoverable = response.status >= 500 || ["MAZIAO_INVALID_RESPONSE", "MAZIAO_TIMEOUT", "MAZIAO_UNAVAILABLE", "MAZIAO_REJECTED", "MAZIAO_AUDIO_DOWNLOAD", "AUDIO_STORE_FAILED", "AUDIO_LINK_FAILED"].includes(result.code);
        if (recoverable) setPendingTask(task);
        else voiceRequestRef.current = null;
        throw error;
      }
      const audio = validVoiceResult(result, task);
      delivered = true;
      setReadyVoice(audio);
      await receiveVoice(audio);
    } catch (cause) {
      if (task && !delivered && !(cause && typeof cause === "object" && "status" in cause)) { setPendingTask(task); recoverable = true; }
      setError(`${errorMessage(cause)} ${delivered ? "Bấm Tải lại lời đọc đã tạo; không tạo giọng mới." : recoverable ? "Hãy dùng Lấy lại lời đọc trước khi tạo lượt mới." : "Hãy kiểm tra kịch bản và thử lại."}`);
    } finally { setProgressText(""); end(); }
  }

  async function retryAudioDownload() {
    if (!readyVoice || !begin("audio")) return;
    try { await receiveVoice(readyVoice); }
    catch (cause) { setError(`${errorMessage(cause)} Tệp đã tạo vẫn được giữ để tải lại mà không tốn thêm lượt.`); }
    finally { end(); }
  }

  async function renderVideo() {
    if (!source || !audioCurrent || !generatedAudio || !generatedDuration) { setError("Tạo và nghe thử lời thoại trước khi ghép video."); return; }
    if (generatedDuration > MAX_AUDIO_SECONDS) { setError("Lời thoại dài quá 90 giây cho bộ ghép hiện tại. Hãy rút gọn kịch bản."); return; }
    if (!begin("export")) return;
    setProgress(0); setProgressText("Đang chuẩn bị video và lời thoại…");
    try {
      const { exportStockVideo } = await import("@/lib/video-export");
      const result = await exportStockVideo({ clips: [source], narration: generatedAudio, aspectRatio: ratio, onProgress: (fraction, message) => { if (mountedRef.current) { setProgress(Math.round(fraction * 100)); setProgressText(message); } } });
      setExported(result); setProgress(100); setNote("MP4 đã ghép xong. Hãy phát và nghe đến cuối trước khi tải về.");
    } catch (cause) { setError(`${errorMessage(cause)} Video gốc, kịch bản và lời đọc vẫn được giữ để ghép lại.`); }
    finally { end(); }
  }

  async function saveExport() { if (!exported) return; try { await saveVideoFile(exported, title || "video-ai"); } catch (cause) { setError(errorMessage(cause)); } }
  async function shareExport() { if (!exported) return; try { await shareVideoFile(exported, title || "video-ai"); } catch (cause) { setError(errorMessage(cause)); } }

  return <section className={styles.workspace} aria-labelledby="video-source-title">
    <div className={styles.intro}><span className={styles.eyebrow}>VIDEO CỦA BẠN · LỜI THOẠI AI</span><h2 id="video-source-title">Tạo Video Từ Video</h2><p>Tải video, chọn cách kể, duyệt lời thoại rồi ghép. App tự điều chỉnh phần hình theo độ dài giọng đọc.</p></div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {note ? <p className={styles.note} role="status">{note}</p> : null}
    {pendingTask && !approvedScript ? <div className={styles.section}><div className={styles.heading}><span className={styles.number}>↻</span><div><h3>Lời đọc cũ đang chờ</h3><p>Tác vụ đã gửi từ kịch bản trước. Lấy lại kết quả trước khi tạo lượt giọng mới.</p></div></div><button type="button" className={styles.secondary} onClick={() => void recoverVoice(pendingTask)} disabled={Boolean(busy)}>Lấy lại lời đọc</button>{busy === "recover" ? <button type="button" className={styles.textLink} onClick={stopRecovery}>Dừng chờ trên trang</button> : null}{recoveryBlocked ? <button type="button" className={styles.textLink} onClick={() => { setPendingTask(null); voiceRequestRef.current = null; setRecoveryBlocked(false); setNote("Đã bỏ tác vụ không thể khôi phục. Lượt tạo mới có thể phát sinh phí."); }}>Bỏ tác vụ cũ để tạo lượt mới</button> : null}</div> : null}
    {readyVoice && !approvedScript ? <div className={styles.section}><div className={styles.heading}><span className={styles.number}>♪</span><div><h3>Lời đọc cũ đã tạo</h3><p>Tệp đã có trong kho riêng. Bạn có thể tải lại mà không tạo thêm lượt giọng.</p></div></div><button type="button" className={styles.secondary} onClick={() => void retryAudioDownload()} disabled={Boolean(busy)}>Tải lại lời đọc đã tạo</button></div> : null}
    {generatedAudio && audioUrl && !approvedScript ? <div className={styles.section}><div className={styles.heading}><span className={styles.number}>♪</span><div><h3>Lời đọc đã lấy lại</h3><p>Nghe lại và quyết định có dùng cùng video hiện tại không.</p></div></div><audio src={audioUrl} controls preload="metadata" /><button type="button" className={styles.secondary} onClick={() => { setScript(generatedText); setApprovedScript(generatedText); setVoiceId(generatedVoiceId); setExported(undefined); }} disabled={Boolean(busy) || !source}>Dùng lời đọc này với video hiện tại</button></div> : null}

    <div className={styles.section}>
      <div className={styles.heading}><span className={styles.number}>1</span><div><h3>Tải video gốc</h3><p>MP4, MOV hoặc WebM · tối đa 60 MB và 90 giây.</p></div></div>
      <label className={styles.upload}><input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" disabled={Boolean(busy)} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void chooseVideo(file); }} /><span>{source ? "Thay video khác" : "Chọn video từ thiết bị"}</span><small>Có thể chọn video trong thư viện điện thoại.</small></label>
      {source && sourceUrl ? <div className={styles.mediaCard}><video src={sourceUrl} controls playsInline preload="metadata" aria-label="Xem trước video gốc" /><div className={styles.metadata}><strong>{source.name}</strong><span>{clock(sourceDuration)} · {sourceSize.width} × {sourceSize.height} · {(source.size / 1024 / 1024).toFixed(1)} MB</span></div></div> : null}
    </div>

    {source ? <div className={styles.section}>
      <div className={styles.heading}><span className={styles.number}>2</span><div><h3>Chọn dạng kịch bản</h3><p>AI xem hình ảnh làm tư liệu và viết lời thoại theo dạng bạn chọn.</p></div></div>
      <div className={styles.types} role="group" aria-label="Dạng kịch bản">{builtins.map(item => <button key={item.format} type="button" className={scriptType === `builtin:${item.format}` ? styles.typeActive : styles.type} onClick={() => setScriptType(`builtin:${item.format}`)} disabled={Boolean(busy)} aria-pressed={scriptType === `builtin:${item.format}`}><strong>{item.title}</strong><span>{item.description}</span></button>)}{templates.map(item => <button key={item.id} type="button" className={scriptType === `custom:${item.id}` ? styles.typeActive : styles.type} onClick={() => setScriptType(`custom:${item.id}`)} disabled={Boolean(busy)} aria-pressed={scriptType === `custom:${item.id}`}><strong>{item.title}</strong><span>{item.description || (item.scope === "shared" ? "Dạng dùng chung" : "Dạng của bạn")}</span></button>)}</div>
      <label className={styles.field}>Điều bạn muốn người xem hiểu <span>(khuyến khích)</span><textarea value={intent} onChange={event => setIntent(event.target.value)} maxLength={5000} rows={3} placeholder="Ví dụ: Sản phẩm này giúp chuẩn bị bữa sáng nhanh hơn; hãy kể như trải nghiệm của tôi." disabled={Boolean(busy)} /></label>
      <p className={styles.hint}>AI chỉ phân tích khung hình, không nghe tiếng trong video gốc. Hãy nhập ý chính nếu video có lời nói hoặc thông tin không thể nhìn thấy.</p>
      <button type="button" className={styles.primary} onClick={() => void analyzeAndWrite()} disabled={Boolean(busy) || !deepseekReady}>{busy === "analyze" ? "Đang phân tích video…" : busy === "script" ? "Đang viết kịch bản…" : analysisRef.current?.source === source ? "Viết lại kịch bản" : "Phân Tích & Tạo Kịch Bản"}</button>
      {!deepseekReady ? <p className={styles.warning}>AI viết kịch bản chưa sẵn sàng. Quản trị viên cần kiểm tra kết nối.</p> : null}
      {(busy === "analyze" || busy === "script") && progressText ? <p className={styles.working} role="status">{progressText}</p> : null}
    </div> : null}

    {script ? <div className={styles.section}>
      <div className={styles.heading}><span className={styles.number}>3</span><div><h3>Đọc và duyệt lời thoại</h3><p>Sửa cho đúng ý bạn trước khi tạo giọng có tính phí.</p></div></div>
      <label className={styles.field}>Kịch bản<textarea className={styles.script} value={script} onChange={event => changeScript(event.target.value)} rows={9} disabled={Boolean(busy)} /></label>
      <div className={styles.inline}><span className={script.trim().length > MAX_SCRIPT_LENGTH ? styles.warningText : styles.counter}>{script.trim().length} / {MAX_SCRIPT_LENGTH} ký tự</span><button type="button" className={styles.secondary} onClick={approveScript} disabled={Boolean(busy) || !script.trim()}>Duyệt kịch bản</button></div>
      {approvedScript === script.trim() ? <p className={styles.approved}>✓ Đã duyệt. Lời đọc sẽ dùng đúng văn bản này.</p> : null}
    </div> : null}

    {approvedScript ? <div className={styles.section}>
      <div className={styles.heading}><span className={styles.number}>4</span><div><h3>Tạo và nghe lời thoại</h3><p>Giọng đọc được tạo từ toàn bộ kịch bản đã duyệt.</p></div></div>
      <div className={styles.voiceRow}><label className={styles.field}>Chọn giọng đọc<select value={voiceId} onChange={event => { setVoiceId(event.target.value); setExported(undefined); }} disabled={Boolean(busy)}><option value="">Chọn giọng</option>{voices.map(voice => <option key={voiceKey(voice)} value={voiceKey(voice)}>{voice.name}{voice.category === "cloned" ? " · Giọng cá nhân" : ""}</option>)}</select></label><button type="button" className={styles.secondary} onClick={onReloadVoices} disabled={Boolean(busy) || voicesLoading}>{voicesLoading ? "Đang tải…" : "Làm mới giọng"}</button></div>
      {selectedVoice && (selectedVoice.preview_url || selectedVoice.previewUrl) ? <div className={styles.voiceSample}><span>Nghe mẫu {selectedVoice.name}</span><audio src={selectedVoice.preview_url || selectedVoice.previewUrl} controls preload="none" /></div> : null}
      {pendingTask ? <div className={styles.pending}><strong>Lời đọc đã gửi, có thể lấy lại</strong><span>Không bấm tạo lượt mới. Hãy lấy kết quả của tác vụ đang chờ.</span><button type="button" className={styles.secondary} onClick={() => void recoverVoice(pendingTask)} disabled={Boolean(busy)}>{busy === "recover" ? "Đang kiểm tra…" : "Lấy lại lời đọc"}</button>{busy === "recover" ? <button type="button" className={styles.textLink} onClick={stopRecovery}>Dừng chờ trên trang</button> : null}{recoveryBlocked ? <button type="button" className={styles.textLink} onClick={() => { setPendingTask(null); voiceRequestRef.current = null; setRecoveryBlocked(false); setNote("Đã bỏ tác vụ không thể khôi phục. Lượt tạo mới có thể phát sinh phí."); }}>Bỏ tác vụ cũ để tạo lượt mới</button> : null}</div> : null}
      {readyVoice ? <button type="button" className={styles.secondary} onClick={() => void retryAudioDownload()} disabled={Boolean(busy)}>Tải lại lời đọc đã tạo</button> : null}
      {!pendingTask && !audioCurrent ? <button type="button" className={styles.primary} onClick={() => void createVoice()} disabled={Boolean(busy) || !voiceReady || !voiceId}>{busy === "voice" || busy === "recover" || busy === "audio" ? "Đang tạo lời thoại…" : "Tạo Lời Thoại"}</button> : null}
      {!voiceReady ? <p className={styles.warning}>Công cụ giọng nói chưa sẵn sàng. Quản trị viên cần kiểm tra kết nối.</p> : null}
      {generatedAudio && audioUrl ? <div className={styles.mediaCard}><strong>{audioCurrent ? "Lời thoại đã tạo" : "Lời thoại cũ · kịch bản hoặc giọng đã thay đổi"}</strong><audio src={audioUrl} controls preload="metadata" /><span>Thời lượng thực tế: {clock(generatedDuration)}. {generatedDuration > MAX_AUDIO_SECONDS ? "Dài quá 90 giây để ghép trên thiết bị hiện tại." : "Video sẽ được tự kéo dài hoặc cắt phần hình cho vừa."}</span></div> : null}
    </div> : null}

    {source && audioCurrent && generatedAudio ? <div className={styles.section}>
      <div className={styles.heading}><span className={styles.number}>5</span><div><h3>Ghép và tải video</h3><p>Giữ trọn lời thoại; tự lặp hoặc cắt hình. Tiếng gốc của video được tắt.</p></div></div>
      <label className={styles.field}>Tỷ lệ video đầu ra<select value={ratio} onChange={event => { setRatio(event.target.value as StockAspectRatio); setExported(undefined); }} disabled={Boolean(busy)}><option value="9:16">Dọc 9:16</option><option value="16:9">Ngang 16:9</option><option value="1:1">Vuông 1:1</option></select></label>
      {busy === "export" ? <div className={styles.progress} role="status"><strong>{progressText || "Đang ghép video…"}</strong><progress max={100} value={progress} /><span>{progress}% · Giữ trang mở đến khi hoàn tất.</span></div> : null}
      <button type="button" className={styles.primary} onClick={() => void renderVideo()} disabled={Boolean(busy) || generatedDuration > MAX_AUDIO_SECONDS}>{busy === "export" ? "Đang ghép…" : exported ? "Ghép lại video" : "Ghép Video"}</button>
      {exported && exportedUrl ? <div className={styles.result}><video src={exportedUrl} controls playsInline preload="metadata" aria-label="Xem trước video đã ghép" /><div className={styles.actions}><a className={styles.primary} href={exportedUrl} download={videoDownloadName(title || "video-ai")}>Tải Video MP4</a>{supportsVideoSave() ? <button type="button" className={styles.secondary} onClick={() => void saveExport()}>Lưu vào thư mục…</button> : null}{canShareVideoFile(exported, title || "video-ai") ? <button type="button" className={styles.secondary} onClick={() => void shareExport()}>Chia sẻ</button> : null}<a className={styles.textLink} href={exportedUrl} target="_blank" rel="noopener">Mở video để lưu</a></div><p>Hãy tải tệp trước khi rời trang. Video hoàn chỉnh chỉ được giữ trong lần mở này.</p></div> : null}
    </div> : null}
  </section>;
}
