-- ============================================================
-- 204_authjs_support.sql
--
-- Adds Auth.js v5 support tables alongside the existing auth schema.
-- Phase 1 of the Supabase → self-hosted PG migration.
--
-- Adds:
--   auth.users.password_hash  — bcrypt hash for our own credential
--                               verification (populated on new signups
--                               and lazily migrated on first login)
--   auth.oauth_accounts       — links OAuth provider accounts to users
--                               (replaces Supabase's internal identity table)
--   auth.verification_tokens  — short-lived tokens for password reset
--                               and email verification flows
-- ============================================================

-- ── OAuth account links ──────────────────────────────────────
-- NOTE: auth.users.password_hash is Phase 2 (self-hosted bcrypt).
--       Deferred until GoTrue is removed.
-- One row per OAuth provider identity linked to a user.
-- provider + provider_account_id is the unique identity key.
-- Stored in public schema (postgres owns it; auth schema is restricted on Supabase).
CREATE TABLE IF NOT EXISTS public.oauth_accounts (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type                 text        NOT NULL,           -- "oauth" | "oidc"
  provider             text        NOT NULL,           -- "google" | "azure-ad"
  provider_account_id  text        NOT NULL,           -- provider's stable user id
  refresh_token        text,
  access_token         text,
  expires_at           bigint,
  token_type           text,
  scope                text,
  id_token             text,
  session_state        text,
  created_at           timestamptz DEFAULT now(),
  UNIQUE(provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS oauth_accounts_user_id_idx ON public.oauth_accounts (user_id);

ALTER TABLE public.oauth_accounts ENABLE ROW LEVEL SECURITY;

-- ── Password-reset / email-verification tokens ───────────────
-- identifier = email; token = hashed random string; expires = TTL.
CREATE TABLE IF NOT EXISTS public.verification_tokens (
  identifier   text        NOT NULL,   -- the email address
  token        text        NOT NULL,   -- HMAC-SHA256 hex of the raw token
  expires      timestamptz NOT NULL,
  created_at   timestamptz DEFAULT now(),
  PRIMARY KEY (identifier, token)
);

ALTER TABLE public.verification_tokens ENABLE ROW LEVEL SECURITY;
