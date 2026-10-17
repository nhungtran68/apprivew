import { apiError, json, limitedJson, readSettings, requestUser, saveSettings } from "@/lib/studio-server";
import { StudioError, sanitizeProfile } from "@/lib/studio-contract";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return json(await readSettings(await requestUser(request))); }
  catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true), body = await limitedJson(request, 64000);
    if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile)) throw new StudioError("PROFILE_REQUIRED", "Nhập hồ sơ sáng tạo để AI hiểu cách bạn muốn chia sẻ.");
    await saveSettings(userId, { profile: sanitizeProfile(body.profile) });
    return json({ ok: true, ...await readSettings(userId) });
  } catch (error) { return apiError(error); }
}
