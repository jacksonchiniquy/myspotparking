-- ============================================================
-- TENANT HISTORY: a permanent record of each tenant who moves out
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- Adds one table, unit_tenancies. "Move Out Tenant" saves a snapshot here
-- (tenant, dates, vehicles, spots, who moved them out) before clearing the
-- unit. Records are kept permanently.
--
-- Who can see it: admins, and the property's manager (their own properties).
-- Nobody can add, change or delete records from the browser — only the
-- server writes them.
-- No existing data is changed or deleted.
-- ============================================================

begin;

create table if not exists public.unit_tenancies (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null,
  unit_number       text not null,
  tenant_name       text,
  tenant_email      text,
  moved_in_at       timestamptz,
  moved_out_at      timestamptz not null default now(),
  vehicles          jsonb not null default '[]'::jsonb,   -- [{plate, desc}]
  spots             jsonb not null default '[]'::jsonb,   -- [{label, type, billing, amount, paid, via}]
  moved_out_by      uuid,
  moved_out_by_name text,
  created_at        timestamptz not null default now()
);
create index if not exists unit_tenancies_unit on public.unit_tenancies (property_id, unit_number, moved_out_at desc);

-- Same helpers as earlier files, so this file works on its own
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'admin');
$$;
create or replace function public.manages_property(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.properties p
    join public.users u on u.id = auth.uid()
    where p.id = pid and p.manager_id = auth.uid() and u.role = 'manager'
  );
$$;

alter table public.unit_tenancies enable row level security;
drop policy if exists "tenancies: admins read" on public.unit_tenancies;
drop policy if exists "tenancies: managers read own properties" on public.unit_tenancies;
create policy "tenancies: admins read" on public.unit_tenancies for select using (public.is_admin());
create policy "tenancies: managers read own properties" on public.unit_tenancies for select using (public.manages_property(property_id));

commit;

notify pgrst, 'reload schema';
