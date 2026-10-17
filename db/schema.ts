// Canonical schema and RLS policies are reviewed SQL in supabase/setup.sql.
export type StudioMemberRow = { user_id: string; email: string; display_name: string; role: "admin" | "member"; enabled: boolean; ai_units_limit: number; ai_units_used: number; created_at: string; updated_at: string };
export type StudioSettingsRow = { user_id: string; profile_json: Record<string, unknown>; updated_at: string };
export type StudioVoiceRow = { user_id: string; voice_id: string; name: string; source: "personal" | "needs_verification" | "shared"; authorization_tag: string; verified_at: string };
