-- ============================================================
-- PAY TO PARK: ADD TIME + "ENDS SOON" REMINDERS
-- Run once in Supabase > SQL Editor, AFTER supabase-parking-areas.sql.
-- Safe to re-run. All-or-nothing.
--
-- Adds:
--   properties.add_time_enabled   lets drivers add time to a session before it
--                                 ends (starts Off). Only an admin can change it.
--   parking_sessions.extends_id   the session this one adds time to
--   parking_sessions.reminder_sent_at  when the "ends soon" email went out
-- No existing data is changed or deleted.
-- ============================================================

begin;

alter table public.properties add column if not exists add_time_enabled boolean not null default false;

alter table public.parking_sessions
  add column if not exists extends_id uuid references public.parking_sessions(id) on delete set null,
  add column if not exists reminder_sent_at timestamptz;

create index if not exists parking_sessions_reminders_idx
  on public.parking_sessions (expires_at) where status = 'active' and reminder_sent_at is null and email is not null;

-- Same guard as supabase-parking-areas.sql, now also protecting add_time_enabled
create or replace function public.guard_park_settings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not public.can_set_billing() then
      new.park_code := null;
      new.stall_mode := 'off';
      new.area_mode := 'off';
      new.add_time_enabled := false;
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
  if new.add_time_enabled is distinct from old.add_time_enabled then
    raise exception 'Only an admin can change the Add time setting.';
  end if;
  return new;
end $$;

commit;

notify pgrst, 'reload schema';

select name as property, add_time_enabled from public.properties order by name;
