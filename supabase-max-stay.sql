-- ============================================================
-- PAY TO PARK: LONGEST STAY
-- Run once in Supabase > SQL Editor, AFTER supabase-add-time.sql.
-- Safe to re-run. All-or-nothing.
--
-- Adds:
--   properties.max_stay_minutes     the most time one car can park in a row,
--                                   counting time added (empty = no limit).
--                                   Managers set it on the Pay to Park tab.
--   properties.hide_long_rates      hide rates longer than the limit
--   parking_sessions.stay_started_at  when the car's stay began (the first
--                                   session in a chain of added time)
-- No existing data is changed or deleted.
-- ============================================================

begin;

alter table public.properties
  add column if not exists max_stay_minutes integer,
  add column if not exists hide_long_rates boolean not null default false;

alter table public.properties drop constraint if exists properties_max_stay_check;
alter table public.properties add constraint properties_max_stay_check
  check (max_stay_minutes is null or (max_stay_minutes >= 15 and max_stay_minutes <= 10080));

alter table public.parking_sessions add column if not exists stay_started_at timestamptz;

commit;

notify pgrst, 'reload schema';

select name as property, max_stay_minutes, hide_long_rates from public.properties order by name;
