-- ============================================================
-- 055_messenger_instagram_channels
--
-- Adds Facebook Messenger and Instagram DM as first-class channels,
-- alongside WhatsApp and the Web Widget. Connection is via a real
-- "Connect with Facebook" OAuth flow (Facebook Login for Business) —
-- the first OAuth flow in this repo — reusing the SAME shared Meta
-- App WhatsApp already uses (META_APP_ID/META_APP_SECRET), just with
-- the Messenger/Instagram products' permissions added to it.
--
-- Four pieces:
--   1. messenger_config / instagram_config — one row per account,
--      same shape/RLS tier as whatsapp_config.
--   2. oauth_pending_connections — bridges the OAuth callback to the
--      Page-picker step. Service-role only, no client policy (same
--      tier as widget_visitors, migration 046). Never stores live
--      Page tokens — only id/name pairs — so a 10-minute-TTL row
--      never holds anything sensitive enough to matter if read
--      unexpectedly.
--   3. contacts.messenger_psid / contacts.instagram_igsid — direct-
--      column identity keys, mirroring wa_user_id (migration 040)
--      exactly. Messenger/Instagram identity is asserted server-side
--      by Meta's webhook, the same trust model as WhatsApp's BSUID —
--      not migration 046's anonymous-auth widget_visitors pattern.
--   4. Widen the messages.channel_type / conversations.last_channel_type
--      CHECK constraints (migration 048/049) to allow the two new
--      values. bump_conversation_on_inbound (current body: migration
--      049) needs NO change — it already takes p_channel_type TEXT
--      with no hardcoded value list.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1) messenger_config / instagram_config
-- ============================================================
CREATE TABLE IF NOT EXISTS messenger_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connected_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  page_name TEXT,
  -- Encrypted with the same ENCRYPTION_KEY / AES-256-GCM utility as
  -- whatsapp_config.access_token (src/lib/whatsapp/encryption.ts).
  page_access_token TEXT NOT NULL,
  -- Kept (encrypted) so a reconnect/re-derive doesn't need a fresh
  -- OAuth round-trip through Meta's consent screen.
  long_lived_user_token TEXT,
  verify_token TEXT,
  -- Set by the send path on a Graph API `code: 190` (OAuthException —
  -- invalid/expired token). The Settings panel shows a Reconnect
  -- banner when true; `oauth/finalize` clears it on a fresh connect.
  needs_reauth BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'error')),
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messenger_config_account_id_key') THEN
    ALTER TABLE messenger_config ADD CONSTRAINT messenger_config_account_id_key UNIQUE (account_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messenger_config_page_id_key') THEN
    ALTER TABLE messenger_config ADD CONSTRAINT messenger_config_page_id_key UNIQUE (page_id);
  END IF;
END $$;

ALTER TABLE messenger_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messenger_config_select ON messenger_config;
DROP POLICY IF EXISTS messenger_config_insert ON messenger_config;
DROP POLICY IF EXISTS messenger_config_update ON messenger_config;
DROP POLICY IF EXISTS messenger_config_delete ON messenger_config;
CREATE POLICY messenger_config_select ON messenger_config FOR SELECT USING (is_account_member(account_id));
CREATE POLICY messenger_config_insert ON messenger_config FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY messenger_config_update ON messenger_config FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY messenger_config_delete ON messenger_config FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON messenger_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON messenger_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS instagram_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connected_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The linked Facebook Page — Instagram DM messaging authenticates
  -- via the Page's access token, not a separate IG-only token.
  page_id TEXT NOT NULL,
  ig_business_account_id TEXT NOT NULL,
  ig_username TEXT,
  page_access_token TEXT NOT NULL,
  long_lived_user_token TEXT,
  verify_token TEXT,
  needs_reauth BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'error')),
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instagram_config_account_id_key') THEN
    ALTER TABLE instagram_config ADD CONSTRAINT instagram_config_account_id_key UNIQUE (account_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instagram_config_ig_business_account_id_key') THEN
    ALTER TABLE instagram_config ADD CONSTRAINT instagram_config_ig_business_account_id_key UNIQUE (ig_business_account_id);
  END IF;
END $$;

ALTER TABLE instagram_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instagram_config_select ON instagram_config;
DROP POLICY IF EXISTS instagram_config_insert ON instagram_config;
DROP POLICY IF EXISTS instagram_config_update ON instagram_config;
DROP POLICY IF EXISTS instagram_config_delete ON instagram_config;
CREATE POLICY instagram_config_select ON instagram_config FOR SELECT USING (is_account_member(account_id));
CREATE POLICY instagram_config_insert ON instagram_config FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY instagram_config_update ON instagram_config FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY instagram_config_delete ON instagram_config FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON instagram_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2) oauth_pending_connections
-- ============================================================
CREATE TABLE IF NOT EXISTS oauth_pending_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  initiated_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('messenger', 'instagram')),
  -- CSRF token AND the callback's lookup key — the callback never
  -- trusts anything else client-supplied.
  state TEXT NOT NULL,
  long_lived_user_token TEXT,
  -- [{id, name}] ONLY — never Page access tokens. See file header.
  pages_json JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'awaiting_page_selection', 'completed', 'expired', 'failed')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_pending_connections_state_key') THEN
    ALTER TABLE oauth_pending_connections ADD CONSTRAINT oauth_pending_connections_state_key UNIQUE (state);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_oauth_pending_connections_expires
  ON oauth_pending_connections (expires_at);

-- Service-role only — no client-facing policy at all (same tier as
-- widget_visitors, migration 046). The OAuth routes always use the
-- admin client.
ALTER TABLE oauth_pending_connections ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3) Contact identity — direct-column pattern (mirrors wa_user_id,
--    migration 040), not the widget_visitors join-table pattern.
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS messenger_psid TEXT,
  ADD COLUMN IF NOT EXISTS instagram_igsid TEXT;

COMMENT ON COLUMN contacts.messenger_psid IS
  'Facebook Messenger page-scoped user ID for this contact. Stable per (user, Page). phone stays NOT NULL and is empty-string for Messenger-only contacts, mirroring wa_user_id (migration 040).';
COMMENT ON COLUMN contacts.instagram_igsid IS
  'Instagram-scoped user ID for this contact. Stable per (user, IG business account). Same NOT NULL/empty-string phone convention as messenger_psid.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_messenger_psid
  ON contacts (account_id, messenger_psid) WHERE messenger_psid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_instagram_igsid
  ON contacts (account_id, instagram_igsid) WHERE instagram_igsid IS NOT NULL;

-- ============================================================
-- 4) Widen channel_type / last_channel_type CHECK constraints
--
-- Constraint names below are Postgres's default-generated names for
-- an unnamed `CHECK (...)` added via `ALTER TABLE ... ADD COLUMN`,
-- which is how migrations 048/049 wrote them — confirmed against the
-- live schema before applying. `IF EXISTS` makes a wrong name a safe
-- no-op rather than a hard failure, but would silently leave the old,
-- narrower CHECK in place, so this was verified against a live
-- `\d messages` / `\d conversations` rather than assumed.
-- ============================================================
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_channel_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_type_check
  CHECK (channel_type IN ('whatsapp', 'web_widget', 'messenger', 'instagram'));

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_last_channel_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_last_channel_type_check
  CHECK (last_channel_type IN ('whatsapp', 'web_widget', 'messenger', 'instagram'));
