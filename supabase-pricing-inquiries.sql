-- Run this once in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/ajadbfojccztiauxyxos/sql/new
--
-- Stores demo/pricing requests from the pricing page form.
-- Only the server (pricing-inquiry Netlify function, using the service key)
-- writes here. The public cannot read or write it.

create table if not exists public.pricing_inquiries (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  first_name  text not null,
  last_name   text not null,
  email       text not null,
  phone       text,
  company     text not null,
  units       text not null,
  state       text,
  message     text,
  source      text not null default 'pricing-page',
  status      text not null default 'new'   -- 'new' | 'contacted' | 'demo_booked' | 'won' | 'lost'
);

create index if not exists idx_pricing_inquiries_created_at
  on public.pricing_inquiries (created_at desc);

-- Lock it down: RLS on, no public policies.
-- The service key used by the Netlify function bypasses RLS.
alter table public.pricing_inquiries enable row level security;

-- Admins can view and update leads from the admin portal
create policy "Admin full access" on public.pricing_inquiries
  for all
  using (
    exists (
      select 1 from public.users
      where id = auth.uid() and role = 'admin'
    )
  );
