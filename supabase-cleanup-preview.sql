-- ============================================================
-- TEST DATA CLEANUP — STEP 1: PREVIEW (read-only, changes nothing)
-- Run in Supabase > SQL Editor. It lists every property with how much
-- data it has, so you can tell me which ones are REAL and must be kept.
-- The last row counts old violations that have no property on them.
-- ============================================================

select * from (
  select
    p.name                                                                       as property,
    coalesce(u.full_name, u.email, '—')                                          as manager,
    (select count(*) from public.property_units x where x.property_id = p.id)   as unit_spots,
    (select count(*) from public.permits x where x.property_id = p.id)          as permits,
    (select count(*) from public.violations x where x.property_id = p.id)       as violations,
    (select count(*) from public.parking_sessions x where x.property_id = p.id) as pay_to_park,
    left(p.id::text, 8)                                                          as id_starts_with
  from public.properties p
  left join public.users u on u.id = p.manager_id
  union all
  select '(no property recorded)', '—', 0,
    (select count(*) from public.permits where property_id is null),
    (select count(*) from public.violations where property_id is null),
    (select count(*) from public.parking_sessions where property_id is null),
    '—'
) t
order by property;
