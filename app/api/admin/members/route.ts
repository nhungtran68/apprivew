import { apiError, json, limitedJson, listMembers, requestUser, updateMember } from "@/lib/studio-server";
import { creditRequestId } from "@/lib/studio-credit-operation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { const userId = await requestUser(request); return json({ members: await listMembers(userId) }); } catch (error) { return apiError(error); } }
export async function PATCH(request: Request) { try { const userId = await requestUser(request, true); const body = await limitedJson(request, 5000); return json({ member: await updateMember(userId, body, "creditDelta" in body ? creditRequestId(request) : undefined) }); } catch (error) { return apiError(error); } }
