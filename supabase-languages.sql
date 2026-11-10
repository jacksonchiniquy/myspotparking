-- supabase-languages.sql — languages for resident, guest and driver pages
-- Safe to run more than once.

-- Site-wide settings LotHQ admins change (first one: which languages are switched on)
create table if not exists public.site_settings (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);
alter table public.site_settings enable row level security;
drop policy if exists "site settings: admins" on public.site_settings;
create policy "site settings: admins" on public.site_settings for all
  using (public.is_admin()) with check (public.is_admin());

-- Spanish on to start; the others are switched on in Admin after a native speaker checks them
insert into public.site_settings (key, value) values ('languages', '["es"]'::jsonb)
on conflict (key) do nothing;

-- The language someone used, so their emails come in it
alter table public.parking_sessions add column if not exists lang text;
alter table public.guest_passes     add column if not exists guest_lang text;

-- Check: should show 3 rows, all "ok"
select 'settings table' as item, case when count(*) = 1 then 'ok' else 'missing' end as status
  from information_schema.tables where table_schema = 'public' and table_name = 'site_settings'
union all
select 'languages setting', case when count(*) = 1 then 'ok' else 'missing' end from public.site_settings where key = 'languages'
union all
select 'language columns', case when count(*) = 2 then 'ok' else 'missing' end
  from information_schema.columns where table_schema = 'public'
   and ((table_name = 'parking_sessions' and column_name = 'lang') or (table_name = 'guest_passes' and column_name = 'guest_lang'));
