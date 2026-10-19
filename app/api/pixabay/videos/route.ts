import { searchPixabayVideos } from "@/lib/pixabay";
import { StudioError } from "@/lib/studio-contract";
import { apiError, json, requestUser } from "@/lib/studio-server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requestUser(request);
    const search = new URL(request.url).searchParams;
    const page = Number(search.get("page") ?? "1");
    const lang = search.get("lang") ?? "vi";
    if (lang !== "vi" && lang !== "en") throw new StudioError("INVALID_PIXABAY_LANGUAGE", "Ngôn ngữ tìm kiếm không hợp lệ.");
    return json(await searchPixabayVideos(search.get("q") ?? "", page, lang));
  } catch (error) { return apiError(error); }
}
