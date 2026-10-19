begin;

-- The channel may be rotated after webhook registration. A new set of keys
-- must confirm the webhook again before checkout is enabled.
alter table public.studio_payment_gateway
  add column if not exists credential_fingerprint text;
alter table public.studio_payment_gateway
  add constraint studio_payment_gateway_fingerprint_check
  check (credential_fingerprint is null or credential_fingerprint ~ '^[0-9a-f]{64}$');

-- The gateway state is server-only. An explicit deny policy also documents
-- that browsers cannot discover or mutate it through PostgREST.
create policy studio_payment_gateway_browser_deny on public.studio_payment_gateway
  for select to anon, authenticated using (false);

create index if not exists studio_payment_orders_pack_id_idx
  on public.studio_payment_orders(pack_id);

commit;
