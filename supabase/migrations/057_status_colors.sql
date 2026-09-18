-- ============================================================
-- 057_status_colors
--
-- Per-account customizable colors for the Inbox's conversation-status
-- dot, the SLA-breached "overdue" pill, and the priority flag —
-- previously hardcoded Tailwind classes in conversation-list.tsx
-- (STATUS_COLORS / PRIORITY_COLORS), now driven by this JSONB config
-- so an account can pick its own palette from Settings -> Status
-- colors. Same schemaless-JSONB pattern already used for
-- inbox_views.filter_config (migration 051) — no new columns needed
-- if the shape grows later.
--
-- Shape (see src/lib/status-colors.ts for the TS side + defaults):
--   { open, pending, closed, overdue, priority: { urgent, high, normal, low } }
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS status_colors JSONB NOT NULL DEFAULT '{
  "open": "#7c3aed",
  "pending": "#f59e0b",
  "closed": "#6b7280",
  "overdue": "#ef4444",
  "priority": {
    "urgent": "#ef4444",
    "high": "#fbbf24",
    "normal": "#6b7280",
    "low": "#38bdf8"
  }
}'::jsonb;

COMMENT ON COLUMN accounts.status_colors IS
  'Per-account colors for the Inbox status dot / overdue pill / priority flag. Editable from Settings -> Status colors. See src/lib/status-colors.ts.';
