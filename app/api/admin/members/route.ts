import { apiError, json, limitedJson, listMembers, requestUser, updateMember } from "@/lib/studio-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { const userId = await requestUser(request); return json({ members: await listMembers(userId) }); } catch (error) { return apiError(error); } }
export async function PATCH(request: Request) { try { const userId = await requestUser(request, true); return json({ member: await updateMember(userId, await limitedJson(request, 5000)) }); } catch (error) { return apiError(error); } }
