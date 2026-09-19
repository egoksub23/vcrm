-- ============================================================
-- 074_comments
--
-- Public comments as an inbox of their own (Chat | Email | Comments):
-- Facebook Page posts (incl. ads), Instagram posts and TikTok videos.
--
--   comment_posts        the post a comment sits under (caption, link, image)
--   comments             one row per comment or reply, from any provider
--   comment_actions      audit trail of what agents did (reply, private
--                        reply, hide, delete) and how the provider answered
--   comment_webhook_events  dedupe (TikTok delivers at-least-once and Meta
--                        retries; payloads carry no event id)
--   tiktok_config        the connected TikTok account (encrypted tokens)
--   messenger_config / instagram_config.comments_enabled
--                        set once the Page is subscribed to comment events
--
-- Rows are written by the webhook / sync routes (service role) and by the
-- action routes; agents read them and change handled status / assignee.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- Posts
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comment_posts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('facebook', 'instagram', 'tiktok')),
  -- ad = an ad / dark post (Facebook), organic = a normal post
  source           TEXT NOT NULL DEFAULT 'organic' CHECK (source IN ('organic', 'ad')),
  -- page id | instagram business account id | tiktok open_id
  channel_ref_id   TEXT NOT NULL,
  -- "{page}_{post}" | instagram media id | tiktok video id (19 digits: text!)
  external_post_id TEXT NOT NULL,
  message          TEXT,
  permalink_url    TEXT,
  media_url        TEXT,
  media_type       TEXT,
  posted_at        TIMESTAMPTZ,
  last_comment_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, provider, external_post_id)
);

-- ------------------------------------------------------------
-- Comments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  post_id             UUID NOT NULL REFERENCES comment_posts(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('facebook', 'instagram', 'tiktok')),
  external_comment_id TEXT NOT NULL,
  -- Reply threading. The raw parent id is kept so a reply that arrives
  -- before its parent can still be linked later.
  parent_comment_id   UUID REFERENCES comments(id) ON DELETE CASCADE,
  parent_external_id  TEXT,
  -- outbound = written by us (an agent reply or the Page itself)
  direction           TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
  -- facebook from.id | instagram IGSID | tiktok unique_identifier
  author_external_id  TEXT,
  author_name         TEXT,
  author_username     TEXT,
  author_avatar_url   TEXT,
  -- Matched lazily to a contact (messenger_psid / instagram_igsid), or set
  -- when an agent private-replies. TikTok commenters have no DM identity.
  contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
  text                TEXT,
  attachment_url      TEXT,
  status              TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden', 'deleted')),
  handled_status      TEXT NOT NULL DEFAULT 'open' CHECK (handled_status IN ('open', 'replied', 'resolved', 'spam')),
  assigned_to         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- A private reply can be sent once per comment, inside a time window.
  private_replied_at  TIMESTAMPTZ,
  -- Sample comments injected from Settings so the screens can be tried
  -- before a real account is connected; actions on them are simulated.
  is_test             BOOLEAN NOT NULL DEFAULT false,
  provider_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, provider, external_comment_id)
);
CREATE INDEX IF NOT EXISTS comments_inbox_idx
  ON comments (account_id, handled_status, provider_created_at DESC);
CREATE INDEX IF NOT EXISTS comments_post_idx
  ON comments (post_id, provider_created_at);
CREATE INDEX IF NOT EXISTS comments_author_idx
  ON comments (account_id, author_external_id);

-- ------------------------------------------------------------
-- Action audit
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comment_actions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  comment_id         UUID NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  actor_user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action             TEXT NOT NULL CHECK (action IN ('reply', 'private_reply', 'hide', 'unhide', 'delete')),
  text               TEXT,
  -- Provider id of what we created (the reply comment / DM).
  provider_object_id TEXT,
  status             TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS comment_actions_comment_idx
  ON comment_actions (comment_id, created_at DESC);

-- ------------------------------------------------------------
-- Webhook dedupe
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comment_webhook_events (
  provider    TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, dedupe_key)
);

