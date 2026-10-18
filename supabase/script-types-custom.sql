-- Apply once to an existing installation before deploying custom script types.
-- Only widens the legacy format constraint. Existing templates and prompts stay intact.
begin;

alter table public.studio_script_templates
  drop constraint if exists studio_script_templates_format_check;

alter table public.studio_script_templates
  add constraint studio_script_templates_format_check
  check (format in ('review','story','tips','sales','custom'));

commit;
