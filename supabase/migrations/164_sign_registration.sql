-- ============================================================
-- 164_sign_registration.sql
--
-- Doc Sign, work package 21 (requirement F-58): a public registration page. Someone with no login opens
-- /r/<slug>, enters a few details, and a contact is created or matched in the workspace; the signing flow
-- starts (the document goes to the email they entered, which is also what proves the address is theirs).
--
--   sign_registration_forms   one row per public page: its slug, which template to send and who fills which
--                             role, the tag the contact gets, which fields are asked, the consent and success
--                             wording per language, and a daily cap. Managed by sign.settings.
--   sign_registration_counts  the numbers the Settings list shows, counted in the database (the API caps the rows it returns)
--   sign_registrations        one row per submission and what became of it (accepted, rejected as spam, over
--                             the daily cap, or failed). Written only by the server. It never holds a raw IP
--                             address or a raw email: both are keyed hashes (HMAC with a server secret), enough
--                             to count and to spot a repeat, not to read back.
--
-- `mode` is the extension point for the "form only, no signature" document mode of a later work package: today
-- the only mode is 'sign'. A form with send_document = FALSE only creates or updates the contact and applies the
-- tag (an automation on that tag can send the document instead).
--
-- A slug is a public identifier and never contains the workspace id. It is globally unique and ends in a random
-- suffix (made by the app), so a page cannot be found by counting. Forms are switched off, never deleted, so the
-- submissions (and the consent they record) stay; a workspace purge removes them with everything else (153: both
-- tables carry account_id with a cascade, so the export and the deletion find them by themselves).
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sign_registration_forms (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- 6 to 40 characters of a to z, 0 to 9 and hyphens, starting and ending with a letter or digit.
  slug               TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{4,38}[a-z0-9]$'),
  name               TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- New forms start switched off: the page answers "not found" until someone turns it on.
  active             BOOLEAN NOT NULL DEFAULT FALSE,
  -- Only 'sign' exists. A later work package adds the form-only mode here.
  mode               TEXT NOT NULL DEFAULT 'sign' CHECK (mode IN ('sign')),
  send_document      BOOLEAN NOT NULL DEFAULT TRUE,
  -- Kept as a plain id (the template may be deleted later; the page then cannot send and says so to the admins).
  template_id        UUID REFERENCES public.sign_templates(id) ON DELETE SET NULL,
  -- Which role of the template the applicant completes.
  applicant_role_key TEXT CHECK (applicant_role_key IS NULL OR length(applicant_role_key) BETWEEN 1 AND 40),
  -- People for the other roles: [{ "role_key", "name", "email", "channel", "phone"? }]
  -- (a CASE, not AND: the length of something that is not an array is an error, and AND does not promise to stop early)
  signers_other      JSONB NOT NULL DEFAULT '[]'::jsonb
                     CHECK (CASE WHEN jsonb_typeof(signers_other) = 'array'
                                 THEN jsonb_array_length(signers_other) <= 10 AND pg_column_size(signers_other) <= 20000
                                 ELSE FALSE END),
  contact_tag_id     UUID REFERENCES public.tags(id) ON DELETE SET NULL,
  -- Which details the page asks for: { full_name, email, phone, company } each 'required', 'optional' or 'off'.
  -- The email is always required: it is where the document goes.
  fields             JSONB NOT NULL DEFAULT '{"full_name": "required", "email": "required", "phone": "optional", "company": "required"}'::jsonb
                     CHECK (jsonb_typeof(fields) = 'object' AND fields ->> 'email' = 'required' AND pg_column_size(fields) <= 1000),
  -- Wording per language ({ "en": "...", "ms": "..." }); a language left out uses the product's own wording.
  consent_text       JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(consent_text) = 'object' AND pg_column_size(consent_text) <= 12000),
  success_message    JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(success_message) = 'object' AND pg_column_size(success_message) <= 12000),
  default_locale     TEXT NOT NULL DEFAULT 'en' CHECK (default_locale IN ('en', 'ms', 'zh', 'ko')),
  -- Accepted registrations a day (rolling 24 hours); beyond it the page says it is busy.
  daily_cap          INTEGER NOT NULL DEFAULT 100 CHECK (daily_cap BETWEEN 1 AND 5000),
  created_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_registration_forms_slug_key UNIQUE (slug),
  CONSTRAINT sign_registration_forms_id_account UNIQUE (id, account_id)
);
CREATE INDEX IF NOT EXISTS sign_registration_forms_account_idx ON public.sign_registration_forms (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.sign_registrations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  form_id     UUID NOT NULL,
  contact_id  UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  document_id UUID REFERENCES public.sign_documents(id) ON DELETE SET NULL,
  status      TEXT NOT NULL CHECK (status IN ('accepted', 'rejected_spam', 'rejected_cap', 'failed')),
  -- A short code that says why (honeypot, token_expired, duplicate, sign_limit_reached, ...). Never personal data.
  reason      TEXT CHECK (reason IS NULL OR length(reason) <= 60),
  -- HMAC-SHA256 (hex) of the email (lower case) and of the caller's address, keyed with a server secret.
  email_hash  TEXT CHECK (email_hash IS NULL OR email_hash ~ '^[0-9a-f]{64}$'),
  ip_hash     TEXT CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  user_agent  TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 120),
  locale      TEXT CHECK (locale IS NULL OR locale IN ('en', 'ms', 'zh', 'ko')),
  -- The wording version the applicant agreed to (default-v1-en, custom-ms-<hash>), the record of consent.
  consent_version TEXT CHECK (consent_version IS NULL OR length(consent_version) <= 60),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_registrations_form_fk FOREIGN KEY (form_id, account_id)
    REFERENCES public.sign_registration_forms (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sign_registrations_form_idx ON public.sign_registrations (form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sign_registrations_email_idx ON public.sign_registrations (form_id, email_hash, created_at DESC) WHERE email_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS sign_registrations_account_idx ON public.sign_registrations (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sign_registrations_contact_idx ON public.sign_registrations (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sign_registrations_document_idx ON public.sign_registrations (document_id) WHERE document_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Row level security and grants
--    Reading follows menu.sign; managing a form is sign.settings. Submissions are written by the server alone
--    (service role): no insert, update or delete policy and no privilege for the API roles.
-- ------------------------------------------------------------
ALTER TABLE public.sign_registration_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_registrations      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sign_registration_forms FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sign_registrations      FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sign_registration_forms TO authenticated;
GRANT SELECT                 ON public.sign_registrations      TO authenticated;
GRANT ALL ON public.sign_registration_forms TO service_role;
GRANT ALL ON public.sign_registrations      TO service_role;

DROP POLICY IF EXISTS sign_registration_forms_select ON public.sign_registration_forms;
DROP POLICY IF EXISTS sign_registration_forms_insert ON public.sign_registration_forms;
DROP POLICY IF EXISTS sign_registration_forms_update ON public.sign_registration_forms;
CREATE POLICY sign_registration_forms_select ON public.sign_registration_forms
  FOR SELECT USING (has_capability(account_id, 'menu.sign'));
CREATE POLICY sign_registration_forms_insert ON public.sign_registration_forms
  FOR INSERT WITH CHECK (has_capability(account_id, 'sign.settings') AND (created_by IS NULL OR created_by = auth.uid()));
CREATE POLICY sign_registration_forms_update ON public.sign_registration_forms
  FOR UPDATE USING (has_capability(account_id, 'sign.settings'))
  WITH CHECK (has_capability(account_id, 'sign.settings'));
-- No delete: a form is switched off, so its submissions (and the consent they record) stay.

DROP POLICY IF EXISTS sign_registrations_select ON public.sign_registrations;
CREATE POLICY sign_registrations_select ON public.sign_registrations
  FOR SELECT USING (has_capability(account_id, 'menu.sign'));

-- ------------------------------------------------------------
-- 3. updated_at and audit
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON public.sign_registration_forms;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.sign_registration_forms
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- The slug (a public identifier an admin may regenerate), the people for the other roles, the wording and
-- the details asked are recorded by name only; the rest with their from and to values. The entity type is
-- sign_settings (the audit screen already knows it); the label is the form's name.
DROP TRIGGER IF EXISTS audit_row_change ON public.sign_registration_forms;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_registration_forms
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'sign_settings', 'name', 'name,active,send_document,template_id,applicant_role_key,contact_tag_id,daily_cap,default_locale,mode',
    'slug,signers_other,fields,consent_text,success_message', '', 'created_by');

-- ------------------------------------------------------------
-- 4. A form can only point at its own workspace's template and tag, and its JSON has the shape the page expects
--    (a BEFORE trigger runs ahead of the CHECK constraints, so the shape is tested here with the same error code).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_registration_forms_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'sign_registration_form_account_is_fixed' USING ERRCODE = '23514';
  END IF;

  IF NEW.template_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.sign_templates t WHERE t.id = NEW.template_id AND t.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'sign_registration_template_not_in_workspace' USING ERRCODE = '23514';
  END IF;
  IF NEW.contact_tag_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.tags g WHERE g.id = NEW.contact_tag_id AND g.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'sign_registration_tag_not_in_workspace' USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(NEW.fields) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'sign_registration_fields_invalid' USING ERRCODE = '23514';
  END IF;
  FOR e IN SELECT k.key, k.value FROM jsonb_each_text(NEW.fields) AS k LOOP
    IF e.key NOT IN ('full_name', 'email', 'phone', 'company') OR e.value NOT IN ('required', 'optional', 'off') THEN
      RAISE EXCEPTION 'sign_registration_fields_invalid' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF jsonb_typeof(NEW.consent_text) IS DISTINCT FROM 'object' OR jsonb_typeof(NEW.success_message) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'sign_registration_wording_invalid' USING ERRCODE = '23514';
  END IF;
  FOR e IN SELECT k.key, k.value, jsonb_typeof(NEW.consent_text -> k.key) AS kind FROM jsonb_each(NEW.consent_text) AS k LOOP
    IF e.key NOT IN ('en', 'ms', 'zh', 'ko') OR e.kind <> 'string' OR length(NEW.consent_text ->> e.key) > 2000 THEN
      RAISE EXCEPTION 'sign_registration_wording_invalid' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  FOR e IN SELECT k.key, k.value, jsonb_typeof(NEW.success_message -> k.key) AS kind FROM jsonb_each(NEW.success_message) AS k LOOP
    IF e.key NOT IN ('en', 'ms', 'zh', 'ko') OR e.kind <> 'string' OR length(NEW.success_message ->> e.key) > 1000 THEN
      RAISE EXCEPTION 'sign_registration_wording_invalid' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_registration_forms_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_registration_forms_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_registration_forms_guard ON public.sign_registration_forms;
CREATE TRIGGER sign_registration_forms_guard
  BEFORE INSERT OR UPDATE ON public.sign_registration_forms
  FOR EACH ROW EXECUTE FUNCTION public.sign_registration_forms_guard();

-- ------------------------------------------------------------
-- 5. The counts the Settings list shows, in one pass (the API returns at most a thousand rows to count in code).
--    SECURITY INVOKER: it reads sign_registrations as the caller, so row level security (menu.sign) decides what is
--    counted. p_since starts the window of the last-30-days columns, p_today the window of "today" (what the daily cap counts).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_registration_counts(p_account UUID, p_since TIMESTAMPTZ, p_today TIMESTAMPTZ)
RETURNS TABLE (form_id UUID, accepted BIGINT, rejected_spam BIGINT, rejected_cap BIGINT, failed BIGINT, today BIGINT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT r.form_id,
         count(*) FILTER (WHERE r.status = 'accepted'),
         count(*) FILTER (WHERE r.status = 'rejected_spam'),
         count(*) FILTER (WHERE r.status = 'rejected_cap'),
         -- a claim still being handled is not an outcome yet
         count(*) FILTER (WHERE r.status = 'failed' AND r.reason IS DISTINCT FROM 'in_progress'),
         count(*) FILTER (WHERE r.status = 'accepted' AND r.reason IS NULL AND r.created_at >= p_today)
    FROM public.sign_registrations r
   WHERE r.account_id = p_account AND r.created_at >= p_since
   GROUP BY r.form_id;
$$;
REVOKE ALL ON FUNCTION public.sign_registration_counts(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sign_registration_counts(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
