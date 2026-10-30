-- ============================================================
-- auth-shim.sql
--
-- Creates the minimal Supabase-compatible auth schema on a
-- plain self-hosted PostgreSQL 16 instance so the existing
-- 200+ migrations run without modification.
--
-- This shim is Phase 0 of the Supabase → self-hosted PG
-- migration. It does NOT implement real authentication —
-- auth is still handled by Supabase Auth (or Auth.js later).
-- Its only purpose is to satisfy FK and function references
-- so the schema migrations compile cleanly.
--
-- Run this BEFORE applying any migration file.
-- ============================================================

-- Ensure required extensions exist (confirmed from migration audit)
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_bytes, SHA-256
CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; -- uuid_generate_v4, used in 001+
CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector, used in 030+

-- ── auth schema ─────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS auth;

-- Minimal auth.users table — matches the columns referenced
-- by FK constraints and RLS policies across the migrations.
CREATE TABLE IF NOT EXISTS auth.users (
  id                   uuid        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text,
  phone                text,
  raw_user_meta_data   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  raw_app_meta_data    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  is_super_admin       boolean,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now(),
  last_sign_in_at      timestamptz,
  confirmed_at         timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_idx ON auth.users (email)
  WHERE email IS NOT NULL;

-- auth.uid() — reads the user id injected into the session by
-- the connection pool / API layer. Returns NULL when not set
-- (service-role connections bypass RLS anyway).
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

-- auth.jwt() — returns the full JWT claims object.
CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb
$$;

-- auth.role() — returns the role name from the JWT claims.
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    'anon'
  )
$$;

-- auth.email() — convenience function used in some policies.
CREATE OR REPLACE FUNCTION auth.email()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
$$;

-- ── realtime schema stub ────────────────────────────────────

-- Migrations add tables to the supabase_realtime publication.
-- Create a stub so those ALTER PUBLICATION statements don't fail.
-- The publication stays empty (realtime is not active here).
CREATE SCHEMA IF NOT EXISTS realtime;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- ── storage schema stub ─────────────────────────────────────

-- Migrations insert into storage.buckets for bucket definitions.
-- Create a minimal stub so those INSERTs compile.
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id                text    PRIMARY KEY,
  name              text    NOT NULL UNIQUE,
  public            boolean NOT NULL DEFAULT false,
  file_size_limit   bigint,
  allowed_mime_types text[]
);

-- Storage objects table (referenced by RLS policies in some migrations)
CREATE TABLE IF NOT EXISTS storage.objects (
  id         uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id  text    REFERENCES storage.buckets(id),
  name       text,
  created_at timestamptz DEFAULT now()
);

-- ── Search path ─────────────────────────────────────────────

-- Supabase sets search_path = "$user", public, extensions.
-- Match that so migrations that omit schema prefixes resolve correctly.
ALTER DATABASE halo_uat SET search_path TO "$user", public;
