import type { FFmpeg } from "@ffmpeg/ffmpeg";

export type ExportProgress = (progress: number, message: string) => void;

export interface SpeechSegment {
  start: number;
  end: number;
  text?: string;
  audioBase64: string;
  mimeType?: string;
  /** Actual duration returned by the voice service, in seconds. Rechecked before export. */
  audioDuration?: number;
}

export interface ExportVideoOptions {
  video: Blob;
  segments?: SpeechSegment[];
  narration?: Blob;
  duration: number;
  keepAmbient?: boolean;
  onProgress?: ExportProgress;
}

export type StockAspectRatio = "9:16" | "16:9" | "1:1";

export interface StockVideoScene {
  /** Zero-based index into clips. The same clip can be used by several scenes. */
  clipIndex: number;
  /** Relative scene length. The exporter scales all scenes to the measured narration. */
  duration: number;
}

export interface ExportStockVideoOptions {
  clips: Blob[];
  narration: Blob;
  aspectRatio?: StockAspectRatio;
  /** Omit to alternate all selected clips until the narration ends. */
  scenes?: StockVideoScene[];
  onProgress?: ExportProgress;
}

interface MediaStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  sample_aspect_ratio?: string;
  color_transfer?: string;
  color_primaries?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number; side_data_type?: string }[];
}

interface MediaInfo {
  streams?: MediaStream[];
  format?: { duration?: string };
}

interface MeasuredAudio {
  file: string;
  start: number;
  duration: number;
}

const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_DURATION = 90;
const FPS = 30;
const FRAME = 1 / FPS;
const ENCODE_TIMEOUT = 15 * 60 * 1000;
const MAX_STOCK_CLIPS = 12;
const MAX_STOCK_SCENES = 24;
const MAX_STOCK_VIDEO_BYTES = 90 * 1024 * 1024;
// AAC priming can make the reported audio stream ~40 ms shorter than its PCM input.
// Three frozen video frames leave room for the complete last spoken samples.
const STOCK_TAIL_FRAMES = 3;
let exportInProgress = false;

