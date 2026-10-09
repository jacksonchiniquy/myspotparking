-- ============================================================
-- STEP 2 — LOCK THE TABLES
-- Run supabase-backup-rules.sql first and save its output.
-- Run in Supabase > SQL Editor:
-- https://supabase.com/dashboard/project/ajadbfojccztiauxyxos/sql/new
-- Safe to re-run. All-or-nothing: if anything fails, nothing changes.
--
-- Replaces the "anyone can read/write" rules on these tables:
--   permits, property_units, unit_permits, unit_vehicles,
--   vehicles, guest_passes, parking_sessions
-- with:
--   Admins ............ everything
--   Managers .......... only their own properties' data
--   Residents ......... only their own permits, vehicles, guest passes
--   Enforcement ....... checks plates only through enforcement_lookup()
--                       (see supabase-enforcement.sql), for assigned properties
--   Not logged in ..... nothing (the unit portal, invite sign-up and
--                       payments now go through private server functions)
-- No data is changed or deleted.
-- ============================================================

begin;

-- ── Helpers ─────────────────────────────────────────────────
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'admin');
$$;

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.users where id = auth.uid();
$$;

-- Does the logged-in user manage this property?
create or replace function public.manages_property(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.properties p
    join public.users u on u.id = auth.uid()
    where p.id = pid and p.manager_id = auth.uid() and u.role = 'manager'
  );
$$;

-- Resident portal: link permits a manager issued to my email before I had an account
create or replace function public.claim_my_permits()
returns integer language plpgsql security definer set search_path = public, auth as $$
declare n integer;
begin
  if auth.uid() is null then return 0; end if;
  update public.permits set holder_id = auth.uid()
   where holder_id is null
     and lower(holder_email) = (select lower(email) from auth.users where id = auth.uid());
  get diagnostics n = row_count;
  return n;
end $$;

-- Resident sign-up: is there already an account for this email?
create or replace function public.account_exists_for_email(addr text)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (select 1 from auth.users where lower(email) = lower(trim(addr)));
$$;

grant execute on function public.claim_my_permits() to authenticated;
grant execute on function public.account_exists_for_email(text) to anon, authenticated;

-- ── Remove every existing rule on these tables ──────────────
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('permits','property_units','unit_permits','unit_vehicles','vehicles','guest_passes','parking_sessions')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

alter table public.permits          enable row level security;
alter table public.property_units   enable row level security;
alter table public.unit_permits     enable row level security;
alter table public.unit_vehicles    enable row level security;
alter table public.vehicles         enable row level security;
alter table public.guest_passes     enable row level security;
alter table public.parking_sessions enable row level security;

-- ── permits ─────────────────────────────────────────────────
create policy "permits: admins" on public.permits for all
  using (public.is_admin()) with check (public.is_admin());
create policy "permits: managers, own properties" on public.permits for all
  using (public.manages_property(property_id)) with check (public.manages_property(property_id));
create policy "permits: residents read own" on public.permits for select
  using (holder_id = auth.uid());
create policy "permits: residents delete own" on public.permits for delete
  using (holder_id = auth.uid());

-- ── property_units (unit slots, invite codes, unit passwords) ─
create policy "units: admins" on public.property_units for all
  using (public.is_admin()) with check (public.is_admin());
create policy "units: managers, own properties" on public.property_units for all
  using (public.manages_property(property_id)) with check (public.manages_property(property_id));

-- ── unit_permits (which car is in which unit spot) ──────────
create policy "unit permits: admins" on public.unit_permits for all
  using (public.is_admin()) with check (public.is_admin());
create policy "unit permits: managers, own properties" on public.unit_permits for all
  using (exists (select 1 from public.property_units s where s.id = unit_slot_id and public.manages_property(s.property_id)))
  with check (exists (select 1 from public.property_units s where s.id = unit_slot_id and public.manages_property(s.property_id)));

-- ── unit_vehicles (a unit's saved cars) ─────────────────────
create policy "unit vehicles: admins" on public.unit_vehicles for all
  using (public.is_admin()) with check (public.is_admin());
create policy "unit vehicles: managers, own properties" on public.unit_vehicles for all
  using (public.manages_property(property_id)) with check (public.manages_property(property_id));

-- ── vehicles (resident portal cars, tied to a permit) ───────
create policy "vehicles: admins" on public.vehicles for all
  using (public.is_admin()) with check (public.is_admin());
create policy "vehicles: residents, own permits" on public.vehicles for all
  using (exists (select 1 from public.permits p where p.id = permit_id and p.holder_id = auth.uid()))
  with check (exists (select 1 from public.permits p where p.id = permit_id and p.holder_id = auth.uid()));
create policy "vehicles: managers read, own properties" on public.vehicles for select
  using (exists (select 1 from public.permits p where p.id = permit_id and public.manages_property(p.property_id)));

-- ── guest_passes ────────────────────────────────────────────
create policy "guest passes: admins" on public.guest_passes for all
  using (public.is_admin()) with check (public.is_admin());
create policy "guest passes: residents, own" on public.guest_passes for all
  using (host_id = auth.uid()) with check (host_id = auth.uid());

-- ── parking_sessions (Pay to Park) ──────────────────────────
-- Created only by the payment server function. Readable by enforcement,
-- the property's manager, and admins.
create policy "sessions: admins" on public.parking_sessions for all
  using (public.is_admin()) with check (public.is_admin());
create policy "sessions: managers read, own properties" on public.parking_sessions for select
  using (public.manages_property(property_id));

commit;
