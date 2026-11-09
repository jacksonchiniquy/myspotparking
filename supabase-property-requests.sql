-- ============================================================
-- PROPERTY REQUESTS (managers' "Request a property")
-- Run once in Supabase > SQL Editor. Safe to re-run.
--
-- Keeps each request until LotHQ approves or declines it, so they show in
-- Admin → Managers → Property requests. Only LotHQ's server functions write
-- this table; admins can read it. No existing data is changed.
-- ============================================================

create table if not exists public.property_requests (
  id            uuid primary key default gen_random_uuid(),
  requested_by  uuid references public.users(id) on delete cascade,
  name          text not null,
  address       text,
  spots         int,
  units         int,
  notes         text,
  status        text not null default 'pending' check (status in ('pending','approved','declined')),
  property_id   uuid references public.properties(id) on delete set null,
  decided_by    uuid,
  decided_at    timestamptz,
  decline_note  text,
  created_at    timestamptz not null default now()
);
create index if not exists property_requests_pending_idx on public.property_requests (created_at) where status = 'pending';
alter table public.property_requests enable row level security;

drop policy if exists "property requests: admins read" on public.property_requests;
create policy "property requests: admins read" on public.property_requests for select using (public.is_admin());
drop policy if exists "property requests: own read" on public.property_requests;
create policy "property requests: own read" on public.property_requests for select using (requested_by = auth.uid());

notify pgrst, 'reload schema';
