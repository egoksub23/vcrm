-- ============================================================
-- 044_conversation_labels
--
-- P0 gap-analysis item: respond.io lets an agent label the topic of a
-- *conversation* (billing, refund, technical issue) independently of
-- who the contact is. This codebase only had tags on contacts
-- (migration 001's `contact_tags`) — labelling a conversation meant
-- polluting the contact record, which is wrong when the same contact
-- has had conversations about different things over time.
--
-- Reuses the existing `tags` table (same palette already managed at
-- Settings → Fields & tags) rather than introducing a parallel
-- `labels` table with its own name/color CRUD — a tag is a tag,
-- whether it's stuck on a contact or a conversation. Only the join
-- table differs.
--
-- `conversation_labels` mirrors `contact_tags` structurally, but adds
-- `applied_by` / `applied_at` (the P0 spec's audit fields) since
-- "who labelled this conversation urgent" is useful in a way "who
-- tagged this contact VIP" wasn't judged to be worth tracking back
-- in migration 001.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_labels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  applied_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(conversation_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_labels_conversation ON conversation_labels(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_labels_tag ON conversation_labels(tag_id);

ALTER TABLE conversation_labels ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RLS — same tiering as contact_tags_select/modify (migration 017):
-- any account member reads, agent+ writes. Tenancy is enforced via
-- the parent conversation's account_id (conversation_labels itself
-- carries no account_id column).
-- ============================================================
DROP POLICY IF EXISTS conversation_labels_select ON conversation_labels;
DROP POLICY IF EXISTS conversation_labels_modify ON conversation_labels;

CREATE POLICY conversation_labels_select ON conversation_labels FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = conversation_labels.conversation_id
      AND is_account_member(c.account_id)
  )
);

CREATE POLICY conversation_labels_modify ON conversation_labels FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = conversation_labels.conversation_id
      AND is_account_member(c.account_id, 'agent')
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = conversation_labels.conversation_id
      AND is_account_member(c.account_id, 'agent')
  )
);
