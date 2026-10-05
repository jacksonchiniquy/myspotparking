-- Run this in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/ajadbfojccztiauxyxos/sql/new

-- Add per-spot billing fields to property_units
alter table public.property_units
  add column if not exists billing_type  text not null default 'free',  -- 'free' | 'monthly'
  add column if not exists monthly_amount numeric(10,2);                  -- null = free, otherwise $ per month

-- Optional: add a check constraint so only valid billing types are stored
alter table public.property_units
  drop constraint if exists chk_billing_type;

alter table public.property_units
  add constraint chk_billing_type check (billing_type in ('free','monthly'));

-- Index for querying by billing type (e.g. find all paid spots)
create index if not exists idx_property_units_billing_type
  on public.property_units (billing_type);
