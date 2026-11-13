-- Migration 224: findings on notes, and voiding or deleting one incident.
--
-- 1. A note can be marked as a finding (incident_comments.is_finding), so it stands out in the Timeline and in the report for filing.
-- 2. An incident raised by mistake can be voided: it stays on record (with who voided it, when and why) but leaves the Dashboard, Reports and registers, its
--    timers stop, and it can be restored. A voided incident can then be deleted for good by the school's Owner only; the deletion is written to
--    incident_deletions (the reference, title, who, why and when), which keeps no personal details.
-- 3. The activity trail records voiding and restoring.
-- Run on the Halo PostgreSQL after 223. Idempotent.

ALTER TABLE public.incident_comments ADD COLUMN IF NOT EXISTS is_finding BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS voided_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS void_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_incidents_voided ON public.incidents (account_id) WHERE voided_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.incident_deletions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  reference       TEXT        NOT NULL,
  incident_number INTEGER     NOT NULL,
  title           TEXT        NOT NULL,
  void_reason     TEXT,
  files_removed   INTEGER     NOT NULL DEFAULT 0,
  deleted_by      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_deletions_account ON public.incident_deletions (account_id, deleted_at DESC);
ALTER TABLE public.incident_deletions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_deletions_select ON public.incident_deletions;
-- Read by people who configure incidents; written only by the server after it has checked the caller is the Owner.
CREATE POLICY incident_deletions_select ON public.incident_deletions FOR SELECT USING (has_capability(account_id, 'incidents.configure'));

-- The activity trail also records voiding and restoring.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.incident_activity'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%event_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.incident_activity DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.incident_activity ADD CONSTRAINT incident_activity_event_type_check
  CHECK (event_type IN ('created', 'status_changed', 'severity_changed', 'type_changed', 'lead_changed', 'escalated', 'closed', 'root_cause_changed', 'file_deleted', 'voided', 'restored'));

NOTIFY pgrst, 'reload schema';
