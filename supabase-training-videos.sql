-- ============================================================
-- TRAINING VIDEOS (private storage)
-- Run once in Supabase > SQL Editor. Safe to re-run.
--
-- Makes a PRIVATE storage bucket called "training" for LotHQ's training
-- videos. "Private" means nobody can open a file from it directly: the
-- enforcement portal asks LotHQ's server for a link that only works for
-- signed-in officers and expires after 2 hours.
-- No policies are added on purpose, so only LotHQ's server can read it.
-- No existing data is changed or deleted.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('training', 'training', false, 52428800, array['video/mp4'])
on conflict (id) do update set public = false;
