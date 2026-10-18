import { deleteScriptTemplate, updateScriptTemplate } from "@/lib/script-templates";
import { apiError, json, limitedJson, requestUser } from "@/lib/studio-server";

export const runtime = "nodejs";

type TemplateContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: TemplateContext) {
  try {
    const userId = await requestUser(request, true);
    const { id } = await context.params;
    const template = await updateScriptTemplate(userId, id, await limitedJson(request, 16_000));
    return json({ template });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: TemplateContext) {
  try {
    const userId = await requestUser(request, true);
    const { id } = await context.params;
    await deleteScriptTemplate(userId, id);
    return json({ ok: true });
  } catch (error) { return apiError(error); }
}
