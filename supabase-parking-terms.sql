-- ============================================================
-- PARKING TERMS (the "I agree" checkbox when someone adds a plate)
-- Run once in Supabase > SQL Editor. Safe to re-run. All-or-nothing.
--
-- Adds:
--   parking_terms       the wording, saved as numbered versions. Only the
--                       server (admin page) can add a version. Anyone can read
--                       it, since it is shown on public pages.
--   properties.terms_owner     owner / HOA name used in the wording
--   properties.terms_manager   management company name used in the wording
--   properties.terms_rules     extra rules for that property
--   properties.terms_enabled   show the checkbox at that property (on by default)
--                       Only an admin can change these four.
--   terms_acceptances   who agreed, for which plate, which version, and when.
--                       Only the server writes these; admins and that
--                       property's managers can read them.
-- Starts with a starter version 1 of the wording (edit it in Admin).
-- No existing data is changed or deleted.
-- ============================================================

begin;

create table if not exists public.parking_terms (
  id          bigserial primary key,
  version     int not null unique,
  title       text not null default 'Parking Terms',
  body        text not null,
  placements  jsonb not null default '{"pay":true,"guest":true,"unit_vehicle":true,"resident_vehicle":true,"signup":true}'::jsonb,
  created_at  timestamptz not null default now(),
  created_by  text
);
alter table public.parking_terms enable row level security;
drop policy if exists parking_terms_read on public.parking_terms;
create policy parking_terms_read on public.parking_terms for select using (true);

alter table public.properties
  add column if not exists terms_owner   text,
  add column if not exists terms_manager text,
  add column if not exists terms_rules   text,
  add column if not exists terms_enabled boolean not null default true;

create or replace function public.guard_terms_settings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.can_set_billing() then return new; end if;
  if tg_op = 'INSERT' then
    new.terms_owner := null; new.terms_manager := null; new.terms_rules := null; new.terms_enabled := true;
    return new;
  end if;
  if new.terms_owner   is distinct from old.terms_owner
  or new.terms_manager is distinct from old.terms_manager
  or new.terms_rules   is distinct from old.terms_rules
  or new.terms_enabled is distinct from old.terms_enabled then
    raise exception 'Parking terms can only be changed by My Spot Parking.';
  end if;
  return new;
end $$;
drop trigger if exists guard_terms_settings on public.properties;
create trigger guard_terms_settings before insert or update on public.properties
  for each row execute function public.guard_terms_settings();

create table if not exists public.terms_acceptances (
  id             bigserial primary key,
  property_id    uuid references public.properties(id) on delete set null,
  terms_version  int not null,
  plate          text,
  context        text not null,
  accepted_by    text,
  user_id        uuid,
  ip             text,
  user_agent     text,
  created_at     timestamptz not null default now()
);
create index if not exists terms_acceptances_property_idx on public.terms_acceptances (property_id, created_at desc);
create index if not exists terms_acceptances_plate_idx on public.terms_acceptances (plate);
alter table public.terms_acceptances drop constraint if exists terms_acceptances_context_check;
alter table public.terms_acceptances add constraint terms_acceptances_context_check
  check (context in ('pay','guest','unit_vehicle','resident_vehicle','signup'));
alter table public.terms_acceptances enable row level security;
drop policy if exists terms_acceptances_read on public.terms_acceptances;
create policy terms_acceptances_read on public.terms_acceptances for select using (
  public.is_admin()
  or exists (select 1 from public.properties p where p.id = terms_acceptances.property_id and p.manager_id = auth.uid())
);

-- Starter wording (version 1). Edit it any time in Admin > Parking Terms;
-- each save becomes a new version.
insert into public.parking_terms (version, title, body, created_by)
select 1, 'Parking Terms',
$terms$By registering a vehicle, activating a guest pass, or paying to park at {property_name} ({property_address}), you agree to these terms.

1. Park at your own risk. {responsible_parties}, My Spot Parking, and their agents are not responsible for loss, theft, or damage to any vehicle or its contents, including damage caused by weather, other vehicles, or towing or booting done under these terms.

2. Correct information. You confirm the license plate and vehicle details you entered are correct. A permit, guest pass, or paid session only covers the plate entered. A wrong plate may lead to enforcement.

3. Enforcement. Vehicles parked without valid authorization, outside allowed times or areas, or against posted rules may be ticketed, booted, or towed at the vehicle owner's expense by {enforcement_company}. Fees are set by the enforcement company as allowed by law.

4. Posted rules. Signs posted on the property and the property rules below are part of these terms.

5. No guaranteed space. A permit or pass lets you park where parking is allowed. It does not guarantee a space unless one is assigned to you.

6. Changes. {responsible_parties} may update these terms and the parking rules. You will be asked to agree to the new version the next time you add or change a vehicle.$terms$,
'starter'
where not exists (select 1 from public.parking_terms);

commit;

notify pgrst, 'reload schema';

-- Shows what was set up (should list version 1)
select version, title, created_at from public.parking_terms order by version;
