-- Migration 217: events pushed to the coach portal (optional).
--
-- A key may name an address. Halo then posts a signed, name-free event there when an incident is filed through that key's links, and when a Return to Play date
-- changes. Each event is one row here, sent with retries. The signing secret is derived from the server's secret and the key's id, so nothing secret is stored.
-- Run on the Halo PostgreSQL after 216. Idempotent.

ALTER TABLE public.incident_intake_keys ADD COLUMN IF NOT EXISTS webhook_url TEXT CHECK (webhook_url IS NULL OR (webhook_url ~ '^https://' AND length(webhook_url) <= 500));

CREATE TABLE IF NOT EXISTS public.incident_webhook_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key_id          UUID        NOT NULL REFERENCES public.incident_intake_keys(id) ON DELETE CASCADE,
  event           TEXT        NOT NULL CHECK (event IN ('incident.created', 'clearance.updated')),
  payload         JSONB       NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts        INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incident_webhook_events_outbox ON public.incident_webhook_events (next_attempt_at) WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS idx_incident_webhook_events_key ON public.incident_webhook_events (key_id, created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at ON public.incident_webhook_events;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incident_webhook_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.incident_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_webhook_events_select ON public.incident_webhook_events;
-- Configurers can see what was sent and what failed. Written by the server only.
CREATE POLICY incident_webhook_events_select ON public.incident_webhook_events FOR SELECT USING (has_capability(account_id, 'incidents.configure'));

CREATE OR REPLACE FUNCTION public.claim_incident_webhook_events(p_limit INTEGER DEFAULT 25)
RETURNS SETOF public.incident_webhook_events
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.incident_webhook_events e
     SET status = 'sending', updated_at = now()
   WHERE e.id IN (
     SELECT x.id FROM public.incident_webhook_events x
      WHERE ((x.status = 'queued' OR (x.status = 'failed' AND x.attempts < 6)) AND x.next_attempt_at <= now())
         OR (x.status = 'sending' AND x.updated_at < now() - interval '10 minutes')
      ORDER BY x.next_attempt_at
      LIMIT GREATEST(p_limit, 1)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING e.*;
$$;

-- Sent events are kept for 30 days (a record of what the portal was told), then forgotten.
CREATE OR REPLACE FUNCTION public.purge_incident_webhook_events()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM public.incident_webhook_events
   WHERE (status = 'sent' AND sent_at < now() - interval '30 days')
      OR (status = 'failed' AND attempts >= 6 AND updated_at < now() - interval '30 days');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_incident_webhook_events(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_incident_webhook_events() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_incident_webhook_events(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_incident_webhook_events() TO service_role;

NOTIFY pgrst, 'reload schema';
