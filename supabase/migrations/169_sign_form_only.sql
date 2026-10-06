-- ============================================================
-- 169_sign_form_only.sql
--
-- Doc Sign, work package 24 (feature F-97): a form WITHOUT a signature. The same form in parts, the same single link,
-- the same consent, verification code, autosave, uploads, write-back to the contact, audit trail and sealed record, for
-- a person who has nothing to sign: for example the e-invoice and tax details of a merchant who already signed their
-- agreement. The person opens the link, fills the parts over several sittings, reviews and submits.
--
--   mode          a template, each of its versions and a document are either 'sign' (today) or 'form'.
--                 A template's mode is fixed when it is made (a template always has a version, so "a template with
--                 versions in use" is every template). A version carries its template's mode and a document copies
--                 its version's mode when it is made; a document's mode never changes.
--   no signature  a 'form' document has only fillers, no signature, initials or signing-date place on the page and a
--                 form with at least one part. The database holds that line when the document is sent (the app
--                 checks it earlier, with words).
--   completion    every participant "submits"; when the last has, the document goes to sealing as before and the
--                 sealing job writes a SEALED SUBMISSION RECORD (a PDF: who, when, the answers by part, the files with
--                 their fingerprints, the audit trail fingerprint, the certificate pages) as its final file. So the
--                 rule that a completed document has a sealed final file (sign_documents_guard) is unchanged.
--
--   sign_send_document          recreated: the form-mode rules above; the "needs a signer" rule is for 'sign' only
--   sign_complete_signer        recreated (from 166): a form document logs `all_submitted` and every person `submitted`
--   sign_record_consent         recreated (from 158): the consent event of a form document says so (`mode`)
--   sign_documents_guard        recreated (from 160): the mode is fixed
--   notify_sign_document_finished  recreated (from 159): "Submitted" for a form, "Signed by everyone" otherwise
--   sign_registration_forms     `mode` may be 'form'; the form's template must have the same mode
--
-- Everything here is for the service role only, with the grants of 158 and 166. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Columns
-- ------------------------------------------------------------
ALTER TABLE public.sign_templates         ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'sign';
ALTER TABLE public.sign_template_versions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'sign';
ALTER TABLE public.sign_documents         ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'sign';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_templates_mode_values') THEN
    ALTER TABLE public.sign_templates ADD CONSTRAINT sign_templates_mode_values CHECK (mode IN ('sign', 'form'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_template_versions_mode_values') THEN
    ALTER TABLE public.sign_template_versions ADD CONSTRAINT sign_template_versions_mode_values CHECK (mode IN ('sign', 'form'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_documents_mode_values') THEN
    ALTER TABLE public.sign_documents ADD CONSTRAINT sign_documents_mode_values CHECK (mode IN ('sign', 'form'));
  END IF;
END $$;

-- The registration form (164) had `mode IN ('sign')`; it now also takes 'form'. The old CHECK was written inline, so its
-- name is whatever the database gave it: find it by what it says and replace it with a named one.
DO $$
DECLARE
  c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.sign_registration_forms'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%mode%' AND pg_get_constraintdef(oid) LIKE '%sign%'
       AND conname <> 'sign_registration_forms_mode_values'
  LOOP
    EXECUTE format('ALTER TABLE public.sign_registration_forms DROP CONSTRAINT %I', c);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_registration_forms_mode_values') THEN
    ALTER TABLE public.sign_registration_forms ADD CONSTRAINT sign_registration_forms_mode_values CHECK (mode IN ('sign', 'form'));
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. A template's mode is fixed, and a version carries its template's mode
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_templates_mode_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'sign_template_mode_is_fixed' USING ERRCODE = '23514',
      DETAIL = 'A template is an agreement to sign or a form without a signature from the moment it is made. Make a new template instead.';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_templates_mode_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_templates_mode_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_templates_mode_guard ON public.sign_templates;
CREATE TRIGGER sign_templates_mode_guard
  BEFORE UPDATE OF mode ON public.sign_templates
  FOR EACH ROW EXECUTE FUNCTION public.sign_templates_mode_guard();

CREATE OR REPLACE FUNCTION public.sign_template_versions_mode_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mode TEXT;
BEGIN
  SELECT t.mode INTO v_mode FROM public.sign_templates t WHERE t.id = NEW.template_id AND t.account_id = NEW.account_id;
  IF v_mode IS NOT NULL AND NEW.mode IS DISTINCT FROM v_mode THEN
    RAISE EXCEPTION 'sign_template_version_mode_mismatch' USING ERRCODE = '23514',
      DETAIL = 'A version has the mode of its template.';
  END IF;
  -- a form-only version has no signature place on the page
  IF NEW.mode = 'form' AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.fields, '[]'::jsonb)) f
        WHERE f ->> 'type' IN ('signature', 'initials', 'date_signed')) THEN
    RAISE EXCEPTION 'sign_form_mode_has_signature' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_template_versions_mode_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_template_versions_mode_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_template_versions_mode_guard ON public.sign_template_versions;
CREATE TRIGGER sign_template_versions_mode_guard
  BEFORE INSERT ON public.sign_template_versions
  FOR EACH ROW EXECUTE FUNCTION public.sign_template_versions_mode_guard();

-- ------------------------------------------------------------
-- 3. Documents: the mode is fixed (160's guard, with one more rule)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_documents_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq INTEGER;
  v_ok  BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'sign_document_must_start_as_draft' USING ERRCODE = '23514';
    END IF;
    IF NEW.reference IS NULL OR NEW.reference = '' THEN
      UPDATE public.accounts SET sign_seq = sign_seq + 1 WHERE id = NEW.account_id
        RETURNING sign_seq INTO v_seq;
      IF v_seq IS NULL THEN
        RAISE EXCEPTION 'Account % not found', NEW.account_id USING ERRCODE = '22023';
      END IF;
      NEW.reference := 'SGN-' || to_char(now() AT TIME ZONE 'utc', 'YYYY') || '-' || lpad(v_seq::text, 6, '0');
    END IF;
    RETURN NEW;
  END IF;

  -- The reference never changes.
  IF NEW.reference IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION 'sign_document_reference_is_fixed' USING ERRCODE = '23514';
  END IF;
  -- Nor does the mode: what the people are asked to do (sign, or only submit) is decided when the document is made.
  IF NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'sign_document_mode_is_fixed' USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_ok := CASE OLD.status
      WHEN 'draft'       THEN NEW.status IN ('sent', 'voided')
      WHEN 'sent'        THEN NEW.status IN ('in_progress', 'sealing', 'declined', 'expired', 'voided')
      WHEN 'in_progress' THEN NEW.status IN ('sealing', 'declined', 'expired', 'voided')
      WHEN 'sealing'     THEN NEW.status IN ('completed', 'failed', 'voided')
      WHEN 'failed'      THEN NEW.status IN ('sealing', 'voided')
      ELSE FALSE
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'invalid_sign_status_move' USING ERRCODE = '23514',
        DETAIL = format('%s -> %s', OLD.status, NEW.status);
    END IF;
    IF NEW.status = 'sent' THEN
      IF NEW.base_path IS NULL OR NEW.base_sha256 IS NULL THEN
        RAISE EXCEPTION 'sign_document_needs_a_base_file_to_send' USING ERRCODE = '23514';
      END IF;
      NEW.sent_at := COALESCE(NEW.sent_at, now());
    ELSIF NEW.status = 'completed' THEN
      -- (a form document completes with its sealed submission record as the final file: the rule is the same)
      IF NEW.final_path IS NULL OR NEW.final_sha256 IS NULL THEN
        RAISE EXCEPTION 'sign_document_needs_a_final_file_to_complete' USING ERRCODE = '23514';
      END IF;
      NEW.completed_at := COALESCE(NEW.completed_at, now());
    END IF;
  END IF;

  -- Once sent, what the signers were shown cannot change.
  IF OLD.status <> 'draft' AND (
       NEW.title               IS DISTINCT FROM OLD.title
    OR NEW.category_id         IS DISTINCT FROM OLD.category_id
    -- (cleared to NULL when its template is deleted: the document keeps its own snapshot)
    OR (NEW.template_version_id IS DISTINCT FROM OLD.template_version_id AND NEW.template_version_id IS NOT NULL)
    OR NEW.merge_values       IS DISTINCT FROM OLD.merge_values
    OR NEW.fields_snapshot     IS DISTINCT FROM OLD.fields_snapshot
    OR NEW.roles_snapshot      IS DISTINCT FROM OLD.roles_snapshot
    OR NEW.form_snapshot       IS DISTINCT FROM OLD.form_snapshot
    OR NEW.sign_in_order       IS DISTINCT FROM OLD.sign_in_order
    OR NEW.code_required       IS DISTINCT FROM OLD.code_required
    OR NEW.original_path       IS DISTINCT FROM OLD.original_path
    OR NEW.original_sha256     IS DISTINCT FROM OLD.original_sha256
    OR NEW.base_path           IS DISTINCT FROM OLD.base_path
    OR NEW.base_sha256         IS DISTINCT FROM OLD.base_sha256
    OR NEW.page_count          IS DISTINCT FROM OLD.page_count
  ) THEN
    RAISE EXCEPTION 'sign_document_is_frozen' USING ERRCODE = '23514',
      DETAIL = 'A document that was sent cannot be edited. Void it and send a new one.';
  END IF;

  -- The sealed file is written once.
  IF OLD.final_path IS NOT NULL AND (
       NEW.final_path   IS DISTINCT FROM OLD.final_path
    OR NEW.final_sha256 IS DISTINCT FROM OLD.final_sha256
  ) THEN
    RAISE EXCEPTION 'sign_document_final_file_is_write_once' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_documents_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_documents_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_documents_guard ON public.sign_documents;
CREATE TRIGGER sign_documents_guard
  BEFORE INSERT OR UPDATE ON public.sign_documents
  FOR EACH ROW EXECUTE FUNCTION public.sign_documents_guard();

-- ------------------------------------------------------------
-- 4. draft -> sent (158's function, with the rules of a form that is not signed)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_send_document(
  p_document    UUID,
  p_base_path   TEXT,
  p_base_sha256 TEXT,
  p_page_count  INTEGER,
  p_expires_at  TIMESTAMPTZ,
  p_actor       UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d      public.sign_documents%ROWTYPE;
  v_step INTEGER := 1;
  v_in   JSONB;
BEGIN
  SELECT * INTO d FROM public.sign_documents WHERE id = p_document FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found' USING ERRCODE = '22023';
  END IF;
  IF d.status <> 'draft' THEN
    RAISE EXCEPTION 'document_not_draft' USING ERRCODE = '23514';
  END IF;
  IF d.mode = 'form' THEN
    -- a form without a signature: somebody to fill it in, nobody to sign it, nothing to sign on it, and a form to fill
    IF NOT EXISTS (SELECT 1 FROM public.sign_signers s WHERE s.document_id = p_document) THEN
      RAISE EXCEPTION 'document_has_no_signer' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.sign_signers s WHERE s.document_id = p_document AND s.kind = 'signer') THEN
      RAISE EXCEPTION 'form_mode_has_signer' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(d.fields_snapshot, '[]'::jsonb)) f
          WHERE f ->> 'type' IN ('signature', 'initials', 'date_signed')) THEN
      RAISE EXCEPTION 'form_mode_has_signature' USING ERRCODE = '23514';
    END IF;
    IF jsonb_array_length(COALESCE(d.form_snapshot -> 'parts', '[]'::jsonb)) = 0 THEN
      RAISE EXCEPTION 'form_mode_needs_a_form' USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.sign_signers s WHERE s.document_id = p_document AND s.kind = 'signer') THEN
    RAISE EXCEPTION 'document_has_no_signer' USING ERRCODE = '23514';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'expiry_in_the_past' USING ERRCODE = '23514';
  END IF;

  UPDATE public.sign_documents
     SET base_path = p_base_path, base_sha256 = p_base_sha256, page_count = p_page_count,
         expires_at = p_expires_at, status = 'sent'
   WHERE id = p_document;

  PERFORM public.sign_log(p_document, 'sent', 'user', NULL, p_actor,
    jsonb_build_object('base_sha256', p_base_sha256, 'ordered', d.sign_in_order,
                       'signers', (SELECT count(*) FROM public.sign_signers s WHERE s.document_id = p_document))
    || CASE WHEN d.mode = 'form' THEN jsonb_build_object('mode', 'form') ELSE '{}'::jsonb END);

  IF d.sign_in_order THEN
    SELECT min(s.order_no) INTO v_step FROM public.sign_signers s WHERE s.document_id = p_document;
  END IF;
  v_in := public.sign_invite_step(p_document, v_step, d.sign_in_order, p_actor);
  RETURN jsonb_build_object('reference', d.reference, 'account_id', d.account_id, 'step', v_step, 'invited', v_in);
