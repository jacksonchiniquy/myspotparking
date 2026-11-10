-- supabase-discounts.sql — discounts, live price changes, pay-ahead savings, promo codes
-- Safe to run more than once.

-- ── 1. Discounts on a spot (property_units) ─────────────────
--   discount_type      'pct' (percent off) or 'amount' (dollars off a month); null = no discount
--   discount_value     the percent, or the dollars per month
--   discount_duration  'forever' | 'months' | 'once' (next payment only)
--   discount_months    how many months, for 'months'
--   discount_note      optional note managers see
--   discount_ends_at   when it runs out (set once it's on live card billing)
--   discount_coupon_id / discount_coupon_cents   the Stripe coupon that carries it
-- And, saved at sign-up, the billing cycle the tenant chose:
--   billing_cycle      'monthly' | 'quarterly' | 'yearly'
--   cycle_pct          the pay-ahead savings they got (e.g. 5 for 5%)
alter table public.property_units
  add column if not exists discount_type          text,
  add column if not exists discount_value         numeric,
  add column if not exists discount_duration      text,
  add column if not exists discount_months        int,
  add column if not exists discount_note          text,
  add column if not exists discount_ends_at       timestamptz,
  add column if not exists discount_coupon_id     text,
  add column if not exists discount_coupon_cents  int,
  add column if not exists billing_cycle          text,
  add column if not exists cycle_pct              numeric;

-- ── 3. Pay-ahead savings per property ───────────────────────
--   {"monthly":{"on":true},"quarterly":{"on":true,"pct":5},"yearly":{"on":true,"pct":15}}
--   Empty = today's standard (5% quarterly, 15% yearly).
alter table public.properties add column if not exists pay_ahead jsonb;

-- ── 4. Pay to Park promo codes ──────────────────────────────
create table if not exists public.promo_codes (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  code          text not null,
  kind          text not null check (kind in ('pct','amount','free')),
  value         numeric,              -- percent, or dollars off
  rate_ids      text[],               -- null = works on every rate
  max_uses      int,                  -- null = no limit
  uses          int not null default 0,
  ends_at       timestamptz,          -- null = no end date
  once_per_day  boolean not null default false,  -- one use per plate per day
  active        boolean not null default true,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create unique index if not exists promo_codes_property_code on public.promo_codes (property_id, upper(code));
alter table public.promo_codes enable row level security;
-- Managed only through LotHQ's server (no direct browser access)

alter table public.parking_sessions
  add column if not exists promo_code     text,
  add column if not exists original_cents int;

-- Count one use of a code, only if it still has uses left. Returns true if counted.
create or replace function public.promo_use(p_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.promo_codes set uses = uses + 1
   where id = p_id and active and (max_uses is null or uses < max_uses)
     and (ends_at is null or ends_at > now());
  return found;
end $$;
revoke all on function public.promo_use(uuid) from public, anon, authenticated;

-- Check: should show 4 rows, all "ok"
select 'spot discount columns' as item, case when count(*) = 10 then 'ok' else 'missing' end as status
  from information_schema.columns where table_schema = 'public' and table_name = 'property_units'
   and column_name in ('discount_type','discount_value','discount_duration','discount_months','discount_note',
                       'discount_ends_at','discount_coupon_id','discount_coupon_cents','billing_cycle','cycle_pct')
union all
select 'pay-ahead savings', case when count(*) = 1 then 'ok' else 'missing' end
  from information_schema.columns where table_schema = 'public' and table_name = 'properties' and column_name = 'pay_ahead'
union all
select 'promo codes table', case when count(*) = 1 then 'ok' else 'missing' end
  from information_schema.tables where table_schema = 'public' and table_name = 'promo_codes'
union all
select 'promo columns on sessions', case when count(*) = 2 then 'ok' else 'missing' end
  from information_schema.columns where table_schema = 'public' and table_name = 'parking_sessions'
   and column_name in ('promo_code','original_cents');
