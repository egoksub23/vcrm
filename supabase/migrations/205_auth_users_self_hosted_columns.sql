-- ============================================================
-- 205_auth_users_self_hosted_columns.sql
--
-- Adds columns to auth.users that Supabase GoTrue normally creates
-- automatically, but are absent on a self-hosted install that does not
-- run GoTrue. Required by Phase 3 of the Supabase → self-hosted PG
-- migration (direct auth.users INSERT in signup, OAuth, and platform
-- account-creation flows).
--
-- Safe to run against a Supabase-cloud-managed database — all columns
-- are added with IF NOT EXISTS so existing GoTrue-created columns are
-- left untouched.
-- ============================================================

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS instance_id uuid        DEFAULT '00000000-0000-0000-0000-000000000000',
  ADD COLUMN IF NOT EXISTS aud         text        DEFAULT 'authenticated';
