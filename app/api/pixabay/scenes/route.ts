import { StudioError } from "@/lib/studio-contract";
import { planStockScenes, validStockAspectRatio, validStockScript } from "@/lib/stock-scenes";
import { apiError, consumeAiUnits, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";

export const runtime = "nodejs";
export const maxDuration = 240;

export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    // A 6,000-character Vietnamese script may occupy ~18 KB in UTF-8 JSON.
    const body = await limitedJson(request, 30_000);
    const script = validStockScript(body.script);
    const aspectRatio = validStockAspectRatio(body.aspectRatio);
    const { key } = await providerKey(userId, "deepseek");
    if (!process.env.PIXABAY_API_KEY?.trim())
      throw new StudioError("PIXABAY_NOT_CONFIGURED", "Kho video chưa được cấu hình. Vui lòng liên hệ quản trị viên.", 503, "contact_admin");
    return json(await planStockScenes(key, { script, aspectRatio }, () => consumeAiUnits(userId, 1)));
  } catch (error) { return apiError(error); }
}
