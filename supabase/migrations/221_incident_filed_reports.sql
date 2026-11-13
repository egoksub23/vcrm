-- Migration 221: filed incident reports, and plain wording for the school starter steps.
--
-- 1. A closed incident can have a report generated for filing: one PDF holding everything the workflow recorded (who reported it, what happened, the people
--    named, the pictures, every action and notice until closure). The PDF is kept in file storage and this table links each one to the incident, so it is
--    listed on the incident and can be downloaded again. Generating again after a reopen-and-close adds a new version; earlier ones are kept.
--    A report can only be made for a closed incident (the trigger below refuses otherwise).
-- 2. The school starter pack and the school template said "Ministry of Education" as if a ministry policy were behind them. None is: the steps and hours are
--    Halo's own starting points. The wording now says that. Incidents already raised keep the title they were raised with.
-- Run on the Halo PostgreSQL after 220. Idempotent.

CREATE TABLE IF NOT EXISTS public.incident_filed_reports (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id        UUID        NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  account_id         UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  version            INTEGER     NOT NULL CHECK (version >= 1),
  reference          TEXT        NOT NULL,
  filename           TEXT        NOT NULL,
  storage_path       TEXT        NOT NULL,
  size_bytes         BIGINT      NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  file_hash          TEXT,
  incident_closed_at TIMESTAMPTZ,
  generated_by       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  generated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (incident_id, version)
);
CREATE INDEX IF NOT EXISTS idx_incident_filed_reports_incident ON public.incident_filed_reports (incident_id, version DESC);

ALTER TABLE public.incident_filed_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_filed_reports_select ON public.incident_filed_reports;
DROP POLICY IF EXISTS incident_filed_reports_insert ON public.incident_filed_reports;
-- Whoever may export an incident may see and make its filed reports. Nobody edits or deletes one (it goes only if the incident does).
CREATE POLICY incident_filed_reports_select ON public.incident_filed_reports FOR SELECT USING (has_capability(account_id, 'incidents.export'));
CREATE POLICY incident_filed_reports_insert ON public.incident_filed_reports FOR INSERT WITH CHECK (has_capability(account_id, 'incidents.export') AND generated_by = auth.uid());

CREATE OR REPLACE FUNCTION public.enforce_incident_filed_report()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_account UUID;
BEGIN
  SELECT status, account_id INTO v_status, v_account FROM public.incidents WHERE id = NEW.incident_id;
  IF v_status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'a report for filing can only be made once the incident is closed';
  END IF;
  IF v_account IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'the report must belong to the incident''s own school';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS enforce_incident_filed_report ON public.incident_filed_reports;
CREATE TRIGGER enforce_incident_filed_report
  BEFORE INSERT ON public.incident_filed_reports
  FOR EACH ROW EXECUTE FUNCTION public.enforce_incident_filed_report();

-- Wording: no ministry or education-office policy stands behind the school starter steps.
UPDATE public.incident_standards
   SET regulatory_body = 'Set by your school'
 WHERE slug = 'school_incident' AND regulatory_body LIKE '%Ministry of Education%';

UPDATE public.incident_standards
   SET name = 'School steps (starter)',
       regulatory_body = 'Your school',
       description = 'A starting checklist for informing school leadership, your insurer and the police. These steps and hours are Halo''s own suggestions, not an official requirement: replace them with your school''s own procedures.'
 WHERE slug = 'school_policy' AND name LIKE '%ministry%';

UPDATE public.incident_obligation_rules
   SET title = 'Report to the education authority, if your school''s policy requires it',
       description = 'Starter step: ask school leadership whether this applies to your school, and by when.'
 WHERE code IN ('SCHOOL_MINISTRY_INJURY', 'SCHOOL_MINISTRY_SECURITY') AND title LIKE '%ministry%';
