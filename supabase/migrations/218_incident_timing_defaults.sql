-- Migration 218: timing a school can change, with the shipped values as defaults.
--
-- 1. incident_settings.ack_wait_minutes: how long a notice may go unacknowledged before the "nobody acknowledged" rule fires. Default 30.
--    (The rule keeps its own wait too; saving this setting also updates the school's rule that came from the starter recipe.)
-- 2. incident_step_overrides: a school's own deadline (or none) for a built-in required step (PDPA, ISO, school policy), and a switch to leave a built-in
--    step off. The shared step rows stay as they are, so every school without an override keeps the shipped hours.
-- 3. incident_sync_obligations() reads the overrides when it builds an incident's checklist. Incidents already raised keep the steps and dates they have.
-- Run on the Halo PostgreSQL after 217. Idempotent.

ALTER TABLE public.incident_settings
  ADD COLUMN IF NOT EXISTS ack_wait_minutes INTEGER NOT NULL DEFAULT 30 CHECK (ack_wait_minutes BETWEEN 1 AND 43200);

CREATE TABLE IF NOT EXISTS public.incident_step_overrides (
  account_id  UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  rule_id     UUID        NOT NULL REFERENCES public.incident_obligation_rules(id) ON DELETE CASCADE,
  -- A deadline in hours after the incident was detected. NULL with no_deadline = FALSE means "use the shipped hours".
  due_hours   INTEGER     CHECK (due_hours IS NULL OR due_hours BETWEEN 1 AND 8760),
  no_deadline BOOLEAN     NOT NULL DEFAULT FALSE,
  -- FALSE = this school does not want the step added to new incidents.
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, rule_id),
  CHECK (NOT (no_deadline AND due_hours IS NOT NULL))
);

ALTER TABLE public.incident_step_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_step_overrides_select ON public.incident_step_overrides;
DROP POLICY IF EXISTS incident_step_overrides_write  ON public.incident_step_overrides;
CREATE POLICY incident_step_overrides_select ON public.incident_step_overrides FOR SELECT USING (has_capability(account_id, 'incidents.configure'));
CREATE POLICY incident_step_overrides_write  ON public.incident_step_overrides FOR ALL
  USING (has_capability(account_id, 'incidents.configure'))
  WITH CHECK (has_capability(account_id, 'incidents.configure'));

-- Same function as migration 206, with the school's override applied: skip a step the school turned off, and use its own deadline when it set one.
CREATE OR REPLACE FUNCTION public.incident_sync_obligations(p_incident_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v incidents%ROWTYPE;
BEGIN
  SELECT * INTO v FROM incidents WHERE id = p_incident_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO incident_obligations (incident_id, account_id, rule_id, standard_id, title, description, party, due_at)
  SELECT v.id, v.account_id, r.id, r.standard_id, r.title, r.description, r.party,
         CASE
           WHEN ov.no_deadline THEN NULL
           WHEN ov.due_hours IS NOT NULL THEN v.detected_at + make_interval(hours => ov.due_hours)
           WHEN r.due_hours IS NULL THEN NULL
           ELSE v.detected_at + make_interval(hours => r.due_hours)
         END
    FROM account_incident_standards ais
    JOIN incident_standards s ON s.id = ais.standard_id AND s.kind = 'framework'
    JOIN incident_obligation_rules r ON r.standard_id = s.id AND r.trigger_flag = ANY (v.incident_flags)
    LEFT JOIN incident_step_overrides ov ON ov.account_id = v.account_id AND ov.rule_id = r.id
   WHERE ais.account_id = v.account_id AND ais.is_active
     AND COALESCE(ov.enabled, TRUE)
  ON CONFLICT (incident_id, rule_id) DO UPDATE
    SET status = 'open'
    WHERE incident_obligations.status = 'not_applicable';

  UPDATE incident_obligations o
     SET status = 'not_applicable'
   WHERE o.incident_id = v.id
     AND o.status = 'open'
     AND o.rule_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM incident_obligation_rules r
        WHERE r.id = o.rule_id AND r.trigger_flag = ANY (v.incident_flags)
     );
END;
$$;

NOTIFY pgrst, 'reload schema';
