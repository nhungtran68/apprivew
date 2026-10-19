import { getPixabayVideo } from "@/lib/pixabay";
import { StudioError } from "@/lib/studio-contract";
import { apiError, limitedJson, requestUser } from "@/lib/studio-server";
import { creditRequestId } from "@/lib/studio-credit-operation";
import { creditsForStockBytes, refundCredits, reserveCredits, settleCredits } from "@/lib/studio-credits";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_VIDEO_BYTES = 60 * 1024 * 1024;

export async function POST(request: Request) {
  let billed: { userId: string; requestId: string } | null = null;
  try {
    const userId = await requestUser(request, true);
    const requestId = creditRequestId(request);
    const body = await limitedJson(request, 1000);
    const id = Number(body.id);
    const quality = body.quality ?? "medium";
    if (quality !== "medium" && quality !== "small" && quality !== "tiny") throw new StudioError("INVALID_PIXABAY_QUALITY", "Chất lượng video đã chọn không hợp lệ.");
    const selected = await getPixabayVideo(id, quality);
    if (!selected.size || selected.size > MAX_VIDEO_BYTES) throw new StudioError("PIXABAY_VIDEO_TOO_LARGE", "Video này chưa rõ dung lượng hoặc quá 60 MB. Hãy chọn bản khác.", 413);
    const quotedCredits = creditsForStockBytes(selected.size);
    const reserved = await reserveCredits(userId, requestId, "stockVideo", quotedCredits, { videoId: id, quality, quotedBytes: selected.size });
    if (!reserved.created) throw new StudioError("CREDIT_REQUEST_REUSED", "Video này đã được tải hoặc đang xử lý. Hãy kiểm tra kết quả trước khi thử lại.", 409);
    billed = { userId, requestId };
    let upstream: Response;
    try { upstream = await fetch(selected.url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(90_000) }); }
    catch { throw new StudioError("PIXABAY_VIDEO_UNAVAILABLE", "Chưa tải được video thư viện. Vui lòng thử lại.", 502); }
    if (!upstream.ok || !upstream.body) throw new StudioError("PIXABAY_VIDEO_UNAVAILABLE", "Chưa tải được video thư viện. Vui lòng thử lại.", 502);
    const contentLength = Number(upstream.headers.get("content-length"));
    if (contentLength > MAX_VIDEO_BYTES || (Number.isFinite(contentLength) && contentLength > 0 && creditsForStockBytes(contentLength) > quotedCredits)) {
      await upstream.body.cancel();
      throw new StudioError("PIXABAY_VIDEO_TOO_LARGE", "Dung lượng video lớn hơn dự kiến. Hãy chọn bản nhỏ hơn hoặc video khác.", 413);
    }
    const contentType = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
      await upstream.body.cancel();
      throw new StudioError("PIXABAY_VIDEO_INVALID", "Tệp video không đúng định dạng MP4.", 502);
    }
    const reader = upstream.body.getReader();
    let received = 0;
    let finished = false;
    let settlementStarted = false;
    // The reservation stays in place if settlement fails after the source was
    // fully delivered. Retrying the same ID can never download twice for free.
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            if (!received) throw new Error("Video thư viện trống.");
            settlementStarted = true;
            await settleCredits(userId, requestId, creditsForStockBytes(received));
            finished = true;
            controller.close();
            return;
          }
          received += chunk.value.byteLength;
          if (received > MAX_VIDEO_BYTES || creditsForStockBytes(received) > quotedCredits) {
            await reader.cancel();
            throw new Error("Video thư viện vượt dung lượng dự kiến.");
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          if (!settlementStarted && !finished) await refundCredits(userId, requestId).catch(() => {});
          controller.error(error);
        }
      },
      async cancel() {
        await reader.cancel();
        if (!settlementStarted && !finished) await refundCredits(userId, requestId).catch(() => {});
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="thu-vien-${id}.mp4"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error) {
    if (billed) await refundCredits(billed.userId, billed.requestId).catch(() => {});
    return apiError(error);
  }
}
