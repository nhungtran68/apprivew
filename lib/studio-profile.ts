import "server-only";
import { mergeProfile } from "./studio-contract";
import { readSettings } from "./studio-server";

// The authenticated session and studio_settings RLS select the account. A caller's
// userId in JSON is never used, and an omitted field keeps the saved preference.
export async function projectProfile(userId: string, override: unknown) {
  const { profile } = await readSettings(userId);
  return mergeProfile(profile, override);
}
