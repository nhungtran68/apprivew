import { apiError, getConfig, json, requestUser } from "@/lib/studio-server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { try { return json(await getConfig(await requestUser(request))); } catch (error) { return apiError(error); } }
