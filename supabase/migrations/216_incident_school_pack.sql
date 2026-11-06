-- Migration 216: a school's own compliance pack.
--
-- The built-in packs (PDPA, ISO 27035, ISO 45001, the school-policy starter) are shared by every school. A school can now also keep ITS OWN pack of required
-- steps: "when an incident involves a child, the Head of Sport must phone the parents within 4 hours". The pack is an ordinary framework owned by one
-- school (incident_standards.account_id), so it is switched on and listed like the others and feeds the same checklist on each incident. Other schools never
-- see it: the policies below show a row only to its own school (built-in rows have no account_id and stay visible to everyone).
-- Run on the Halo PostgreSQL after 215. Idempotent.

ALTER TABLE public.incident_standards ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_standards_account_pack ON public.incident_standards (account_id) WHERE account_id IS NOT NULL AND kind = 'framework';

-- A school's pack must be a framework (steps), never a template (categories and severities), and never marked as a built-in.
CREATE OR REPLACE FUNCTION public.enforce_incident_school_pack()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.account_id IS NOT NULL AND (NEW.kind <> 'framework' OR NEW.is_system) THEN
    RAISE EXCEPTION 'a school''s own pack must be a framework and not a built-in';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enforce_incident_school_pack ON public.incident_standards;
CREATE TRIGGER enforce_incident_school_pack
  BEFORE INSERT OR UPDATE ON public.incident_standards
  FOR EACH ROW EXECUTE FUNCTION public.enforce_incident_school_pack();

-- Who can see a standard: everyone for a built-in; only the owning school for its own pack.
DROP POLICY IF EXISTS "incident_standards_select" ON public.incident_standards;
CREATE POLICY "incident_standards_select" ON public.incident_standards
  FOR SELECT USING (account_id IS NULL OR is_account_member(account_id));

DROP POLICY IF EXISTS incident_standards_write ON public.incident_standards;
CREATE POLICY incident_standards_write ON public.incident_standards FOR ALL
  USING (account_id IS NOT NULL AND has_capability(account_id, 'incidents.configure'))
  WITH CHECK (account_id IS NOT NULL AND has_capability(account_id, 'incidents.configure'));

-- The steps of a standard follow the standard.
DROP POLICY IF EXISTS "incident_obligation_rules_select" ON public.incident_obligation_rules;
CREATE POLICY "incident_obligation_rules_select" ON public.incident_obligation_rules FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.incident_standards s WHERE s.id = incident_obligation_rules.standard_id AND (s.account_id IS NULL OR is_account_member(s.account_id)))
);

DROP POLICY IF EXISTS incident_obligation_rules_write ON public.incident_obligation_rules;
CREATE POLICY incident_obligation_rules_write ON public.incident_obligation_rules FOR ALL
  USING (EXISTS (SELECT 1 FROM public.incident_standards s WHERE s.id = incident_obligation_rules.standard_id AND s.account_id IS NOT NULL AND has_capability(s.account_id, 'incidents.configure')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.incident_standards s WHERE s.id = incident_obligation_rules.standard_id AND s.account_id IS NOT NULL AND has_capability(s.account_id, 'incidents.configure')));

-- The catalogue tables (categories, severities) also follow the standard, so a school's pack does not leak through them.
DROP POLICY IF EXISTS "incident_type_catalogue_select" ON public.incident_type_catalogue;
CREATE POLICY "incident_type_catalogue_select" ON public.incident_type_catalogue FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.incident_standards s WHERE s.id = incident_type_catalogue.standard_id AND (s.account_id IS NULL OR is_account_member(s.account_id)))
);
DROP POLICY IF EXISTS "incident_severity_levels_select" ON public.incident_severity_levels;
CREATE POLICY "incident_severity_levels_select" ON public.incident_severity_levels FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.incident_standards s WHERE s.id = incident_severity_levels.standard_id AND (s.account_id IS NULL OR is_account_member(s.account_id)))
);

NOTIFY pgrst, 'reload schema';
