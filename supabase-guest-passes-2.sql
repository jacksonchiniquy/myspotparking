-- ============================================================
-- GUEST PASSES — STEP 2: GIVING, ACTIVATING AND CHECKING PASSES
-- Run once in Supabase > SQL Editor (after supabase-guest-passes-1.sql).
-- Safe to re-run. All-or-nothing.
--
-- Adds to guest_passes (the old resident-portal passes keep working):
--   property_id, pass_type_id, unit_number   who gave the pass, and which kind
--   code, code_expires_at                    the guest code (G-XXXX-XX)
--   starts_at, ends_at                       when the pass is valid
--   guest_state, guest_vehicle, guest_email  filled in by the guest
--   issued_by_name, activated_at, reminder_sent_at, cancelled_at
-- Managers can see guest passes at their properties.
-- Enforcement plate checks now recognise these passes.
-- No existing data is changed or deleted.
-- ============================================================

begin;

alter table public.guest_passes
  add column if not exists property_id      uuid,
  add column if not exists pass_type_id     uuid,
  add column if not exists unit_number      text,
  add column if not exists code             text,
  add column if not exists code_expires_at  timestamptz,
  add column if not exists starts_at        timestamptz,
  add column if not exists ends_at          timestamptz,
  add column if not exists guest_state      text,
  add column if not exists guest_vehicle    text,
  add column if not exists guest_email      text,
  add column if not exists issued_by_name   text,
  add column if not exists activated_at     timestamptz,
  add column if not exists reminder_sent_at timestamptz,
  add column if not exists cancelled_at     timestamptz;

create unique index if not exists guest_passes_code_key on public.guest_passes (code) where code is not null;
create index if not exists guest_passes_unit on public.guest_passes (property_id, unit_number, pass_type_id, created_at desc);
create index if not exists guest_passes_plate on public.guest_passes (property_id, guest_plate);

drop policy if exists "guest passes: managers, own properties" on public.guest_passes;
create policy "guest passes: managers, own properties" on public.guest_passes for select
  using (property_id is not null and public.manages_property(property_id));

