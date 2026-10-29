-- ============================================================
-- TEAM ACCESS (several people on one property)
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- Adds:
--   property_team   who besides the property's main manager can sign in to it,
--                   with a role:
--                     owner    Owner / Admin: everything, incl. payouts and the team
--                     manager  everything except payouts and the team
--                     leasing  units, tenant invites, vehicles, guest passes
--                     viewer   sees everything, changes nothing
--                   Invites are rows with status 'invited' until accepted.
--                   Only the server (LotHQ's functions) writes this table.
--   manages_property(pid)  now also true for active owner / manager / leasing
--                   team members (this one rule controls most manager access)
--   views_property(pid)    true for anyone on the team, view-only included;
--                   used to let view-only people read the property's data
-- The property's main manager (properties.manager_id) is always an Owner.
-- No existing data is changed or deleted.
-- ============================================================

begin;

create table if not exists public.property_team (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references public.properties(id) on delete cascade,
  user_id          uuid,
  email            text not null,
  role             text not null check (role in ('owner','manager','leasing','viewer')),
  status           text not null default 'invited' check (status in ('invited','active')),
  invited_by       uuid,
  invited_by_name  text,
  token_hash       text,
  invited_at       timestamptz not null default now(),
  expires_at       timestamptz,
  accepted_at      timestamptz,
  unique (property_id, email)
);
create index if not exists property_team_user_idx on public.property_team (user_id) where status = 'active';
alter table public.property_team enable row level security;

-- Write access: main manager, or an active owner / manager / leasing team member
create or replace function public.manages_property(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.properties p
    join public.users u on u.id = auth.uid()
    where p.id = pid and p.manager_id = auth.uid() and u.role = 'manager'
  ) or exists (
    select 1 from public.property_team t
    join public.users u on u.id = auth.uid()
    where t.property_id = pid and t.user_id = auth.uid() and t.status = 'active'
      and t.role in ('owner','manager','leasing') and u.role = 'manager'
  );
$$;

-- Read access: anyone on the team, view-only included
create or replace function public.views_property(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.manages_property(pid) or exists (
    select 1 from public.property_team t
    join public.users u on u.id = auth.uid()
    where t.property_id = pid and t.user_id = auth.uid() and t.status = 'active' and u.role = 'manager'
  );
$$;

-- Property-level settings (rates, lot map, guest rules…): main manager, owners and managers
create or replace function public.runs_property(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.properties p
    join public.users u on u.id = auth.uid()
    where p.id = pid and p.manager_id = auth.uid() and u.role = 'manager'
  ) or exists (
    select 1 from public.property_team t
    join public.users u on u.id = auth.uid()
    where t.property_id = pid and t.user_id = auth.uid() and t.status = 'active'
      and t.role in ('owner','manager') and u.role = 'manager'
  );
$$;

-- Team list: admins, and people on the property's team
drop policy if exists "team: admins" on public.property_team;
create policy "team: admins" on public.property_team for select using (public.is_admin());
drop policy if exists "team: own rows" on public.property_team;
create policy "team: own rows" on public.property_team for select using (user_id = auth.uid());
drop policy if exists "team: property team reads" on public.property_team;
create policy "team: property team reads" on public.property_team for select using (public.views_property(property_id));

-- Team members can see and (owners/managers) update the property itself.
-- (These only add access; the main manager's existing access is unchanged.)
drop policy if exists "properties: team reads" on public.properties;
create policy "properties: team reads" on public.properties for select using (public.views_property(id));
drop policy if exists "properties: team updates" on public.properties;
create policy "properties: team updates" on public.properties for update
  using (public.runs_property(id)) with check (public.runs_property(id));

-- View-only team members can read the property's data
drop policy if exists "permits: team viewers read" on public.permits;
create policy "permits: team viewers read" on public.permits for select using (public.views_property(property_id));
drop policy if exists "units: team viewers read" on public.property_units;
create policy "units: team viewers read" on public.property_units for select using (public.views_property(property_id));
drop policy if exists "unit permits: team viewers read" on public.unit_permits;
create policy "unit permits: team viewers read" on public.unit_permits for select
  using (exists (select 1 from public.property_units s where s.id = unit_slot_id and public.views_property(s.property_id)));
drop policy if exists "unit vehicles: team viewers read" on public.unit_vehicles;
create policy "unit vehicles: team viewers read" on public.unit_vehicles for select using (public.views_property(property_id));
drop policy if exists "vehicles: team viewers read" on public.vehicles;
create policy "vehicles: team viewers read" on public.vehicles for select
  using (exists (select 1 from public.permits p where p.id = permit_id and public.views_property(p.property_id)));
drop policy if exists "sessions: team viewers read" on public.parking_sessions;
create policy "sessions: team viewers read" on public.parking_sessions for select using (public.views_property(property_id));
drop policy if exists "violations: team viewers read" on public.violations;
create policy "violations: team viewers read" on public.violations for select using (public.views_property(property_id));
drop policy if exists "tenancies: team viewers read" on public.unit_tenancies;
create policy "tenancies: team viewers read" on public.unit_tenancies for select using (public.views_property(property_id));
drop policy if exists "guest pass types: team viewers read" on public.guest_pass_types;
create policy "guest pass types: team viewers read" on public.guest_pass_types for select using (public.views_property(property_id));
drop policy if exists "guest passes: team viewers read" on public.guest_passes;
create policy "guest passes: team viewers read" on public.guest_passes for select
  using (property_id is not null and public.views_property(property_id));
drop policy if exists "terms acceptances: team reads" on public.terms_acceptances;
create policy "terms acceptances: team reads" on public.terms_acceptances for select using (public.views_property(property_id));

-- Owners on the team can see the property's payout account status
drop policy if exists "payout accounts: team owners read" on public.payout_accounts;
create policy "payout accounts: team owners read" on public.payout_accounts for select using (
  exists (select 1 from public.properties p
          join public.property_team t on t.property_id = p.id
          where p.payout_account_id = payout_accounts.id and t.user_id = auth.uid()
            and t.status = 'active' and t.role = 'owner')
);

commit;

notify pgrst, 'reload schema';
