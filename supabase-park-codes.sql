-- ============================================================
-- PAY TO PARK: PROPERTY CODES + STALL NUMBERS
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- Adds:
--   properties.park_code    short permanent code printed on signs, e.g. TPP-4821.
--                           Every property gets one automatically.
--   properties.stall_mode   'off' | 'optional' | 'required' — whether the pay
--                           page asks for a stall number. Starts 'off'.
--   parking_sessions.stall  the stall number a driver paid for
-- Only an admin can change a code or the stall setting.
-- No existing data is changed or deleted.
-- ============================================================

begin;

alter table public.properties
  add column if not exists park_code  text,
  add column if not exists stall_mode text not null default 'off';

alter table public.properties drop constraint if exists properties_stall_mode_check;
alter table public.properties add constraint properties_stall_mode_check
  check (stall_mode in ('off','optional','required'));

alter table public.parking_sessions add column if not exists stall text;

-- Letters from the property name, then 4 digits that can't be misread (no 0 or 1)
create or replace function public.new_park_code(pname text)
returns text language plpgsql volatile set search_path = public as $$
declare
  letters text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  digits  text := '23456789';
  prefix  text := '';
  w       text;
  code    text;
  i       int;
begin
  -- First letter of up to 3 words of the name
  for w in select unnest(regexp_split_to_array(upper(coalesce(pname,'')), '[^A-Z]+')) loop
    if w <> '' and length(prefix) < 3 then
      prefix := prefix || left(w,1);
    end if;
  end loop;
  while length(prefix) < 3 loop
    prefix := prefix || substr(letters, 1 + floor(random()*length(letters))::int, 1);
  end loop;
  loop
    code := prefix || '-';
    for i in 1..4 loop
      code := code || substr(digits, 1 + floor(random()*length(digits))::int, 1);
    end loop;
    exit when not exists (select 1 from public.properties where park_code = code);
  end loop;
  return code;
end $$;

-- Give every existing property a code
update public.properties set park_code = public.new_park_code(name) where park_code is null;

create unique index if not exists properties_park_code_key on public.properties (park_code);

-- New properties get a code automatically; only an admin can change codes or stall setting
create or replace function public.guard_park_settings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not public.can_set_billing() then
      new.park_code := null;
      new.stall_mode := 'off';
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
  return new;
end $$;

drop trigger if exists guard_park_settings on public.properties;
create trigger guard_park_settings before insert or update on public.properties
  for each row execute function public.guard_park_settings();

commit;

notify pgrst, 'reload schema';

-- Shows the codes it created
select name as property, park_code, stall_mode from public.properties order by name;
