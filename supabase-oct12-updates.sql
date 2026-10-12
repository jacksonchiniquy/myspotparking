-- ============================================================
-- OCT 12 UPDATES — run once in Supabase > SQL Editor. Safe to re-run.
-- All-or-nothing: if anything fails, nothing changes.
--
-- PART A (#15) Contact info privacy on the users table
--   Before: any logged-in user could read every user's name/email/phone,
--           and any manager could edit any user.
--   After:  everyone sees their own account
--           admins see/edit everyone
--           managers see/edit only residents tied to their properties
--             (a permit there, a unit there, or a resident they added)
--   Residents a manager added by hand before today aren't tied to any
--   property; they stay visible to admins only.
--
-- PART B (#20) Pay to Park: columns the payment flow saves.
--
-- No existing data is changed or deleted.
-- ============================================================

begin;

-- ── PART A: users privacy ───────────────────────────────────
alter table public.users add column if not exists added_by uuid;
alter table public.users alter column added_by set default auth.uid();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'admin');
$$;

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.users where id = auth.uid();
$$;

create or replace function public.manages_property(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.properties p
    join public.users u on u.id = auth.uid()
    where p.id = pid and p.manager_id = auth.uid() and u.role = 'manager'
  );
$$;

-- Can the logged-in manager see this resident?
create or replace function public.manager_sees_resident(uid uuid, addr text, adder uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.my_role() = 'manager' and (
       adder = auth.uid()
    or exists (select 1 from public.permits p
               where p.holder_id = uid and public.manages_property(p.property_id))
    or (addr is not null and exists (
               select 1 from public.permits p
               where lower(p.holder_email) = lower(addr) and public.manages_property(p.property_id)))
    or (addr is not null and exists (
               select 1 from public.property_units s
               where lower(s.tenant_email) = lower(addr) and public.manages_property(s.property_id)))
  );
$$;

-- Managers/admins: find a resident's account id by email (to link a permit)
create or replace function public.holder_id_for_email(addr text)
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(public.my_role(), '') not in ('manager', 'admin') then
    raise exception 'Not allowed';
  end if;
  return (select id from public.users
          where lower(email) = lower(trim(addr)) and role = 'holder'
          order by created_at limit 1);
end $$;
revoke all on function public.holder_id_for_email(text) from public, anon;
grant execute on function public.holder_id_for_email(text) to authenticated;

-- Replace the broad rules
drop policy if exists "Allow authenticated users to read users" on public.users;
drop policy if exists "Managers can update users status" on public.users;

drop policy if exists "users: admins" on public.users;
create policy "users: admins" on public.users for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "users: read own" on public.users;
create policy "users: read own" on public.users for select
  using (id = auth.uid());

drop policy if exists "users: managers read own residents" on public.users;
create policy "users: managers read own residents" on public.users for select
  using (role = 'holder' and public.manager_sees_resident(id, email, added_by));

drop policy if exists "users: managers update own residents" on public.users;
create policy "users: managers update own residents" on public.users for update
  using (role = 'holder' and public.manager_sees_resident(id, email, added_by));

-- ── PART B: Pay to Park columns ─────────────────────────────
alter table public.parking_sessions
  add column if not exists vehicle_desc      text,
  add column if not exists email             text,
  add column if not exists rate_name         text,
  add column if not exists amount_paid       numeric,
  add column if not exists duration_minutes  integer,
  add column if not exists started_at        timestamptz,
  add column if not exists expires_at        timestamptz,
  add column if not exists stripe_session_id text,
  add column if not exists status            text,
  add column if not exists created_at        timestamptz default now();
create unique index if not exists parking_sessions_stripe_session_id
  on public.parking_sessions (stripe_session_id) where stripe_session_id is not null;

commit;

notify pgrst, 'reload schema';
