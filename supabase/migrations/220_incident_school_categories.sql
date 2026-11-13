-- Migration 220: a school can keep its own copy of the incident template, and edit its categories.
--
-- The built-in templates (BNM, School Incident Management) are shared by every school, so one school cannot rename or add a category in them. A school can now
-- "make our own copy": an ordinary template owned by that school (incident_standards.account_id), with its own categories, severity levels and any steps the
-- original carried. The copy becomes the school's one active template (migration 206's trigger switches the old one off). Incidents already raised keep the
-- template they were raised under, so their categories and severity labels do not change.
--   * incident_type_catalogue.is_hidden: a category the school has hidden. It no longer appears when raising an incident; reports, filters, rules and the coach
--     portal's report form still know it, so nothing that already uses it breaks.
--   * incident_standards.copied_from: which built-in template the copy was made from.
--   * one copy per school, and the school-pack trigger from 216 now only refuses a school-owned row marked as a built-in (it used to refuse every template).
-- Run on the Halo PostgreSQL after 219. Idempotent.

ALTER TABLE public.incident_type_catalogue ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.incident_standards ADD COLUMN IF NOT EXISTS copied_from UUID REFERENCES public.incident_standards(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_standards_account_template ON public.incident_standards (account_id) WHERE account_id IS NOT NULL AND kind = 'template';

CREATE OR REPLACE FUNCTION public.enforce_incident_school_pack()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.account_id IS NOT NULL AND NEW.is_system THEN
    RAISE EXCEPTION 'a school''s own standard cannot be marked as a built-in';
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
