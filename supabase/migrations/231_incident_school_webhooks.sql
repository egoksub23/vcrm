-- Migration 231: school-level webhook subscriptions for incident events (Phase 3.6)
-- Schools register HTTPS endpoints here. Halo posts a signed JSON payload when incidents are
-- filed, closed, escalated, or change status. Signing follows the same envelope as migration 217
-- (X-Halo-Event / X-Halo-Delivery / X-Halo-Timestamp / X-Halo-Signature).
-- Run on the Halo PostgreSQL after 230. Idempotent.

CREATE TABLE IF NOT EXISTS public.incident_school_webhooks (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  url             TEXT        NOT NULL
                              CHECK (url ~ '^https://' AND length(url) <= 500),
  events          TEXT[]      NOT NULL
                              DEFAULT ARRAY['incident.filed','incident.closed','incident.escalated','incident.status_changed'],
  label           TEXT        CHECK (label IS NULL OR length(label) <= 100),
  signing_secret  TEXT        NOT NULL,
  enabled         BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_called_at  TIMESTAMPTZ,
  last_status_code INTEGER
);

CREATE INDEX IF NOT EXISTS idx_incident_school_webhooks_account
  ON public.incident_school_webhooks(account_id) WHERE enabled;

ALTER TABLE public.incident_school_webhooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incident_school_webhooks_select ON public.incident_school_webhooks;
CREATE POLICY incident_school_webhooks_select ON public.incident_school_webhooks
  FOR SELECT USING (has_capability(account_id, 'incidents.configure'));

NOTIFY pgrst, 'reload schema';
