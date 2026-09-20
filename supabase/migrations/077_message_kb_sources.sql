-- ============================================================
-- 077_message_kb_sources
--
-- The internal note the AI leaves after answering from the knowledge base
-- ("AI answered from: Business hours, Refunds") needs to link to those
-- articles. `kb_sources` holds them as [{ "id": "<article uuid>", "title": "…" }]
-- on that internal message; it is NULL on every other message. The note's
-- text stays readable on its own (content_text), so nothing depends on this
-- column to make sense of a thread.
--
-- Idempotent — safe to re-run.
-- ============================================================
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kb_sources jsonb;

COMMENT ON COLUMN messages.kb_sources IS
  'Knowledge articles an AI reply was based on, as [{id, title}]. Only set on the internal "AI answered from" note (is_internal = true).';
