-- ============================================================
-- SECURITY CHECK (read-only: changes nothing)
-- Run in Supabase > SQL Editor and screenshot the results table.
-- One row per finding. An empty result means nothing to worry about.
-- ============================================================

-- 1. Tables anyone could read or write because access rules are OFF
select 'RULES OFF' as finding, c.relname as table_name, 'Row-level security is not turned on' as detail
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity

union all
-- 2. Rules that let everyone in (no conditions)
select 'OPEN RULE', tablename, policyname || ' (' || cmd || ', for ' || array_to_string(roles, ',') || ')'
from pg_policies
where schemaname = 'public'
  and (coalesce(qual, '') in ('true', '(true)') or (qual is null and coalesce(with_check, '') in ('true', '(true)')))
  and policyname not ilike '%admin%'

union all
-- 3. Logins and people that look like test accounts (to review before going live)
select 'TEST ACCOUNT?', role, coalesce(full_name, '') || ' · ' || coalesce(email, '')
from public.users
where email ilike any (array['%test%', '%example.com', '%@x.com'])
   or full_name ilike any (array['%test%', 'john doe'])

union all
-- 4. Properties that look like test data
select 'TEST PROPERTY?', 'properties', name
from public.properties
where name ilike any (array['%test%', '%sample%', 'self managed'])

order by 1, 2;
