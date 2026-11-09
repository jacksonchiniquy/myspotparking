-- ============================================================
-- PROPERTY FEATURES (what each property uses)
-- Run once in Supabase > SQL Editor. Safe to re-run.
--
-- Adds properties.features: which tabs and tools a property uses (lot map,
-- Pay to Park, guest passes, payouts, units, team, tenant history,
-- enforcement). Only LotHQ admins can change it.
-- Existing properties are left blank, which means "everything on", so
-- nothing disappears for current managers. New properties start with the
-- basics on (units, team, tenant history, enforcement) and the extras off.
-- No existing data is changed.
-- ============================================================

begin;

alter table public.properties add column if not exists features jsonb;
alter table public.properties alter column features set default
  '{"units":true,"lot_map":false,"pay_to_park":false,"guest_passes":false,"payouts":false,"team":true,"tenant_history":true,"enforcement":true}'::jsonb;

-- Managers can't change their own features
create or replace function public.guard_property_features()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.can_set_billing() then return new; end if;
  if tg_op = 'UPDATE' and new.features is distinct from old.features then
    raise exception 'Features are set by LotHQ.';
  end if;
  if tg_op = 'INSERT' then
    new.features := '{"units":true,"lot_map":false,"pay_to_park":false,"guest_passes":false,"payouts":false,"team":true,"tenant_history":true,"enforcement":true}'::jsonb;
  end if;
  return new;
end $$;

drop trigger if exists guard_property_features on public.properties;
create trigger guard_property_features before insert or update on public.properties
  for each row execute function public.guard_property_features();

commit;

notify pgrst, 'reload schema';
