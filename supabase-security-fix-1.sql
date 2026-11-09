-- ============================================================
-- SECURITY FIX 1
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- 1. Properties: removes "All users can view properties" (which let anyone,
--    even without signing in, read every property and its billing settings).
--    Each person now sees only their own properties:
--      LotHQ admins ...... all of them
--      Managers & team ... properties they work on (unchanged rule)
--      Residents ......... properties where they have a permit
--      Enforcement ....... properties assigned to their company
--    Public pages (Pay to Park, property search, sign-up) are unaffected:
--    they go through LotHQ's server.
-- 2. Users: managers can no longer edit other managers' or admins'
--    profiles. People edit their own; managers edit residents; admins anyone.
-- No data is changed or deleted. Shows the resulting rules at the end.
-- ============================================================

begin;

-- 1. Properties
drop policy if exists "All users can view properties" on public.properties;

drop policy if exists "properties: admins read" on public.properties;
create policy "properties: admins read" on public.properties for select using (public.is_admin());

drop policy if exists "properties: residents read" on public.properties;
create policy "properties: residents read" on public.properties for select using (
  exists (select 1 from public.permits p where p.property_id = properties.id and p.holder_id = auth.uid())
);

drop policy if exists "properties: enforcement reads" on public.properties;
create policy "properties: enforcement reads" on public.properties for select using (public.enforces_property(id));

-- 2. Users
drop policy if exists "Managers can update users status" on public.users;
drop policy if exists "users: who can update" on public.users;
create policy "users: who can update" on public.users for update
  using (id = auth.uid() or public.is_admin() or (role = 'holder' and public.is_manager_or_admin()))
  with check (id = auth.uid() or public.is_admin() or (role = 'holder' and public.is_manager_or_admin()));

commit;

notify pgrst, 'reload schema';

-- What's in place now (for your screenshot)
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public' and tablename in ('properties', 'users')
order by tablename, cmd, policyname;
