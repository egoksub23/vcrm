-- ============================================================
-- 047_conversation_priority
--
-- Adds a priority field to conversations (P1 gap-analysis item —
-- neither respond.io nor this CRM had one; respond.io has it on their
-- own public roadmap). Agents set it manually from the thread header,
-- or an automation sets it via the new `set_priority` step (e.g. a
-- condition on a "VIP" custom field → set_priority: urgent), and the
-- inbox can sort/badge/filter by it.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('urgent', 'high', 'normal', 'low'));

-- Supports both the inbox's priority filter and an eventual
-- priority-first sort without a sequential scan.
CREATE INDEX IF NOT EXISTS idx_conversations_priority
  ON conversations (account_id, priority);
