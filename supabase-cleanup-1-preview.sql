-- ============================================================
-- TEST DATA CLEANUP, STEP 1: PREVIEW (read-only, changes nothing)
-- Shows what step 2 will remove. Screenshot it and check it.
--
-- Removing:  properties "self managed", "test", "Test Property"
--            accounts me@test.com, jackson82fs@gmail.com
-- Keeping:   "Test property Provo" and jackson@lonestarrecovery.us
-- ============================================================

with gone_props as (
  select id, name, manager_id from public.properties
  where name in ('self managed', 'test', 'Test Property')
), gone_users as (
  select id, email, full_name, role from public.users
  where lower(email) in ('me@test.com', 'jackson82fs@gmail.com')
)
select 'PROPERTY' as what, p.name as item,
  'owner: ' || coalesce(u.email, '—') as detail,
  (select count(*) from public.property_units x where x.property_id = p.id) || ' spots · ' ||
  (select count(*) from public.permits x where x.property_id = p.id) || ' permits · ' ||
  (select count(*) from public.violations x where x.property_id = p.id) || ' violations' as also_removed
from gone_props p left join public.users u on u.id = p.manager_id
union all
select 'ACCOUNT', g.email, g.role || ' · ' || coalesce(g.full_name, ''),
  'main manager of: ' || coalesce((select string_agg(name, ', ') from public.properties where manager_id = g.id), 'nothing')
from gone_users g
union all
-- Safety check: should say "Test property Provo" is kept and not owned by an account being removed
select 'KEPT', p.name, 'owner: ' || coalesce(u.email, '—'),
  case when lower(u.email) in ('me@test.com', 'jackson82fs@gmail.com') then '⚠ owned by an account being removed' else 'ok' end
from public.properties p left join public.users u on u.id = p.manager_id
where p.name = 'Test property Provo'
order by 1, 2;
