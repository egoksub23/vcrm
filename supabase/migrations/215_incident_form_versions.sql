-- Migration 215: the coach report form, versioned.
--
-- The form the coach fills in is data (src/lib/incidents/intake/form-schema.ts). A school edits a DRAFT in the builder and PUBLISHES it; the published
-- version is the one new report links use. A link keeps the version it was issued with, and an incident records the version it was filed under, so
-- changing the form never changes a report already made. Before a school publishes anything the built-in form is used (no row needed).
-- Run on the Halo PostgreSQL after 214. Idempotent.

CREATE TABLE IF NOT EXISTS public.incident_form_versions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  form_key     TEXT        NOT NULL DEFAULT 'cca' CHECK (form_key IN ('cca')),
  version      INTEGER     NOT NULL CHECK (version >= 1),
  status       TEXT        NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  schema       JSONB       NOT NULL CHECK (jsonb_typeof(schema) = 'object'),
  note         TEXT,
  created_by   UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  UNIQUE (account_id, form_key, version),
  CHECK ((status = 'draft') = (published_at IS NULL))
);
-- At most one draft and one published version per school and form.
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_form_draft     ON public.incident_form_versions (account_id, form_key) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_form_published ON public.incident_form_versions (account_id, form_key) WHERE status = 'published';

DROP TRIGGER IF EXISTS set_updated_at ON public.incident_form_versions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incident_form_versions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.incident_form_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_form_versions_select ON public.incident_form_versions;
DROP POLICY IF EXISTS incident_form_versions_write  ON public.incident_form_versions;
CREATE POLICY incident_form_versions_select ON public.incident_form_versions FOR SELECT USING (
  has_capability(account_id, 'incidents.manage') OR has_capability(account_id, 'incidents.configure')
);
CREATE POLICY incident_form_versions_write ON public.incident_form_versions FOR ALL
  USING (has_capability(account_id, 'incidents.configure'))
  WITH CHECK (has_capability(account_id, 'incidents.configure'));

-- Which version a link was issued with, and which an incident was filed under (NULL = the built-in form).
ALTER TABLE public.incident_intake_sessions ADD COLUMN IF NOT EXISTS form_version INTEGER;
ALTER TABLE public.incidents                ADD COLUMN IF NOT EXISTS form_version INTEGER;

-- Publish a draft in one step: the old published version is archived and the draft takes its place, so there is never a moment with none.
-- Service role only; the route has already checked the person and validated the form.
CREATE OR REPLACE FUNCTION public.publish_incident_form(p_account_id UUID, p_form_key TEXT, p_version INTEGER, p_user UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  SELECT TRUE INTO v_ok FROM public.incident_form_versions
   WHERE account_id = p_account_id AND form_key = p_form_key AND version = p_version AND status = 'draft'
   FOR UPDATE;
  IF v_ok IS NOT TRUE THEN
    RETURN FALSE;
  END IF;
  UPDATE public.incident_form_versions SET status = 'archived'
   WHERE account_id = p_account_id AND form_key = p_form_key AND status = 'published';
  UPDATE public.incident_form_versions SET status = 'published', published_at = now(), published_by = p_user
   WHERE account_id = p_account_id AND form_key = p_form_key AND version = p_version;
  RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.publish_incident_form(UUID, TEXT, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_incident_form(UUID, TEXT, INTEGER, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
