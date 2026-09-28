-- ============================================================
-- 119_sembang_jira_unfurl.sql
--
-- Widens sembang_link_previews (migration 107) with a `kind` discriminator
-- and Jira-specific columns, so a pasted Jira Cloud issue URL
-- (*.atlassian.net/browse/<KEY>) unfurls into a live status/priority/
-- assignee card — matching how Slack's Jira app unfurls an issue link —
-- instead of the generic OpenGraph scrape every other URL gets. Reuses
-- the existing table (one preview per message, same RLS, already in the
-- realtime publication) rather than a parallel table: the generic
-- `url`/`title`/`domain` columns still carry the issue's browse URL /
-- summary / site name for anything that doesn't know about `kind`.
--
-- Populated by POST /api/sembang/channels/[id]/messages, which already
-- schedules a best-effort preview fetch after the message is sent
-- (migration 107) — this migration only adds where the Jira-shaped
-- result lands, not a new write path.
--
-- Idempotent — safe to run more than once.
-- ============================================================

ALTER TABLE public.sembang_link_previews
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'link',
  ADD COLUMN IF NOT EXISTS jira_key TEXT,
  ADD COLUMN IF NOT EXISTS jira_issue_type TEXT,
  ADD COLUMN IF NOT EXISTS jira_status TEXT,
  ADD COLUMN IF NOT EXISTS jira_status_category TEXT,
  ADD COLUMN IF NOT EXISTS jira_priority TEXT,
  ADD COLUMN IF NOT EXISTS jira_assignee TEXT,
  ADD COLUMN IF NOT EXISTS jira_project TEXT,
  ADD COLUMN IF NOT EXISTS jira_updated_at TIMESTAMPTZ;

ALTER TABLE public.sembang_link_previews DROP CONSTRAINT IF EXISTS sembang_link_previews_kind_check;
ALTER TABLE public.sembang_link_previews ADD CONSTRAINT sembang_link_previews_kind_check
  CHECK (kind IN ('link', 'jira'));