END;
$$;
ALTER FUNCTION public.sign_send_document(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_send_document(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_send_document(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID) TO service_role;

-- ------------------------------------------------------------
-- 5. Agreeing to the electronic record: the event says "submit" for a form (158's function, with `mode` in the detail)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_record_consent(p_signer UUID, p_version TEXT, p_locale TEXT, p_ip TEXT, p_device TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.sign_signers%ROWTYPE;
  d public.sign_documents%ROWTYPE;
BEGIN
  SELECT document_id INTO STRICT d.id FROM public.sign_signers WHERE id = p_signer;
  SELECT * INTO d FROM public.sign_documents WHERE id = d.id FOR UPDATE;
  SELECT * INTO s FROM public.sign_signers WHERE id = p_signer;
  IF d.status NOT IN ('sent', 'in_progress') OR s.status NOT IN ('sent', 'viewed') THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  IF s.consented_at IS NOT NULL THEN
    RETURN FALSE; -- already recorded; the first agreement is the one that counts
  END IF;
  UPDATE public.sign_signers
     SET consented_at = now(), consent_version = p_version, locale = COALESCE(p_locale, locale),
         ip = COALESCE(p_ip, ip), device = COALESCE(p_device, device)
   WHERE id = p_signer;
  PERFORM public.sign_log(d.id, 'consented', 'signer', p_signer, NULL,
                          jsonb_build_object('version', p_version) || CASE WHEN d.mode = 'form' THEN jsonb_build_object('mode', 'form') ELSE '{}'::jsonb END,
                          p_ip, p_device);
  RETURN TRUE;
END;
$$;
ALTER FUNCTION public.sign_record_consent(UUID, TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_record_consent(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_record_consent(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 6. A person finishes (166's function). In a form document everyone "submits"; when the last has, sealing starts and
--    the history says everyone had submitted (not signed).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_complete_signer(
  p_signer  UUID,
  p_ip      TEXT,
  p_device  TEXT,
  p_locale  TEXT,
  p_consent TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s         public.sign_signers%ROWTYPE;
  d         public.sign_documents%ROWTYPE;
  v_next    INTEGER;
  v_in      JSONB := '[]'::jsonb;
  v_people  INTEGER;
  v_name    TEXT;
  v_because JSONB;
BEGIN
  SELECT document_id INTO STRICT d.id FROM public.sign_signers WHERE id = p_signer;
  -- The document row is the lock: signers finishing together take turns here.
  SELECT * INTO d FROM public.sign_documents WHERE id = d.id FOR UPDATE;
  SELECT * INTO s FROM public.sign_signers WHERE id = p_signer;

  IF d.status NOT IN ('sent', 'in_progress') THEN
    RAISE EXCEPTION 'document_not_open' USING ERRCODE = '23514';
  END IF;
  IF s.status = 'signed' THEN
    RAISE EXCEPTION 'already_signed' USING ERRCODE = '23514';
  END IF;
  IF s.status NOT IN ('sent', 'viewed') THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  IF s.consented_at IS NULL THEN
    RAISE EXCEPTION 'consent_required' USING ERRCODE = '23514';
  END IF;
  -- a part handed to someone else must come back (or be taken back) before the signer finishes
  IF EXISTS (SELECT 1 FROM public.sign_signers x WHERE x.delegated_by = p_signer AND x.status NOT IN ('signed', 'declined')) THEN
    RAISE EXCEPTION 'delegation_open' USING ERRCODE = '23514';
  END IF;

  -- (a person's status is 'signed' once they have finished, whatever they were asked to do: a form-only person
  -- "submitted", and the history and every screen word it so)
  UPDATE public.sign_signers
     SET status = 'signed', signed_at = now(), ip = COALESCE(p_ip, ip), device = COALESCE(p_device, device),
         locale = COALESCE(p_locale, locale), consent_version = COALESCE(p_consent, consent_version)
   WHERE id = p_signer;
  IF d.status = 'sent' THEN
    UPDATE public.sign_documents SET status = 'in_progress' WHERE id = d.id;
  END IF;
  PERFORM public.sign_log(d.id, CASE WHEN s.kind = 'filler' OR d.mode = 'form' THEN 'submitted' ELSE 'signed' END, 'signer', p_signer, NULL,
                          jsonb_build_object('role', s.role_key, 'consent', p_consent), p_ip, p_device);

  -- Everyone done: sealing starts.
  IF NOT EXISTS (SELECT 1 FROM public.sign_signers x WHERE x.document_id = d.id AND x.status <> 'signed') THEN
    UPDATE public.sign_documents SET status = 'sealing', sealing_started_at = NULL, sealing_attempts = 0, seal_error = NULL WHERE id = d.id;
    PERFORM public.sign_log(d.id, CASE WHEN d.mode = 'form' THEN 'all_submitted' ELSE 'all_signed' END, 'system');
    RETURN jsonb_build_object('sealing', true, 'invited', v_in, 'account_id', d.account_id, 'reference', d.reference);
  END IF;

  -- With signing order, the next step is invited once every signer of this step is done (a delegate is part of
  -- its signer's step, not a person of their own).
  IF d.sign_in_order
     AND NOT EXISTS (SELECT 1 FROM public.sign_signers x WHERE x.document_id = d.id AND x.order_no = s.order_no AND x.status <> 'signed') THEN
    SELECT min(x.order_no) INTO v_next FROM public.sign_signers x WHERE x.document_id = d.id AND x.order_no > s.order_no;
    IF v_next IS NOT NULL THEN
      SELECT count(*) INTO v_people FROM public.sign_signers x
       WHERE x.document_id = d.id AND x.order_no = s.order_no AND x.part_keys IS NULL;
      IF v_people > 1 THEN
        v_because := jsonb_build_object('because', 'step_finished', 'previous_step', s.order_no);
      ELSE
        SELECT x.full_name INTO v_name FROM public.sign_signers x
         WHERE x.document_id = d.id AND x.order_no = s.order_no AND x.part_keys IS NULL
         ORDER BY x.created_at LIMIT 1;
        v_because := jsonb_build_object('because', 'signer_finished', 'previous_step', s.order_no, 'finished_name', COALESCE(v_name, s.full_name));
      END IF;
      v_in := public.sign_invite_step(d.id, v_next, TRUE, NULL, v_because);
    END IF;
  END IF;
  RETURN jsonb_build_object('sealing', false, 'invited', v_in, 'account_id', d.account_id, 'reference', d.reference);
END;
$$;
ALTER FUNCTION public.sign_complete_signer(UUID, TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_complete_signer(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_complete_signer(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 7. The sender is told inside Halo (159's function): a form is "submitted", an agreement "signed by everyone".
--    The notification type is the same (`sign_completed`), so the list and its icon need nothing new.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_sign_document_finished()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type  TEXT;
  v_title TEXT;
  v_ref   TEXT;
BEGIN
  IF NEW.created_by IS NULL OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  v_type := CASE NEW.status
    WHEN 'completed' THEN 'sign_completed'
    WHEN 'declined'  THEN 'sign_declined'
    WHEN 'expired'   THEN 'sign_expired'
    ELSE NULL
  END;
  IF v_type IS NULL THEN
    RETURN NEW;
  END IF;
  -- still a member of the workspace?
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = NEW.created_by AND account_id = NEW.account_id) THEN
    RETURN NEW;
  END IF;
  v_ref := COALESCE(NEW.reference, NEW.title);
  v_title := CASE v_type
    WHEN 'sign_completed' THEN CASE WHEN NEW.mode = 'form' THEN 'Submitted: ' ELSE 'Signed by everyone: ' END || v_ref
    WHEN 'sign_declined'  THEN 'Declined: ' || v_ref
    ELSE 'Expired: ' || v_ref
  END;
  INSERT INTO public.notifications (account_id, user_id, type, title, body, sign_document_id)
  VALUES (NEW.account_id, NEW.created_by, v_type, left(v_title, 200), left(NEW.title, 200), NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- a notification must never undo or block the document's own state change
  RAISE WARNING 'Could not create the Doc Sign notification for document %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.notify_sign_document_finished() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_sign_document_finished() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 8. A registration form (164): its template must be of the form's own mode (a form that sends a form-only document uses a
--    form-only template). 164's guard, with that one more rule.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_registration_forms_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e RECORD;
  v_template_mode TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'sign_registration_form_account_is_fixed' USING ERRCODE = '23514';
  END IF;

  IF NEW.template_id IS NOT NULL THEN
    SELECT t.mode INTO v_template_mode FROM public.sign_templates t WHERE t.id = NEW.template_id AND t.account_id = NEW.account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'sign_registration_template_not_in_workspace' USING ERRCODE = '23514';
    END IF;
    IF NEW.send_document AND v_template_mode IS DISTINCT FROM NEW.mode THEN
      RAISE EXCEPTION 'sign_registration_template_mode_mismatch' USING ERRCODE = '23514';
    END IF;
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

NOTIFY pgrst, 'reload schema';
