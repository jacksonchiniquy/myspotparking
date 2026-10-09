-- ============================================================
-- My Spot Parking: protect user roles
-- Run once in Supabase > SQL Editor:
-- https://supabase.com/dashboard/project/ajadbfojccztiauxyxos/sql/new
-- Safe to re-run.
--
-- What it does:
--  1. Nobody can change their own role (e.g. resident -> admin).
--  2. Only admins can create enforcer and admin accounts.
--     Managers can still create residents.
--  3. Replaces the rule that let ANY logged-in user edit ANY
--     user's row with one that only lets managers/admins do it.
-- Admins, your server functions and the Supabase dashboard
-- are not restricted.
-- ============================================================

-- Is the person making this request an admin?
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_manager_or_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = auth.uid() and role in ('manager','admin'));
$$;

-- Guard: runs before every new or changed user row
create or replace function public.guard_user_role()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Supabase dashboard, server functions (service key): no limits
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  -- Admins: no limits
  if public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.id = auth.uid() then
      -- Creating your own profile at sign-up: resident or manager only
      if coalesce(new.role, 'holder') not in ('holder', 'manager') then
        raise exception 'Not allowed to create an account with role %', new.role;
      end if;
    else
      -- Creating someone else's profile: managers may add residents only
      if not public.is_manager_or_admin() or coalesce(new.role, 'holder') <> 'holder' then
        raise exception 'Not allowed to create this account';
      end if;
    end if;
  else -- UPDATE
    if new.role is distinct from old.role then
      raise exception 'Only an admin can change account roles';
    end if;
    if new.id is distinct from old.id then
      raise exception 'Account id cannot be changed';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_user_role on public.users;
create trigger guard_user_role
  before insert or update on public.users
  for each row execute function public.guard_user_role();

-- Replace "any logged-in user can update any user" with managers/admins only
drop policy if exists "Managers can update users status" on public.users;
create policy "Managers can update users status" on public.users
  for update using (public.is_manager_or_admin());
