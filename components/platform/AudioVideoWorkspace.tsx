"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createStudioBrowser } from "@/lib/studio-browser";
import { cleanupAnalysisMedia } from "@/lib/studio-upload";
import { audioSceneDurations, type TimedWord } from "@/lib/audio-scene-timing";
import { planStockClipQualities, type StockClipQuote, type StockQuality } from "@/lib/stock-preflight";
import { canShareVideoFile, saveVideoFile, shareVideoFile, supportsVideoSave, videoDownloadName } from "@/lib/video-download";
import styles from "./StockVideoWorkspace.module.css";
import local from "./AudioVideoWorkspace.module.css";

type Ratio = "9:16" | "16:9" | "1:1";
type Video = {
  id: number; tags: string; duration: number; width: number; height: number;
  size: number; thumbnail: string; videoUrl: string; pageUrl: string;
};
type Scene = {
  id: string; text: string; description: string; query: string;
  startFraction: number; endFraction: number;
  video: Video | null; alternatives: Video[]; warning?: string;
};
type Transcript = { text: string; words: TimedWord[]; duration: number };
type Busy = "audio" | "upload" | "transcribe" | "plan" | "search" | "export" | null;

function errorText(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") return "Xử lý quá lâu. Hãy kiểm tra kết nối rồi thử lại; tác vụ cũ sẽ được lấy lại khi có kết quả.";
  return error instanceof Error ? error.message : "Chưa hoàn tất. Vui lòng thử lại.";
}

