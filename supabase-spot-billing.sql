-- ============================================================
-- PAID SPOTS: remember which paid spots a resident has paid for
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- Adds one yes/no column, property_units.spot_paid.
--   • Set to yes when a resident pays for that spot at sign-up.
--   • Set back to no if their subscription is cancelled.
--   • A resident can't put a car on a paid spot that isn't paid
--     (the manager still can).
-- Residents who ALREADY signed up and paid keep working: their
-- paid spot is marked as paid below.
-- No data is deleted.
-- ============================================================

begin;

alter table public.property_units
  add column if not exists spot_paid boolean not null default false;

-- Units that already signed up through a paid checkout
update public.property_units pu
   set spot_paid = true
 where pu.billing_type = 'monthly'
   and pu.spot_paid = false
   and exists (
     select 1 from public.permits p
      where p.property_id = pu.property_id
        and p.unit_number = pu.unit_number
        and p.stripe_subscription_id is not null
        and coalesce(p.billing_status, '') not in ('suspended', 'canceled', 'cancelled')
   );

commit;

notify pgrst, 'reload schema';