-- ── Enforcement lookup: same as before, plus the new guest passes ──
create or replace function public.enforcement_lookup(p_plate text, p_property uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  norm  text := regexp_replace(upper(coalesce(p_plate, '')), '[^A-Z0-9]', '', 'g');
  pname text;
  pword text;
  r     record;
  tz    text := 'America/Denver';
  matches jsonb;
begin
  if not (public.is_admin() or public.enforces_property(p_property)) then
    raise exception 'Your company is not assigned to this property';
  end if;
  if norm = '' then raise exception 'Enter a plate number'; end if;

  select name, coalesce(nullif(trim(space_word), ''), 'Unit') into pname, pword
    from public.properties where id = p_property;

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

  -- Guest pass given by a unit at this property (new guest passes)
  select g.*, t.name as pass_name into r
    from public.guest_passes g
    left join public.guest_pass_types t on t.id = g.pass_type_id
   where g.property_id = p_property
     and g.status = 'active'
     and regexp_replace(upper(coalesce(g.guest_plate, '')), '[^A-Z0-9]', '', 'g') = norm
     and now() >= g.starts_at and now() < g.ends_at
   order by g.ends_at desc limit 1;
  if found then
    return jsonb_build_object('result', 'valid', 'kind', 'guest', 'property', pname,
      'plate', r.guest_plate, 'guest_name', r.guest_name, 'host_name', r.issued_by_name,
      'host_unit', r.unit_number, 'host_word', pword, 'pass_name', r.pass_name,
      'vehicle', r.guest_vehicle, 'starts_at', r.starts_at, 'ends_at', r.ends_at);
  end if;

  -- Guest pass from a resident who has an active permit at this property (resident portal)
  select g.*, u.full_name as host_name, hp.unit_number as host_unit,
         ((nullif(g.visit_date::text, '')::date)::timestamp at time zone tz) as v_start,
         ((nullif(g.visit_date::text, '')::date)::timestamp at time zone tz)
           + case
               when g.duration ilike '%week%' then make_interval(days => 7 * coalesce(nullif(substring(g.duration from '\d+'), '')::int, 1))
               when g.duration ilike '%day%'  then make_interval(days => coalesce(nullif(substring(g.duration from '\d+'), '')::int, 1))
               else make_interval(hours => coalesce(nullif(substring(g.duration from '\d+'), '')::int, 24))
             end as v_end
    into r
    from public.guest_passes g
    join public.permits hp on hp.holder_id = g.host_id and hp.property_id = p_property and hp.status = 'active'
    left join public.users u on u.id = g.host_id
   where regexp_replace(upper(coalesce(g.guest_plate, '')), '[^A-Z0-9]', '', 'g') = norm
     and coalesce(g.status, 'active') = 'active'
     and g.visit_date is not null
   order by g.visit_date desc
   limit 1;
  if found and now() >= r.v_start and now() < r.v_end then
    return jsonb_build_object('result', 'valid', 'kind', 'guest', 'property', pname,
      'plate', r.guest_plate, 'guest_name', r.guest_name, 'host_name', r.host_name,
      'host_unit', r.host_unit, 'visit_date', r.visit_date, 'duration', r.duration, 'ends_at', r.v_end);
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

  -- No exact match: look-alike plates and one-character typos among everything valid here.
  -- These are NEVER treated as valid automatically; the officer verifies.
  select jsonb_agg(m order by (m->>'match') = 'look-alike' desc, m->>'plate') into matches from (
    select c.m from (
      select jsonb_build_object('kind', 'permit', 'plate', p.plate, 'vehicle', p.vehicle,
               'permit_type', p.permit_type, 'unit_number', p.unit_number, 'vin_last6', p.vin_last6,
               'end_date', p.end_date, 'match', public.plate_match_type(norm, p.plate)) as m
        from public.permits p
       where p.property_id = p_property and p.status = 'active'
         and (p.start_date is null or nullif(p.start_date::text, '')::date <= (now() at time zone tz)::date)
         and (p.end_date   is null or nullif(p.end_date::text, '')::date   >= (now() at time zone tz)::date)
         and public.plate_match_type(norm, p.plate) is not null
      union all
      select jsonb_build_object('kind', 'session', 'plate', s.plate, 'vehicle', s.vehicle_desc,
               'expires_at', s.expires_at, 'match', public.plate_match_type(norm, s.plate))
        from public.parking_sessions s
       where s.property_id = p_property and s.status = 'active' and s.expires_at > now()
         and public.plate_match_type(norm, s.plate) is not null
      union all
      select jsonb_build_object('kind', 'guest', 'plate', g.guest_plate, 'guest_name', g.guest_name,
               'vehicle', g.guest_vehicle, 'host_unit', g.unit_number, 'host_word', pword, 'host_name', g.issued_by_name,
               'expires_at', g.ends_at, 'match', public.plate_match_type(norm, g.guest_plate))
        from public.guest_passes g
       where g.property_id = p_property and g.status = 'active'
         and now() >= g.starts_at and now() < g.ends_at
         and public.plate_match_type(norm, g.guest_plate) is not null
      union all
      select jsonb_build_object('kind', 'guest', 'plate', g.guest_plate, 'guest_name', g.guest_name,
               'host_name', u.full_name, 'host_unit', hp.unit_number, 'visit_date', g.visit_date,
               'duration', g.duration, 'match', public.plate_match_type(norm, g.guest_plate))
        from public.guest_passes g
        join public.permits hp on hp.holder_id = g.host_id and hp.property_id = p_property and hp.status = 'active'
        left join public.users u on u.id = g.host_id
       where coalesce(g.status, 'active') = 'active'
         and g.visit_date is not null
         and now() >= ((nullif(g.visit_date::text, '')::date)::timestamp at time zone tz)
         and now() <  ((nullif(g.visit_date::text, '')::date)::timestamp at time zone tz)
                      + case
                          when g.duration ilike '%week%' then make_interval(days => 7 * coalesce(nullif(substring(g.duration from '\d+'), '')::int, 1))
                          when g.duration ilike '%day%'  then make_interval(days => coalesce(nullif(substring(g.duration from '\d+'), '')::int, 1))
                          else make_interval(hours => coalesce(nullif(substring(g.duration from '\d+'), '')::int, 24))
                        end
         and public.plate_match_type(norm, g.guest_plate) is not null
    ) c
    order by (c.m->>'match') = 'look-alike' desc
    limit 5
  ) x(m);
  if matches is not null then
    return jsonb_build_object('result', 'possible', 'property', pname, 'plate', norm, 'matches', matches);
  end if;

  return jsonb_build_object('result', 'none', 'property', pname, 'plate', norm);
end $$;

revoke all on function public.enforcement_lookup(text, uuid) from public, anon;
grant execute on function public.enforcement_lookup(text, uuid) to authenticated;

commit;

notify pgrst, 'reload schema';
