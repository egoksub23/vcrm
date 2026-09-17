-- ============================================================
-- 050_conversation_closed_at
--
-- The Reporting & Analytics gap audit (roadmap artifact, Sep 17 2026)
-- flagged the Resolutions report as schema-blocked: `conversations`
-- had no timestamp for "when did this get closed", only `status` +
-- `updated_at` — and `updated_at` is overwritten by ANY change
-- (reassignment, priority, a new message), not specifically a close
-- event, so it can't stand in for one.
--
-- `closed_at` is stamped at every place `status` transitions to
-- 'closed' (the dashboard Status dropdown, the close_conversation
-- automation step) and cleared at every place it transitions back
-- (reopenClosedConversation, on a new inbound message).
--
-- Backfill note: existing already-closed conversations have no real
-- close timestamp to recover, so they're backfilled from `updated_at`
-- as the best available approximation — flagged here rather than left
-- silently wrong, and the Resolutions report should treat rows closed
-- before this migration as approximate.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

UPDATE conversations
SET closed_at = updated_at
WHERE status = 'closed'
  AND closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_closed_at
  ON conversations (account_id, closed_at)
  WHERE closed_at IS NOT NULL;
