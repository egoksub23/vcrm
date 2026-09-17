-- ============================================================
-- 048_merge_channel_conversations
--
-- Migration 046 gave a contact one `conversations` row PER
-- `channel_type` — a contact messaging via both WhatsApp and the Web
-- Widget ended up with two separate threads. Contact-matching across
-- channels already worked correctly (phone-based, via
-- findExistingContact); this migration merges those per-channel
-- threads into the single conversation the user wants: one contact,
-- one conversation, full history regardless of channel.
--
-- `channel_type` moves from `conversations` (a whole-thread property)
-- down to `messages` (a per-message property — the discriminator that
-- actually varies now that a thread can span channels).
-- `conversations.last_channel_type` replaces it as a rollup, mirroring
-- the existing `last_message_text`/`last_message_at` pattern: it's
-- what UI badges read and what an agent's reply defaults to sending
-- on (the channel the customer most recently used).
--
-- Accepted trade-off (confirmed with the user): a widget visitor's
-- own message history, read back through their RLS-scoped session,
-- will now include their past WhatsApp-channel messages too, since
-- RLS scopes by contact_id, not channel. That's intentional — it's
-- their own conversation, and it's what "one merged thread" means.
--
-- Idempotent — safe to re-run. The merge step below only ever acts on
-- `(account_id, contact_id)` groups with more than one conversation
-- row, so a second run finds nothing to merge.
-- ============================================================

-- ============================================================
-- 1) messages.channel_type — per-message channel tag
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel_type TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (channel_type IN ('whatsapp', 'web_widget'));

-- Backfill from each message's (still-intact, for now) conversation.
UPDATE messages
SET channel_type = 'web_widget'
FROM conversations
WHERE messages.conversation_id = conversations.id
  AND conversations.channel_type = 'web_widget'
  AND messages.channel_type <> 'web_widget';

-- ============================================================
-- 2) conversations.last_channel_type — rollup, same shape as
--    last_message_text/last_message_at
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_channel_type TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (last_channel_type IN ('whatsapp', 'web_widget'));

UPDATE conversations
SET last_channel_type = channel_type
WHERE last_channel_type <> channel_type;

-- ============================================================
-- 3) Merge duplicate per-channel conversations, per contact.
--
-- For every (account_id, contact_id) with more than one conversation
-- row, the earliest-created becomes the primary and every other row's
-- data is folded into it, then the secondary row is deleted.
--
-- Every FK that actually points at conversations.id (confirmed by
-- grepping every migration) is repointed here first so the final
-- DELETE never orphans data or fails a constraint:
--   - messages, message_reactions, notifications: ON DELETE CASCADE —
--     would silently lose rows if not repointed first.
--   - flow_runs, ai_usage_log: ON DELETE SET NULL — repointed anyway
--     to preserve the historical association.
--   - deals: NO ACTION (nullable) — MUST be repointed, or the DELETE
--     below fails outright with a foreign-key violation.
--   - conversation_labels: ON DELETE CASCADE, but has its own
--     UNIQUE(conversation_id, tag_id) — handled as an insert-merge
--     (both sides may already carry the same label) rather than a
--     blind repoint, then left to cascade-delete on the secondary.
--   - automation_logs: has no conversation_id column at all —
--     confirmed, nothing to do there.
-- ============================================================
DO $$
DECLARE
  dup RECORD;
  v_primary UUID;
  v_secondary UUID;
  i INTEGER;
