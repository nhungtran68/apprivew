import { apiError, getConfig, json, limitedJson, requestUser, saveSettings } from "@/lib/studio-server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { return json(await getConfig(await requestUser(request))); } catch (error) { return apiError(error); } }
export async function POST(request: Request) { try { const userId = await requestUser(request, true); await saveSettings(userId, await limitedJson(request, 64000)); return json({ ok: true, ...await getConfig(userId) }); } catch (error) { return apiError(error); } }
