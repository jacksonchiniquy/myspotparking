-- ============================================================
-- LOCK THE VIOLATIONS TABLE + AI HELPER USAGE COUNTER
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- Before: one rule let ANYONE (even not logged in) read, add, change
--         or delete violations.
-- After:  enforcement  — add violations only at properties assigned to
--                        their company; see the ones they wrote
--         managers     — see and update violations at their properties
--         admins       — everything
--         everyone else — nothing
-- Older violations saved without a property stay visible to admins.
--
-- Also adds ai_usage (private) so the lot-map AI helper can enforce
-- a daily limit per manager.
-- No existing data is changed or deleted.
-- ============================================================

begin;

-- Helpers (same as earlier files, so this file works on its own)
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

create or replace function public.enforces_property(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.enforcement_assignments a
    join public.users u on u.id = auth.uid()
    where a.property_id = pid
      and u.role = 'enforcer'
      and lower(trim(a.company)) = lower(trim(coalesce(u.company, '')))
  );
$$;

alter table public.violations add column if not exists property_id uuid;
alter table public.violations enable row level security;

-- Remove every existing rule on violations
do $$
declare r record;
begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'violations'
  loop
    execute format('drop policy %I on public.violations', r.policyname);
  end loop;
end $$;

create policy "violations: admins" on public.violations for all
  using (public.is_admin()) with check (public.is_admin());

create policy "violations: enforcement adds at assigned properties" on public.violations for insert
  with check (officer_id = auth.uid() and public.enforces_property(property_id));

create policy "violations: enforcement sees own" on public.violations for select
  using (officer_id = auth.uid());

create policy "violations: managers, own properties" on public.violations for select
  using (public.manages_property(property_id));

create policy "violations: managers update, own properties" on public.violations for update
  using (public.manages_property(property_id)) with check (public.manages_property(property_id));

-- ── AI helper usage counter (written only by the server) ────
create table if not exists public.ai_usage (
  id         bigserial primary key,
  user_id    uuid not null,
  feature    text not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_user_time on public.ai_usage (user_id, created_at desc);
alter table public.ai_usage enable row level security;  -- no rules: server only

commit;

notify pgrst, 'reload schema';
