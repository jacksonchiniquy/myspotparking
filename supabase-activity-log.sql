-- ============================================================
-- ACTIVITY LOG: who did what, when, in every portal
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- Adds one table, activity_log, kept permanently:
--   • Every change people make from the portals (permits, units & spots,
--     properties, vehicles, violations, guest passes, user roles, enforcement
--     assignments, plans) is recorded automatically with before → after.
--   • The server records its own events in plain English (unit sign-ins,
--     move-outs, payments, emails, admin switches).
--   • Sign-ins and enforcement plate checks are recorded by the portals.
--
-- Only admins can read it. Nobody can edit or delete entries — not even
-- the server. Unit passwords are never written to the log.
-- A logging problem can never block the change itself.
-- No existing data is changed or deleted.
-- ============================================================

begin;

create table if not exists public.activity_log (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  actor_id    uuid,
  actor_name  text,
  actor_role  text,      -- admin, manager, enforcer, holder, unit, system, database
  portal      text,      -- admin, manager, resident, unit, enforcement, signup, pay, system
  action      text not null,
  summary     text,
  property_id uuid,
  target      text,
  details     jsonb not null default '{}'::jsonb,
  source      text not null default 'app'   -- db (automatic), app (portal), server
);
create index if not exists activity_log_time on public.activity_log (created_at desc);
create index if not exists activity_log_property on public.activity_log (property_id, created_at desc);
create index if not exists activity_log_actor on public.activity_log (actor_id, created_at desc);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'admin');
$$;

-- Read: admins only. Write from the portals: only as yourself (name/role are filled
-- in by the database, so they can't be faked). No update/delete rules at all.
alter table public.activity_log enable row level security;
drop policy if exists "activity: admins read" on public.activity_log;
drop policy if exists "activity: signed-in users add their own" on public.activity_log;
create policy "activity: admins read" on public.activity_log for select using (public.is_admin());
create policy "activity: signed-in users add their own" on public.activity_log for insert
  with check (auth.uid() is not null and actor_id = auth.uid() and source = 'app');

-- Fill in who did it from the account (portal entries)
create or replace function public.activity_fill_actor()
returns trigger language plpgsql security definer set search_path = public as $$
declare u jsonb;
begin
  if new.source = 'app' and auth.uid() is not null then
    select to_jsonb(x) into u from public.users x where x.id = auth.uid();
    new.actor_id   := auth.uid();
    new.actor_name := coalesce(u->>'full_name', u->>'name', u->>'email', new.actor_name);
    new.actor_role := coalesce(u->>'role', new.actor_role);
  end if;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists activity_fill_actor on public.activity_log;
create trigger activity_fill_actor before insert on public.activity_log
  for each row execute function public.activity_fill_actor();

-- Entries can never be changed or removed
create or replace function public.activity_no_changes()
returns trigger language plpgsql as $$
begin
  raise exception 'Activity log entries are permanent and cannot be changed or deleted.';
end $$;
drop trigger if exists activity_no_changes on public.activity_log;
create trigger activity_no_changes before update or delete on public.activity_log
  for each row execute function public.activity_no_changes();

-- Automatic record of changes made from the portals.
-- (Changes made by the server are skipped here — the server writes its own,
--  clearer entries.)
create or replace function public.log_row_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r       text := coalesce(auth.role(), '');
  uid     uuid := auth.uid();
  newj    jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  oldj    jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  rowj    jsonb;
  changes jsonb := '{}'::jsonb;
  k       text;
  skip    text[] := array['updated_at', 'created_at', 'last_seen_at'];
  who     jsonb;
  pid     uuid;
  tgt     text;
begin
  if r = 'service_role' then return null; end if;
  rowj := coalesce(newj, oldj) - 'unit_password';
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(newj) loop
      if k = any(skip) then continue; end if;
      if newj->k is distinct from oldj->k then
        changes := changes || jsonb_build_object(k,
          case when k = 'unit_password' then jsonb_build_array('(hidden)', '(changed)')
               else jsonb_build_array(oldj->k, newj->k) end);
      end if;
    end loop;
    if changes = '{}'::jsonb then return null; end if;
  end if;

  if tg_table_name = 'properties' then pid := nullif(rowj->>'id', '')::uuid;
  elsif rowj ? 'property_id' then pid := nullif(rowj->>'property_id', '')::uuid;
  elsif rowj ? 'unit_slot_id' then select property_id into pid from public.property_units where id = nullif(rowj->>'unit_slot_id', '')::uuid;
  end if;

  tgt := coalesce(
    nullif(rowj->>'plate', ''),
    case when rowj ? 'unit_number' and nullif(rowj->>'unit_number', '') is not null
         then 'Unit ' || (rowj->>'unit_number') || coalesce(' · ' || nullif(rowj->>'slot_label', ''), '') end,
    nullif(rowj->>'name', ''), nullif(rowj->>'full_name', ''), nullif(rowj->>'email', ''), nullif(rowj->>'company', ''));

  if uid is not null then select to_jsonb(x) into who from public.users x where x.id = uid; end if;

  insert into public.activity_log (actor_id, actor_name, actor_role, portal, action, property_id, target, details, source)
  values (
    uid,
    coalesce(who->>'full_name', who->>'name', who->>'email', case when r = '' then 'Database (SQL editor)' else 'Not signed in' end),
    coalesce(who->>'role', case when r = '' then 'database' else 'anonymous' end),
    null,
    tg_table_name || '.' || lower(tg_op),
    pid, tgt,
    case when tg_op = 'UPDATE' then jsonb_build_object('changes', changes) else jsonb_build_object('row', rowj) end,
    'db');
  return null;
exception when others then
  return null;  -- never block the real change because of logging
end $$;

do $$
declare t text;
begin
  foreach t in array array['permits','property_units','properties','violations','users','vehicles',
                           'unit_vehicles','unit_permits','guest_passes','enforcement_assignments',
                           'parking_sessions','manager_features']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists log_row_change on public.%I', t);
      execute format('create trigger log_row_change after insert or update or delete on public.%I
                      for each row execute function public.log_row_change()', t);
    end if;
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';
