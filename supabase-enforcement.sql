-- ============================================================
-- ENFORCEMENT BY PROPERTY
-- Run in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
--  1. enforcement_assignments: which enforcement COMPANY works which
--     property (managed by admins in the admin portal).
--  2. enforcement_lookup(): the only way enforcement checks a plate.
--     Checks ONE property: active, unexpired permits; paid Pay-to-Park
--     sessions; and resident guest passes. Only works for properties
--     assigned to the officer's company (or for admins).
--     Plates match regardless of dashes, spaces or capitals.
--  3. Enforcement can no longer read permit/session tables directly.
--  4. Only admins can change an officer's company name.
-- No existing data is changed or deleted.
-- ============================================================

begin;

-- ── 1. Assignments ──────────────────────────────────────────
create table if not exists public.enforcement_assignments (
  id          bigserial primary key,
  property_id uuid not null references public.properties(id) on delete cascade,
  company     text not null,
  created_at  timestamptz not null default now()
);
create unique index if not exists enforcement_assignments_unique
  on public.enforcement_assignments (property_id, lower(trim(company)));
alter table public.enforcement_assignments enable row level security;
grant select, insert, update, delete on public.enforcement_assignments to authenticated;
grant usage, select on sequence public.enforcement_assignments_id_seq to authenticated;

-- Helpers (re-created here so this file works on its own)
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'admin');
$$;

-- Is the logged-in officer's company assigned to this property?
create or replace function public.enforces_property(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.enforcement_assignments a
    join public.users u on u.id = auth.uid()
    where a.property_id = pid
      and u.role = 'enforcer'
      and lower(trim(a.company)) = lower(trim(coalesce(u.company, '')))
  );
$$;

drop policy if exists "assignments: admins" on public.enforcement_assignments;
create policy "assignments: admins" on public.enforcement_assignments for all
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "assignments: officers see their company" on public.enforcement_assignments;
create policy "assignments: officers see their company" on public.enforcement_assignments for select
  using (public.enforces_property(property_id));

-- ── 2. The lookup ───────────────────────────────────────────
create or replace function public.enforcement_lookup(p_plate text, p_property uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  norm  text := regexp_replace(upper(coalesce(p_plate, '')), '[^A-Z0-9]', '', 'g');
  pname text;
  r     record;
  tz    text := 'America/Denver';
begin
  if not (public.is_admin() or public.enforces_property(p_property)) then
    raise exception 'Your company is not assigned to this property';
  end if;
  if norm = '' then raise exception 'Enter a plate number'; end if;

  select name into pname from public.properties where id = p_property;

  -- Active permit at this property, within its dates
  select * into r from public.permits p
   where p.property_id = p_property
     and regexp_replace(upper(coalesce(p.plate, '')), '[^A-Z0-9]', '', 'g') = norm
     and p.status = 'active'
     and (p.start_date is null or nullif(p.start_date::text, '')::date <= (now() at time zone tz)::date)
     and (p.end_date   is null or nullif(p.end_date::text, '')::date   >= (now() at time zone tz)::date)
   order by p.end_date desc nulls first
   limit 1;
  if found then
    return jsonb_build_object('result', 'valid', 'kind', 'permit', 'property', pname,
      'plate', r.plate, 'vehicle', r.vehicle, 'permit_type', r.permit_type,
      'unit_number', r.unit_number, 'zone', r.zone, 'end_date', r.end_date, 'vin_last6', r.vin_last6);
  end if;

  -- Paid Pay-to-Park session at this property
  select * into r from public.parking_sessions s
   where s.property_id = p_property
     and regexp_replace(upper(coalesce(s.plate, '')), '[^A-Z0-9]', '', 'g') = norm
     and s.status = 'active' and s.expires_at > now()
   order by s.expires_at desc limit 1;
  if found then
    return jsonb_build_object('result', 'valid', 'kind', 'session', 'property', pname,
      'plate', r.plate, 'vehicle', r.vehicle_desc, 'amount_paid', r.amount_paid, 'expires_at', r.expires_at);
  end if;

  -- Guest pass from a resident who has an active permit at this property
  select g.*, u.full_name as host_name, hp.unit_number as host_unit,
         ((nullif(g.visit_date::text, '')::date)::timestamp at time zone tz) as starts_at,
         ((nullif(g.visit_date::text, '')::date)::timestamp at time zone tz)
           + case
               when g.duration ilike '%week%' then make_interval(days => 7 * coalesce(nullif(substring(g.duration from '\d+'), '')::int, 1))
               when g.duration ilike '%day%'  then make_interval(days => coalesce(nullif(substring(g.duration from '\d+'), '')::int, 1))
               else make_interval(hours => coalesce(nullif(substring(g.duration from '\d+'), '')::int, 24))
             end as ends_at
    into r
    from public.guest_passes g
    join public.permits hp on hp.holder_id = g.host_id and hp.property_id = p_property and hp.status = 'active'
    left join public.users u on u.id = g.host_id
   where regexp_replace(upper(coalesce(g.guest_plate, '')), '[^A-Z0-9]', '', 'g') = norm
     and coalesce(g.status, 'active') = 'active'
     and g.visit_date is not null
   order by g.visit_date desc
   limit 1;
  if found and now() >= r.starts_at and now() < r.ends_at then
    return jsonb_build_object('result', 'valid', 'kind', 'guest', 'property', pname,
      'plate', r.guest_plate, 'guest_name', r.guest_name, 'host_name', r.host_name,
      'host_unit', r.host_unit, 'visit_date', r.visit_date, 'duration', r.duration, 'ends_at', r.ends_at);
  end if;

  -- Permit exists here but is expired / not yet started
  select * into r from public.permits p
   where p.property_id = p_property
     and regexp_replace(upper(coalesce(p.plate, '')), '[^A-Z0-9]', '', 'g') = norm
     and p.status = 'active'
   order by p.end_date desc nulls first limit 1;
  if found then
    return jsonb_build_object('result', 'expired', 'kind', 'permit', 'property', pname,
      'plate', r.plate, 'vehicle', r.vehicle, 'permit_type', r.permit_type,
      'start_date', r.start_date, 'end_date', r.end_date);
  end if;

  return jsonb_build_object('result', 'none', 'property', pname, 'plate', norm);
end $$;

revoke all on function public.enforcement_lookup(text, uuid) from public, anon;
grant execute on function public.enforcement_lookup(text, uuid) to authenticated;

-- ── 3. Enforcement no longer reads these tables directly ────
drop policy if exists "permits: enforcement read" on public.permits;
drop policy if exists "sessions: enforcement read" on public.parking_sessions;

-- Only admins can change an enforcement officer's company
-- (the company decides which properties an officer can check)
create or replace function public.guard_enforcer_company()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') or public.is_admin() then
    return new;
  end if;
  if old.role = 'enforcer' and new.company is distinct from old.company then
    raise exception 'Only an admin can change an enforcement officer''s company';
  end if;
  return new;
end $$;
drop trigger if exists guard_enforcer_company on public.users;
create trigger guard_enforcer_company
  before update on public.users
  for each row execute function public.guard_enforcer_company();

-- Violations remember which property they were written at
alter table public.violations add column if not exists property_id uuid;

commit;

-- Tell the website's database connection about the changes
notify pgrst, 'reload schema';