function seconds(value: number) {
  const whole = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(whole / 60).toString().padStart(2, "0")}:${(whole % 60).toString().padStart(2, "0")}`;
}

function validVideo(value: unknown): value is Video {
  if (!value || typeof value !== "object") return false;
  const video = value as Partial<Video>;
  return Number.isSafeInteger(video.id) && Number(video.id) > 0 && typeof video.videoUrl === "string"
    && typeof video.thumbnail === "string" && Number.isFinite(video.duration);
}

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

async function measureAudio(file: Blob): Promise<number> {
  const duration = await new Promise<number | undefined>(resolve => {
    const player = document.createElement("audio");
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (value?: number) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      player.removeAttribute("src"); player.load(); URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(), 10_000);
    player.preload = "metadata";
    player.onloadedmetadata = () => finish(Number.isFinite(player.duration) && player.duration > 0 ? player.duration : undefined);
    player.onerror = () => finish();
    player.src = url;
  });
  if (!duration) throw new Error("Chưa đọc được thời lượng. Hãy chọn tệp MP3, WAV hoặc M4A khác.");
  if (duration < 2 || duration > 90) throw new Error("Bản thử hỗ trợ lời thoại từ 2 đến 90 giây.");
  return duration;
}

function normalizedAudio(file: File): File {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const mime = extension === "mp3" ? "audio/mpeg" : extension === "wav" ? "audio/wav" : extension === "m4a" ? "audio/mp4" : "";
  if (!file.size || file.size > 32 * 1024 * 1024 || !mime)
    throw new Error("Chọn tệp MP3, WAV hoặc M4A có âm thanh, tối đa 32 MB.");
  return file.type === mime ? file : new File([file], file.name, { type: mime, lastModified: file.lastModified });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const detail = body.error;
    throw new Error(typeof detail === "string" ? detail
      : detail && typeof detail === "object" && typeof (detail as { message?: unknown }).message === "string"
        ? (detail as { message: string }).message
        : typeof body.message === "string" ? body.message : `Yêu cầu chưa hoàn tất (${response.status}).`);
  }
  return body;
}

/**
 * Audio-to-video uses the already deployed private bucket. The original File
 * stays in the browser and is passed unchanged to exportStockVideo.
 */
export default function AudioVideoWorkspace({ deepseekReady, onBusyChange }: { deepseekReady: boolean; onBusyChange: (busy: boolean) => void }) {
  const [audio, setAudio] = useState<File>();
  const [audioDuration, setAudioDuration] = useState(0);
  const [ratio, setRatio] = useState<Ratio>("9:16");
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [exported, setExported] = useState<Blob>();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [replacementId, setReplacementId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Video[]>([]);
  const [visibleResults, setVisibleResults] = useState(4);
  const [searchPage, setSearchPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [preview, setPreview] = useState<Video | null>(null);
  const [planUncertain, setPlanUncertain] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const uploadPath = useRef<string | null>(null);
  const transcribeRequestId = useRef(crypto.randomUUID());
  const planRequestId = useRef(crypto.randomUUID());
  const transcript = useRef<Transcript | null>(null);
  const downloadedClips = useRef(new Map<string, Blob>());
  const downloadRequestIds = useRef(new Map<string, string>());
  const audioUrl = useObjectUrl(audio);
  const exportedUrl = useObjectUrl(exported);
  const allScenesReady = scenes.length > 0 && scenes.every(scene => scene.video);

  useEffect(() => { onBusyChange(Boolean(busy)); }, [busy, onBusyChange]);
  useEffect(() => () => { onBusyChange(false); if (uploadPath.current) void cleanupAnalysisMedia([uploadPath.current]).catch(() => {}); }, [onBusyChange]);

  function enter(next: Exclude<Busy, null>) {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(next); setError(""); onBusyChange(true);
    return true;
  }
  function leave() { busyRef.current = false; setBusy(null); onBusyChange(false); }

  async function selectAudio(file?: File) {
    if (!file || !enter("audio")) return;
    try {
      const prepared = normalizedAudio(file);
      const duration = await measureAudio(prepared);
      if (uploadPath.current) void cleanupAnalysisMedia([uploadPath.current]).catch(() => {});
      uploadPath.current = null;
      transcript.current = null;
      transcribeRequestId.current = crypto.randomUUID();
      planRequestId.current = crypto.randomUUID();
      setAudio(prepared); setAudioDuration(duration); setScenes([]); setExported(undefined);
      setPlanUncertain(false);
      setReplacementId(null); setResults([]); setPreview(null);
      setNote(`Đã nhận lời thoại ${seconds(duration)}. Hãy nghe lại rồi bấm Phân Tích & Tạo.`);
    } catch (cause) { setError(errorText(cause)); }
    finally { leave(); }
  }

  async function uploadForTranscription(file: File): Promise<string> {
    if (uploadPath.current) return uploadPath.current;
    setBusy("upload"); setNote("Đang tải lời thoại lên kho tệp riêng…");
    const client = createStudioBrowser();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) throw new Error("Hãy đăng nhập lại để phân tích lời thoại.");
    const extension = file.name.split(".").pop()?.toLowerCase() || "mp3";
    const path = `${data.user.id}/video-transcriptions/${crypto.randomUUID()}.${extension}`;
    const uploaded = await client.storage.from("studio-media").upload(path, file, { contentType: file.type, upsert: false });
    if (uploaded.error) throw new Error("Chưa tải được lời thoại lên kho tệp riêng. Kiểm tra kết nối rồi thử lại.");
    uploadPath.current = path;
    return path;
  }

  async function analyzeAndCreate(refreshPlan = false) {
    if (!audio || !audioDuration || !enter("transcribe")) return;
    try {
      if (!deepseekReady) throw new Error("AI tìm cảnh chưa sẵn sàng. Hãy thử lại sau.");
      let current = transcript.current;
      if (!current) {
        const path = await uploadForTranscription(audio);
        setBusy("transcribe"); setNote("AI đang nghe và xác định thời điểm từng câu…");
        let result: Record<string, unknown> | null = null;
        for (let attempt = 0; attempt < 16; attempt++) {
          const response = await fetch("/api/video/transcribe", {
            method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": transcribeRequestId.current },
            body: JSON.stringify({ storagePath: path }), signal: AbortSignal.timeout(150_000),
          });
          const body = await response.json().catch(() => ({})) as Record<string, unknown>;
          if (response.status === 202 || (response.status === 409 && body.code === "CREDIT_REQUEST_REUSED")) {
            setNote("Lời thoại vẫn đang được nhận diện. Ứng dụng đang lấy lại cùng tác vụ, không gửi thêm lượt mới…");
            await new Promise(resolve => window.setTimeout(resolve, 4_000));
            continue;
          }
          if (!response.ok) {
            // These failures happen before success or are refunded by the
            // server. A later user-initiated retry may use a fresh request ID.
            if (["TRANSCRIPTION_RETRY_NEW_REQUEST", "TRANSCRIPTION_INVALID", "TRANSCRIPTION_REJECTED",
              "TRANSCRIPTION_PERMISSION", "TRANSCRIPTION_QUOTA", "TRANSCRIPTION_RATE_LIMIT",
              "TRANSCRIPTION_UNAVAILABLE", "INVALID_TRANSCRIPTION_DURATION"].includes(String(body.code)))
              transcribeRequestId.current = crypto.randomUUID();
            throw new Error(typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : `Nhận diện lời thoại chưa hoàn tất (${response.status}).`);
          }
          result = body;
          break;
        }
        if (!result) {
          setNote("Tác vụ vẫn đang xử lý. Bấm Phân Tích & Tạo lần nữa để lấy lại kết quả mà không phát sinh lượt nhận diện mới.");
          return;
        }
        const text = typeof result.text === "string" ? result.text.trim() : "";
        if (text.length < 12) throw new Error("Chưa nhận diện đủ lời nói trong tệp. Hãy thử bản thu rõ hơn.");
        const words = Array.isArray(result.words) ? result.words.filter((word): word is TimedWord =>
          Boolean(word) && typeof word === "object" && typeof word.text === "string"
          && Number.isFinite(word.start) && Number.isFinite(word.end)) : [];
        current = { text, words, duration: Number(result.duration) || audioDuration };
        transcript.current = current;
        if (uploadPath.current) {
          const finishedPath = uploadPath.current;
          uploadPath.current = null;
          void cleanupAnalysisMedia([finishedPath]).catch(() => {});
        }
        window.dispatchEvent(new Event("studio-credits-changed"));
      }
      if (refreshPlan) planRequestId.current = crypto.randomUUID();
      setBusy("plan"); setNote("AI đang tìm và sắp xếp cảnh minh họa theo lời nói…");
      let response: Response;
      try {
        response = await fetch("/api/pixabay/scenes", {
          method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": planRequestId.current },
          body: JSON.stringify({ script: current.text, aspectRatio: ratio }), signal: AbortSignal.timeout(240_000),
        });
      } catch (cause) {
        setPlanUncertain(true);
        throw cause;
      }
      if (response.status === 409) setPlanUncertain(true);
      else if (!response.ok) planRequestId.current = crypto.randomUUID();
      const result = await responseJson(response);
      const rawScenes = Array.isArray(result.scenes) ? result.scenes : [];
      const planned: Scene[] = rawScenes.slice(0, 12).map((item, index) => {
        const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return {
          id: typeof row.id === "string" ? row.id : `scene-${index + 1}`,
          text: typeof row.text === "string" ? row.text : "",
          description: typeof row.description === "string" ? row.description : "",
          query: typeof row.query === "string" ? row.query : "",
          startFraction: Number(row.startFraction), endFraction: Number(row.endFraction),
          video: validVideo(row.video) ? row.video : null,
          alternatives: Array.isArray(row.alternatives) ? row.alternatives.filter(validVideo) : [],
          warning: typeof row.warning === "string" ? row.warning : undefined,
        };
      });
      if (!planned.length) { setPlanUncertain(true); throw new Error("Kế hoạch cảnh chưa hợp lệ. Hãy kiểm tra trước khi tạo lại vì lượt trước có thể đã tính credit."); }
      setScenes(planned); setExported(undefined); setReplacementId(null); setResults([]);
      setPlanUncertain(false);
      setNote(planned.some(scene => !scene.video)
        ? "Một số cảnh chưa có video. Hãy bấm Tìm cảnh thay thế trước khi ghép."
        : "Đã có đủ cảnh. Xem lại từng cảnh hoặc thay video trước khi ghép.");
      window.dispatchEvent(new Event("studio-credits-changed"));
    } catch (cause) { setError(errorText(cause)); setNote(""); }
    finally { leave(); }
  }

  function changeRatio(next: Ratio) {
    if (busyRef.current || next === ratio) return;
    setRatio(next); setScenes([]); setExported(undefined); setReplacementId(null); setResults([]);
    planRequestId.current = crypto.randomUUID();
    if (transcript.current) setNote("Đã đổi tỷ lệ. Bấm Phân Tích & Tạo để tìm lại cảnh; app sẽ dùng kết quả nhận diện lời thoại đã có.");
  }

  function replaceScene(sceneId: string, video: Video) {
    setScenes(current => current.map(scene => scene.id === sceneId ? { ...scene, video } : scene));
    setReplacementId(null); setResults([]); setPreview(null); setExported(undefined);
    setNote("Đã thay cảnh. Hãy ghép lại video để xem kết quả.");
  }

  function moveSceneVideo(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= scenes.length) return;
    setScenes(current => {
      const copy = [...current];
      const video = copy[index].video;
      copy[index] = { ...copy[index], video: copy[next].video };
      copy[next] = { ...copy[next], video };
      return copy;
    });
    setExported(undefined);
  }

  async function searchVideos(term: string, page = 1, sceneId = replacementId) {
    if (!sceneId || !enter("search")) return;
    const cleaned = term.trim();
    if (cleaned.length < 2) { setError("Nhập ít nhất hai ký tự để tìm cảnh."); leave(); return; }
    try {
      const lang = /[^\x00-\x7f]/.test(cleaned) ? "vi" : "en";
      const response = await fetch(`/api/pixabay/videos?q=${encodeURIComponent(cleaned)}&page=${page}&lang=${lang}`, { cache: "no-store" });
      const result = await responseJson(response);
      const videos = Array.isArray(result.videos) ? result.videos.filter(validVideo) : [];
      setResults(current => page === 1 ? videos : [...current, ...videos.filter(video => !current.some(item => item.id === video.id))]);
      setVisibleResults(current => page === 1 ? 4 : current + 4);
      setSearchPage(page); setHasMore(Boolean(result.hasMore)); setQuery(cleaned);
      if (page === 1) setPreview(null);
      if (page === 1 && !videos.length) setNote("Chưa có cảnh phù hợp. Hãy thử từ khóa tiếng Anh ngắn hoặc gần nghĩa.");
    } catch (cause) { setError(errorText(cause)); }
    finally { leave(); }
  }

  async function fetchClip(video: Video, quality: StockQuality): Promise<Blob> {
    const cacheKey = `${video.id}:${quality}`;
    const cached = downloadedClips.current.get(cacheKey);
    if (cached) return cached;
    if (!downloadRequestIds.current.has(cacheKey)) downloadRequestIds.current.set(cacheKey, crypto.randomUUID());
    const response = await fetch("/api/pixabay/video", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": downloadRequestIds.current.get(cacheKey)! },
      body: JSON.stringify({ id: video.id, quality }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      if (response.status !== 409) downloadRequestIds.current.delete(cacheKey);
      const result = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(result.error || `Chưa tải được cảnh #${video.id}. Hãy chọn cảnh khác.`);
    }
    const clip = await response.blob();
    if (!clip.size || clip.size > 60 * 1024 * 1024) throw new Error(`Cảnh #${video.id} quá lớn hoặc không hợp lệ.`);
    downloadedClips.current.set(cacheKey, clip);
    window.dispatchEvent(new Event("studio-credits-changed"));
    return clip;
  }

  async function renderVideo() {
    if (!audio || !audioDuration || !allScenesReady || !enter("export")) return;
    setProgress(0); setProgressText("Đang chuẩn bị cảnh và lời thoại…");
    try {
      const ordered = scenes.map(scene => scene.video!);
      const unique = [...new Map(ordered.map(video => [video.id, video])).values()];
      setProgressText("Đang kiểm tra dung lượng và chọn chất lượng cảnh phù hợp…");
      const quoteResponse = await fetch(`/api/pixabay/video/quote?ids=${unique.map(video => video.id).join(",")}`, { cache: "no-store" });
      const quoted = await responseJson(quoteResponse);
      const rawQuotes = Array.isArray(quoted.quotes) ? quoted.quotes : [];
      const rows = new Map<number, Record<string, unknown>>();
      for (const item of rawQuotes) {
        if (item && typeof item === "object" && Number.isSafeInteger((item as { id?: unknown }).id))
          rows.set((item as { id: number }).id, item as Record<string, unknown>);
      }
      const bytes = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
      const clipQuotes: StockClipQuote[] = unique.map(video => {
        const quote = rows.get(video.id);
        if (!quote) throw new Error(`Chưa kiểm tra được dung lượng cảnh #${video.id}. Hãy thử lại.`);
        return { id: video.id, medium: bytes(quote.medium), small: bytes(quote.small), tiny: bytes(quote.tiny) };
      });
      const cachedSizes = new Map([...downloadedClips.current].map(([key, blob]) => [key, blob.size]));
      const plan = planStockClipQualities(clipQuotes, cachedSizes);
      const clips: Blob[] = [];
      for (let index = 0; index < unique.length; index++) {
        setProgressText(`Đang tải cảnh ${index + 1}/${unique.length}…`);
        clips.push(await fetchClip(unique[index], plan[index].quality));
      }
      if (clips.reduce((sum, clip) => sum + clip.size, 0) > 90 * 1024 * 1024)
        throw new Error("Video nhận được lớn hơn mức báo trước. Hãy thay một cảnh khác rồi ghép lại.");
      const durations = audioSceneDurations(scenes, transcript.current?.words || [], audioDuration);
      const timeline = scenes.map((scene, index) => ({
        clipIndex: unique.findIndex(video => video.id === scene.video!.id), duration: durations[index],
      }));
      const { exportStockVideo } = await import("@/lib/video-export");
      const finished = await exportStockVideo({
        clips, narration: audio, aspectRatio: ratio, scenes: timeline,
        onProgress: (fraction, detail) => { setProgress(Math.max(0, Math.min(100, fraction * 100))); setProgressText(detail); },
      });
      setExported(finished); setProgress(100);
      setNote("Video MP4 đã hoàn tất. Hãy xem lại đầy đủ hình và tiếng trước khi tải.");
    } catch (cause) { setError(errorText(cause)); }
    finally { leave(); }
  }

  async function saveExport() { if (!exported) return; try { await saveVideoFile(exported, "video-tu-loi-thoai"); } catch (cause) { setError(errorText(cause)); } }
  async function shareExport() { if (!exported) return; try { await shareVideoFile(exported, "video-tu-loi-thoai"); } catch (cause) { setError(errorText(cause)); } }

  return <section className={styles.workspace} aria-labelledby="audio-video-title">
    <div className={styles.intro}><span className={styles.eyebrow}>TẠO VIDEO AI</span><h2 id="audio-video-title">Tạo Video Từ Lời Thoại</h2><p>Tải bản thu của bạn. AI nghe nội dung, tìm cảnh minh họa và dùng chính bản thu này làm lời thoại video.</p></div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {note ? <p className={styles.note} role="status">{note}</p> : null}

    <div className={styles.section}>
      <div className={styles.sectionHeading}><span className={styles.number}>1</span><div><h3>Tải giọng nói</h3><p>Chọn MP3, WAV hoặc M4A. Nghe lại trước khi phân tích.</p></div></div>
      <input ref={fileInput} className={styles.visuallyHidden} type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4" onChange={event => { void selectAudio(event.target.files?.[0]); event.target.value = ""; }} />
      <button type="button" className={`${styles.secondary} ${styles.uploadAction}`} onClick={() => fileInput.current?.click()} disabled={Boolean(busy)}>{audio ? "Thay file lời thoại" : "Chọn file lời thoại"}</button>
      <p className={styles.uploadHint}>Tối đa 32 MB, 90 giây. Video giữ đủ nội dung và nhịp nói của bản thu.</p>
      {audio ? <div className={styles.audioCard}><strong>{audio.name} · {seconds(audioDuration)}</strong><audio controls src={audioUrl} preload="metadata" /><small>Hãy kiểm tra tiếng đầu và cuối của bản thu.</small></div> : null}
      <label className={`${styles.field} ${local.ratioField}`}>Tỷ lệ video
        <select value={ratio} onChange={event => changeRatio(event.target.value as Ratio)} disabled={Boolean(busy)}><option value="9:16">Dọc 9:16 · TikTok/Reels</option><option value="16:9">Ngang 16:9</option><option value="1:1">Vuông 1:1</option></select>
      </label>
      <button type="button" className={`${styles.primary} ${local.mainAction}`} onClick={() => void analyzeAndCreate(Boolean(scenes.length))} disabled={!audio || !deepseekReady || Boolean(busy) || planUncertain}>{busy === "upload" ? "Đang tải lời thoại…" : busy === "transcribe" ? "Đang phân tích lời thoại…" : busy === "plan" ? "Đang tìm cảnh…" : scenes.length ? "Tìm lại cảnh · có tính credit" : "Phân Tích & Tạo"}</button>
      {!deepseekReady ? <p className={styles.warning}>AI tìm cảnh chưa sẵn sàng. Vui lòng thử lại sau hoặc báo quản trị viên.</p> : null}
      {planUncertain ? <div className={styles.warning} role="status"><p>Lượt tìm cảnh trước có thể đã tính credit nhưng phản hồi chưa đến trình duyệt. Nếu tạo kế hoạch mới, hệ thống sẽ tính một lượt mới; lời thoại đã nhận diện vẫn được giữ.</p><button type="button" className={styles.secondary} onClick={() => { planRequestId.current = crypto.randomUUID(); setPlanUncertain(false); void analyzeAndCreate(false); }} disabled={Boolean(busy)}>Tạo kế hoạch mới · có tính credit</button></div> : null}
      {transcript.current && !scenes.length ? <p className={styles.approved}>Đã nhận diện lời thoại. Nếu tìm cảnh chưa hoàn tất, bấm lại để tiếp tục mà không phân tích file lần nữa.</p> : null}
    </div>

    {scenes.length ? <div className={styles.section}>
      <div className={styles.sectionHeading}><span className={styles.number}>2</span><div><h3>Xem và thay cảnh minh họa</h3><p>{scenes.length} cảnh theo thứ tự lời thoại. Chạm xem thử; cảnh chưa phù hợp có thể thay trước khi ghép.</p></div></div>
      <div className={styles.sceneList}>{scenes.map((scene, index) => {
        const durations = audioSceneDurations(scenes, transcript.current?.words || [], audioDuration);
        const start = durations.slice(0, index).reduce((sum, value) => sum + value, 0);
        return <article className={styles.sceneCard} key={scene.id}>
          <div className={styles.sceneTop}><span className={styles.selectedIndex}>{index + 1}</span><div><strong>{scene.description || `Cảnh ${index + 1}`}</strong><small>{seconds(start)} – {seconds(start + durations[index])} · {scene.query}</small></div><div className={styles.rowActions}><button type="button" onClick={() => moveSceneVideo(index, -1)} disabled={index === 0 || Boolean(busy)} aria-label={`Đổi video cảnh ${index + 1} với cảnh trước`}>↑</button><button type="button" onClick={() => moveSceneVideo(index, 1)} disabled={index === scenes.length - 1 || Boolean(busy)} aria-label={`Đổi video cảnh ${index + 1} với cảnh sau`}>↓</button></div></div>
          {scene.video ? <video src={scene.video.videoUrl} poster={scene.video.thumbnail} controls playsInline preload="metadata" aria-label={`Xem thử cảnh ${index + 1}`} /> : <p className={styles.warning}>Chưa tìm được video cho cảnh này.</p>}
          {scene.warning ? <p className={styles.warning}>{scene.warning}</p> : null}
          <div className={styles.sceneActions}><button type="button" className={styles.textButton} onClick={() => { setReplacementId(scene.id); setQuery(scene.query || "people"); setResults([]); setPreview(null); }} disabled={Boolean(busy)}>Tìm cảnh thay thế</button>
            {scene.alternatives.length ? <label className={styles.field}>Chọn nhanh cảnh khác<select value={scene.video?.id || ""} onChange={event => { const video = scene.alternatives.find(item => String(item.id) === event.target.value); if (video) replaceScene(scene.id, video); }} disabled={Boolean(busy)}><option value={scene.video?.id || ""}>Cảnh đang dùng</option>{scene.alternatives.filter(item => item.id !== scene.video?.id).map(item => <option key={item.id} value={item.id}>{item.tags || `Video #${item.id}`}</option>)}</select></label> : null}</div>
          {replacementId === scene.id ? <div className={styles.replaceSearch}><div className={styles.replaceHeading}><strong>Chọn cảnh thay thế</strong><button type="button" className={styles.textButton} onClick={() => { setReplacementId(null); setResults([]); setPreview(null); }}>Đóng</button></div>
            <form className={styles.search} onSubmit={(event: FormEvent) => { event.preventDefault(); void searchVideos(query, 1, scene.id); }}><label className={styles.field}>Từ khóa tìm video<input value={query} onChange={event => setQuery(event.target.value)} maxLength={100} disabled={Boolean(busy)} /></label><button type="submit" className={styles.primary} disabled={Boolean(busy)}>{busy === "search" ? "Đang tìm…" : "Tìm cảnh"}</button></form>
            {results.length ? <><div className={styles.results}>{results.slice(0, visibleResults).map(video => <button type="button" key={video.id} className={`${styles.result} ${preview?.id === video.id ? styles.resultActive : ""}`} onClick={() => setPreview(video)} aria-pressed={preview?.id === video.id}><img src={video.thumbnail} alt="" loading="lazy" /><span><strong>{video.tags || `Video #${video.id}`}</strong><small>{seconds(video.duration)} · {video.width} × {video.height}</small></span></button>)}</div>{visibleResults < results.length || hasMore ? <button type="button" className={styles.secondary} onClick={() => { if (visibleResults < results.length) setVisibleResults(current => current + 4); else void searchVideos(query, searchPage + 1, scene.id); }} disabled={Boolean(busy)}>Xem thêm</button> : null}</> : null}
            {preview ? <div className={styles.preview}><video src={preview.videoUrl} poster={preview.thumbnail} controls playsInline preload="metadata" /><button type="button" className={styles.primary} onClick={() => replaceScene(scene.id, preview)}>Dùng cảnh này</button></div> : null}
          </div> : null}
        </article>;
      })}</div>
      {!allScenesReady ? <p className={styles.warning}>Cần có video cho tất cả cảnh. Hãy thay cảnh còn thiếu rồi mới ghép.</p> : <p className={styles.approved}>Đã đủ tư liệu cho toàn bộ {seconds(audioDuration)} lời thoại.</p>}
    </div> : null}

    {scenes.length ? <div className={styles.section}>
      <div className={styles.sectionHeading}><span className={styles.number}>3</span><div><h3>Ghép và tải video</h3><p>Ứng dụng tự lặp hoặc cắt phần hình cho khớp lời thoại gốc. Không rút ngắn hoặc tạo lại giọng nói.</p></div></div>
      <button type="button" className={`${styles.primary} ${local.mainAction}`} onClick={() => void renderVideo()} disabled={!allScenesReady || Boolean(busy)}>{busy === "export" ? "Đang ghép video…" : exported ? "Ghép lại bản đã chỉnh" : "Ghép Video"}</button>
      {busy === "export" ? <div className={styles.exportProgress} role="status"><progress value={progress} max={100} /><span>{Math.round(progress)}% · {progressText}</span></div> : null}
      {exported && exportedUrl ? <div className={styles.finished}><video src={exportedUrl} controls playsInline preload="metadata" aria-label="Xem video hoàn chỉnh" /><p>Đã ghép xong. Hãy nghe đến hết file trước khi tải.</p><div className={styles.finishedActions}><a className={styles.primary} href={exportedUrl} download={videoDownloadName("video-tu-loi-thoai")}>Tải Video MP4</a>{supportsVideoSave() ? <button type="button" className={styles.secondary} onClick={() => void saveExport()}>Lưu vào thư mục…</button> : null}{canShareVideoFile(exported, "video-tu-loi-thoai") ? <button type="button" className={styles.secondary} onClick={() => void shareExport()}>Chia sẻ video</button> : null}<a className={styles.secondary} href={exportedUrl} target="_blank" rel="noopener">Mở video để lưu</a></div><p>Hãy tải MP4 trước khi rời trang; bản xuất chỉ được giữ trong lần mở này.</p></div> : null}
    </div> : null}
    <p className={styles.credit}>Hãy duyệt nội dung và quyền sử dụng của từng cảnh trước khi đăng. Ứng dụng không thêm watermark.</p>
  </section>;
}
