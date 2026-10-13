-- ============================================================
-- PAID SPOTS, PART 2: add a spot later, payment links, outside billing
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- Adds:
--   property_units.paid_via              'card' (paid through Stripe) or
--                                        'manual' (marked paid by the manager)
--   property_units.spot_subscription_id  the Stripe subscription for that spot,
--                                        so cancelling one spot locks only that spot
--   property_units.stripe_customer_id    the resident's Stripe customer, so the
--                                        unit portal can open Manage Billing
--   properties.outside_billing           yes/no, set by admin only. When yes, the
--                                        property's managers can "Mark as Paid".
--
-- Protection: only the server (or an admin) can change whether a spot is
-- paid, and only an admin can turn on outside billing. A manager can't flip
-- these from the browser.
--
-- Spots already marked paid are recorded as paid by card. No data is deleted.
-- ============================================================

begin;

alter table public.property_units add column if not exists paid_via text;
alter table public.property_units add column if not exists spot_subscription_id text;
alter table public.property_units add column if not exists stripe_customer_id text;
alter table public.properties     add column if not exists outside_billing boolean not null default false;

update public.property_units set paid_via = 'card' where spot_paid = true and paid_via is null;

-- Same helper as earlier files, so this file works on its own
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'admin');
$$;

-- True for the server (service key), the SQL editor, or an admin
create or replace function public.can_set_billing()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(auth.role(), '') in ('', 'service_role') or public.is_admin();
$$;

create or replace function public.guard_spot_billing()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.can_set_billing() then return new; end if;
  if tg_op = 'INSERT' then
    if coalesce(new.spot_paid, false) or new.paid_via is not null or new.spot_subscription_id is not null then
      raise exception 'Only the payment system can mark a spot as paid.';
    end if;
  elsif new.spot_paid is distinct from old.spot_paid
     or new.paid_via is distinct from old.paid_via
     or new.spot_subscription_id is distinct from old.spot_subscription_id then
    raise exception 'Only the payment system can mark a spot as paid.';
  end if;
  return new;
end $$;

drop trigger if exists guard_spot_billing on public.property_units;
create trigger guard_spot_billing before insert or update on public.property_units
  for each row execute function public.guard_spot_billing();

create or replace function public.guard_outside_billing()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.can_set_billing() then return new; end if;
  if tg_op = 'INSERT' and coalesce(new.outside_billing, false) then
    raise exception 'Only an admin can turn on outside billing.';
  elsif tg_op = 'UPDATE' and new.outside_billing is distinct from old.outside_billing then
    raise exception 'Only an admin can turn on outside billing.';
  end if;
  return new;
end $$;

drop trigger if exists guard_outside_billing on public.properties;
create trigger guard_outside_billing before insert or update on public.properties
  for each row execute function public.guard_outside_billing();

commit;

notify pgrst, 'reload schema';
