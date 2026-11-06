-- Migration 214: workflow requirements for moving an incident on, and approvals.
--
-- The statuses are unchanged. A school can require things before an incident moves to a status (a root cause written, every required step done, a lead
-- assigned, a role's approval) and can forbid moving back. The server checks on every status change. An approval is a role's yes or no on one incident.
-- Run on the Halo PostgreSQL after 213. Idempotent.

ALTER TABLE public.incident_settings ADD COLUMN IF NOT EXISTS workflow_allow_backward BOOLEAN NOT NULL DEFAULT TRUE;

-- ------------------------------------------------------------
-- 1. incident_workflow_guards
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_workflow_guards (
  account_id UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  to_status  TEXT        NOT NULL CHECK (to_status IN ('triaged', 'contained', 'investigating', 'recovered', 'closed')),
  -- { "root_cause": true, "steps_done": true, "lead_assigned": true, "approval_role": "principal" }
  requires   JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(requires) = 'object'),
  updated_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, to_status)
);

-- ------------------------------------------------------------
-- 2. incident_approvals
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_approvals (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  incident_id  UUID        NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  role_key     TEXT        NOT NULL,
  -- What the approval is for, for example the status the incident is trying to reach.
  for_status   TEXT,
  requested_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision     TEXT        CHECK (decision IN ('approved', 'rejected')),
  decided_by   UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at   TIMESTAMPTZ,
  note         TEXT,
  CHECK ((decision IS NULL) = (decided_at IS NULL))
);
-- One question at a time per role per incident.
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_approvals_pending ON public.incident_approvals (incident_id, role_key) WHERE decision IS NULL;
CREATE INDEX IF NOT EXISTS idx_incident_approvals_incident ON public.incident_approvals (incident_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_incident_approvals_waiting ON public.incident_approvals (account_id, role_key) WHERE decision IS NULL;

ALTER TABLE public.incident_workflow_guards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_approvals       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incident_workflow_guards_select ON public.incident_workflow_guards;
DROP POLICY IF EXISTS incident_workflow_guards_write  ON public.incident_workflow_guards;
CREATE POLICY incident_workflow_guards_select ON public.incident_workflow_guards FOR SELECT USING (
  has_capability(account_id, 'incidents.manage') OR has_capability(account_id, 'incidents.configure')
);
CREATE POLICY incident_workflow_guards_write ON public.incident_workflow_guards FOR ALL
  USING (has_capability(account_id, 'incidents.configure'))
  WITH CHECK (has_capability(account_id, 'incidents.configure'));

-- Approvals are read by whoever can see the incident; they are written by the server after it has checked the person holds the role.
DROP POLICY IF EXISTS incident_approvals_select ON public.incident_approvals;
CREATE POLICY incident_approvals_select ON public.incident_approvals FOR SELECT USING (
  has_capability(account_id, 'incidents.manage')
  OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_approvals.incident_id AND i.reporter_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.incident_watchers w WHERE w.incident_id = incident_approvals.incident_id AND w.user_id = auth.uid())
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'halo_notify_account_change') THEN
    DROP TRIGGER IF EXISTS halo_rt_incident_approvals ON public.incident_approvals;
    CREATE TRIGGER halo_rt_incident_approvals
      AFTER INSERT OR UPDATE OR DELETE ON public.incident_approvals
      FOR EACH ROW EXECUTE FUNCTION public.halo_notify_account_change();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
