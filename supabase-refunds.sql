-- supabase-refunds.sql — Pay to Park refunds (Manager portal → Pay to Park → Refund)
--
-- Adds columns to parking_sessions that record a refund:
--   refunded_cents     how much has been refunded so far (cents)
--   refunded_at        when the last refund was made
--   refunded_by        who made it (user id)
--   refunded_by_name   their name, for the sessions list
--   refund_reason      optional note from the manager
--
-- A session whose parking time was ended by a refund gets status 'refunded',
-- so enforcement no longer counts it (enforcement only counts 'active').
-- Refunds are made by the server (Netlify), so no new access rules are needed.
-- Safe to run more than once.

alter table public.parking_sessions
  add column if not exists refunded_cents   int not null default 0,
  add column if not exists refunded_at      timestamptz,
  add column if not exists refunded_by      uuid,
  add column if not exists refunded_by_name text,
  add column if not exists refund_reason    text;

-- Check: should show 5 rows
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'parking_sessions'
   and column_name in ('refunded_cents','refunded_at','refunded_by','refunded_by_name','refund_reason');
