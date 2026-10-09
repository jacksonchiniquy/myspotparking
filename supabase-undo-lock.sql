-- ============================================================
-- UNDO THE LOCK (only if something broke after supabase-lock-tables.sql)
-- Restores the access rules saved by supabase-backup-rules.sql
-- (the first backup you made, i.e. before the lock).
-- Run in Supabase > SQL Editor. You should see "Success".
-- ============================================================

do $$ declare s text; begin
  select script into s from public.rules_backup order by id asc limit 1;
  execute s;
end $$;
