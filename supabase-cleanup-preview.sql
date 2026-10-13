-- ============================================================
-- TEST DATA CLEANUP — STEP 1: PREVIEW (read-only, changes nothing)
-- Run in Supabase > SQL Editor. It lists every property with how much
-- data it has, so you can tell me which ones are REAL and must be kept.
-- ============================================================

select
  p.name                                                         as property,
  coalesce(u.full_name, u.email, '—')                            as manager,
  to_char(p.created_at, 'Mon DD, YYYY')                          as created,
  (select count(*) from public.property_units x where x.property_id = p.id)   as unit_spots,
  (select count(*) from public.permits x where x.property_id = p.id)          as permits,
  (select count(*) from public.violations x where x.property_id = p.id)       as violations,
  (select count(*) from public.parking_sessions x where x.property_id = p.id) as pay_to_park,
  left(p.id::text, 8)                                            as id_starts_with
from public.properties p
left join public.users u on u.id = p.manager_id
order by p.created_at;
