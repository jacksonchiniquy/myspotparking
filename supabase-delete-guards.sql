-- ============================================================
-- SAFE DELETES FOR UNITS AND SPOTS
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- Stops deletes that would lose money or history:
--   • A spot paid by card can't be deleted (Stripe would keep charging).
--     Use Move Out Tenant, or the resident cancels in Manage Billing, first.
--   • The last spot of a unit with a current tenant can't be deleted.
--     Use Move Out Tenant first, so their history is saved and billing ends.
-- Free spots, empty units and units still waiting for sign-up delete as usual.
-- Deleting a whole property follows the same rules for its units.
-- No data is changed or deleted by this file.
-- ============================================================

begin;

create or replace function public.guard_unit_delete()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  others int;
begin
  if coalesce(old.spot_paid, false) and coalesce(old.paid_via, 'card') = 'card' then
    raise exception 'Unit % · % is paid by card. Use Move Out Tenant (or the resident cancels it in Manage Billing) before deleting it.',
      old.unit_number, coalesce(old.slot_label, 'this spot');
  end if;
  if old.unit_password is not null or coalesce(old.invite_used, false) then
    select count(*) into others from public.property_units
     where property_id = old.property_id and unit_number = old.unit_number and id <> old.id;
    if others = 0 then
      raise exception 'Unit % has a current tenant. Use Move Out Tenant first so their history is saved and their billing stops.',
        old.unit_number;
    end if;
  end if;
  return old;
end $$;

drop trigger if exists guard_unit_delete on public.property_units;
create trigger guard_unit_delete before delete on public.property_units
  for each row execute function public.guard_unit_delete();

commit;
