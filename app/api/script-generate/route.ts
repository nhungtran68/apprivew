import { generateStandaloneScript } from "@/lib/script-generation";
import { scriptTemplateInstruction } from "@/lib/script-templates";
import { StudioError, cleanText, validDuration, validFormat, type StudioFormat } from "@/lib/studio-contract";
import { projectProfile } from "@/lib/studio-profile";
import { apiError, consumeAiUnits, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    const body = await limitedJson(request, 12_000);
    const title = cleanText(body.title, 121);
    const brief = cleanText(body.brief, 5001);
    if (!title || title.length > 120) throw new StudioError("SCRIPT_TITLE_REQUIRED", "Nhập tiêu đề kịch bản, tối đa 120 ký tự.");
    if (brief.length < 5 || brief.length > 5000) throw new StudioError("SCRIPT_BRIEF_REQUIRED", "Cho AI biết sản phẩm, người xem và điều bạn muốn chia sẻ (5–5.000 ký tự).");
    const durationSeconds = validDuration(body.durationSeconds);
    let style: { kind: "builtin"; format: StudioFormat } | { kind: "custom"; name: string; prompt: string };
    if (body.templateId !== undefined && body.templateId !== null && body.templateId !== "") {
      if (typeof body.templateId !== "string") throw new StudioError("INVALID_TEMPLATE", "Chọn mẫu kịch bản hợp lệ.");
      const template = await scriptTemplateInstruction(userId, body.templateId);
      style = { kind: "custom", name: template.title, prompt: template.prompt };
    } else style = { kind: "builtin", format: validFormat(body.format) };
    const [{ key }, profile] = await Promise.all([providerKey(userId, "deepseek"), projectProfile(userId, undefined)]);
    const script = await generateStandaloneScript(key, {
      style, title, brief, durationSeconds, profile,
    }, () => consumeAiUnits(userId, 1));
    return json({ script });
  } catch (error) { return apiError(error); }
}
