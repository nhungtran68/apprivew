# Member data and AI allowance

Review and run `setup.sql` once in a fresh Supabase project. It creates member/profile/voice tables, ownership policies, an atomic allowance RPC, and private `studio-media` storage. No provider credential is stored in these tables.

For Tạo Kịch Bản AI, run `script-templates.sql` after `setup.sql` on a fresh project. An existing project that already ran the earlier script should run `script-types-custom.sql` before deploying the custom script-type UI. This only broadens the `format` check to accept `custom`; existing rows and encrypted prompts remain unchanged. The application stores each script type's private prompt encrypted using the existing server-only `STUDIO_ENCRYPTION_KEY`.

Run `script-builtins.sql` before deploying editable prompts for the four built-in script types. It adds a separate administrator-managed table; the four cards use their existing defaults until the administrator saves an edit. All enabled members can select the cards, while only administrators can change their encrypted prompts. Existing custom types are unaffected.

Invite/create the first Auth user through the Supabase dashboard. Promote that exact user's UUID with the last commented SQL statement, then sign in. New users start disabled with zero allowance. An enabled administrator can enable members and set their allowance through `/api/admin/members`; this API cannot create Auth identities, change roles or expose provider keys. Disable public signup for an invitation-only app.

Required server values are `DEEPSEEK_API_KEY`, `ELEVENLABS_API_KEY`, and a random `STUDIO_ENCRYPTION_KEY` at least 32 characters long. The last value signs voice ownership grants so a member cannot forge a database row to use another member's cloned voice. Retain it across deployments. Public values are `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. No service-role key is needed. Optional `STUDIO_SHARED_VOICE_IDS` is a comma-separated allowlist; otherwise members see only premade voices and their own clones.

One DeepSeek request costs 1 AI unit. Each ElevenLabs speech request costs one unit per started 100 text characters; timing retries are new requests and consume units. Cloning a voice costs 10 units. Units are consumed atomically immediately before a provider call, including a call that fails or times out, because the provider may already have processed it. No member-facing refund/reset operation exists. An administrator can increase the limit or reset usage explicitly. Units are application allowances, not money or video counts.

Video remains on the device. The browser sends at most 20 small JPEG frames to DeepSeek; analysis explicitly identifies this sampling limit and does not claim to hear original audio. Voice samples upload directly to private storage to bypass Vercel's request size limit, and are removed after the clone request. Generated narration returns five-minute signed URLs; the browser must fetch the WAVs directly, keep its local project copy, and remove the temporary objects when finished. Signed URLs grant temporary access to anyone possessing the URL; do not log or share them.

After applying SQL, run Supabase security advisors and test as two separate members: one cannot select the other's settings, voice records or media. Test allowance exhaustion and concurrent consumption. Source-only tests verify application guards, but live RLS/SQL checks require an attached project and have not been run by creating these files.

## Email links

Set Site URL to the production app. Configure Auth Email Templates with these links so signup, dashboard invitations and password recovery work without a browser PKCE verifier:

- Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`
- Invite user: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite`
- Reset password: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`

If retaining default PKCE recovery, also allow the exact app URL `/auth/callback?next=/dat-mat-khau` in Redirect URLs.
