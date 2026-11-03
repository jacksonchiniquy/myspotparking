-- ============================================================
-- TEAM ACCESS, PART 4: adding properties is a per-manager switch
-- Run once in Supabase > SQL Editor. Safe to re-run.
--
-- Managers add properties themselves only when LotHQ has turned on
-- "Can add properties" for them (Admin → Managers → Plan). Everyone else
-- uses "Request a property" and LotHQ creates it from Admin.
-- Replaces the add-property rule from part 3. The "only the main manager
-- can remove a property" rule from part 3 stays. No data is changed.
-- ============================================================

begin;

drop policy if exists "properties: team-only members don't add" on public.properties;
drop policy if exists "properties: add only with LotHQ's ok" on public.properties;
create policy "properties: add only with LotHQ's ok" on public.properties
  as restrictive for insert
  with check (
    public.is_admin()
    or (
      manager_id = auth.uid()
      and exists (
        select 1 from public.manager_features f
        where f.manager_id = auth.uid()
          and coalesce((f.flags->>'add_properties')::boolean, false)
      )
    )
  );

commit;

notify pgrst, 'reload schema';
