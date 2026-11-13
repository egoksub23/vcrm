-- Migration 210: required steps name a role.
--
-- A required step (an incident_obligations row, built from a compliance-pack rule) used to say only WHO the step is about through `party`
-- (for example school_leadership). It now also carries the incident ROLE that owns it (principal, dpo ...), so "My tasks" can show each person
-- the steps for the roles they hold, and the overdue-step rule can chase the right role.
-- Run on the Halo PostgreSQL after 209. Idempotent.

ALTER TABLE public.incident_obligation_rules ADD COLUMN IF NOT EXISTS role_key TEXT;
ALTER TABLE public.incident_obligations      ADD COLUMN IF NOT EXISTS role_key TEXT;

-- The built-in packs only know the party a step is about; map the parties that are people inside or around the school to a role.
-- (Police, insurers, the ministry and so on stay unmapped: the incident lead does those steps.)
UPDATE public.incident_obligation_rules
   SET role_key = CASE party
                    WHEN 'school_leadership' THEN 'principal'
                    WHEN 'parent_guardian'   THEN 'parent_guardian'
                    WHEN 'pdp_commissioner'  THEN 'dpo'
                    WHEN 'data_subjects'     THEN 'dpo'
                    ELSE NULL
                  END
 WHERE role_key IS NULL AND party IS NOT NULL;

UPDATE public.incident_obligations o
   SET role_key = r.role_key
  FROM public.incident_obligation_rules r
 WHERE o.rule_id = r.id AND o.role_key IS NULL AND r.role_key IS NOT NULL;

-- New steps copy the role from their rule, so incident_sync_obligations (migration 206) does not need to change.
CREATE OR REPLACE FUNCTION public.set_incident_obligation_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.role_key IS NULL AND NEW.rule_id IS NOT NULL THEN
    SELECT r.role_key INTO NEW.role_key FROM public.incident_obligation_rules r WHERE r.id = NEW.rule_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_incident_obligation_role ON public.incident_obligations;
CREATE TRIGGER on_incident_obligation_role
  BEFORE INSERT ON public.incident_obligations
  FOR EACH ROW EXECUTE FUNCTION public.set_incident_obligation_role();

CREATE INDEX IF NOT EXISTS idx_incident_obligations_role_open
  ON public.incident_obligations (account_id, role_key, due_at) WHERE status = 'open';

NOTIFY pgrst, 'reload schema';
