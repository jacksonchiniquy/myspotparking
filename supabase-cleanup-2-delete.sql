-- ============================================================
-- TEST DATA CLEANUP, STEP 2: REMOVE (run only after checking step 1)
-- All-or-nothing: if anything fails, nothing is removed.
--
-- Removes properties "self managed", "test", "Test Property" (and their
-- spots, permits, vehicles, guest passes, sessions and violations) and the
-- logins me@test.com and jackson82fs@gmail.com.
-- Keeps "Test property Provo", jackson@lonestarrecovery.us and the
-- activity log (history). Stripe test payments are not touched.
-- ============================================================

begin;

-- Stop if a kept property belongs to an account being removed
do $$ begin
  if exists (select 1 from public.properties p join public.users u on u.id = p.manager_id
             where p.name = 'Test property Provo' and lower(u.email) in ('me@test.com', 'jackson82fs@gmail.com')) then
    raise exception 'Stopped: Test property Provo belongs to an account being removed. Nothing was changed.';
  end if;
end $$;

create temp table _gone_props on commit drop as
  select id from public.properties where name in ('self managed', 'test', 'Test Property');
create temp table _gone_users on commit drop as
  select id from public.users where lower(email) in ('me@test.com', 'jackson82fs@gmail.com');

-- Data that belongs to the removed properties
delete from public.unit_permits  where unit_slot_id in (select id from public.property_units where property_id in (select id from _gone_props));
delete from public.unit_vehicles where property_id in (select id from _gone_props);
delete from public.vehicles      where permit_id in (select id from public.permits where property_id in (select id from _gone_props));
delete from public.guest_passes  where property_id in (select id from _gone_props);
delete from public.parking_sessions where property_id in (select id from _gone_props);
delete from public.violations    where property_id in (select id from _gone_props);
delete from public.permits       where property_id in (select id from _gone_props);
delete from public.property_units where property_id in (select id from _gone_props);
delete from public.properties    where id in (select id from _gone_props);

-- Data that belongs to the removed accounts
delete from public.vehicles      where permit_id in (select id from public.permits where holder_id in (select id from _gone_users));
delete from public.permits       where holder_id in (select id from _gone_users);
delete from public.property_team where user_id in (select id from _gone_users);
delete from public.manager_features where manager_id in (select id from _gone_users);
delete from public.users         where id in (select id from _gone_users);
delete from auth.users           where id in (select id from _gone_users);

commit;

select 'Done' as result,
  (select count(*) from public.properties where name in ('self managed', 'test', 'Test Property')) as test_properties_left,
  (select count(*) from public.users where lower(email) in ('me@test.com', 'jackson82fs@gmail.com')) as test_accounts_left,
  (select count(*) from public.properties where name = 'Test property Provo') as provo_kept;
