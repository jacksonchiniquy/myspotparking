-- ============================================================
-- ENFORCEMENT ACTIONS (Tow / Boot / Ticket)
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- Adds:
--   violations.action               'tow', 'boot' or 'ticket' — what the
--                                   officer actually did to the vehicle
--   properties.enforcement_actions  which of those officers may use at the
--                                   property. Starts as all three.
--                                   Only an admin can change it.
-- No existing data is changed or deleted.
-- ============================================================

begin;

alter table public.violations add column if not exists action text;

alter table public.properties
  add column if not exists enforcement_actions text[] not null default array['tow','boot','ticket'];

-- Only tow / boot / ticket, and at least one must stay on
alter table public.properties drop constraint if exists properties_enforcement_actions_check;
alter table public.properties add constraint properties_enforcement_actions_check
  check (cardinality(enforcement_actions) > 0 and enforcement_actions <@ array['tow','boot','ticket']);

alter table public.violations drop constraint if exists violations_action_check;
alter table public.violations add constraint violations_action_check
  check (action is null or action in ('tow','boot','ticket'));

-- Managers can edit their own property, but not this setting
create or replace function public.guard_enforcement_actions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.can_set_billing() then return new; end if;
  if tg_op = 'INSERT' then
    new.enforcement_actions := array['tow','boot','ticket'];
  elsif new.enforcement_actions is distinct from old.enforcement_actions then
    raise exception 'Only an admin can change enforcement options.';
  end if;
  return new;
end $$;

drop trigger if exists guard_enforcement_actions on public.properties;
create trigger guard_enforcement_actions before insert or update on public.properties
  for each row execute function public.guard_enforcement_actions();

commit;

notify pgrst, 'reload schema';
