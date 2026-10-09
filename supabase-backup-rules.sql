-- ============================================================
-- STEP 1 — BACKUP (changes no access rules)
-- Run this BEFORE supabase-lock-tables.sql.
--
-- Saves your current access rules inside your database, in a
-- private "rules_backup" table only you can see (in the dashboard).
-- Nothing to copy or save by hand.
--
-- You should see one row: backup_number, saved_at, rules_saved.
-- To undo the lock later, run supabase-undo-lock.sql.
-- ============================================================

create table if not exists public.rules_backup (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  rules_saved integer,
  script text not null
);
alter table public.rules_backup enable row level security;  -- no rules = only you (dashboard) can see it

insert into public.rules_backup (rules_saved, script)
select count(*),
  'do $u$ declare r record; begin for r in select policyname, tablename from pg_policies where schemaname = ''public'' and tablename in (''permits'',''property_units'',''unit_permits'',''unit_vehicles'',''vehicles'',''guest_passes'',''parking_sessions'') loop execute format(''drop policy %I on public.%I'', r.policyname, r.tablename); end loop; end $u$;' || E'\n' ||
  coalesce(string_agg(
    format('create policy %I on public.%I as %s for %s to %s%s%s;',
      policyname, tablename, permissive, cmd, array_to_string(roles, ', '),
      coalesce(' using (' || qual || ')', ''),
      coalesce(' with check (' || with_check || ')', '')),
    E'\n' order by tablename, policyname), '')
from pg_policies
where schemaname = 'public'
  and tablename in ('permits','property_units','unit_permits','unit_vehicles','vehicles','guest_passes','parking_sessions');

select id as backup_number, created_at as saved_at, rules_saved
from public.rules_backup order by id desc limit 1;
