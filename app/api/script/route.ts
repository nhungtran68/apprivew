import { apiError, json, limitedJson, providerKey, requestUser } from "@/lib/studio-server";
import { runWithCredits } from "@/lib/studio-credit-operation";
import { creditRates } from "@/lib/studio-credits";
import { StudioError, cleanText, validDuration, validFormat } from "@/lib/studio-contract";
import { createScript } from "@/lib/studio-deepseek";
import { projectProfile } from "@/lib/studio-profile";
import { builtinScriptTypeInstruction, scriptTemplateInstruction } from "@/lib/script-templates";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true), body = await limitedJson(request);
    if (!body.analysis || typeof body.analysis !== "object" || Array.isArray(body.analysis)) throw new StudioError("ANALYSIS_REQUIRED", "Phân tích ảnh video trước khi viết kịch bản.");
    const intent = cleanText(body.intent, 5000), duration = validDuration(body.duration);
    if (!intent) throw new StudioError("INTENT_REQUIRED", "Cho AI biết điều bạn muốn người xem hiểu hoặc làm.");
    let style: { kind: "builtin"; format: ReturnType<typeof validFormat>; name: string; prompt: string } | { kind: "custom"; name: string; prompt: string };
    if (body.templateId !== undefined && body.templateId !== null && body.templateId !== "") {
      if (typeof body.templateId !== "string") throw new StudioError("INVALID_TEMPLATE", "Chọn dạng kịch bản hợp lệ.");
      const template = await scriptTemplateInstruction(userId, body.templateId);
      style = { kind: "custom", name: template.title, prompt: template.prompt };
    } else {
      const format = validFormat(body.format);
      const builtin = await builtinScriptTypeInstruction(userId, format);
      style = { kind: "builtin", format, name: builtin.name, prompt: builtin.prompt };
    }
    const [{ key }, profile] = await Promise.all([providerKey(userId, "deepseek"), projectProfile(userId, body.profile)]);
    return json(await runWithCredits(request, userId, "script", creditRates.script, () => createScript(key, {
      analysis: body.analysis, intent, duration, profile, style,
      format: style.kind === "builtin" ? style.format : undefined,
      angleId: style.kind === "builtin" ? cleanText(body.angleId, 60) : "",
      instruction: cleanText(body.instruction, 3000),
    }, async () => {})));
  } catch (error) { return apiError(error); }
}
