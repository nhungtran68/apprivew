import { updateBuiltinScriptType } from "@/lib/script-templates";
import { apiError, json, limitedJson, requestUser } from "@/lib/studio-server";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ format: string }> }) {
  try {
    const userId = await requestUser(request, true);
    const { format } = await context.params;
    const builtin = await updateBuiltinScriptType(userId, format, await limitedJson(request, 16_000));
    return json({ builtin });
  } catch (error) { return apiError(error); }
}
