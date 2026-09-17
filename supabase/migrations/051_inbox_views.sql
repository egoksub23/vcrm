-- ============================================================
-- 051_inbox_views
--
-- Inbox Views P1 gap-analysis item: respond.io lets a team save a named
-- filter combination ("Custom Inboxes") and re-select it later instead
-- of rebuilding it every session. `conversation-list.tsx` already has a
-- rich filter set (status/mine/unassigned, tags, team, labels, channel,
-- priority, sort) but nothing to save one — every session starts back
-- at the hardcoded default.
--
-- `inbox_views` stores an arbitrary filter combination as JSONB rather
-- than a column per filter, so adding a new inbox filter later never
-- needs a matching migration here. `owner_id` doubles as the personal
-- vs. shared switch (mirrors the "owner_id or null for shared" shape
-- from the original gap-analysis card): a NULL owner is visible to the
-- whole account, same as a team-wide saved view in respond.io; a non-
-- NULL owner is visible only to that user. Only admin+ can create or
-- edit a shared (owner_id IS NULL) view — same governance tier as
-- teams/tags in migration 017/043, since a shared view is effectively
-- account-wide configuration, not personal preference.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS inbox_views (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- NULL = shared with the whole account. Non-NULL = personal to that user.
  owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Arbitrary shape matching ConversationList's filter state (filter,
  -- tagIds, company, teamId, labelIds, channelType, priority, sortMode)
  -- — kept schemaless so new filters don't need a migration here too.
  filter_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbox_views_account ON inbox_views(account_id);
CREATE INDEX IF NOT EXISTS idx_inbox_views_owner ON inbox_views(owner_id);

ALTER TABLE inbox_views ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON inbox_views;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON inbox_views
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP POLICY IF EXISTS inbox_views_select ON inbox_views;
DROP POLICY IF EXISTS inbox_views_insert ON inbox_views;
DROP POLICY IF EXISTS inbox_views_update ON inbox_views;
DROP POLICY IF EXISTS inbox_views_delete ON inbox_views;

-- Any member can read their own views plus every shared view.
CREATE POLICY inbox_views_select ON inbox_views FOR SELECT USING (
  is_account_member(account_id) AND (owner_id = auth.uid() OR owner_id IS NULL)
);

-- Any agent+ can save a personal view; only admin+ can save a shared one.
CREATE POLICY inbox_views_insert ON inbox_views FOR INSERT WITH CHECK (
  is_account_member(account_id, 'agent')
  AND (owner_id = auth.uid() OR (owner_id IS NULL AND is_account_member(account_id, 'admin')))
);

CREATE POLICY inbox_views_update ON inbox_views FOR UPDATE USING (
  is_account_member(account_id)
  AND (owner_id = auth.uid() OR (owner_id IS NULL AND is_account_member(account_id, 'admin')))
);

CREATE POLICY inbox_views_delete ON inbox_views FOR DELETE USING (
  is_account_member(account_id)
  AND (owner_id = auth.uid() OR (owner_id IS NULL AND is_account_member(account_id, 'admin')))
);
