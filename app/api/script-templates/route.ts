import { createScriptTemplate, listBuiltinScriptTypes, listScriptTemplates } from "@/lib/script-templates";
import { apiError, json, limitedJson, requestUser } from "@/lib/studio-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const userId = await requestUser(request);
    const [templates, builtins] = await Promise.all([listScriptTemplates(userId), listBuiltinScriptTypes(userId)]);
    return json({ templates, builtins });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    const template = await createScriptTemplate(userId, await limitedJson(request, 16_000));
    return json({ template }, 201);
  } catch (error) { return apiError(error); }
}
