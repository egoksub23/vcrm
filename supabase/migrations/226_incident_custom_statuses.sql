-- Migration 226: a school's own wording and extra steps for incident statuses.
--
-- Every incident still has one of the six base statuses (Reported, Triaged, Contained, Investigating, Recovered, Closed): the timers, the rules, the
-- requirements before a move and the reports all work on those. A school can now (1) rename a base status ("Triaged" becomes "Assessed"), and (2) add its own
-- extra statuses, each mapped to one base status ("Waiting for parents" counts as Investigating). An incident keeps its base status in `status` and the
-- school's own choice in `status_key` (null = the base status itself). Run on the Halo PostgreSQL after 225. Idempotent.

CREATE TABLE IF NOT EXISTS public.incident_status_options (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- A base status's own key is its name (reported ...); an extra status gets a key made from its label.
  key         TEXT        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label       TEXT        NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 40),
  base_status TEXT        NOT NULL CHECK (base_status IN ('reported', 'triaged', 'contained', 'investigating', 'recovered', 'closed')),
  position    INTEGER     NOT NULL DEFAULT 0,
  is_builtin  BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, key),
  -- a built-in row only renames its own base status
  CHECK (NOT is_builtin OR key = base_status)
);
CREATE INDEX IF NOT EXISTS idx_incident_status_options_account ON public.incident_status_options (account_id, position);

ALTER TABLE public.incident_status_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_status_options_select ON public.incident_status_options;
-- Everyone in the school reads them (they name the status on every incident); only the server writes, after it has checked incidents.configure.
CREATE POLICY incident_status_options_select ON public.incident_status_options FOR SELECT USING (is_account_member(account_id));

ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS status_key TEXT;

NOTIFY pgrst, 'reload schema';
