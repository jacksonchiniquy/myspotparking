-- ============================================================
-- GUEST PASSES — STEP 1 OF 2: SETTINGS
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- Adds:
--   properties.guest_passes_enabled  on/off per property (admin only)
--   properties.guest_rules           code expiry, same-plate limit,
--                                    paid extra passes on/off
--   guest_pass_types                 the passes a property offers
--                                    (Day Pass, Night Pass, Extended Stay…)
-- No existing data is changed or deleted.
-- ============================================================

begin;

alter table public.properties
  add column if not exists guest_passes_enabled boolean not null default false,
  add column if not exists guest_rules jsonb not null
    default '{"code_hours":48,"plate_month_limit":4,"extras_enabled":false}'::jsonb;

-- Only an admin turns guest passes on or off
create or replace function public.guest_passes_switch_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.can_set_billing() then return new; end if;
  if tg_op = 'INSERT' then
    new.guest_passes_enabled := false;
  elsif new.guest_passes_enabled is distinct from old.guest_passes_enabled then
    raise exception 'Guest passes are turned on or off by My Spot Parking.';
  end if;
  return new;
end $$;

drop trigger if exists guest_passes_switch_guard on public.properties;
create trigger guest_passes_switch_guard before insert or update on public.properties
  for each row execute function public.guest_passes_switch_guard();

-- ── Pass types ──────────────────────────────────────────────
create table if not exists public.guest_pass_types (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  name            text not null check (char_length(trim(name)) between 1 and 40),
  length_kind     text not null default 'hours' check (length_kind in ('hours','window','dates')),
  hours           int  check (hours is null or hours between 1 and 720),
  window_start    time,                       -- e.g. 18:00
  window_end      time,                       -- e.g. 10:00 (next day)
  max_days        int  check (max_days is null or max_days between 1 and 365),
  allowance       int  check (allowance is null or allowance between 0 and 1000),  -- null = no limit
  reset_period    text not null default 'yearly' check (reset_period in ('monthly','quarterly','semiannual','yearly')),
  needs_approval  boolean not null default false,
  extra_price_cents int check (extra_price_cents is null or extra_price_cents between 0 and 100000),
  active          boolean not null default true,
  sort            int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists guest_pass_types_property on public.guest_pass_types (property_id, sort);

alter table public.guest_pass_types enable row level security;

drop policy if exists "guest pass types: admins" on public.guest_pass_types;
create policy "guest pass types: admins" on public.guest_pass_types for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "guest pass types: managers, own properties" on public.guest_pass_types;
create policy "guest pass types: managers, own properties" on public.guest_pass_types for all
  using (public.manages_property(property_id)) with check (public.manages_property(property_id));

-- Changes to pass types show in the admin activity log like everything else
do $$
begin
  if exists (select 1 from pg_proc where proname = 'log_row_change') then
    execute 'drop trigger if exists log_row_change on public.guest_pass_types';
    execute 'create trigger log_row_change after insert or update or delete on public.guest_pass_types
             for each row execute function public.log_row_change()';
  end if;
end $$;

commit;

notify pgrst, 'reload schema';
