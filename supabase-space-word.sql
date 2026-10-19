-- ============================================================
-- "WHAT DO PEOPLE HERE CALL THEIR SPACE?"
-- Run once in Supabase > SQL Editor. Safe to re-run.
--
-- Adds properties.space_word — the word shown to people at that
-- property: Unit, Apartment, Suite, Space, Bay, Lot, Office, Building
-- or anything the manager types. Starts as "Unit" for every property,
-- so nothing changes until a manager picks another word.
-- No existing data is changed or deleted.
-- ============================================================

alter table public.properties add column if not exists space_word text not null default 'Unit';

alter table public.properties drop constraint if exists properties_space_word_check;
alter table public.properties add constraint properties_space_word_check
  check (char_length(trim(space_word)) between 1 and 20);

notify pgrst, 'reload schema';
