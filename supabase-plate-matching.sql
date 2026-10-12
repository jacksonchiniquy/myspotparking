-- ============================================================
-- PLATE LOOK-ALIKES & TYPOS FOR ENFORCEMENT
-- Run in Supabase > SQL Editor (after supabase-enforcement.sql). Safe to re-run.
--
-- Exact plate matches work exactly as before. When there is NO exact match,
-- the lookup now also returns "possible matches" at the same property:
--   * look-alike characters: 0/O/Q/D, 1/I/L/7, 5/S, 2/Z, 8/B, 6/G
--   * one-character typos: one wrong, missing, extra, or swapped character
--     (plates of 4+ characters)
-- Possible matches are never treated as valid automatically; the officer
-- compares the vehicle and decides.
-- No data is changed or deleted.
-- ============================================================

begin;

-- Same plate once look-alike characters are treated as equal
create or replace function public.plate_canon(t text)
returns text language sql immutable as $$
  select translate(regexp_replace(upper(coalesce(t, '')), '[^A-Z0-9]', '', 'g'), 'OQDIL7SZBG', '0001115286');
$$;

-- Exactly one character wrong, missing, extra, or two neighbors swapped
create or replace function public.plate_one_edit(a text, b text)
returns boolean language plpgsql immutable as $$
declare la int := length(a); lb int := length(b); i int; diffs int := 0; first_diff int := 0; s text; l text;
begin
  if a = b or abs(la - lb) > 1 then return false; end if;
  if la = lb then
    for i in 1..la loop
      if substr(a, i, 1) <> substr(b, i, 1) then
        diffs := diffs + 1;
        if first_diff = 0 then first_diff := i; end if;
      end if;
    end loop;
    if diffs = 1 then return true; end if;
    return diffs = 2 and first_diff < la
       and substr(a, first_diff, 1) = substr(b, first_diff + 1, 1)
       and substr(a, first_diff + 1, 1) = substr(b, first_diff, 1);
  end if;
  if la < lb then s := a; l := b; else s := b; l := a; end if;
  i := 1;
  while i <= length(s) and substr(s, i, 1) = substr(l, i, 1) loop i := i + 1; end loop;
  return substr(s, i) = substr(l, i + 1);
end $$;

-- 'look-alike', 'typo', or null (no match / exact match)
create or replace function public.plate_match_type(typed text, registered text)
returns text language sql immutable as $$
  select case
    when regexp_replace(upper(coalesce(registered, '')), '[^A-Z0-9]', '', 'g')
       = regexp_replace(upper(coalesce(typed, '')), '[^A-Z0-9]', '', 'g') then null
    when public.plate_canon(typed) = public.plate_canon(registered) then 'look-alike'
    when length(public.plate_canon(typed)) >= 4
     and public.plate_one_edit(public.plate_canon(typed), public.plate_canon(registered)) then 'typo'
    else null end;
$$;

create or replace function public.enforcement_lookup(p_plate text, p_property uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  norm  text := regexp_replace(upper(coalesce(p_plate, '')), '[^A-Z0-9]', '', 'g');
  pname text;
  r     record;
  tz    text := 'America/Denver';
  matches jsonb;
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

  -- No exact match: look for look-alike plates (0/O/Q/D, 1/I/L/7, 5/S, 2/Z, 8/B, 6/G)
  -- and one-character typos among everything currently valid at this property.
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
