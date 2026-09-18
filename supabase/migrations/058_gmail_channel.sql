-- ============================================================
-- 058_gmail_channel
--
-- Adds Gmail as a channel, distinct from the Microsoft 365 / Outlook
-- Email channel (migration 056) even though both are "email" — an
-- account may run one, the other, or both (e.g. support@ on Gmail and
-- sales@ on Microsoft 365), so each gets its own config table and its
-- own ChannelType value ('gmail' vs 'email'), same as Messenger and
-- Instagram staying separate despite both being Meta.
--
-- Connection is a real "Connect Gmail" OAuth flow (Google OAuth 2.0),
-- structurally close to migration 056's Microsoft flow — an access
-- token that expires hourly, refreshed on demand via a stored refresh
-- token. Two things Microsoft's flow didn't need:
--   - Google does NOT rotate the refresh token on every use (Microsoft
--     does) — src/lib/gmail/token.ts only rewrites it when Google
--     actually returns a new one, which is the documented but
--     uncommon case (e.g., the user re-consents).
--   - Inbound delivery has no equivalent of Graph's self-service
--     subscription creation. Gmail push notifications require a
--     Google Cloud Pub/Sub topic + push subscription, which needs
--     project-level GCP IAM the account's own OAuth token can't grant
--     — that part is one-time manual setup by the operator (see
--     docs/gmail-setup.md), closer to Messenger/Instagram's manual
--     webhook-URL registration than to Microsoft 365's fully
--     automatic flow. gmail_config.pubsub_verify_token is OUR side of
--     authenticating that push endpoint (a shared secret we generate
--     and the operator pastes into the Pub/Sub subscription's push
--     endpoint URL as a query param) — Pub/Sub has no clientState-echo
--     mechanism like Graph's to reuse.
--
-- Contact identity reuses contacts.email exactly like migration 056 —
-- see that migration's header for why there's no dedicated
-- gmail_*_id column and no uniqueness constraint on that field.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1) gmail_config
-- ============================================================
CREATE TABLE IF NOT EXISTS gmail_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connected_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  -- Encrypted with the same ENCRYPTION_KEY / AES-256-GCM utility as
  -- every other channel's stored credential (src/lib/whatsapp/encryption.ts).
  access_token TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  refresh_token TEXT NOT NULL,
  -- Baseline for GET users.history.list on the next webhook delivery —
  -- advanced forward after each processed batch. Set from users.watch's
  -- response at connect time.
  history_id TEXT,
  -- users.watch registrations expire after at most 7 days and must be
  -- renewed (src/app/api/gmail/watch-renew/route.ts, cron-driven).
  watch_expiration TIMESTAMPTZ,
  -- Shared secret embedded in the Pub/Sub push subscription's endpoint
  -- URL (?token=...) — this webhook's equivalent of WhatsApp/Messenger's
  -- verify_token, since Pub/Sub carries no signature of its own.
  pubsub_verify_token TEXT NOT NULL,
  -- Set on a Gmail API 401 (invalid/expired token) that a refresh also
  -- fails to clear (refresh_token itself revoked). The Settings panel
  -- shows a Reconnect banner when true; a fresh OAuth completion clears it.
  needs_reauth BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'error')),
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gmail_config_account_id_key') THEN
    ALTER TABLE gmail_config ADD CONSTRAINT gmail_config_account_id_key UNIQUE (account_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gmail_config_pubsub_verify_token_key') THEN
    ALTER TABLE gmail_config ADD CONSTRAINT gmail_config_pubsub_verify_token_key UNIQUE (pubsub_verify_token);
  END IF;
END $$;

ALTER TABLE gmail_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gmail_config_select ON gmail_config;
DROP POLICY IF EXISTS gmail_config_insert ON gmail_config;
DROP POLICY IF EXISTS gmail_config_update ON gmail_config;
DROP POLICY IF EXISTS gmail_config_delete ON gmail_config;
CREATE POLICY gmail_config_select ON gmail_config FOR SELECT USING (is_account_member(account_id));
CREATE POLICY gmail_config_insert ON gmail_config FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY gmail_config_update ON gmail_config FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY gmail_config_delete ON gmail_config FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON gmail_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON gmail_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2) Widen oauth_pending_connections.channel (migrations 055/056)
-- ============================================================
ALTER TABLE oauth_pending_connections DROP CONSTRAINT IF EXISTS oauth_pending_connections_channel_check;
ALTER TABLE oauth_pending_connections ADD CONSTRAINT oauth_pending_connections_channel_check
  CHECK (channel IN ('messenger', 'instagram', 'email', 'gmail'));

-- ============================================================
-- 3) Widen channel_type / last_channel_type CHECK constraints
-- ============================================================
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_channel_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_type_check
  CHECK (channel_type IN ('whatsapp', 'web_widget', 'messenger', 'instagram', 'email', 'gmail'));

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_last_channel_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_last_channel_type_check
  CHECK (last_channel_type IN ('whatsapp', 'web_widget', 'messenger', 'instagram', 'email', 'gmail'));

-- ============================================================
-- 4) Status colors default (migration 057) has no 'gmail' key, but
--    status_colors only covers status/priority, not per-channel
--    colors — nothing to widen there.
-- ============================================================