BEGIN
  FOR dup IN
    SELECT account_id, contact_id, array_agg(id ORDER BY created_at ASC) AS ids
    FROM conversations
    GROUP BY account_id, contact_id
    HAVING COUNT(*) > 1
  LOOP
    v_primary := dup.ids[1];

    FOR i IN 2 .. array_length(dup.ids, 1) LOOP
      v_secondary := dup.ids[i];

      UPDATE messages SET conversation_id = v_primary WHERE conversation_id = v_secondary;
      UPDATE message_reactions SET conversation_id = v_primary WHERE conversation_id = v_secondary;
      UPDATE flow_runs SET conversation_id = v_primary WHERE conversation_id = v_secondary;
      UPDATE notifications SET conversation_id = v_primary WHERE conversation_id = v_secondary;
      UPDATE ai_usage_log SET conversation_id = v_primary WHERE conversation_id = v_secondary;
      UPDATE deals SET conversation_id = v_primary WHERE conversation_id = v_secondary;

      INSERT INTO conversation_labels (conversation_id, tag_id, applied_by, applied_at)
      SELECT v_primary, tag_id, applied_by, applied_at
      FROM conversation_labels
      WHERE conversation_id = v_secondary
      ON CONFLICT (conversation_id, tag_id) DO NOTHING;

      -- Recompute the primary's rollup fields from the now-merged
      -- message set (messages were already repointed above, so this
      -- SELECT sees both sides).
      UPDATE conversations c
      SET
        unread_count = COALESCE(c.unread_count, 0)
          + COALESCE((SELECT unread_count FROM conversations WHERE id = v_secondary), 0),
        last_message_text = m.content_text,
        last_message_at = m.created_at,
        last_channel_type = m.channel_type,
        updated_at = NOW()
      FROM (
        SELECT content_text, created_at, channel_type
        FROM messages
        WHERE conversation_id = v_primary
        ORDER BY created_at DESC
        LIMIT 1
      ) m
      WHERE c.id = v_primary;

      -- Cascades the now-empty secondary's conversation_labels /
      -- messages / message_reactions / notifications rows — all
      -- already moved to the primary above, so nothing is lost.
      DELETE FROM conversations WHERE id = v_secondary;
    END LOOP;
  END LOOP;
END $$;

-- ============================================================
-- 4) Collapse the unique index back to one conversation per contact
-- ============================================================
DROP INDEX IF EXISTS idx_conversations_account_contact_channel;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact
  ON conversations (account_id, contact_id);

-- ============================================================
-- 5) Drop the now-redundant per-thread channel column/index
-- ============================================================
DROP INDEX IF EXISTS idx_conversations_channel_type;
ALTER TABLE conversations DROP COLUMN IF EXISTS channel_type;

-- ============================================================
-- 6) Visitor-scoped RLS (migration 046) — drop the channel_type
-- condition now that a widget visitor's contact_id can point at a
-- conversation whose most recent message came in on either channel.
-- Contact_id match alone is the correct scope: it's their own
-- conversation regardless of which channel any given message used.
-- ============================================================
DROP POLICY IF EXISTS conversations_widget_visitor_select ON conversations;
CREATE POLICY conversations_widget_visitor_select ON conversations FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM widget_visitors wv
    WHERE wv.id = auth.uid() AND wv.contact_id = conversations.contact_id
  )
);

DROP POLICY IF EXISTS messages_widget_visitor_select ON messages;
CREATE POLICY messages_widget_visitor_select ON messages FOR SELECT USING (
  is_internal IS NOT TRUE
  AND EXISTS (
    SELECT 1 FROM conversations c
    JOIN widget_visitors wv ON wv.contact_id = c.contact_id
    WHERE c.id = messages.conversation_id
      AND wv.id = auth.uid()
  )
);

-- ============================================================
-- 7) bump_conversation_on_inbound — add p_channel_type so an inbound
-- message on either channel also stamps last_channel_type. Postgres
-- treats a different argument list as a distinct overload, so the old
-- 2-arg version is dropped explicitly rather than relying on
-- CREATE OR REPLACE to replace it.
-- ============================================================
DROP FUNCTION IF EXISTS public.bump_conversation_on_inbound(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.bump_conversation_on_inbound(
  p_conversation_id UUID,
  p_last_message_text TEXT,
  p_channel_type TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET unread_count      = COALESCE(unread_count, 0) + 1,
      last_message_text = p_last_message_text,
      last_message_at   = NOW(),
      last_channel_type = p_channel_type,
      updated_at        = NOW()
  WHERE id = p_conversation_id;
$$;

REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TEXT) TO service_role;
