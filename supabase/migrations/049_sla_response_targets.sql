-- ============================================================
-- 049_sla_response_targets
--
-- "Aging response" visibility (user-requested Sep 17, 2026): surface
-- conversations where the customer's last message has gone
-- unanswered, and for how long. Two pieces:
--   - conversations.awaiting_response / last_customer_message_at —
--     cheap, always-current state an outbound send clears and an
--     inbound customer message sets, so the Inbox can show a live
--     "waiting Xh" indicator without recomputing it per-render from
--     the full message history.
--   - accounts.sla_response_minutes — a single account-wide target
--     (not per-team/per-priority — that's a bigger feature for
--     later, see the gap-analysis roadmap's SLA card) driving the
--     indicator's color and the breach-alert cron.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS sla_response_minutes INTEGER NOT NULL DEFAULT 30;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_sla_response_minutes_positive;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_sla_response_minutes_positive
  CHECK (sla_response_minutes > 0);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS awaiting_response BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ,
  -- Set when a breach notification has already fired for the CURRENT
  -- waiting period, so the cron sweep doesn't re-notify every run.
  -- Cleared back to NULL whenever a new customer message restarts the
  -- wait, so the next cycle can notify again.
  ADD COLUMN IF NOT EXISTS sla_notified_at TIMESTAMPTZ;

-- Backfill from existing message history.
UPDATE conversations c
SET last_customer_message_at = m.created_at
FROM (
  SELECT DISTINCT ON (conversation_id) conversation_id, created_at
  FROM messages
  WHERE sender_type = 'customer'
  ORDER BY conversation_id, created_at DESC
) m
WHERE c.id = m.conversation_id
  AND c.last_customer_message_at IS NULL;

UPDATE conversations c
SET awaiting_response = true
WHERE NOT c.awaiting_response
  AND EXISTS (
    SELECT 1 FROM messages m
    WHERE m.conversation_id = c.id
      AND m.sender_type = 'customer'
      AND m.created_at = (
        SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id
      )
  );

CREATE INDEX IF NOT EXISTS idx_conversations_awaiting_response
  ON conversations (account_id, awaiting_response)
  WHERE awaiting_response = true;

-- ============================================================
-- bump_conversation_on_inbound (migration 037, extended in 048 with
-- p_channel_type) — same 3-arg signature, so CREATE OR REPLACE is
-- enough this time, no DROP needed. Every inbound customer message
-- now also marks the conversation as awaiting a response and clears
-- any stale sla_notified_at from a previous wait cycle.
-- ============================================================
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
  SET unread_count             = COALESCE(unread_count, 0) + 1,
      last_message_text        = p_last_message_text,
      last_message_at          = NOW(),
      last_channel_type        = p_channel_type,
      awaiting_response        = true,
      last_customer_message_at = NOW(),
      sla_notified_at          = NULL,
      updated_at               = NOW()
  WHERE id = p_conversation_id;
$$;

-- Grants unchanged from migration 048 (same signature) — restated so
-- this migration is self-contained.
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT, TEXT) TO service_role;

-- ============================================================
-- notifications.type — add 'sla_breach', same DROP+ADD pattern
-- migration 045 used to add 'mention'.
-- ============================================================
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'mention', 'sla_breach'));
