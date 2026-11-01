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

-- Minimal auth.users table — holds user UUIDs referenced by public.* FKs.
-- Populated by scripts/migrate-auth-users.ts before the data migration.
CREATE TABLE IF NOT EXISTS auth.users (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT,
  phone       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  is_anonymous BOOLEAN    DEFAULT FALSE
);

-- ── auth helper functions (mirror Supabase's built-ins) ───

-- auth.uid() → UUID of the authenticated user from JWT claims
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true), ''
  )::json->>'sub'
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
