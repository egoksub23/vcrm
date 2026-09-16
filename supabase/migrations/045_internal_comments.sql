-- ============================================================
-- 045_internal_comments
--
-- Last two P0 gap-analysis items:
--
--   1. Internal comments — respond.io's "Comment" mode: an agent
--      posts inside the conversation thread but it never reaches the
--      customer over WhatsApp. Used for @mentioning a teammate,
--      flagging something for compliance, or leaving context for
--      whoever picks the conversation up next.
--
--   2. Agent handoff note — when reassigning a conversation to a
--      different human agent, the new owner should get context. This
--      reuses the same internal-comment mechanism: a handoff note is
--      just an internal comment posted immediately before the
--      assignment change, so it shows up as the most recent entry in
--      the thread the moment the new owner opens it.
--
-- No new table for comments — `messages` already models "something
-- that happened in this conversation, in order, with an author."
-- Two columns are enough to turn a row into a comment instead of a
-- customer-facing message:
--
--   - `is_internal` — true means the WhatsApp send path never sees
--     this row. The existing `messages_modify` RLS policy from
--     migration 017 already covers inserts (agent+ on the parent
--     conversation's account); no policy change needed.
--   - `mentions` — JSONB array of mentioned user_ids. A trigger
--     (mirroring `notify_conversation_assigned` from migration 027)
--     fires a 'mention' notification per mentioned teammate, so the
--     existing notification bell picks it up without any app-code
--     notification-writing path.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN messages.is_internal IS
  'True for an agent-only comment that is never sent to WhatsApp. '
  'False (default) for every ordinary customer-facing message.';
COMMENT ON COLUMN messages.mentions IS
  'JSONB array of mentioned user_ids, set only on internal comments. '
  'Drives the mention-notification trigger below.';

-- Partial index — only internal rows are ever queried by this flag
-- (e.g. "show this conversation's comment history"), so indexing the
-- full table would waste space on the vast majority of rows where
-- it's false.
CREATE INDEX IF NOT EXISTS idx_messages_internal
  ON messages(conversation_id, created_at)
  WHERE is_internal;

-- ============================================================
-- notifications.type — widen to allow 'mention' alongside the
-- existing 'conversation_assigned'. Postgres names an inline column
-- CHECK constraint <table>_<column>_check by default (migration 027
-- didn't name it explicitly), so that's the constraint being replaced.
-- ============================================================
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'mention'));

-- ============================================================
-- TRIGGER — notify each mentioned teammate on an internal comment
-- ============================================================
CREATE OR REPLACE FUNCTION notify_message_mentions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_contact_id UUID;
  v_contact_name TEXT;
  v_actor_name TEXT;
  v_mentioned_id UUID;
BEGIN
  IF NOT NEW.is_internal OR NEW.mentions IS NULL OR jsonb_array_length(NEW.mentions) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT c.account_id, c.contact_id INTO v_account_id, v_contact_id
  FROM conversations c WHERE c.id = NEW.conversation_id;

  -- Orphaned conversation_id (shouldn't happen — FK enforced) or the
  -- row somehow has no parent account to scope the notification to.
  IF v_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = v_contact_id;

  IF NEW.sender_id IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM profiles WHERE user_id = NEW.sender_id;
  END IF;

  FOR v_mentioned_id IN
    SELECT DISTINCT (elem.value#>>'{}')::UUID
    FROM jsonb_array_elements(NEW.mentions) AS elem(value)
  LOOP
    -- Skip self-mentions.
    IF v_mentioned_id IS NULL OR v_mentioned_id = NEW.sender_id THEN
      CONTINUE;
    END IF;
    -- Skip anyone the mentions array names who isn't actually a
    -- member of this account — defense in depth against a forged
    -- mentions payload turning into a cross-tenant notification.
    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE user_id = v_mentioned_id AND account_id = v_account_id
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO notifications (
      account_id, user_id, type, conversation_id, contact_id,
      actor_user_id, title, body
    ) VALUES (
      v_account_id,
      v_mentioned_id,
      'mention',
      NEW.conversation_id,
      v_contact_id,
      NEW.sender_id,
      'You were mentioned',
      COALESCE(v_actor_name, 'Someone') || ' mentioned you in a comment on the conversation with '
        || COALESCE(v_contact_name, 'a contact')
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block the comment itself.
  RAISE WARNING 'Failed to create mention notification(s) for message %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_message_mentions() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_message_mentions ON messages;
CREATE TRIGGER on_message_mentions
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION notify_message_mentions();
