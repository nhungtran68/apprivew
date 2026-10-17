-- Read-only checks after setup.sql is applied. Run in Supabase SQL Editor.
-- Expected: all three tables have row security enabled; no anon table grants;
-- authenticated cannot update member role/email/user_id; only the positive consume RPC is public.
select c.relname, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('studio_members','studio_settings','studio_voices')
order by c.relname;

select table_name, grantee, privilege_type
from information_schema.table_privileges
where table_schema='public' and table_name in ('studio_members','studio_settings','studio_voices')
  and grantee in ('anon','authenticated')
order by table_name,grantee,privilege_type;

select column_name, privilege_type
from information_schema.column_privileges
where table_schema='public' and table_name='studio_members' and grantee='authenticated'
  and privilege_type='UPDATE'
order by column_name;

select n.nspname,p.proname,p.prosecdef,p.proconfig
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where (n.nspname='studio_private' or (n.nspname='public' and p.proname='consume_studio_ai_units'))
order by n.nspname,p.proname;

select schemaname,tablename,policyname,roles,cmd,qual,with_check
from pg_policies
where (schemaname='public' and tablename in ('studio_members','studio_settings','studio_voices'))
   or (schemaname='storage' and policyname like 'studio_media_%')
order by schemaname,tablename,policyname;

select id,public,file_size_limit,allowed_mime_types from storage.buckets where id='studio-media';
