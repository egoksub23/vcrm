-- ============================================================
-- Self-hosted PostgreSQL bootstrap
--
-- Run ONCE against a fresh database BEFORE applying any
-- supabase/migrations/*.sql files.
--
-- Creates:
--   • auth schema + auth.users stub (so FK constraints succeed)
--   • auth.uid() / auth.role() / auth.jwt() functions (used by RLS)
--   • authenticated / anon / service_role roles (used by RLS policies)
--   • pgcrypto + uuid-ossp extensions
--
-- The auth.uid() implementation reads from request.jwt.claims,
-- which our postgres.js shim sets via SET LOCAL before every query.
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── auth schema ────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS auth;

-- auth.users stub — mirrors enough of Supabase's auth.users schema so that
-- FK constraints and migration-created triggers compile without errors.
-- Populated by scripts/migrate-auth-users.ts before the data migration.
CREATE TABLE IF NOT EXISTS auth.users (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                     TEXT,
  phone                     TEXT,
  role                      TEXT        DEFAULT 'authenticated',
  encrypted_password        TEXT,
  email_confirmed_at        TIMESTAMPTZ,
  confirmed_at              TIMESTAMPTZ,
  last_sign_in_at           TIMESTAMPTZ,
  raw_app_meta_data         JSONB,
  raw_user_meta_data        JSONB,
  is_super_admin            BOOLEAN     DEFAULT FALSE,
  is_sso_user               BOOLEAN     DEFAULT FALSE,
  is_anonymous              BOOLEAN     DEFAULT FALSE,
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW(),
  deleted_at                TIMESTAMPTZ
);

-- ── auth helper functions (mirror Supabase's built-ins) ───

-- auth.uid() → UUID of the authenticated user from JWT claims
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql STABLE
AS $$
  SELECT (NULLIF(
    current_setting('request.jwt.claims', true), ''
  )::json->>'sub')::UUID
$$;

-- auth.role() → role string from JWT claims ('authenticated' | 'anon' | …)
CREATE OR REPLACE FUNCTION auth.role()
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::json->>'role',
    'anon'
  )
$$;

-- auth.jwt() → full JWT claims JSON
CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS JSON
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true), '')::json
$$;

-- ── roles used by RLS policies ─────────────────────────────

DO $$
BEGIN
  CREATE ROLE anon              NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE ROLE authenticated     NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE ROLE service_role      NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Grant public schema usage to all roles
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth   TO anon, authenticated, service_role;

-- service_role bypasses RLS (mirrors Supabase behaviour)
ALTER ROLE service_role BYPASSRLS;

-- Default privileges: tables and sequences created by wacrm are readable/writable
-- by authenticated and service_role without per-table GRANT statements.
ALTER DEFAULT PRIVILEGES FOR ROLE wacrm IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE wacrm IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE wacrm IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO authenticated, service_role;
