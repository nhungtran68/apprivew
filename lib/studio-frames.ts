export interface VideoFrameSample {
  /** Seconds into the original video. */
  time: number;
  /** JPEG data URL, ready for an image-capable AI request. */
  image: string;
}

type FrameProgress = (progress: number, message: string) => void;

const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_FRAME_BYTES = 100 * 1024;
const MAX_FRAME_DATA_LENGTH = 2_500_000;
const MAX_FRAME_COUNT = 16;
const MAX_EDGE = 640;

class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

function videoFailure(video: HTMLVideoElement): FrameError {
  if (video.error?.code === 3 || video.error?.code === 4) {
    return new FrameError("Trình duyệt chưa đọc được định dạng video này. Hãy thử video MP4 H.264 hoặc quay lại ở chế độ tương thích.");
  }
  return new FrameError("Không đọc được hình ảnh từ video. Hãy chọn lại tệp hoặc thử trên Chrome, Edge hay Safari mới.");
}

function waitForMedia(
  video: HTMLVideoElement,
  events: string[],
  ready: () => boolean,
  message: string,
  start?: () => void,
  timeout = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = () => {
      clearTimeout(timer);
      for (const event of events) video.removeEventListener(event, check);
      video.removeEventListener("error", fail);
    };
    const check = () => {
      if (!ready()) return;
      clean();
      resolve();
    };
    const fail = () => {
      clean();
      reject(videoFailure(video));
    };
    for (const event of events) video.addEventListener(event, check);
    video.addEventListener("error", fail);
    timer = setTimeout(() => {
      clean();
      reject(new FrameError(message));
    }, timeout);
    try {
      start?.();
      if (video.error) fail();
      else check();
    } catch {
      clean();
      reject(new FrameError(message));
    }
  });
}

async function seekFrame(video: HTMLVideoElement, time: number): Promise<void> {
  await waitForMedia(
    video,
    ["seeked", "loadeddata", "canplay", "timeupdate"],
    () => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - time) <= 0.1,
    "Không chuyển được đến một cảnh trong video. Hãy chọn lại tệp; với clip vừa quay, dừng quay hoàn toàn trước khi phân tích.",
    () => {
      // Set currentTime rather than fastSeek: fastSeek may choose a distant keyframe.
      // This also supports WebM with Infinity duration when the app measured the
      // recording's actual elapsed time and passed it into sampleVideoFrames.
      if (Math.abs(video.currentTime - time) > 0.005) video.currentTime = time;
    },
  );
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new FrameError("Thiết bị xử lý ảnh quá lâu. Hãy đóng bớt tab và thử lại."));
    }, 10_000);
    try {
      canvas.toBlob((blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!blob || blob.type !== "image/jpeg") reject(new FrameError("Trình duyệt chưa tạo được ảnh JPEG từ video."));
        else resolve(blob);
      }, "image/jpeg", quality);
    } catch {
      settled = true;
      clearTimeout(timer);
      reject(new FrameError("Không tạo được ảnh từ video. Hãy chọn lại tệp nguồn."));
    }
  });
}

async function encodeFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<string> {
  const originalWidth = video.videoWidth;
  const originalHeight = video.videoHeight;
  const scale = Math.min(1, MAX_EDGE / Math.max(originalWidth, originalHeight));
  let width = Math.max(1, Math.round(originalWidth * scale));
  let height = Math.max(1, Math.round(originalHeight * scale));
  let quality = 0.65;
  for (let attempt = 0; attempt < 7; attempt++) {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new FrameError("Trình duyệt không hỗ trợ đọc hình từ video. Hãy thử một trình duyệt mới hơn.");
    context.drawImage(video, 0, 0, width, height);
    const blob = await canvasBlob(canvas, quality);
    if (blob.size <= MAX_FRAME_BYTES) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 16_384) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
      }
      return `data:image/jpeg;base64,${btoa(binary)}`;
    }
    if (quality > 0.4) quality -= 0.12;
    else {
      width = Math.max(1, Math.round(width * 0.78));
      height = Math.max(1, Math.round(height * 0.78));
    }
  }
  throw new FrameError("Ảnh trích từ video quá lớn. Hãy dùng video có độ phân giải thấp hơn.");
}

/**
 * Samples real frames without playing audio, uploading the video, or loading FFmpeg.
 * At most 16 × 100 KiB JPEGs become ~2.19 MB of data URLs, leaving room for the
 * intent/profile in a JSON request below the app's 3 MB analysis boundary.
 */
export async function sampleVideoFrames(
  source: Blob,
  duration: number,
  onProgress?: FrameProgress,
): Promise<VideoFrameSample[]> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    throw new FrameError("Hãy mở app trong trình duyệt để phân tích video.");
  }
  if (!(source instanceof Blob) || source.size === 0) throw new FrameError("Hãy quay hoặc chọn video trước khi phân tích.");
  if (source.size > MAX_VIDEO_BYTES) throw new FrameError("Bản thử hỗ trợ video tối đa 60 MB. Hãy chọn clip nhỏ hơn.");
  if (!Number.isFinite(duration) || duration < 2 || duration > 90) throw new FrameError("Bản thử hỗ trợ video dài từ 2 đến 90 giây.");

  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  video.preload = "auto";
  video.muted = true;
  video.defaultMuted = true;
  video.volume = 0;
  video.playsInline = true;
  const url = URL.createObjectURL(source);
  try {
    onProgress?.(0, "Đang đọc các cảnh trong video…");
    await waitForMedia(video, ["loadedmetadata", "loadeddata"], () => video.readyState >= 1,
      "Chưa đọc được video trong thời gian cho phép. Hãy chọn lại tệp hoặc thử video MP4 khác.", () => {
        video.src = url;
        video.load();
      }, 20_000);
    if (!video.videoWidth || !video.videoHeight) throw new FrameError("Tệp được chọn không chứa hình ảnh video có thể đọc được.");
    const browserDuration = video.duration;
    if (Number.isFinite(browserDuration) && browserDuration > 0
      && Math.abs(browserDuration - duration) > Math.max(0.5, duration * 0.03)) {
      throw new FrameError("Thời lượng video đã thay đổi. Hãy chọn lại video để app đo thời lượng trước khi phân tích.");
    }
    const usableDuration = Number.isFinite(browserDuration) && browserDuration > 0
      ? Math.min(duration, browserDuration) : duration;
    // Leave the last frame at least 80 ms before EOF, avoiding Safari/WebM end
    // seeks that return an empty frame. Include both ends of the usable timeline.
    const lastTime = Math.max(0, usableDuration - Math.min(0.08, usableDuration / 20));
    const count = Math.min(MAX_FRAME_COUNT, Math.max(4, Math.ceil(duration / 2) + 1));
    const samples: VideoFrameSample[] = [];
    let totalDataLength = 0;
    for (let index = 0; index < count; index++) {
      const time = Math.round(lastTime * index / (count - 1) * 1000) / 1000;
      await seekFrame(video, time);
      const image = await encodeFrame(video, canvas);
      totalDataLength += image.length;
      if (totalDataLength > MAX_FRAME_DATA_LENGTH) throw new FrameError("Tổng ảnh phân tích quá lớn. Hãy dùng video có độ phân giải thấp hơn.");
      samples.push({ time, image });
      onProgress?.((index + 1) / count, `Đã đọc ${index + 1}/${count} cảnh…`);
    }
    return samples;
  } catch (error) {
    if (error instanceof FrameError) throw error;
    throw videoFailure(video);
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
    // Release decoded-frame and canvas backing memory even after a failed seek.
    canvas.width = 0;
    canvas.height = 0;
  }
}
