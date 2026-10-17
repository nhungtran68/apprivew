/** Browser file actions must be called directly by a click, before any await/import. */
interface WritableVideoFile {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

interface VideoFileHandle {
  createWritable(): Promise<WritableVideoFile>;
}

type VideoSaveWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
    excludeAcceptAllOption: boolean;
  }) => Promise<VideoFileHandle>;
};

export type VideoSaveResult = "saved" | "cancelled" | "unsupported";
export type VideoShareResult = "shared" | "cancelled" | "unsupported";

/** Keep readable Vietnamese titles while avoiding invalid Windows/mobile names. */
export function videoDownloadName(title = ""): string {
  const name = title.normalize("NFC").trim().replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ")
    .replace(/\.mp4$/i, "").replace(/\s+/g, " ").replace(/^[. ]+|[. ]+$/g, "").slice(0, 100).trim();
  const safe = !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? "loi-ke" : name;
  return `${safe}.mp4`;
}

function requireVideo(blob: Blob): void {
  if (!(blob instanceof Blob) || blob.size === 0 || blob.type !== "video/mp4") {
    throw new Error("Tệp video chưa sẵn sàng. Hãy ghép video lại trước khi tải.");
  }
}

function cancelled(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function supportsVideoSave(): boolean {
  return typeof window !== "undefined" && window.isSecureContext
    && typeof (window as VideoSaveWindow).showSaveFilePicker === "function";
}

/**
 * Chromium desktop can write to the user's chosen file and confirm completion.
 * Other browsers keep using the persistent <a download> rendered by the UI.
 * Never dynamically import this function in the click handler: the picker needs
 * the original user activation. Cancelling a picker must not start a download.
 */
export async function saveVideoFile(blob: Blob, title: string): Promise<VideoSaveResult> {
  requireVideo(blob);
  if (!supportsVideoSave()) return "unsupported";
  let writable: WritableVideoFile | undefined;
  try {
    const handle = await (window as VideoSaveWindow).showSaveFilePicker!({
      suggestedName: videoDownloadName(title),
      types: [{ description: "Video MP4", accept: { "video/mp4": [".mp4"] } }],
      excludeAcceptAllOption: true,
    });
    writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return "saved";
  } catch (error) {
    if (writable?.abort) await writable.abort().catch(() => {});
    if (cancelled(error)) return "cancelled";
    throw new Error("Chưa lưu được tệp. Hãy dùng Tải trực tiếp hoặc Mở video để lưu bằng trình duyệt.");
  }
}

function sharedFile(blob: Blob, title: string): File {
  requireVideo(blob);
  return new File([blob], videoDownloadName(title), { type: "video/mp4" });
}

export function canShareVideoFile(blob?: Blob, title = ""): boolean {
  if (!blob || typeof navigator === "undefined" || typeof navigator.canShare !== "function"
    || typeof navigator.share !== "function" || typeof File === "undefined") return false;
  try { return navigator.canShare({ files: [sharedFile(blob, title)] }); } catch { return false; }
}

/** Share the actual MP4 file, never a blob URL that another app cannot open. */
export async function shareVideoFile(blob: Blob, title: string): Promise<VideoShareResult> {
  const file = sharedFile(blob, title);
  if (!canShareVideoFile(blob, title)) return "unsupported";
  try {
    await navigator.share({ files: [file], title: title || "Video Lời Kể" });
    return "shared";
  } catch (error) {
    if (cancelled(error)) return "cancelled";
    throw new Error("Chưa chia sẻ được video. Bạn vẫn có thể tải tệp MP4 hoặc mở video để lưu.");
  }
}
