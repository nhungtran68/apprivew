"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { canShareVideoFile, saveVideoFile, shareVideoFile, supportsVideoSave, videoDownloadName } from "@/lib/video-download";
import styles from "./StockVideoWorkspace.module.css";

export type StockMode = "library" | "text";
export type StockRatio = "9:16" | "16:9" | "1:1";
export type StockVoice = { voice_id?: string; id?: string; name: string; category?: string; preview_url?: string };
export type StockScriptType = { id: string; title: string; description?: string; scope: "shared" | "personal" };
export type StockBuiltinType = { format: "review" | "story" | "tips" | "sales"; title: string; description: string };

type StockVideo = {
  id: number; tags: string; duration: number; width: number; height: number;
  size: number; thumbnail: string; videoUrl: string; pageUrl: string; user: string;
};
type PlannedScene = {
  id: string; text: string; description: string; query: string;
  startFraction: number; endFraction: number;
  video: StockVideo | null; alternatives: StockVideo[]; warning?: string;
};
type PendingVoice = { audioPath: string; audioUrl?: string; audioMime: string; duration: number; text: string; voiceId: string };
type Busy = "search" | "script" | "voice" | "download" | "audio" | "plan" | "export" | null;

function seconds(value: number) {
  const whole = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(whole / 60).toString().padStart(2, "0")}:${(whole % 60).toString().padStart(2, "0")}`;
}

function message(error: unknown) { return error instanceof Error ? error.message : "Chưa hoàn tất. Vui lòng thử lại."; }

async function api(path: string, init?: RequestInit): Promise<Record<string, any>> {
  const response = await fetch(path, init);
  const result = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : result.error?.message || result.message || `Yêu cầu chưa hoàn tất (${response.status}).`);
  return result;
}

async function measuredAudio(file: Blob): Promise<number> {
  const duration = await new Promise<number | undefined>(resolve => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    let finished = false;
    const finish = (value?: number) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      audio.removeAttribute("src"); audio.load(); URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(), 10000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined);
    audio.onerror = () => finish();
    audio.src = url;
  });
  if (!duration || duration > 90) throw new Error(duration ? "Lời thoại dài quá 90 giây. Hãy dùng bản ngắn hơn để xuất ổn định trên điện thoại." : "Chưa đo được thời lượng âm thanh. Hãy chọn tệp MP3, WAV hoặc M4A khác.");
  return duration;
}

function useObjectUrl(file?: Blob) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file) { setUrl(""); return; }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

function validVideo(value: unknown): value is StockVideo {
  if (!value || typeof value !== "object") return false;
  const video = value as Partial<StockVideo>;
  return Number.isSafeInteger(video.id) && Number(video.id) > 0 && typeof video.videoUrl === "string" && typeof video.pageUrl === "string" && Number.isFinite(video.duration);
}

export default function StockVideoWorkspace({ mode, deepseekReady, voiceReady, voices, voicesLoading, onReloadVoices, onBusyChange, builtins, templates }: {
  mode: StockMode;
  deepseekReady: boolean;
  voiceReady: boolean;
  voices: StockVoice[];
  voicesLoading: boolean;
  onReloadVoices: () => void;
  onBusyChange: (busy: boolean) => void;
  builtins: StockBuiltinType[];
  templates: StockScriptType[];
}) {
  const [ratio, setRatio] = useState<StockRatio>("9:16");
  const [query, setQuery] = useState("");
  const [searchPage, setSearchPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const [results, setResults] = useState<StockVideo[]>([]);
  const [preview, setPreview] = useState<StockVideo | null>(null);
  const [selected, setSelected] = useState<StockVideo[]>([]);
  const [replacementId, setReplacementId] = useState<string | null>(null);
  const [scenes, setScenes] = useState<PlannedScene[]>([]);
  const [plannedScript, setPlannedScript] = useState("");
  const [plannedRatio, setPlannedRatio] = useState<StockRatio>("9:16");
  const [title, setTitle] = useState("");
  const [topic, setTopic] = useState("");
  const [targetSeconds, setTargetSeconds] = useState(30);
  const [scriptType, setScriptType] = useState("builtin:review");
  const [script, setScript] = useState("");
  const [approvedScript, setApprovedScript] = useState("");
  const [uploadedAudio, setUploadedAudio] = useState<Blob>();
  const [uploadedName, setUploadedName] = useState("");
  const [uploadedDuration, setUploadedDuration] = useState(0);
  const [generatedAudio, setGeneratedAudio] = useState<Blob>();
  const [generatedDuration, setGeneratedDuration] = useState(0);
  const [generatedScript, setGeneratedScript] = useState("");
  const [generatedVoiceId, setGeneratedVoiceId] = useState("");
  const [pendingVoice, setPendingVoice] = useState<PendingVoice | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [exported, setExported] = useState<Blob>();
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const scriptFileInput = useRef<HTMLInputElement>(null);
  const audioFileInput = useRef<HTMLInputElement>(null);
  const downloadedClips = useRef(new Map<number, Blob>());
  const generatedCurrent = generatedScript === approvedScript && generatedVoiceId === voiceId;
  const activeAudio = uploadedAudio || (generatedCurrent ? generatedAudio : undefined);
  const audioDuration = uploadedAudio ? uploadedDuration : generatedCurrent ? generatedDuration : 0;
  const audioUrl = useObjectUrl(activeAudio);
  const exportedUrl = useObjectUrl(exported);
  const planCurrent = Boolean(scenes.length && plannedScript === approvedScript && plannedRatio === ratio);
  const chosenVideos = mode === "library" ? selected : scenes.map(scene => scene.video).filter((video): video is StockVideo => Boolean(video));
  const canExport = Boolean(activeAudio && audioDuration > 0 && (mode === "library" ? selected.length : planCurrent && scenes.every(scene => scene.video)) && !busy);

  useEffect(() => { onBusyChange(Boolean(busy)); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => { setExported(undefined); setResults([]); setPreview(null); setReplacementId(null); setSearched(false); }, [mode]);

  function invalidateVideo() { setExported(undefined); }
  function changeScript(value: string) {
    setScript(value);
    setApprovedScript("");
    setPendingVoice(null);
    setPlannedScript("");
    setScenes([]);
    invalidateVideo();
  }
  function changeRatio(value: StockRatio) { setRatio(value); setPlannedScript(""); setScenes([]); invalidateVideo(); }

  async function searchVideos(term: string, page = 1, sceneId: string | null = replacementId) {
    const cleaned = term.trim();
    if (cleaned.length < 2) { setError("Nhập ít nhất hai ký tự để tìm video."); return; }
    setBusy("search"); setError(""); setNote(""); setReplacementId(sceneId);
    try {
      const lang = /[^\x00-\x7f]/.test(cleaned) ? "vi" : "en";
      const result = await api(`/api/pixabay/videos?q=${encodeURIComponent(cleaned)}&page=${page}&lang=${lang}`, { cache: "no-store" });
      const videos = Array.isArray(result.videos) ? result.videos.filter(validVideo) as StockVideo[] : [];
      setResults(current => page === 1 ? videos : [...current, ...videos.filter(video => !current.some(item => item.id === video.id))]);
      setSearchPage(page); setHasMore(Boolean(result.hasMore)); setSearched(true); setQuery(cleaned);
      if (!videos.length && page === 1) setNote("Chưa có video phù hợp. Hãy thử từ khóa tiếng Anh ngắn hơn hoặc chủ đề gần nghĩa.");
    } catch (cause) { setError(message(cause)); if (page === 1) setResults([]); }
    finally { setBusy(null); }
  }

  function addVideo(video: StockVideo) {
    if (replacementId) {
      setScenes(current => current.map(scene => scene.id === replacementId ? { ...scene, video } : scene));
      setReplacementId(null); setResults([]); setPreview(null); invalidateVideo();
      setNote("Đã thay cảnh. Ghép lại video để xem bản mới.");
      return;
    }
    if (selected.some(item => item.id === video.id)) return;
    if (selected.length >= 8) { setError("Một video dùng tối đa tám cảnh nguồn để giữ tốc độ xuất trên điện thoại."); return; }
    setSelected(current => [...current, video]); invalidateVideo(); setNote("Đã thêm cảnh vào danh sách.");
  }

  function moveVideo(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= selected.length) return;
    setSelected(current => { const copy = [...current]; [copy[index], copy[next]] = [copy[next], copy[index]]; return copy; });
    invalidateVideo();
  }

  function moveScene(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= scenes.length) return;
    // The narration text and its timing stay in place; only the video choices move.
    setScenes(current => { const copy = [...current]; const video = copy[index].video; copy[index] = { ...copy[index], video: copy[next].video }; copy[next] = { ...copy[next], video }; return copy; });
    invalidateVideo();
  }

  async function readScriptFile(file?: File) {
    if (!file) return;
    if (!/\.(txt|md)$/i.test(file.name) || file.size > 100_000) { setError("Hãy chọn tệp kịch bản .txt hoặc .md, tối đa 100 KB."); return; }
    try { const content = await file.text(); if (!content.trim()) throw new Error("Tệp kịch bản chưa có nội dung."); if (content.length > 6000) throw new Error("Kịch bản vượt 6.000 ký tự. Hãy rút gọn tệp trước khi tải lên."); changeScript(content); setNote(`Đã nhập kịch bản từ ${file.name}. Hãy đọc và duyệt trước khi tiếp tục.`); setError(""); }
    catch (cause) { setError(message(cause)); }
  }

  async function generateScript() {
    if (!topic.trim() || topic.trim().length < 5) { setError("Hãy mô tả chủ đề hoặc ý tưởng ít nhất năm ký tự."); return; }
    if (!deepseekReady) { setError("AI viết kịch bản chưa sẵn sàng. Bạn vẫn có thể nhập kịch bản có sẵn."); return; }
    setBusy("script"); setError(""); setNote("");
    try {
      const style = scriptType.startsWith("custom:") ? { templateId: scriptType.slice(7) } : { format: scriptType.slice(8) };
      const result = await api("/api/script-generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: title.trim().slice(0, 120) || topic.trim().slice(0, 120), brief: topic.trim(), durationSeconds: targetSeconds, ...style }) });
      if (typeof result.script !== "string" || !result.script.trim()) throw new Error("AI chưa viết được kịch bản. Hãy thử lại.");
      changeScript(result.script.trim()); setNote("AI đã viết bản nháp. Hãy sửa và bấm Duyệt kịch bản trước khi tạo giọng hoặc tìm cảnh.");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  }

  function approveScript() {
    if (script.trim().length < 12 || script.length > 6000) { setError("Kịch bản cần từ 12 đến 6.000 ký tự."); return; }
    if (approvedScript !== script) setPendingVoice(null);
    setApprovedScript(script); setPlannedScript(""); setScenes([]); invalidateVideo();
    setError(""); setNote("Đã duyệt kịch bản. Nội dung này sẽ không bị AI sửa khi tìm video.");
  }

  async function readAudio(file?: File) {
    if (!file) return;
    if (!file.size || file.size > 32 * 1024 * 1024 || (!file.type.startsWith("audio/") && !/\.(mp3|wav|m4a|aac|ogg|webm|flac)$/i.test(file.name))) { setError("Chọn tệp âm thanh MP3, WAV hoặc M4A tối đa 32 MB."); return; }
    setBusy("audio"); setError(""); setNote("Đang đo thời lượng lời thoại…");
    try {
      const audio = file.type ? file : new File([file], file.name, { type: /\.wav$/i.test(file.name) ? "audio/wav" : /\.m4a$/i.test(file.name) ? "audio/mp4" : "audio/mpeg" });
      const duration = await measuredAudio(audio);
      setUploadedAudio(audio); setUploadedName(file.name); setUploadedDuration(duration); invalidateVideo();
      setNote(`Đã nhận bản thu ${duration.toFixed(1)} giây. Tệp này được ưu tiên khi ghép video.`);
    } catch (cause) { setError(message(cause)); setNote(""); }
    finally { setBusy(null); }
  }

  async function downloadVoice(pending: PendingVoice) {
    setBusy("download"); setError(""); setNote("Đang nhận lời đọc đã tạo…");
    try {
      const { downloadSpeechSegments } = await import("@/lib/studio-upload");
      const [received] = await downloadSpeechSegments([{ start: 0, end: pending.duration || 1, text: pending.text, audioPath: pending.audioPath, audioUrl: pending.audioUrl, audioMime: pending.audioMime }]);
      const binary = atob(received.audioBase64);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: received.mimeType });
      const duration = await measuredAudio(blob);
      setGeneratedAudio(blob); setGeneratedDuration(duration); setGeneratedScript(pending.text); setGeneratedVoiceId(pending.voiceId); setPendingVoice(null); invalidateVideo();
      setNote(`Lời đọc AI dài ${duration.toFixed(1)} giây. Hãy nghe thử trước khi ghép.`);
    } catch (cause) { setError(`${message(cause)} Bấm “Tải lại lời đọc” để nhận tệp đã tạo, không tạo giọng mới.`); }
    finally { setBusy(null); }
  }

  async function createVoice() {
    if (!approvedScript) { setError("Hãy duyệt kịch bản trước khi tạo giọng AI."); return; }
    if (!voiceId) { setError("Chọn giọng đọc trước khi tạo âm thanh."); return; }
    if (pendingVoice && pendingVoice.text === approvedScript && pendingVoice.voiceId === voiceId) { await downloadVoice(pendingVoice); return; }
    if (approvedScript.trim().split(/\s+/).length > 245) { setError("Kịch bản quá dài cho giới hạn video 90 giây. Hãy rút xuống khoảng 245 từ hoặc ít hơn trước khi tạo giọng có tính phí."); return; }
    setBusy("voice"); setError(""); setNote("Đang tạo giọng đọc…");
    try {
      const result = await api("/api/voice-over", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: approvedScript, voiceId, speed: 1, volume: 1, pitch: 1 }) });
      if (typeof result.audioPath !== "string" || !result.audioPath || typeof result.audioMime !== "string") throw new Error("Dịch vụ chưa trả tệp lời đọc hợp lệ.");
      const pending = { audioPath: result.audioPath, audioUrl: typeof result.audioUrl === "string" ? result.audioUrl : undefined, audioMime: result.audioMime, duration: Number(result.duration) || 0, text: approvedScript, voiceId };
      setPendingVoice(pending);
      await downloadVoice(pending);
    } catch (cause) { setError(message(cause)); setNote(""); }
    finally { setBusy(null); }
  }

  async function planScenes() {
    if (!approvedScript) { setError("Duyệt kịch bản trước khi tìm cảnh tự động."); return; }
    if (!audioDuration) { setError("Thêm bản thu hoặc tạo giọng AI để đo thời lượng trước khi chia cảnh."); return; }
    if (!deepseekReady) { setError("AI chọn cảnh chưa sẵn sàng. Hãy thử lại sau."); return; }
    setBusy("plan"); setError(""); setNote("AI đang chia kịch bản và tìm cảnh minh họa phù hợp…");
    try {
      const result = await api("/api/pixabay/scenes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ script: approvedScript, aspectRatio: ratio }) });
      if (!Array.isArray(result.scenes) || !result.scenes.length) throw new Error("Chưa tìm được phân cảnh phù hợp. Hãy thử mô tả cụ thể hơn.");
      const parsed = result.scenes.slice(0, 12).map((scene: Record<string, any>, index: number): PlannedScene => ({
        id: typeof scene.id === "string" && scene.id ? scene.id : `scene-${index}`,
        text: typeof scene.text === "string" ? scene.text : "",
        description: typeof scene.description === "string" ? scene.description : "",
        query: typeof scene.query === "string" ? scene.query : "",
        startFraction: Number(scene.startFraction), endFraction: Number(scene.endFraction),
        video: validVideo(scene.video) ? scene.video : null,
        alternatives: Array.isArray(scene.alternatives) ? scene.alternatives.filter(validVideo) : [],
        warning: typeof scene.warning === "string" ? scene.warning : undefined,
      }));
      setScenes(parsed); setPlannedScript(approvedScript); setPlannedRatio(ratio); invalidateVideo();
      setNote(parsed.some(scene => !scene.video) ? "Một vài cảnh chưa có video. Hãy thay cảnh trước khi ghép." : "Đã chọn cảnh theo mạch kịch bản. Xem lại từng cảnh và thay nếu cần.");
    } catch (cause) { setError(message(cause)); setNote(""); }
    finally { setBusy(null); }
  }

  async function fetchClip(video: StockVideo): Promise<Blob> {
    const cached = downloadedClips.current.get(video.id);
    if (cached) return cached;
    const response = await fetch("/api/pixabay/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: video.id, quality: video.size > 45 * 1024 * 1024 ? "small" : "medium" }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || `Chưa tải được cảnh Pixabay #${video.id}. Hãy chọn cảnh khác.`);
    }
    const blob = await response.blob();
    if (!blob.size || blob.size > 60 * 1024 * 1024) throw new Error(`Cảnh #${video.id} quá lớn hoặc không hợp lệ. Hãy chọn cảnh khác.`);
    downloadedClips.current.set(video.id, blob);
    return blob;
  }

  async function renderVideo() {
    if (!canExport || !activeAudio) return;
    setBusy("export"); setError(""); setProgress(0); setProgressText("Đang chuẩn bị cảnh và lời thoại…");
    try {
      const orderedVideos = mode === "library" ? selected : scenes.map(scene => scene.video!);
      const uniqueVideos = [...new Map(orderedVideos.map(video => [video.id, video])).values()];
      const clips: Blob[] = [];
      for (let index = 0; index < uniqueVideos.length; index++) {
        setProgressText(`Đang tải cảnh ${index + 1}/${uniqueVideos.length} từ Pixabay…`);
        clips.push(await fetchClip(uniqueVideos[index]));
      }
      let alignmentNote = "";
      let sceneTiming: { clipIndex: number; duration: number }[] | undefined;
      if (mode === "text") {
        const weights = scenes.map(scene => Math.max(0.01, scene.endFraction - scene.startFraction));
        const total = weights.reduce((sum, value) => sum + value, 0);
        let durations = weights.map(weight => weight * audioDuration / total);
        setProgressText("Đang căn chuyển cảnh theo nhịp lời đọc…");
        try {
          const { alignStockSceneDurations } = await import("@/lib/stock-audio-timing");
          const aligned = await alignStockSceneDurations(activeAudio, weights, audioDuration);
          if (aligned.durations.length === scenes.length && aligned.durations.every((value: number) => Number.isFinite(value) && value > 0)) {
            durations = aligned.durations;
            alignmentNote = aligned.silenceAligned ? " Điểm đổi cảnh đã căn gần khoảng lặng trong lời đọc." : " Cảnh được chia theo độ dài lời thoại.";
          }
        } catch {
          alignmentNote = " Cảnh được chia theo độ dài lời thoại vì thiết bị chưa đọc được khoảng lặng.";
        }
        sceneTiming = scenes.map((scene, index) => ({ clipIndex: uniqueVideos.findIndex(video => video.id === scene.video!.id), duration: durations[index] }));
      }
      const { exportStockVideo } = await import("@/lib/video-export");
      const finished = await exportStockVideo({ clips, narration: activeAudio, aspectRatio: ratio, scenes: sceneTiming, onProgress: (fraction: number, text: string) => { setProgress(Math.max(0, Math.min(100, fraction * 100))); setProgressText(text); } });
      setExported(finished); setProgress(100); setNote(`Video MP4 đã hoàn tất. Hãy xem lại hình và tiếng trước khi tải.${alignmentNote}`);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  }

  async function saveExport() { if (!exported) return; try { await saveVideoFile(exported, title || "video-pixabay"); } catch (cause) { setError(message(cause)); } }
  async function shareExport() { if (!exported) return; try { await shareVideoFile(exported, title || "video-pixabay"); } catch (cause) { setError(message(cause)); } }

  const modeTitle = mode === "library" ? "Tạo Video Thư Viện" : "Tạo Video Văn Bản";
  return <section className={styles.workspace} aria-labelledby="stock-mode-title">
    <div className={styles.intro}><span className={styles.eyebrow}>PIXABAY · CẢNH MINH HỌA</span><h2 id="stock-mode-title">{modeTitle}</h2><p>{mode === "library" ? "Tự chọn một hoặc nhiều cảnh, thêm lời thoại rồi app tự lặp hoặc cắt hình theo đúng độ dài âm thanh." : "Duyệt kịch bản, thêm lời thoại, để AI tìm cảnh theo mạch nội dung rồi chỉnh lại trước khi ghép."}</p></div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {note ? <p className={styles.note} role="status">{note}</p> : null}

    <div className={styles.layout}>
      <label className={styles.field}>Tỷ lệ video
        <select value={ratio} onChange={event => changeRatio(event.target.value as StockRatio)} disabled={Boolean(busy)}><option value="9:16">Dọc 9:16 · TikTok/Reels</option><option value="16:9">Ngang 16:9</option><option value="1:1">Vuông 1:1</option></select>
      </label>
      <label className={styles.field}>Tên video
        <input value={title} onChange={event => setTitle(event.target.value.slice(0, 120))} maxLength={120} placeholder="Ví dụ: Giới thiệu sản phẩm" />
      </label>
    </div>

    {mode === "library" ? <div className={styles.section}>
      <div className={styles.sectionHeading}><span className={styles.number}>1</span><div><h3>Chọn cảnh từ Pixabay</h3><p>Tìm, xem thử rồi thêm tối đa 8 video. Thứ tự dưới đây cũng là thứ tự ghép.</p></div></div>
      <form className={styles.search} onSubmit={(event: FormEvent) => { event.preventDefault(); void searchVideos(query, 1, null); }}><label className={styles.field}>Tìm theo từ khóa hoặc chủ đề<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Ví dụ: coffee shop, packing orders…" maxLength={100} disabled={Boolean(busy)} /></label><button type="submit" className={styles.primary} disabled={Boolean(busy)}>{busy === "search" ? "Đang tìm…" : "Tìm video"}</button></form>
      {selected.length ? <div className={styles.selectedList}><h4>Đã chọn {selected.length} cảnh</h4>{selected.map((video, index) => <div className={styles.selectedRow} key={video.id}><span className={styles.selectedIndex}>{index + 1}</span><img src={video.thumbnail} alt="" loading="lazy" /><div><strong>{video.tags || `Video #${video.id}`}</strong><small>{seconds(video.duration)} · {video.width} × {video.height}</small></div><div className={styles.rowActions}><button type="button" onClick={() => moveVideo(index, -1)} disabled={index === 0 || Boolean(busy)} aria-label={`Đưa cảnh ${index + 1} lên trước`}>↑</button><button type="button" onClick={() => moveVideo(index, 1)} disabled={index === selected.length - 1 || Boolean(busy)} aria-label={`Đưa cảnh ${index + 1} xuống sau`}>↓</button><button type="button" onClick={() => { setSelected(current => current.filter(item => item.id !== video.id)); invalidateVideo(); }} disabled={Boolean(busy)} aria-label={`Xóa cảnh ${index + 1}`}>×</button></div></div>)}</div> : null}
    </div> : null}

    <div className={styles.section}>
      <div className={styles.sectionHeading}><span className={styles.number}>{mode === "library" ? "2" : "1"}</span><div><h3>{mode === "library" ? "Chuẩn bị lời thoại" : "Nhập hoặc tạo kịch bản"}</h3><p>{mode === "library" ? "Có bản thu sẵn thì tải lên. Muốn dùng giọng AI, hãy duyệt kịch bản trước." : "Nhập văn bản, tải tệp chữ hoặc nhờ AI viết từ chủ đề. Bạn luôn được sửa và duyệt."}</p></div></div>
      <div className={styles.scriptGrid}>
        <label className={styles.field}>Chủ đề để AI viết kịch bản<textarea value={topic} onChange={event => setTopic(event.target.value)} rows={3} maxLength={5000} placeholder="Bạn bán gì, nói với ai, muốn chia sẻ điều gì?" disabled={Boolean(busy)} /></label>
        <div className={styles.scriptOptions}><label className={styles.field}>Dạng kịch bản<select value={scriptType} onChange={event => setScriptType(event.target.value)} disabled={Boolean(busy)}>{builtins.map(item => <option key={item.format} value={`builtin:${item.format}`}>{item.title}</option>)}{templates.map(item => <option key={item.id} value={`custom:${item.id}`}>{item.title} · {item.scope === "shared" ? "Dùng chung" : "Của tôi"}</option>)}</select></label><label className={styles.field}>Thời lượng mong muốn<select value={targetSeconds} onChange={event => setTargetSeconds(Number(event.target.value))} disabled={Boolean(busy)}><option value={15}>15 giây</option><option value={30}>30 giây</option><option value={45}>45 giây</option><option value={60}>60 giây</option><option value={90}>90 giây</option></select></label></div>
      </div>
      <button type="button" className={styles.secondary} onClick={() => void generateScript()} disabled={Boolean(busy) || !deepseekReady}>{busy === "script" ? "AI đang viết…" : "AI viết kịch bản"}</button>
      <label className={`${styles.field} ${styles.scriptField}`}>Kịch bản hoặc văn bản lời thoại<textarea value={script} onChange={event => changeScript(event.target.value)} rows={7} maxLength={6000} placeholder="Viết lời thoại đã có, hoặc bấm AI viết kịch bản rồi sửa lại theo ý bạn…" disabled={Boolean(busy)} /></label>
      <div className={styles.inlineActions}><input ref={scriptFileInput} type="file" accept=".txt,.md,text/plain,text/markdown" className={styles.visuallyHidden} onChange={event => { void readScriptFile(event.target.files?.[0]); event.target.value = ""; }} /><button type="button" className={styles.textButton} onClick={() => scriptFileInput.current?.click()} disabled={Boolean(busy)}>Tải kịch bản .txt / .md</button><button type="button" className={styles.primary} onClick={approveScript} disabled={Boolean(busy) || !script.trim() || approvedScript === script}>{approvedScript === script && approvedScript ? "Đã duyệt kịch bản" : "Duyệt kịch bản"}</button></div>
      {approvedScript ? <p className={styles.approved} role="status">Kịch bản đã duyệt · {approvedScript.trim().split(/\s+/).length} từ. AI chỉ dùng nội dung này để tìm cảnh, không tự sửa lời.</p> : null}
    </div>

    <div className={styles.section}>
      <div className={styles.sectionHeading}><span className={styles.number}>{mode === "library" ? "3" : "2"}</span><div><h3>Thêm giọng đọc</h3><p>Thời lượng thực tế của file âm thanh quyết định độ dài video xuất ra.</p></div></div>
      <input ref={audioFileInput} type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.webm,.flac" className={styles.visuallyHidden} onChange={event => { void readAudio(event.target.files?.[0]); event.target.value = ""; }} />
      <button type="button" className={styles.secondary} onClick={() => audioFileInput.current?.click()} disabled={Boolean(busy)}>{uploadedAudio ? "Thay bản thu" : "Tải file âm thanh lên"}</button>
      {uploadedAudio ? <div className={styles.audioCard}><strong>{uploadedName} · {uploadedDuration.toFixed(1)} giây</strong><audio controls src={audioUrl} /><button type="button" className={styles.textButton} onClick={() => { setUploadedAudio(undefined); setUploadedDuration(0); setUploadedName(""); invalidateVideo(); }} disabled={Boolean(busy)}>Xóa bản thu</button><small>Bản thu tải lên được ưu tiên hơn giọng AI.</small></div> : null}
      <div className={styles.voiceRow}><label className={styles.field}>Hoặc chọn giọng AI<select value={voiceId} onChange={event => setVoiceId(event.target.value)} disabled={Boolean(busy) || !voiceReady}><option value="">{voiceReady ? "Chọn giọng đọc" : "Giọng AI chưa sẵn sàng"}</option>{voices.map(voice => <option value={voice.voice_id || voice.id} key={voice.voice_id || voice.id}>{voice.name}{voice.category === "cloned" ? " · Cá nhân" : ""}</option>)}</select></label><button type="button" className={styles.textButton} onClick={onReloadVoices} disabled={voicesLoading || Boolean(busy)}>{voicesLoading ? "Đang tải giọng…" : "Làm mới giọng"}</button></div>
      {voices.find(voice => (voice.voice_id || voice.id) === voiceId)?.preview_url ? <audio controls src={voices.find(voice => (voice.voice_id || voice.id) === voiceId)?.preview_url} aria-label="Nghe mẫu giọng đã chọn" /> : null}
      <button type="button" className={styles.secondary} onClick={() => void createVoice()} disabled={Boolean(busy) || !voiceReady || !approvedScript || !voiceId}>{busy === "voice" ? "Đang tạo giọng…" : busy === "download" ? "Đang nhận lời đọc…" : pendingVoice ? "Tải lại lời đọc đã tạo" : "Tạo lời đọc AI"}</button>
      {generatedAudio && !uploadedAudio && generatedCurrent ? <div className={styles.audioCard}><strong>Giọng AI · {generatedDuration.toFixed(1)} giây</strong><audio controls src={audioUrl} /><small>Nghe lại trước khi ghép video.</small></div> : null}
      {generatedAudio && !generatedCurrent ? <p className={styles.warning}>Giọng AI thuộc kịch bản hoặc giọng đã chọn trước đó. Hãy tạo lại lời đọc cho lựa chọn hiện tại.</p> : null}
      {activeAudio && <p className={styles.approved}>Âm thanh đang dùng: {audioDuration.toFixed(1)} giây.</p>}
    </div>

    {mode === "text" ? <div className={styles.section}>
      <div className={styles.sectionHeading}><span className={styles.number}>3</span><div><h3>AI tìm cảnh theo kịch bản</h3><p>AI hiểu ý nghĩa từng đoạn và tìm cảnh Pixabay bằng từ khóa phù hợp. Bạn duyệt từng cảnh trước khi ghép.</p></div></div>
      <button type="button" className={styles.primary} onClick={() => void planScenes()} disabled={Boolean(busy) || !approvedScript || !audioDuration || !deepseekReady}>{busy === "plan" ? "Đang chia cảnh và tìm video…" : scenes.length ? "Tìm lại toàn bộ cảnh" : "AI tìm video theo nội dung"}</button>
      {scenes.length ? <div className={styles.sceneList}><h4>{scenes.length} phân cảnh · lời thoại {audioDuration.toFixed(1)} giây</h4>{scenes.map((scene, index) => <article className={styles.sceneCard} key={scene.id}><div className={styles.sceneTop}><span className={styles.selectedIndex}>{index + 1}</span><div><strong>{scene.description || `Cảnh ${index + 1}`}</strong><small>Khoảng {seconds(Math.max(0, scene.startFraction) * audioDuration)} – {seconds(Math.max(0, scene.endFraction) * audioDuration)} · Tìm: {scene.query}</small></div><div className={styles.rowActions}><button type="button" onClick={() => moveScene(index, -1)} disabled={index === 0 || Boolean(busy)} aria-label={`Hoán đổi video cảnh ${index + 1} với cảnh trước`}>↑</button><button type="button" onClick={() => moveScene(index, 1)} disabled={index === scenes.length - 1 || Boolean(busy)} aria-label={`Hoán đổi video cảnh ${index + 1} với cảnh sau`}>↓</button></div></div><p className={styles.sceneText}>“{scene.text}”</p>{scene.video ? <video src={scene.video.videoUrl} poster={scene.video.thumbnail} controls playsInline preload="metadata" aria-label={`Xem trước cảnh ${index + 1}`} /> : <p className={styles.warning}>Chưa tìm được video cho cảnh này.</p>}{scene.warning ? <p className={styles.warning}>{scene.warning}</p> : null}<div className={styles.sceneActions}><button type="button" className={styles.textButton} onClick={() => { setReplacementId(scene.id); void searchVideos(scene.query || scene.description || "people", 1, scene.id); }} disabled={Boolean(busy)}>Tìm video thay thế</button>{scene.alternatives.length ? <label className={styles.field}>Đổi nhanh sang cảnh khác<select value={scene.video?.id || ""} disabled={Boolean(busy)} onChange={event => { const video = scene.alternatives.find(item => String(item.id) === event.target.value); if (video) { setScenes(current => current.map(item => item.id === scene.id ? { ...item, video } : item)); invalidateVideo(); } }}><option value={scene.video?.id || ""}>Cảnh đang chọn</option>{scene.alternatives.filter(video => video.id !== scene.video?.id).map(video => <option key={video.id} value={video.id}>{video.tags || `Video #${video.id}`}</option>)}</select></label> : null}</div>{scene.video ? <a className={styles.sourceLink} href={scene.video.pageUrl} target="_blank" rel="noopener noreferrer">Nguồn cảnh trên Pixabay ↗</a> : null}</article>)}</div> : null}
      {replacementId ? <div className={styles.replaceSearch}><div className={styles.replaceHeading}><strong>Chọn cảnh thay thế</strong><button type="button" className={styles.textButton} onClick={() => { setReplacementId(null); setResults([]); }}>Đóng</button></div><form className={styles.search} onSubmit={event => { event.preventDefault(); void searchVideos(query, 1, replacementId); }}><label className={styles.field}>Tìm cảnh khác<input value={query} onChange={event => setQuery(event.target.value)} maxLength={100} /></label><button type="submit" className={styles.primary} disabled={Boolean(busy)}>Tìm</button></form></div> : null}
    </div> : null}

    {(mode === "library" || replacementId) && (results.length || searched) ? <div className={styles.section}>
      <div className={styles.sectionHeading}><span className={styles.number}>⌕</span><div><h3>{replacementId ? "Cảnh thay thế" : "Kết quả tìm kiếm"}</h3><p>{results.length ? "Chạm vào một video để xem thử, rồi thêm vào video của bạn." : "Chưa tìm được video. Thử từ khóa khác."}</p></div></div>
      <div className={styles.results}>{results.map(video => <button type="button" key={video.id} className={`${styles.result} ${preview?.id === video.id ? styles.resultActive : ""}`} onClick={() => setPreview(video)} aria-pressed={preview?.id === video.id}><img src={video.thumbnail} alt="" loading="lazy" /><span><strong>{video.tags || `Video #${video.id}`}</strong><small>{seconds(video.duration)} · {video.width} × {video.height}</small></span></button>)}</div>
      {preview ? <div className={styles.preview}><video src={preview.videoUrl} poster={preview.thumbnail} controls playsInline preload="metadata" aria-label={`Xem trước ${preview.tags}`} /><div><strong>{preview.tags || `Video #${preview.id}`}</strong><button type="button" className={styles.primary} onClick={() => addVideo(preview)} disabled={Boolean(busy) || (!replacementId && selected.some(item => item.id === preview.id))}>{replacementId ? "Dùng cảnh này" : selected.some(item => item.id === preview.id) ? "Đã thêm" : "Thêm cảnh"}</button></div><a href={preview.pageUrl} target="_blank" rel="noopener noreferrer">Xem nguồn Pixabay ↗</a></div> : null}
      {hasMore ? <button type="button" className={styles.secondary} onClick={() => void searchVideos(query, searchPage + 1)} disabled={Boolean(busy)}>{busy === "search" ? "Đang tải…" : "Xem thêm video"}</button> : null}
    </div> : null}

    <div className={styles.section}>
      <div className={styles.sectionHeading}><span className={styles.number}>{mode === "library" ? "4" : "4"}</span><div><h3>Ghép và tải video</h3><p>{mode === "library" ? "App tự luân phiên hoặc lặp cảnh khi lời thoại dài hơn, cắt phần hình dư khi ngắn hơn." : "Hình chạy theo thứ tự phân cảnh đã duyệt; độ dài tổng thể bám theo âm thanh thực tế."}</p></div></div>
      <p className={styles.summary}>{chosenVideos.length} cảnh · {audioDuration ? `${audioDuration.toFixed(1)} giây lời thoại` : "chưa có lời thoại"} · tỷ lệ {ratio} · MP4 H.264/AAC</p>
      {mode === "text" && scenes.some(scene => !scene.video) ? <p className={styles.warning}>Một số phân cảnh chưa có video. Hãy chọn cảnh thay thế trước khi ghép.</p> : null}
      <button type="button" className={styles.primary} onClick={() => void renderVideo()} disabled={!canExport}>{busy === "export" ? "Đang ghép video…" : exported ? "Ghép lại bản đã chỉnh" : "Ghép và xem trước"}</button>
      {busy === "export" ? <div className={styles.exportProgress} role="status"><progress value={progress} max={100} /><span>{Math.round(progress)}% · {progressText}</span></div> : null}
      {exported && exportedUrl ? <div className={styles.finished}><video src={exportedUrl} controls playsInline preload="metadata" aria-label="Xem trước video hoàn chỉnh" /><p>Đã ghép xong. Hãy xem lại toàn bộ hình và tiếng.</p><div className={styles.finishedActions}><a className={styles.primary} href={exportedUrl} download={videoDownloadName(title || "video-pixabay")}>Tải video MP4</a>{supportsVideoSave() ? <button type="button" className={styles.secondary} onClick={() => void saveExport()}>Lưu vào thư mục…</button> : null}{canShareVideoFile(exported, title || "video-pixabay") ? <button type="button" className={styles.secondary} onClick={() => void shareExport()}>Chia sẻ video</button> : null}</div></div> : null}
    </div>
    <p className={styles.credit}>Cảnh minh họa từ <a href="https://pixabay.com/videos/" target="_blank" rel="noopener noreferrer">Pixabay</a>. Hãy duyệt nội dung và quyền sử dụng của từng cảnh trước khi đăng. App không thêm watermark.</p>
  </section>;
}
