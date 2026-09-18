-- ============================================================
-- 062_message_pending_delete
--
-- "Move to Trash" for a single message (e.g. a spam email that
-- landed in a real conversation thread) — flags the row instead of
-- deleting it outright. A flagged message disappears from its
-- conversation's thread immediately (client-side filter), and shows
-- up account-wide in the Pending Delete panel, where an agent either
-- restores it or clears it for real (a genuine DELETE FROM messages,
-- already permitted by the existing messages_modify RLS policy for
-- any agent+ account member — no new policy needed here).
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pending_delete BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pending_delete_at TIMESTAMPTZ;

-- Backs both the Pending Delete panel's "everything flagged, newest
-- first" query and the per-thread filter's WHERE pending_delete = false.
CREATE INDEX IF NOT EXISTS idx_messages_pending_delete
  ON messages (pending_delete, pending_delete_at DESC)
  WHERE pending_delete = true;
