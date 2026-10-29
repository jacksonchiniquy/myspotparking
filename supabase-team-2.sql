-- ============================================================
-- TEAM ACCESS, PART 2: "must choose a new password at sign-in"
-- Run once in Supabase > SQL Editor. Safe to re-run.
--
-- Adds users.must_change_password. When LotHQ sets a temporary password
-- for someone (or creates their login with that box ticked), the manager
-- portal asks them to choose their own password before anything else.
-- Only LotHQ's server functions change it. No existing data is changed.
-- ============================================================

alter table public.users add column if not exists must_change_password boolean not null default false;

notify pgrst, 'reload schema';