-- ------------------------------------------------------------
-- TikTok connection (organic: Accounts API)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tiktok_config (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  connected_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- TikTok's open_id: also the business_id in API calls and the
  -- user_openid in webhook events (our tenant routing key).
  open_id              TEXT NOT NULL UNIQUE,
  display_name         TEXT,
  username             TEXT,
  -- Encrypted (AES-256-GCM, same utility as the other channels).
  access_token         TEXT NOT NULL,
  refresh_token        TEXT NOT NULL,
  access_expires_at    TIMESTAMPTZ NOT NULL,
  refresh_expires_at   TIMESTAMPTZ NOT NULL,
  scopes               TEXT,
  needs_reauth         BOOLEAN NOT NULL DEFAULT false,
  status               TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'error')),
  webhook_registered_at TIMESTAMPTZ,
  last_synced_at       TIMESTAMPTZ,
  connected_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Short-lived OAuth state for the TikTok connect (CSRF + tenant lookup).
CREATE TABLE IF NOT EXISTS tiktok_oauth_states (
  state         TEXT PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Facebook / Instagram: set once the Page is subscribed to comment events.
ALTER TABLE messenger_config ADD COLUMN IF NOT EXISTS comments_enabled_at TIMESTAMPTZ;
ALTER TABLE instagram_config ADD COLUMN IF NOT EXISTS comments_enabled_at TIMESTAMPTZ;

-- ------------------------------------------------------------
-- updated_at maintenance
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_comments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS comments_touch_updated_at ON comments;
CREATE TRIGGER comments_touch_updated_at BEFORE UPDATE ON comments
  FOR EACH ROW EXECUTE FUNCTION public.touch_comments_updated_at();
DROP TRIGGER IF EXISTS comment_posts_touch_updated_at ON comment_posts;
CREATE TRIGGER comment_posts_touch_updated_at BEFORE UPDATE ON comment_posts
  FOR EACH ROW EXECUTE FUNCTION public.touch_comments_updated_at();
DROP TRIGGER IF EXISTS tiktok_config_touch_updated_at ON tiktok_config;
CREATE TRIGGER tiktok_config_touch_updated_at BEFORE UPDATE ON tiktok_config
  FOR EACH ROW EXECUTE FUNCTION public.touch_comments_updated_at();

-- ------------------------------------------------------------
-- RLS
--   comment_posts / comments / comment_actions: members read; agents may
--   change a comment's handled status and assignee. Inserts and deletes
--   come from the service role (webhooks, sync, action routes).
--   tiktok_config: same tier as messenger_config.
--   webhook events / oauth states: service role only.
-- ------------------------------------------------------------
ALTER TABLE comment_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS comment_posts_select ON comment_posts;
CREATE POLICY comment_posts_select ON comment_posts FOR SELECT USING (is_account_member(account_id));

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS comments_select ON comments;
CREATE POLICY comments_select ON comments FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS comments_update ON comments;
CREATE POLICY comments_update ON comments FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

ALTER TABLE comment_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS comment_actions_select ON comment_actions;
CREATE POLICY comment_actions_select ON comment_actions FOR SELECT USING (is_account_member(account_id));

ALTER TABLE comment_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok_oauth_states ENABLE ROW LEVEL SECURITY;

ALTER TABLE tiktok_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tiktok_config_select ON tiktok_config;
DROP POLICY IF EXISTS tiktok_config_insert ON tiktok_config;
DROP POLICY IF EXISTS tiktok_config_update ON tiktok_config;
DROP POLICY IF EXISTS tiktok_config_delete ON tiktok_config;
CREATE POLICY tiktok_config_select ON tiktok_config FOR SELECT USING (is_account_member(account_id));
CREATE POLICY tiktok_config_insert ON tiktok_config FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY tiktok_config_update ON tiktok_config FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY tiktok_config_delete ON tiktok_config FOR DELETE USING (is_account_member(account_id, 'admin'));

-- Live updates in the Comments inbox.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'comments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE comments;
  END IF;
END $$;
