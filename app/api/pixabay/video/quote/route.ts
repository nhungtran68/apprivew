import { quotePixabayVideo } from "@/lib/pixabay";
import { StudioError } from "@/lib/studio-contract";
import { apiError, json, requestUser } from "@/lib/studio-server";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Quote actual Pixabay rendition metadata; this endpoint does not debit credits. */
export async function GET(request: Request) {
  try {
    await requestUser(request);
    const raw = new URL(request.url).searchParams.get("ids") || "";
    const parts = raw.split(",");
    if (!parts.length || parts.length > 12 || parts.some(part => !/^[1-9]\d{0,9}$/.test(part)))
      throw new StudioError("INVALID_PIXABAY_ID", "Danh sách video chưa hợp lệ. Hãy chọn lại cảnh.");
    const ids = parts.map(Number);
    if (new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id > 9_999_999_999))
      throw new StudioError("INVALID_PIXABAY_ID", "Danh sách video có cảnh bị trùng hoặc không hợp lệ.");
    const quotes = await Promise.all(ids.map(quotePixabayVideo));
    return json({ quotes });
  } catch (error) { return apiError(error); }
}
