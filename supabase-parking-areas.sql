-- ============================================================
-- PAY TO PARK: PARKING AREAS
-- Run once in Supabase > SQL Editor, AFTER supabase-park-codes.sql
-- and supabase-discounts.sql. Safe to re-run. All-or-nothing.
--
-- Adds:
--   properties.area_mode       'off' | 'optional' | 'required' — whether the pay
--                              page asks "Where are you parked?". Starts 'off'.
--                              Works next to stall_mode (stall numbers).
--                              Only an admin can change it, like stall_mode.
--   properties.parking_areas   the property's areas, e.g.
--                              [{"id":"a1","name":"Visitor","desc":"Front lot"}]
--                              Managers and LotHQ can edit the list.
--   parking_sessions.area      the area name a driver paid for
--   promo_codes.area_ids       areas a code works in (empty = every area)
-- Rates pick their areas inside transient_rates ("areas": [...]), so rates
-- need no new column.
-- Also updates enforcement_lookup() so plate checks show a paid session's
-- area and stall.
-- No existing data is changed or deleted.
-- ============================================================

begin;

alter table public.properties
  add column if not exists area_mode     text  not null default 'off',
  add column if not exists parking_areas jsonb not null default '[]'::jsonb;

alter table public.properties drop constraint if exists properties_area_mode_check;
alter table public.properties add constraint properties_area_mode_check
  check (area_mode in ('off','optional','required'));

alter table public.parking_sessions add column if not exists area text;

alter table public.promo_codes add column if not exists area_ids text[];

-- Same guard as supabase-park-codes.sql, now also protecting area_mode
create or replace function public.guard_park_settings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not public.can_set_billing() then
      new.park_code := null;
      new.stall_mode := 'off';
      new.area_mode := 'off';
    end if;
    if new.park_code is null then new.park_code := public.new_park_code(new.name); end if;
    new.park_code := upper(trim(new.park_code));
    return new;
  end if;
  if public.can_set_billing() then
    new.park_code := upper(trim(coalesce(new.park_code, old.park_code)));
    return new;
  end if;
  if new.park_code is distinct from old.park_code then
    raise exception 'Property codes are printed on signs and can only be changed by LotHQ.';
  end if;
  if new.stall_mode is distinct from old.stall_mode then
    raise exception 'Only an admin can change the stall number setting.';
  end if;
  if new.area_mode is distinct from old.area_mode then
    raise exception 'Only an admin can change the parking area setting.';
  end if;
  return new;
end $$;

drop trigger if exists guard_park_settings on public.properties;
create trigger guard_park_settings before insert or update on public.properties
  for each row execute function public.guard_park_settings();

-- Plate checks: paid sessions now show their area and stall
-- (same as supabase-timezones.sql otherwise)
alter table public.properties add column if not exists timezone text;

create or replace function public.enforcement_lookup(p_plate text, p_property uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  norm  text := regexp_replace(upper(coalesce(p_plate, '')), '[^A-Z0-9]', '', 'g');
  pname text;
  pword text;
  r     record;
  tz    text := coalesce((select nullif(trim(timezone), '') from public.properties where id = p_property), 'America/Denver');
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
      'plate', r.plate, 'vehicle', r.vehicle_desc, 'amount_paid', r.amount_paid, 'expires_at', r.expires_at,
      'area', r.area, 'stall', r.stall, 'rate_name', r.rate_name);
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
               'expires_at', s.expires_at, 'area', s.area, 'stall', s.stall,
               'match', public.plate_match_type(norm, s.plate))
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

-- Shows each property's settings
select name as property, park_code, stall_mode, area_mode, jsonb_array_length(parking_areas) as areas
from public.properties order by name;
