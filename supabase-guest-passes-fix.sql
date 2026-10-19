-- ============================================================
-- GUEST PASSES — FIX: let a guest code be saved before the guest
-- has entered their plate.
-- The original guest_passes table required a plate, a resident
-- account and a visit date on every row. New guest codes don't have
-- those yet, so this makes them optional (old passes are unchanged)
-- and removes old status rules that didn't know the new statuses.
-- Run once in Supabase > SQL Editor. Safe to re-run.
-- No existing data is changed or deleted.
-- ============================================================

do $$
declare r record;
begin
  -- Every column except id may be empty now
  for r in
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'guest_passes'
       and is_nullable = 'NO' and column_name <> 'id'
       and column_default is null
  loop
    execute format('alter table public.guest_passes alter column %I drop not null', r.column_name);
    raise notice 'Made % optional', r.column_name;
  end loop;

  -- Old check rules on status/duration (e.g. only "active"/"cancelled")
  for r in
    select conname from pg_constraint
     where conrelid = 'public.guest_passes'::regclass and contype = 'c'
       and (pg_get_constraintdef(oid) ilike '%status%' or pg_get_constraintdef(oid) ilike '%duration%')
  loop
    execute format('alter table public.guest_passes drop constraint %I', r.conname);
    raise notice 'Removed old rule %', r.conname;
  end loop;
end $$;

alter table public.guest_passes drop constraint if exists guest_passes_status_check;
alter table public.guest_passes add constraint guest_passes_status_check
  check (status is null or status in ('active','issued','cancelled','expired','ended','pending','approved','denied'));

notify pgrst, 'reload schema';

-- Shows the table's columns so we can confirm (is_nullable should be YES except id)
select column_name, is_nullable, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'guest_passes'
 order by ordinal_position;
