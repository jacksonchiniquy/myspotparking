-- ============================================================
-- STEP 1 — BACKUP (read-only, changes nothing)
-- Run this BEFORE supabase-lock-tables.sql.
--
-- It produces ONE cell of text: your current access rules for the
-- tables being locked, written as an "undo" script.
-- Click the cell, copy everything, and save it somewhere safe
-- (a note, a text file, an email to yourself).
--
-- To undo the lock later: paste that saved text into the SQL Editor
-- and click Run. You'll be back exactly where you are today.
-- ============================================================

select
  '-- UNDO: restores access rules as of ' || now()::text || E'\n' ||
  'begin;' || E'\n' ||
  'do $$ declare r record; begin for r in select policyname, tablename from pg_policies where schemaname = ''public'' and tablename in (''permits'',''property_units'',''unit_permits'',''unit_vehicles'',''vehicles'',''guest_passes'',''parking_sessions'') loop execute format(''drop policy %I on public.%I'', r.policyname, r.tablename); end loop; end $$;' || E'\n' ||
  coalesce(string_agg(
    format('create policy %I on public.%I as %s for %s to %s%s%s;',
      policyname, tablename, permissive, cmd, array_to_string(roles, ', '),
      coalesce(' using (' || qual || ')', ''),
      coalesce(' with check (' || with_check || ')', '')),
    E'\n' order by tablename, policyname), '') || E'\n' ||
  'commit;' as undo_script
from pg_policies
where schemaname = 'public'
  and tablename in ('permits','property_units','unit_permits','unit_vehicles','vehicles','guest_passes','parking_sessions');
