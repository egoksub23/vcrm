-- Migration 213: a record of every time a school deleted incident records.
--
-- Reports and photos are kept for as long as the school wants (incident_settings.retention_years, empty = until the school deletes them). When a school
-- does delete, the screen offers an export first, and this table keeps a permanent note of what was removed and by whom, without keeping the records.
-- Run on the Halo PostgreSQL after 212. Idempotent.

CREATE TABLE IF NOT EXISTS public.incident_retention_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  action         TEXT        NOT NULL CHECK (action IN ('export', 'purge', 'auto_purge')),
  -- Incidents closed on or before this date were covered.
  cutoff         DATE        NOT NULL,
  incident_count INTEGER      NOT NULL DEFAULT 0,
  file_count     INTEGER      NOT NULL DEFAULT 0,
  performed_by   UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_retention_log_account ON public.incident_retention_log (account_id, created_at DESC);

ALTER TABLE public.incident_retention_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_retention_log_select ON public.incident_retention_log;
-- Written by the server only (no insert, update or delete policy). Configurers and exporters can read it.
CREATE POLICY incident_retention_log_select ON public.incident_retention_log FOR SELECT USING (
  has_capability(account_id, 'incidents.configure') OR has_capability(account_id, 'incidents.export')
);

NOTIFY pgrst, 'reload schema';
