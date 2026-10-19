# Unified application credits

Run `credits-ledger.sql` once in Supabase SQL Editor after the existing member schema. It adds an independent wallet, reservation table, append-only event ledger, and admin adjustments. Existing `studio_members.ai_units_*` and `voice_clone_*` columns and account data are preserved.

The one-time migration grants each existing member `max(0, ai_units_limit - ai_units_used)` application credits. An event named `legacy_conversion` records the grant. Newly registered members start at zero credits. This conversion is a promotional opening balance, not Maziao provider credits and not a financial liability calculation.

Add `SUPABASE_SERVICE_ROLE_KEY` (or a Supabase secret key with the same privileges as `SUPABASE_SECRET_KEY`) **only as a server-side Vercel environment variable** for Production and Preview. Never add `NEXT_PUBLIC_` to its name and never expose it in browser code. User-session Supabase clients can read only their own wallet and history. The reserve, settle, refund, provider-task, and admin-adjust RPCs execute only with the server-side privileged key; the browser's authenticated role has no execute grant.

One application credit is currently priced at 100 VND. Tariffs are defined in `lib/studio-credits.ts`: script 10, video analysis 15, scene plan 10, speech 1 per started 100 characters, voice clone 50, and library video 1 per started 2 MiB delivered. These are retail application charges; provider costs are recorded separately in `provider_usage` when available.

Every paid action needs a stable `Idempotency-Key` UUID. Reserve returns `created: false` for a repeated key, and the server must not call a provider again in that case. Successful work settles and deducts credits exactly once. A definitively failed task refunds the reservation. When Maziao has accepted a task or its status is unclear, retain the reservation and provider task ID for reconciliation; do not blindly refund or submit it again.

Before publishing the new backend, verify on the deployed app with two different accounts: the opening balances, a successful debit, an error refund, an exhausted-wallet rejection, a duplicate request key, simultaneous requests against a near-empty wallet, and a manual admin adjustment retried with the same key. Run Supabase security advisors and confirm an authenticated browser client cannot execute `studio_credit_reserve` or see another member's ledger rows.
