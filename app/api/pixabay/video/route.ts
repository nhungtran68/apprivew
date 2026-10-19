import { getPixabayVideo } from "@/lib/pixabay";
import { StudioError } from "@/lib/studio-contract";
import { apiError, limitedJson, requestUser } from "@/lib/studio-server";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_VIDEO_BYTES = 60 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    await requestUser(request, true);
    const body = await limitedJson(request, 1000);
    const id = Number(body.id);
    const quality = body.quality ?? "medium";
    if (quality !== "medium" && quality !== "small" && quality !== "tiny") throw new StudioError("INVALID_PIXABAY_QUALITY", "Chất lượng video Pixabay không hợp lệ.");
    const selected = await getPixabayVideo(id, quality);
    if (selected.size > MAX_VIDEO_BYTES) throw new StudioError("PIXABAY_VIDEO_TOO_LARGE", "Video này quá 60 MB. Hãy chọn bản nhỏ hơn hoặc video khác.", 413);
    let upstream: Response;
    try { upstream = await fetch(selected.url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(90_000) }); }
    catch { throw new StudioError("PIXABAY_VIDEO_UNAVAILABLE", "Chưa tải được video Pixabay. Vui lòng thử lại.", 502); }
    if (!upstream.ok || !upstream.body) throw new StudioError("PIXABAY_VIDEO_UNAVAILABLE", "Chưa tải được video Pixabay. Vui lòng thử lại.", 502);
    const contentLength = Number(upstream.headers.get("content-length"));
    if (contentLength > MAX_VIDEO_BYTES) {
      await upstream.body.cancel();
      throw new StudioError("PIXABAY_VIDEO_TOO_LARGE", "Video này quá 60 MB. Hãy chọn bản nhỏ hơn hoặc video khác.", 413);
    }
    const contentType = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
      await upstream.body.cancel();
      throw new StudioError("PIXABAY_VIDEO_INVALID", "Tệp video Pixabay không đúng định dạng MP4.", 502);
    }
    const reader = upstream.body.getReader();
    let received = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { controller.close(); return; }
          received += chunk.value.byteLength;
          if (received > MAX_VIDEO_BYTES) {
            await reader.cancel();
            controller.error(new Error("Video Pixabay vượt quá 60 MB."));
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) { controller.error(error); }
      },
      async cancel() { await reader.cancel(); },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="pixabay-${id}.mp4"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error) { return apiError(error); }
}
