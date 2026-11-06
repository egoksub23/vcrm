-- Migration 209: incident platform, part 2 — notification rules, the message log (deliveries) and acknowledgement.
--
-- A rule says WHEN (raised / nobody acknowledged / step overdue / closed), ONLY IF (category, severity, flags) and THEN (tell a role, mark a level).
-- Every message the engine sends is one row in incident_deliveries: to whom, how, to what address (a snapshot), and what became of it.
-- Run on the Halo PostgreSQL after 208. Idempotent.

-- ------------------------------------------------------------
-- 1. incident_rules
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_rules (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Which starter recipe it came from, if any (one rule per recipe per school).
  recipe_key   TEXT,
  name         TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  trigger      TEXT        NOT NULL CHECK (trigger IN ('raised', 'unacknowledged', 'step_overdue', 'unresolved', 'closed')),
  wait_minutes INTEGER     CHECK (wait_minutes IS NULL OR wait_minutes BETWEEN 1 AND 43200),
  conditions   JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(conditions) = 'object'),
  actions      JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) > 0),
  enabled      BOOLEAN     NOT NULL DEFAULT FALSE,
  position     INTEGER     NOT NULL DEFAULT 0,
  created_by   UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((trigger IN ('unacknowledged', 'step_overdue', 'unresolved')) = (wait_minutes IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_incident_rules_account ON public.incident_rules (account_id, enabled, position);
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_rules_recipe ON public.incident_rules (account_id, recipe_key) WHERE recipe_key IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON public.incident_rules;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incident_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.incident_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_rules_select ON public.incident_rules;
DROP POLICY IF EXISTS incident_rules_write  ON public.incident_rules;
CREATE POLICY incident_rules_select ON public.incident_rules FOR SELECT USING (
  has_capability(account_id, 'incidents.manage') OR has_capability(account_id, 'incidents.configure')
);
CREATE POLICY incident_rules_write ON public.incident_rules FOR ALL
  USING (has_capability(account_id, 'incidents.configure'))
  WITH CHECK (has_capability(account_id, 'incidents.configure'));

-- ------------------------------------------------------------
-- 2. incident_deliveries — the message log and the outbox
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_deliveries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  incident_id     UUID        NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  rule_id         UUID        REFERENCES public.incident_rules(id) ON DELETE SET NULL,
  role_key        TEXT        NOT NULL,
  contact_id      UUID        REFERENCES public.incident_contacts(id) ON DELETE SET NULL,
  -- Snapshots, so the log survives a rename or a removed contact.
  recipient_name  TEXT        NOT NULL,
  channel         TEXT        NOT NULL CHECK (channel IN ('email', 'whatsapp', 'sms', 'push')),
  address         TEXT        NOT NULL,
  reason          TEXT        NOT NULL DEFAULT 'raised' CHECK (reason IN ('raised', 'reminder', 'escalated', 'step_overdue', 'closed', 'approval', 'test')),
  ask_ack         BOOLEAN     NOT NULL DEFAULT FALSE,
  -- What this row is about when a rule can fire several times for one incident (for example the id of an overdue step).
  ref_key         TEXT        NOT NULL DEFAULT '',
  status          TEXT        NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped', 'acknowledged')),
  attempts        INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  provider_ref    TEXT,
  sent_at         TIMESTAMPTZ,
  -- Acknowledgement. The one-tap link carries a signed token (HMAC of this row's id), so nothing secret is stored.
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  is_test         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A rule never tells the same address twice about the same thing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_deliveries_once
  ON public.incident_deliveries (incident_id, COALESCE(rule_id, '00000000-0000-0000-0000-000000000000'::uuid), role_key, channel, address, ref_key);
CREATE INDEX IF NOT EXISTS idx_incident_deliveries_incident ON public.incident_deliveries (incident_id, created_at);
CREATE INDEX IF NOT EXISTS idx_incident_deliveries_outbox
  ON public.incident_deliveries (next_attempt_at) WHERE status IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS idx_incident_deliveries_ack
  ON public.incident_deliveries (account_id, incident_id) WHERE ask_ack AND acknowledged_at IS NULL;

DROP TRIGGER IF EXISTS set_updated_at ON public.incident_deliveries;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incident_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.incident_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_deliveries_select ON public.incident_deliveries;
-- Managers read the log. Rows are written by the server (service role) only: there is no insert, update or delete policy.
CREATE POLICY incident_deliveries_select ON public.incident_deliveries FOR SELECT USING (
  has_capability(account_id, 'incidents.manage') OR has_capability(account_id, 'incidents.configure')
);

-- Live updates for the message log on the incident screen (LISTEN/NOTIFY, as migration 207).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'halo_notify_account_change') THEN
    DROP TRIGGER IF EXISTS halo_rt_incident_deliveries ON public.incident_deliveries;
    CREATE TRIGGER halo_rt_incident_deliveries
      AFTER INSERT OR UPDATE OR DELETE ON public.incident_deliveries
      FOR EACH ROW EXECUTE FUNCTION public.halo_notify_account_change();
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. incidents: remember which timed rules have already run
-- ------------------------------------------------------------
-- The raised-event rules are guarded by the unique index above; the timed ones are found by the sweep, which needs to know when the first notice
-- that asked for an acknowledgement went out. That is min(sent_at) over the incident's ask_ack deliveries, so no new column is needed.
-- A view keeps the sweep query short.
CREATE OR REPLACE VIEW public.incident_ack_state AS
SELECT d.incident_id,
       d.account_id,
       MIN(d.sent_at) FILTER (WHERE d.ask_ack AND d.status IN ('sent', 'acknowledged')) AS first_ask_at,
       BOOL_OR(d.acknowledged_at IS NOT NULL)                                             AS acknowledged
  FROM public.incident_deliveries d
 WHERE NOT d.is_test
 GROUP BY d.incident_id, d.account_id;

ALTER VIEW public.incident_ack_state SET (security_invoker = true);

-- ------------------------------------------------------------
-- 4. Functions the sender and the timer sweep call (service role only)
-- ------------------------------------------------------------
-- Take the next batch of due messages. SKIP LOCKED means two sweeps never send the same row; a row stuck in 'sending' for 10 minutes (a crashed
-- worker) is taken again.
CREATE OR REPLACE FUNCTION public.claim_incident_deliveries(p_limit INTEGER DEFAULT 50)
RETURNS SETOF public.incident_deliveries
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.incident_deliveries d
     SET status = 'sending', updated_at = now()
   WHERE d.id IN (
     SELECT x.id FROM public.incident_deliveries x
      WHERE ((x.status = 'queued' OR (x.status = 'failed' AND x.attempts < 5)) AND x.next_attempt_at <= now())
         OR (x.status = 'sending' AND x.updated_at < now() - interval '10 minutes')
      ORDER BY x.next_attempt_at
      LIMIT GREATEST(p_limit, 1)
      FOR UPDATE SKIP LOCKED
   )
  RETURNING d.*;
$$;

-- Incidents whose first acknowledge-asking notice went out at or before p_before and that nobody has acknowledged (open incidents of the last 60 days).
CREATE OR REPLACE FUNCTION public.incident_unacknowledged(p_account_id UUID, p_before TIMESTAMPTZ, p_limit INTEGER DEFAULT 100)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.incident_id
    FROM public.incident_ack_state s
    JOIN public.incidents i ON i.id = s.incident_id
   WHERE s.account_id = p_account_id
     AND s.first_ask_at IS NOT NULL
     AND s.first_ask_at <= p_before
     AND NOT s.acknowledged
     AND i.status = 'reported'
     AND i.created_at > now() - interval '60 days'
   ORDER BY s.first_ask_at
   LIMIT GREATEST(p_limit, 1);
$$;

-- Open required steps whose deadline passed at or before p_before, on incidents that are still open.
CREATE OR REPLACE FUNCTION public.incident_overdue_steps(p_account_id UUID, p_before TIMESTAMPTZ, p_limit INTEGER DEFAULT 100)
RETURNS TABLE (obligation_id UUID, incident_id UUID, party TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.incident_id, o.party
    FROM public.incident_obligations o
    JOIN public.incidents i ON i.id = o.incident_id
   WHERE o.account_id = p_account_id
     AND o.status = 'open'
     AND o.due_at IS NOT NULL
     AND o.due_at <= p_before
     AND i.status <> 'closed'
     AND i.created_at > now() - interval '180 days'
   ORDER BY o.due_at
   LIMIT GREATEST(p_limit, 1);
$$;

-- Incidents still open (not closed) that were raised at or before p_before: the "resolve by" timer.
CREATE OR REPLACE FUNCTION public.incident_unresolved(p_account_id UUID, p_before TIMESTAMPTZ, p_limit INTEGER DEFAULT 100)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id
    FROM public.incidents i
   WHERE i.account_id = p_account_id
     AND i.status <> 'closed'
     AND i.created_at <= p_before
     AND i.created_at > now() - interval '365 days'
     AND NOT i.is_test
   ORDER BY i.created_at
   LIMIT GREATEST(p_limit, 1);
$$;

-- Accounts that have at least one enabled timed rule: the sweep only looks at these.
CREATE OR REPLACE FUNCTION public.incident_accounts_with_timed_rules()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT account_id FROM public.incident_rules
   WHERE enabled AND trigger IN ('unacknowledged', 'step_overdue', 'unresolved');
$$;

REVOKE ALL ON FUNCTION public.claim_incident_deliveries(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.incident_unacknowledged(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.incident_overdue_steps(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.incident_unresolved(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.incident_accounts_with_timed_rules() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_incident_deliveries(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.incident_unacknowledged(UUID, TIMESTAMPTZ, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.incident_overdue_steps(UUID, TIMESTAMPTZ, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.incident_unresolved(UUID, TIMESTAMPTZ, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.incident_accounts_with_timed_rules() TO service_role;

NOTIFY pgrst, 'reload schema';
