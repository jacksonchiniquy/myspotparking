-- ============================================================
-- TEAM ACCESS, PART 3: who can add and remove properties
-- Run once in Supabase > SQL Editor. Safe to re-run.
--
-- Adds two extra checks on top of the existing property rules:
--   Remove a property: only its main manager (or a LotHQ admin).
--     Team members (Owner, Manager, Leasing agent, View only) can't.
--   Add a property: a manager can add one for themselves, unless they're
--     only on other people's teams (an invited staff member who isn't the
--     main manager of any property). The owner or LotHQ adds it for them.
-- These only take access away; nothing that works for main managers or
-- admins changes. No data is changed or deleted.
-- ============================================================

begin;

drop policy if exists "properties: only main manager deletes" on public.properties;
create policy "properties: only main manager deletes" on public.properties
  as restrictive for delete
  using (public.is_admin() or manager_id = auth.uid());

drop policy if exists "properties: team-only members don't add" on public.properties;
create policy "properties: team-only members don't add" on public.properties
  as restrictive for insert
  with check (
    public.is_admin()
    or (
      manager_id = auth.uid()
      and (
        exists (select 1 from public.properties p where p.manager_id = auth.uid())
        or not exists (select 1 from public.property_team t where t.user_id = auth.uid() and t.status = 'active')
      )
    )
  );

commit;

notify pgrst, 'reload schema';
