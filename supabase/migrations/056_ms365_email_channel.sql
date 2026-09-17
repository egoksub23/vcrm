-- ============================================================
-- 056_ms365_email_channel
--
-- Adds Microsoft 365 / Outlook email as a first-class channel,
-- alongside WhatsApp, the Web Widget, Messenger and Instagram DM.
-- Connection is a real "Connect Microsoft 365" OAuth flow (Microsoft
-- identity platform v2.0, delegated permissions against Microsoft
-- Graph) — the second OAuth flow in this repo, structurally mirroring
-- migration 055's Meta OAuth (oauth_pending_connections is reused,
-- widened rather than forked), but with two things Meta's flow never
-- needed:
--   - Microsoft Graph access tokens expire in ~1 hour. email_config
--     stores a refresh_token (encrypted) alongside the access token,
--     and access_token_expires_at so the send/webhook paths can refresh
--     on demand (src/lib/ms365/token.ts) rather than re-running OAuth.
--   - Inbound delivery is a Graph "change notification" subscription
--     (POST /subscriptions), not a static webhook URL registered by
--     hand in a developer dashboard — the subscription is created by
--     the callback route itself and must be renewed before it expires
--     (max ~4230 minutes / ~2.94 days for mail). subscription_id /
--     subscription_expires_at track this; a cron route
--     (src/app/api/email/subscription-renew) renews it periodically.
--
-- Three pieces:
--   1. email_config — one row per account, same shape/RLS tier as
--      whatsapp_config / messenger_config.
--   2. Widen oauth_pending_connections.channel to allow 'email'. No
--      new columns needed there — unlike Messenger/Instagram's Page
--      picker, a Microsoft 365 connection is always the signed-in
--      user's own single mailbox, so there's no multi-choice step and
--      pages_json is simply never used for this channel.
--   3. Widen the messages.channel_type / conversations.last_channel_type
--      CHECK constraints (migrations 048/049/055) to allow 'email'.
--      bump_conversation_on_inbound needs NO change — see 055's header.
--
-- Contact identity deliberately does NOT follow the wa_user_id /
-- messenger_psid / instagram_igsid direct-column-plus-partial-unique-
-- index pattern. Those are all identifiers Meta asserts server-side and
-- which never appear anywhere else in the schema. Email has no such
-- fresh column: `contacts.email` already exists (001_initial_schema.sql)
-- as an ordinary, mutable, non-unique CRM field that predates this
-- channel and is edited directly from the contact form and via the
-- `update_contact_field` automation step. Reusing it as the channel's
-- identity key is the only sensible design (a duplicate `email` column
-- would be confusing and could drift from the "real" one), but it means
-- inbound-email matching is only as reliable as whatever an agent has
-- typed into that field — a deliberate, documented trade-off, not an
-- oversight. No uniqueness is enforced (existing `email` values are
-- free-text and may already collide or be blank across many rows;
-- adding a UNIQUE index here could fail outright against live data) —
-- src/lib/meta/contact-identity.ts's shared find-or-create instead does
-- a case-insensitive, best-effort lookup for this one column.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1) email_config
-- ============================================================
CREATE TABLE IF NOT EXISTS email_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connected_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The connected mailbox's Graph user id (GET /me -> id) — stable,
  -- used to build the notification resource path. Never the email
  -- address itself, which can change (rename/alias) without this id
  -- changing.
  mailbox_user_id TEXT NOT NULL,
  -- Display/send-as address (GET /me -> mail, falling back to
  -- userPrincipalName for accounts with no `mail` claim).
  mailbox_address TEXT NOT NULL,
  -- Encrypted with the same ENCRYPTION_KEY / AES-256-GCM utility as
  -- every other channel's stored credential (src/lib/whatsapp/encryption.ts).
  access_token TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  refresh_token TEXT NOT NULL,
  -- Shared secret Graph echoes back on every change notification
  -- (clientState) — this webhook's equivalent of WhatsApp/Messenger's
  -- verify_token, since Graph notifications carry no HMAC signature.
  client_state TEXT NOT NULL,
  subscription_id TEXT,
  subscription_expires_at TIMESTAMPTZ,
  -- Set on a Graph 401 (InvalidAuthenticationToken) that a token
  -- refresh also fails to clear (refresh_token itself revoked/expired —
  -- Microsoft caps refresh token lifetime too). The Settings panel
  -- shows a Reconnect banner when true; a fresh OAuth completion clears it.
  needs_reauth BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'error')),
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_config_account_id_key') THEN
    ALTER TABLE email_config ADD CONSTRAINT email_config_account_id_key UNIQUE (account_id);
  END IF;
END $$;

ALTER TABLE email_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_config_select ON email_config;
DROP POLICY IF EXISTS email_config_insert ON email_config;
DROP POLICY IF EXISTS email_config_update ON email_config;
DROP POLICY IF EXISTS email_config_delete ON email_config;
CREATE POLICY email_config_select ON email_config FOR SELECT USING (is_account_member(account_id));
CREATE POLICY email_config_insert ON email_config FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY email_config_update ON email_config FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY email_config_delete ON email_config FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON email_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON email_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2) Widen oauth_pending_connections.channel (migration 055)
-- ============================================================
ALTER TABLE oauth_pending_connections DROP CONSTRAINT IF EXISTS oauth_pending_connections_channel_check;
ALTER TABLE oauth_pending_connections ADD CONSTRAINT oauth_pending_connections_channel_check
  CHECK (channel IN ('messenger', 'instagram', 'email'));

-- ============================================================
-- 3) Widen channel_type / last_channel_type CHECK constraints
--
-- Same caveat as migration 055: constraint names below were confirmed
-- against the live schema (they're Postgres's default-generated names
-- for the unnamed CHECK added back in 048/049, re-pinned with explicit
-- names by 055) rather than assumed.
-- ============================================================
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_channel_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_type_check
  CHECK (channel_type IN ('whatsapp', 'web_widget', 'messenger', 'instagram', 'email'));

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_last_channel_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_last_channel_type_check
  CHECK (last_channel_type IN ('whatsapp', 'web_widget', 'messenger', 'instagram', 'email'));