class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function numberString(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

function durationOf(info: MediaInfo, kind?: "video" | "audio"): number | undefined {
  const stream = info.streams?.find((item) => item.codec_type === kind);
  const duration = Number(stream?.duration ?? info.format?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function decodeBase64(value: string): Uint8Array {
  const source = value.replace(/^data:[^,]*;base64,/, "").replace(/\s/g, "");
  if (!source || source.length > Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 4) {
    throw new ExportError("Tệp giọng đọc trống hoặc quá lớn. Hãy tạo lại lời thoại.");
  }
  try {
    const binary = atob(source);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ExportError("Tệp giọng đọc không đọc được. Hãy tạo lại lời thoại.");
  }
}

function audioExtension(mimeType = ""): string {
  if (/wav|wave/i.test(mimeType)) return "wav";
  if (/ogg/i.test(mimeType)) return "ogg";
  if (/webm/i.test(mimeType)) return "webm";
  if (/mp4|m4a|aac/i.test(mimeType)) return "m4a";
  return "mp3";
}

async function withDeadline<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new ExportError(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function loadWasmURL(signal: AbortSignal): Promise<string> {
  const response = await fetch("/ffmpeg/core/wasm-parts.json", { signal });
  if (!response.ok) throw new ExportError("Bộ xuất MP4 chưa sẵn sàng. Hãy tải lại app rồi thử lại.");
  const manifest = await response.json() as { parts?: unknown; byteLength?: unknown };
  if (!Array.isArray(manifest.parts) || manifest.parts.length < 1 || manifest.parts.length > 4
    || !finitePositive(manifest.byteLength) || manifest.byteLength > 64 * 1024 * 1024
    || manifest.parts.some((part) => typeof part !== "string" || !/^ffmpeg-core\.\d+\.wasm\.part$/.test(part))) {
    throw new ExportError("Bộ xuất MP4 chưa đầy đủ. Hãy tải lại app rồi thử lại.");
  }
  const parts = await Promise.all(manifest.parts.map(async (part: string) => {
    const chunk = await fetch(`/ffmpeg/core/${part}`, { signal });
    if (!chunk.ok) throw new ExportError("Chưa tải đủ bộ xuất MP4. Kiểm tra kết nối rồi thử lại.");
    return chunk.arrayBuffer();
  }));
  if (parts.reduce((sum, part) => sum + part.byteLength, 0) !== manifest.byteLength) {
    throw new ExportError("Bộ xuất MP4 tải về chưa đầy đủ. Hãy thử lại.");
  }
  return URL.createObjectURL(new Blob(parts, { type: "application/wasm" }));
}

async function probe(ffmpeg: FFmpeg, file: string, files: Set<string>): Promise<MediaInfo> {
  const metadataFile = `${file}.json`;
  files.add(metadataFile);
  const result = await withDeadline(ffmpeg.ffprobe([
    "-v", "error", "-show_streams", "-show_format", "-of", "json", file, "-o", metadataFile,
  ], 30_000), 35_000, "Không đọc được thông tin tệp trong thời gian cho phép. Hãy thử video ngắn hơn.");
  // core 0.12.10 can leave ret=-1 after a successful ffprobe invocation.
  // Require a complete, freshly written JSON result as the additional check.
  if (result !== 0 && result !== -1) throw new ExportError("Không đọc được video hoặc âm thanh. Hãy thử một tệp MP4 khác.");
  const metadata = await ffmpeg.readFile(metadataFile, "utf8");
  if (typeof metadata !== "string") throw new ExportError("Không xác định được thông tin tệp.");
  try {
    const info = JSON.parse(metadata) as MediaInfo;
    if (!Array.isArray(info.streams) || info.streams.length === 0) throw new Error("No media streams");
    return info;
  } catch {
    throw new ExportError("Không xác định được thông tin tệp.");
  }
}

function outputSize(stream: MediaStream): [number, number] {
  if (!finitePositive(stream.width) || !finitePositive(stream.height)) {
    throw new ExportError("Không đọc được kích thước video. Hãy chọn lại tệp nguồn.");
  }
  const [sarWidth = 1, sarHeight = 1] = (stream.sample_aspect_ratio ?? "1:1").split(":").map(Number);
  const sar = sarWidth > 0 && sarHeight > 0 ? sarWidth / sarHeight : 1;
  let width = stream.width * sar;
  let height = stream.height;
  const rotation = stream.side_data_list?.find((item) => typeof item.rotation === "number")?.rotation
    ?? Number(stream.tags?.rotate ?? 0);
  if (Math.abs(Math.round(rotation / 90)) % 2 === 1) [width, height] = [height, width];
  const factor = Math.min(1, 1920 / width, 1920 / height, Math.sqrt(1920 * 1080 / (width * height)));
  return [Math.max(2, Math.round(width * factor / 2) * 2), Math.max(2, Math.round(height * factor / 2) * 2)];
}

export interface PlannedStockScene {
  clipIndex: number;
  frames: number;
  duration: number;
}

/** A frame-exact timeline. Explicit scene lengths are weights, not a second audio clock. */
export function planStockTimeline(sourceDurations: number[], narrationDuration: number, scenes?: StockVideoScene[]): PlannedStockScene[] {
  if (!sourceDurations.length || sourceDurations.length > MAX_STOCK_CLIPS
    || sourceDurations.some((duration) => !finitePositive(duration) || duration < FRAME)) {
    throw new ExportError("Danh sách video nguồn không hợp lệ. Hãy chọn lại video thư viện.");
  }
  if (!finitePositive(narrationDuration) || narrationDuration > MAX_DURATION) {
    throw new ExportError("Bản thử hỗ trợ lời thoại dài tối đa 90 giây.");
  }
  const totalFrames = Math.max(1, Math.ceil(narrationDuration * FPS - 0.000001));
  if (scenes) {
    if (!scenes.length || scenes.length > MAX_STOCK_SCENES || scenes.length > totalFrames
      || scenes.some((scene) => !Number.isInteger(scene.clipIndex) || scene.clipIndex < 0
        || scene.clipIndex >= sourceDurations.length || !finitePositive(scene.duration))) {
      throw new ExportError("Danh sách phân cảnh không hợp lệ. Hãy kiểm tra lại video và thời lượng mỗi cảnh.");
    }
    const totalWeight = scenes.reduce((sum, scene) => sum + scene.duration, 0);
    if (!Number.isFinite(totalWeight)) throw new ExportError("Thời lượng phân cảnh không hợp lệ.");
    let allocated = 0;
    let cumulative = 0;
    return scenes.map((scene, index) => {
      cumulative += scene.duration;
      const remaining = scenes.length - index - 1;
      const boundary = index === scenes.length - 1 ? totalFrames
        : Math.max(allocated + 1, Math.min(totalFrames - remaining, Math.round(cumulative / totalWeight * totalFrames)));
      const frames = boundary - allocated;
      allocated = boundary;
      return { clipIndex: scene.clipIndex, frames, duration: frames / FPS };
    });
  }

  if (sourceDurations.length === 1) {
    return [{ clipIndex: 0, frames: totalFrames, duration: totalFrames / FPS }];
  }
  const timeline: PlannedStockScene[] = [];
  let remainingFrames = totalFrames;
  const framesPerSelection = Math.max(1, Math.ceil(totalFrames / sourceDurations.length));
  const framesForSceneLimit = Math.ceil(totalFrames / MAX_STOCK_SCENES);
  while (remainingFrames > 0) {
    if (timeline.length >= MAX_STOCK_SCENES) {
      throw new ExportError("Có quá nhiều đoạn video ngắn. Hãy chọn ít video hơn hoặc lời thoại ngắn hơn.");
    }
    const clipIndex = timeline.length % sourceDurations.length;
    // Give every selected clip a turn when the narration is short, while a
    // long narration alternates source clips instead of looping one repeatedly.
    const preferredFrames = Math.min(12 * FPS, framesPerSelection,
      Math.max(FPS, framesForSceneLimit, Math.ceil(sourceDurations[clipIndex] * FPS)));
    const frames = Math.min(remainingFrames, preferredFrames);
    if (frames < Math.min(FPS, preferredFrames / 2) && timeline.length) {
      const previous = timeline[timeline.length - 1];
      previous.frames += frames;
      previous.duration = previous.frames / FPS;
    } else {
      timeline.push({ clipIndex, frames, duration: frames / FPS });
    }
    remainingFrames -= frames;
  }
  return timeline;
}

function friendlyError(error: unknown, logs: string[]): Error {
  if (error instanceof ExportError) return error;
  const detail = `${error instanceof Error ? error.message : String(error)}\n${logs.join("\n")}`;
  if (/out of memory|memory access|allocation|cannot enlarge|abort\(OOM\)|Array buffer|WebAssembly.Memory/i.test(detail)) {
    return new ExportError("Thiết bị không đủ bộ nhớ để xuất video này. Đóng bớt tab, dùng clip ngắn hơn hoặc thử trên máy tính.");
  }
  if (/fetch|network|Failed to load|Importing a module|worker|wasm|MIME type/i.test(detail)) {
    return new ExportError("Chưa tải được bộ xuất MP4. Kiểm tra kết nối và mở app bằng Chrome, Edge hoặc Safari mới rồi thử lại.");
  }
  if (/decoder|Invalid data|moov atom|codec.*not found|unsupported|could not find/i.test(detail)) {
    return new ExportError("Định dạng video này chưa được hỗ trợ. Hãy quay ở chế độ tương thích H.264/SDR hoặc chọn tệp MP4 khác.");
  }
  return new ExportError("Chưa xuất được video. Hãy thử lại với clip ngắn hơn; video và kịch bản hiện tại vẫn còn trong app.");
}

/**
 * Produces an actual H.264 / AAC MP4 locally. No media or API key is sent elsewhere.
 * Speech is measured before encoding and is never shortened or sped up to fit.
 */
export async function exportVideo(options: ExportVideoOptions): Promise<Blob> {
  if (typeof window === "undefined") throw new ExportError("Hãy xuất video trong trình duyệt.");
  if (exportInProgress) throw new ExportError("Một video đang được xuất. Hãy chờ video đó hoàn tất.");
  if (!(options.video instanceof Blob) || options.video.size === 0) throw new ExportError("Hãy chọn hoặc quay video trước khi xuất.");
  if (options.video.size > MAX_VIDEO_BYTES) throw new ExportError("Bản thử hỗ trợ video tối đa 60 MB. Hãy chọn clip nhỏ hơn.");
  if (!finitePositive(options.duration) || options.duration > MAX_DURATION + FRAME) throw new ExportError("Bản thử hỗ trợ video dài tối đa 90 giây.");
  if (options.segments?.length && options.narration) throw new ExportError("Chỉ dùng lời thoại theo cảnh hoặc một bản đọc liền mạch trong mỗi lần xuất.");
  if ((options.segments?.length ?? 0) > 24) throw new ExportError("Bản thử hỗ trợ tối đa 24 đoạn lời thoại trong một video.");
  const segments = [...(options.segments ?? [])].sort((a, b) => a.start - b.start);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!Number.isFinite(segment.start) || segment.start < 0 || !finitePositive(segment.end)
      || segment.end <= segment.start || segment.end > options.duration + FRAME) {
      throw new ExportError(`Thời gian của đoạn lời thoại ${index + 1} không nằm trong video. Hãy tạo lại kịch bản.`);
    }
  }

  exportInProgress = true;
  let ffmpeg: FFmpeg | undefined;
  let wasmURL: string | undefined;
  const assetFetch = new AbortController();
  const files = new Set<string>();
  const logs: string[] = [];
  let encoding = false;
  let reportedProgress = 0;
  const report = (progress: number, message: string) => {
    reportedProgress = Math.max(reportedProgress, Math.min(1, Math.max(0, progress)));
    options.onProgress?.(reportedProgress, message);
  };
  const logHandler = ({ message }: { message: string }) => {
    logs.push(message);
    if (logs.length > 40) logs.shift();
  };
  const progressHandler = ({ time }: { time: number }) => {
    if (encoding && Number.isFinite(time)) {
      report(0.3 + Math.min(1, time / 1_000_000 / options.duration) * 0.64, "Đang ghép hình và giọng đọc…");
    }
  };

  try {
    report(0.02, "Đang tải bộ xuất MP4 lần đầu…");
    const moduleURL = new URL("/ffmpeg/ffmpeg/index.js", window.location.origin).href;
    const { FFmpeg: FFmpegClass } = await withDeadline(
      import(/* webpackIgnore: true */ /* @vite-ignore */ moduleURL) as Promise<{ FFmpeg: new () => FFmpeg }>,
      60_000,
      "Chưa tải được bộ xuất MP4. Kiểm tra kết nối rồi thử lại.",
    );
    ffmpeg = new FFmpegClass();
    ffmpeg.on("log", logHandler);
    ffmpeg.on("progress", progressHandler);
    wasmURL = await withDeadline(loadWasmURL(assetFetch.signal), 120_000,
      "Tải bộ xuất MP4 quá lâu. Kiểm tra kết nối rồi thử lại.");
    await withDeadline(ffmpeg.load({
      classWorkerURL: new URL("/ffmpeg/ffmpeg/worker.js", window.location.origin).href,
      coreURL: new URL("/ffmpeg/core/ffmpeg-core.js", window.location.origin).href,
      wasmURL,
    }), 120_000, "Tải bộ xuất MP4 quá lâu. Kiểm tra kết nối rồi thử lại.");

    const videoFile = "source-video.dat";
    files.add(videoFile);
    await ffmpeg.writeFile(videoFile, new Uint8Array(await options.video.arrayBuffer()));
    report(0.12, "Đang kiểm tra thời lượng và định dạng…");
    const sourceInfo = await probe(ffmpeg, videoFile, files);
    const videoStream = sourceInfo.streams?.find((stream) => stream.codec_type === "video");
    if (!videoStream) throw new ExportError("Tệp được chọn không chứa hình ảnh video.");
    if (/smpte2084|arib-std-b67/i.test(videoStream.color_transfer ?? "")
      || /bt2020/i.test(videoStream.color_primaries ?? "")) {
      throw new ExportError("Bản thử chưa chuyển màu HDR chính xác. Hãy tắt HDR khi quay hoặc chuyển clip sang SDR trước khi tải lên.");
    }
    const sourceDuration = durationOf(sourceInfo, "video") ?? options.duration;
    if (sourceDuration > MAX_DURATION + FRAME) throw new ExportError("Bản thử hỗ trợ video dài tối đa 90 giây.");
    if (Math.abs(sourceDuration - options.duration) > 0.5) {
      throw new ExportError("Thời lượng video đã thay đổi so với kịch bản. Hãy chọn lại video và tạo lại kịch bản.");
    }
    // Round up by at most one frame so conversion never shortens the last word.
    const frames = Math.max(1, Math.ceil(sourceDuration * FPS - 0.000001));
    const outputDuration = frames / FPS;
    const [width, height] = outputSize(videoStream);
    const audioTracks: MeasuredAudio[] = [];
    let totalAudioBytes = 0;

    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      const data = decodeBase64(segment.audioBase64);
      totalAudioBytes += data.byteLength;
      if (totalAudioBytes > MAX_AUDIO_BYTES) throw new ExportError("Tổng tệp giọng đọc quá lớn. Hãy thử clip ngắn hơn.");
      const file = `voice-${index}.${audioExtension(segment.mimeType)}`;
      files.add(file);
      await ffmpeg.writeFile(file, data);
      const info = await probe(ffmpeg, file, files);
      const actualDuration = durationOf(info, "audio");
      if (!info.streams?.some((stream) => stream.codec_type === "audio") || !actualDuration) {
        throw new ExportError(`Không đọc được giọng ở đoạn ${index + 1}. Hãy tạo lại lời thoại.`);
      }
      const limit = Math.min(segment.end, segments[index + 1]?.start ?? outputDuration, outputDuration);
      if (segment.start + actualDuration > limit + 1 / 48000) {
        throw new ExportError(`Lời đọc đoạn ${index + 1} dài hơn khoảng cảnh ${(limit - segment.start).toFixed(1)} giây. Rút gọn lời rồi tạo lại giọng để giữ trọn câu.`);
      }
      audioTracks.push({ file, start: segment.start, duration: actualDuration });
      report(0.14 + 0.13 * ((index + 1) / segments.length), "Đang kiểm tra từng đoạn giọng đọc…");
    }

    if (options.narration) {
      if (!options.narration.size || options.narration.size > MAX_AUDIO_BYTES) throw new ExportError("Tệp lời thoại trống hoặc quá lớn.");
      const file = `narration.${audioExtension(options.narration.type)}`;
      files.add(file);
      await ffmpeg.writeFile(file, new Uint8Array(await options.narration.arrayBuffer()));
      const info = await probe(ffmpeg, file, files);
      const actualDuration = durationOf(info, "audio");
      if (!info.streams?.some((stream) => stream.codec_type === "audio") || !actualDuration) throw new ExportError("Không đọc được bản lời thoại. Hãy tạo lại giọng đọc.");
      if (actualDuration > outputDuration + 1 / 48000) throw new ExportError("Bản đọc dài hơn video. Rút gọn kịch bản và tạo lại giọng; app giữ trọn lời thay vì cắt câu.");
      audioTracks.push({ file, start: 0, duration: actualDuration });
    }

    const args = ["-hide_banner", "-i", videoFile];
    for (const track of audioTracks) args.push("-i", track.file);
    const silenceIndex = audioTracks.length + 1;
    args.push("-f", "lavfi", "-t", numberString(outputDuration), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
    const graph = [
      `[0:v:0]setpts=PTS-STARTPTS,fps=${FPS},scale=${width}:${height}:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=${numberString(FRAME * 2)}[video]`,
      `[${silenceIndex}:a:0]atrim=duration=${numberString(outputDuration)},asetpts=PTS-STARTPTS[silence]`,
    ];
    const mix = ["[silence]"];
    audioTracks.forEach((track, index) => {
      graph.push(`[${index + 1}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,adelay=${Math.round(track.start * 48000)}S:all=1[voice${index}]`);
      mix.push(`[voice${index}]`);
    });
    if (options.keepAmbient && sourceInfo.streams?.some((stream) => stream.codec_type === "audio")) {
      graph.push("[0:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=0.14[ambient]");
      mix.push("[ambient]");
    }
    graph.push(`${mix.join("")}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1[audio]`);
    args.push(
      "-filter_complex", graph.join(";"), "-map", "[video]", "-map", "[audio]",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p",
      "-maxrate", "8M", "-bufsize", "16M",
      "-profile:v", "high", "-level:v", "4.1", "-r", String(FPS), "-frames:v", String(frames),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
      "-map_metadata", "-1", "-metadata:s:v:0", "rotate=0", "-movflags", "+faststart",
      "-t", numberString(outputDuration), "-max_muxing_queue_size", "1024", "finished.mp4",
    );
    files.add("finished.mp4");
    report(0.3, "Đang ghép hình và giọng đọc…");
    encoding = true;
    const result = await withDeadline(ffmpeg.exec(args, ENCODE_TIMEOUT), ENCODE_TIMEOUT + 5_000,
      "Thiết bị xử lý video quá lâu. Hãy thử clip ngắn hơn hoặc xuất trên máy tính.");
    encoding = false;
    if (result !== 0) throw new Error(`FFmpeg failed (${result})`);
    report(0.95, "Đang kiểm tra tệp MP4 hoàn chỉnh…");
    const finishedInfo = await probe(ffmpeg, "finished.mp4", files);
    const finishedVideo = finishedInfo.streams?.find((stream) => stream.codec_type === "video");
    const finishedAudio = finishedInfo.streams?.find((stream) => stream.codec_type === "audio");
    const finishedDuration = durationOf(finishedInfo, "video");
    if (finishedVideo?.codec_name !== "h264" || finishedAudio?.codec_name !== "aac"
      || !finishedDuration || Math.abs(finishedDuration - sourceDuration) > FRAME + 0.002) {
      throw new ExportError("Tệp xuất chưa đạt cấu hình MP4 yêu cầu. Hãy thử lại với clip ngắn hơn.");
    }
    const data = await ffmpeg.readFile("finished.mp4");
    if (typeof data === "string" || data.byteLength === 0) throw new ExportError("Tệp MP4 xuất ra bị trống. Hãy thử lại.");
    // Copy into an owned ArrayBuffer: the worker's data buffer is released below.
    const blob = new Blob([new Uint8Array(data).buffer], { type: "video/mp4" });
    report(1, "Video đã sẵn sàng tải về.");
    return blob;
  } catch (error) {
    throw friendlyError(error, logs);
  } finally {
    encoding = false;
    assetFetch.abort();
    if (ffmpeg) {
      ffmpeg.off("log", logHandler);
      ffmpeg.off("progress", progressHandler);
      // Drop the complete worker and its WASM filesystem even after a failed export.
      // Per-file deletes can hang after a worker crash; termination frees them all.
      ffmpeg.terminate();
    }
    if (wasmURL) URL.revokeObjectURL(wasmURL);
    files.clear();
    exportInProgress = false;
  }
}

/**
 * Composes selected stock clips locally against the actual length of an audio file.
 * Every source is written only once, even if the timeline reuses it. Existing
 * camera/upload exports continue to use exportVideo above.
 */
export async function exportStockVideo(options: ExportStockVideoOptions): Promise<Blob> {
  if (typeof window === "undefined") throw new ExportError("Hãy xuất video trong trình duyệt.");
  if (exportInProgress) throw new ExportError("Một video đang được xuất. Hãy chờ video đó hoàn tất.");
  if (!Array.isArray(options.clips) || !options.clips.length || options.clips.length > MAX_STOCK_CLIPS
    || options.clips.some((clip) => !(clip instanceof Blob) || clip.size === 0)) {
    throw new ExportError("Hãy chọn từ 1 đến 12 video thư viện hợp lệ trước khi xuất.");
  }
  if (options.clips.reduce((sum, clip) => sum + clip.size, 0) > MAX_STOCK_VIDEO_BYTES) {
    throw new ExportError("Tổng video nguồn vượt 90 MB. Hãy chọn clip ngắn hoặc chất lượng thấp hơn.");
  }
  if (!(options.narration instanceof Blob) || !options.narration.size || options.narration.size > MAX_AUDIO_BYTES) {
    throw new ExportError("Hãy tải hoặc tạo tệp lời thoại hợp lệ (tối đa 32 MB).");
  }
  const ratio = options.aspectRatio ?? "9:16";
  const size: Record<StockAspectRatio, [number, number]> = {
    "9:16": [720, 1280],
    "16:9": [1280, 720],
    "1:1": [960, 960],
  };
  if (!Object.prototype.hasOwnProperty.call(size, ratio)) throw new ExportError("Tỷ lệ khung hình chưa được hỗ trợ.");

  exportInProgress = true;
  let ffmpeg: FFmpeg | undefined;
  let wasmURL: string | undefined;
  const assetFetch = new AbortController();
  const files = new Set<string>();
  const logs: string[] = [];
  let encoding = false;
  let plannedDuration = 1;
  let reportedProgress = 0;
  const report = (progress: number, message: string) => {
    reportedProgress = Math.max(reportedProgress, Math.min(1, Math.max(0, progress)));
    options.onProgress?.(reportedProgress, message);
  };
  const logHandler = ({ message }: { message: string }) => {
    logs.push(message);
    if (logs.length > 40) logs.shift();
  };
  const progressHandler = ({ time }: { time: number }) => {
    if (encoding && Number.isFinite(time)) {
      report(0.3 + Math.min(1, time / 1_000_000 / plannedDuration) * 0.64, "Đang ghép các cảnh và lời thoại…");
    }
  };

  try {
    report(0.02, "Đang tải bộ xuất MP4 lần đầu…");
    const moduleURL = new URL("/ffmpeg/ffmpeg/index.js", window.location.origin).href;
    const { FFmpeg: FFmpegClass } = await withDeadline(
      import(/* webpackIgnore: true */ /* @vite-ignore */ moduleURL) as Promise<{ FFmpeg: new () => FFmpeg }>,
      60_000,
      "Chưa tải được bộ xuất MP4. Kiểm tra kết nối rồi thử lại.",
    );
    ffmpeg = new FFmpegClass();
    ffmpeg.on("log", logHandler);
    ffmpeg.on("progress", progressHandler);
    wasmURL = await withDeadline(loadWasmURL(assetFetch.signal), 120_000,
      "Tải bộ xuất MP4 quá lâu. Kiểm tra kết nối rồi thử lại.");
    await withDeadline(ffmpeg.load({
      classWorkerURL: new URL("/ffmpeg/ffmpeg/worker.js", window.location.origin).href,
      coreURL: new URL("/ffmpeg/core/ffmpeg-core.js", window.location.origin).href,
      wasmURL,
    }), 120_000, "Tải bộ xuất MP4 quá lâu. Kiểm tra kết nối rồi thử lại.");

    report(0.1, "Đang kiểm tra file lời thoại và video…");
    const narrationFile = `stock-narration.${audioExtension(options.narration.type)}`;
    files.add(narrationFile);
    await ffmpeg.writeFile(narrationFile, new Uint8Array(await options.narration.arrayBuffer()));
    const narrationInfo = await probe(ffmpeg, narrationFile, files);
    const narrationDuration = durationOf(narrationInfo, "audio");
    if (!narrationInfo.streams?.some((stream) => stream.codec_type === "audio") || !narrationDuration) {
      throw new ExportError("Không đọc được file lời thoại. Hãy chọn lại hoặc tạo giọng đọc mới.");
    }
    if (narrationDuration > MAX_DURATION) throw new ExportError("Bản thử hỗ trợ lời thoại dài tối đa 90 giây.");
    const sourceDurations: number[] = [];
    for (let index = 0; index < options.clips.length; index++) {
      const file = `stock-video-${index}.dat`;
      files.add(file);
      await ffmpeg.writeFile(file, new Uint8Array(await options.clips[index].arrayBuffer()));
      const info = await probe(ffmpeg, file, files);
      const stream = info.streams?.find((item) => item.codec_type === "video");
      const duration = durationOf(info, "video");
      if (!stream || !duration) throw new ExportError(`Video nguồn ${index + 1} không đọc được. Hãy chọn video khác.`);
      if (/smpte2084|arib-std-b67/i.test(stream.color_transfer ?? "")
        || /bt2020/i.test(stream.color_primaries ?? "")) {
        throw new ExportError(`Video nguồn ${index + 1} dùng màu HDR chưa được hỗ trợ. Hãy chọn video SDR khác.`);
      }
      sourceDurations.push(duration);
      report(0.12 + 0.15 * ((index + 1) / options.clips.length), "Đang kiểm tra từng video nguồn…");
    }

    // Narration is the only clock. No approved text or uploaded audio is shortened.
    const timeline = planStockTimeline(sourceDurations, narrationDuration, options.scenes);
    const finalScene = timeline[timeline.length - 1];
    finalScene.frames += STOCK_TAIL_FRAMES;
    finalScene.duration = finalScene.frames / FPS;
    const totalFrames = timeline.reduce((sum, scene) => sum + scene.frames, 0);
    plannedDuration = totalFrames / FPS;
    const [width, height] = size[ratio];
    const args: string[] = ["-hide_banner"];
    timeline.forEach((scene) => {
      args.push("-stream_loop", "-1", "-t", numberString(scene.duration + 0.25), "-i", `stock-video-${scene.clipIndex}.dat`);
    });
    args.push("-i", narrationFile);

    const graph: string[] = timeline.map((scene, index) =>
      `[${index}:v:0]setpts=PTS-STARTPTS,fps=${FPS},scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bicubic,crop=${width}:${height},setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.5,trim=end_frame=${scene.frames},setpts=PTS-STARTPTS[v${index}]`);
    graph.push(`${timeline.map((_, index) => `[v${index}]`).join("")}concat=n=${timeline.length}:v=1:a=0[video]`);
    graph.push(`[${timeline.length}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad=whole_dur=${numberString(plannedDuration)},atrim=duration=${numberString(plannedDuration)}[audio]`);
    args.push(
      "-filter_complex", graph.join(";"), "-map", "[video]", "-map", "[audio]",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p",
      "-maxrate", "8M", "-bufsize", "16M", "-profile:v", "high", "-level:v", "4.1",
      "-r", String(FPS), "-frames:v", String(totalFrames),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
      "-map_metadata", "-1", "-metadata:s:v:0", "rotate=0", "-movflags", "+faststart",
      "-max_muxing_queue_size", "1024", "finished-stock.mp4",
    );
    files.add("finished-stock.mp4");
    report(0.3, "Đang ghép các cảnh và lời thoại…");
    encoding = true;
    const result = await withDeadline(ffmpeg.exec(args, ENCODE_TIMEOUT), ENCODE_TIMEOUT + 5_000,
      "Thiết bị xử lý video quá lâu. Hãy thử clip ngắn hơn hoặc xuất trên máy tính.");
    encoding = false;
    if (result !== 0) throw new Error(`FFmpeg failed (${result})`);

    report(0.95, "Đang kiểm tra tệp MP4 hoàn chỉnh…");
    const finishedInfo = await probe(ffmpeg, "finished-stock.mp4", files);
    const finishedVideo = finishedInfo.streams?.find((stream) => stream.codec_type === "video");
    const finishedAudio = finishedInfo.streams?.find((stream) => stream.codec_type === "audio");
    const videoDuration = durationOf(finishedInfo, "video");
    const audioDuration = Number(finishedAudio?.duration);
    if (finishedVideo?.codec_name !== "h264" || finishedAudio?.codec_name !== "aac"
      || finishedVideo.width !== width || finishedVideo.height !== height
      || !videoDuration || Math.abs(videoDuration - plannedDuration) > FRAME + 0.002
      || !Number.isFinite(audioDuration) || audioDuration + FRAME < narrationDuration) {
      throw new ExportError("Tệp xuất chưa khớp lời thoại hoặc cấu hình MP4. Hãy thử clip ngắn hơn.");
    }
    const data = await ffmpeg.readFile("finished-stock.mp4");
    if (typeof data === "string" || data.byteLength === 0) throw new ExportError("Tệp MP4 xuất ra bị trống. Hãy thử lại.");
    const blob = new Blob([new Uint8Array(data).buffer], { type: "video/mp4" });
    report(1, "Video đã sẵn sàng tải về.");
    return blob;
  } catch (error) {
    throw friendlyError(error, logs);
  } finally {
    encoding = false;
    assetFetch.abort();
    if (ffmpeg) {
      ffmpeg.off("log", logHandler);
      ffmpeg.off("progress", progressHandler);
      ffmpeg.terminate();
    }
    if (wasmURL) URL.revokeObjectURL(wasmURL);
    files.clear();
    exportInProgress = false;
  }
}
