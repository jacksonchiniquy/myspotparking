-- ============================================================
-- PAYOUTS + LOTHQ BILLING (Stripe Connect)
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- Adds:
--   payout_accounts    one row per Stripe account that receives parking money
--                      (an HOA, management company or owner). A manager can
--                      reuse the same account on several properties.
--                      Only the server writes these.
--   properties.payout_account_id   which account gets this property's payments
--   properties.payee_type          'hoa' | 'management' | 'owner'
--   properties.fee_mode            LotHQ fee on each parking payment:
--                                  'none' | 'percent' | 'flat' | 'both'
--   properties.fee_percent / fee_flat_cents
--   properties.plan_interval       LotHQ subscription: 'none' | 'month' | 'year'
--   properties.plan_amount_cents / plan_status / plan_subscription_id / plan_customer_id
--   stripe_account_id on permits, property_units and parking_sessions
--                      (which Stripe account a resident's billing lives in)
--   parking_sessions.lothq_fee_cents  LotHQ's share of a Pay to Park payment
-- Managers can't change the fee, plan or payout fields from the browser;
-- only LotHQ (admin) and the server can.
-- No existing data is changed or deleted.
-- ============================================================

begin;

create table if not exists public.payout_accounts (
  id                 uuid primary key default gen_random_uuid(),
  stripe_account_id  text not null unique,
  owner_id           uuid,            -- the manager who set it up
  label              text,            -- e.g. "Maple Grove HOA"
  payee_type         text check (payee_type in ('hoa','management','owner')),
  email              text,
  details_submitted  boolean not null default false,
  charges_enabled    boolean not null default false,
  payouts_enabled    boolean not null default false,
  needs_info         boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table public.payout_accounts enable row level security;

alter table public.properties
  add column if not exists payout_account_id    uuid references public.payout_accounts(id) on delete set null,
  add column if not exists payee_type           text,
  add column if not exists fee_mode             text not null default 'none',
  add column if not exists fee_percent          numeric(5,2) not null default 0,
  add column if not exists fee_flat_cents       int not null default 0,
  add column if not exists plan_interval        text not null default 'none',
  add column if not exists plan_amount_cents    int,
  add column if not exists plan_status          text,
  add column if not exists plan_subscription_id text,
  add column if not exists plan_customer_id     text;

alter table public.permits          add column if not exists stripe_account_id text;
alter table public.property_units   add column if not exists stripe_account_id text;
alter table public.parking_sessions add column if not exists stripe_account_id text;
alter table public.parking_sessions add column if not exists lothq_fee_cents int;

-- The payout policy above refers to properties, so it is created after the column exists
drop policy if exists payout_accounts_read on public.payout_accounts;
create policy payout_accounts_read on public.payout_accounts for select using (
  public.is_admin() or owner_id = auth.uid()
  or exists (select 1 from public.properties p where p.payout_account_id = payout_accounts.id and p.manager_id = auth.uid())
);

-- Only LotHQ / the server can change fees, the LotHQ plan, or where money goes
create or replace function public.guard_property_billing()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.can_set_billing() then return new; end if;
  if tg_op = 'INSERT' then
    if new.payout_account_id is not null or coalesce(new.fee_mode,'none') <> 'none'
       or coalesce(new.fee_percent,0) <> 0 or coalesce(new.fee_flat_cents,0) <> 0
       or coalesce(new.plan_interval,'none') <> 'none' or new.plan_amount_cents is not null
       or new.plan_status is not null or new.plan_subscription_id is not null or new.plan_customer_id is not null then
      raise exception 'Billing and payout settings can only be changed by LotHQ.';
    end if;
  elsif new.payout_account_id    is distinct from old.payout_account_id
     or new.payee_type           is distinct from old.payee_type
     or new.fee_mode             is distinct from old.fee_mode
     or new.fee_percent          is distinct from old.fee_percent
     or new.fee_flat_cents       is distinct from old.fee_flat_cents
     or new.plan_interval        is distinct from old.plan_interval
     or new.plan_amount_cents    is distinct from old.plan_amount_cents
     or new.plan_status          is distinct from old.plan_status
     or new.plan_subscription_id is distinct from old.plan_subscription_id
     or new.plan_customer_id     is distinct from old.plan_customer_id then
    raise exception 'Billing and payout settings can only be changed by LotHQ.';
  end if;
  return new;
end $$;

drop trigger if exists guard_property_billing on public.properties;
create trigger guard_property_billing before insert or update on public.properties
  for each row execute function public.guard_property_billing();

-- Which Stripe account a resident's billing lives in is set by the server only
create or replace function public.guard_stripe_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.can_set_billing() then return new; end if;
  if (tg_op = 'INSERT' and new.stripe_account_id is not null)
     or (tg_op = 'UPDATE' and new.stripe_account_id is distinct from old.stripe_account_id) then
    raise exception 'Only the payment system can change this.';
  end if;
  return new;
end $$;

drop trigger if exists guard_stripe_account on public.permits;
create trigger guard_stripe_account before insert or update on public.permits
  for each row execute function public.guard_stripe_account();
drop trigger if exists guard_stripe_account on public.property_units;
create trigger guard_stripe_account before insert or update on public.property_units
  for each row execute function public.guard_stripe_account();

commit;

notify pgrst, 'reload schema';
