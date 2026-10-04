-- Run this in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/ajadbfojccztiauxyxos/sql/new

-- Create manager_features table
create table if not exists public.manager_features (
  id          uuid primary key default gen_random_uuid(),
  manager_id  uuid not null references public.users(id) on delete cascade,
  plan        text not null default 'starter',  -- 'starter' | 'pro' | 'enterprise'
  flags       jsonb not null default '{}',       -- { permit_management: true, lot_map: false, ... }
  updated_at  timestamptz not null default now(),
  unique (manager_id)
);

-- Index for fast lookups by manager
create index if not exists idx_manager_features_manager_id
  on public.manager_features (manager_id);

-- RLS: allow authenticated admins to read/write all rows
alter table public.manager_features enable row level security;

-- Admins can do everything
create policy "Admin full access" on public.manager_features
  for all
  using (
    exists (
      select 1 from public.users
      where id = auth.uid() and role = 'admin'
    )
  );

-- Managers can read their own row (so manager portal can check feature flags)
create policy "Manager read own" on public.manager_features
  for select
  using (manager_id = auth.uid());
