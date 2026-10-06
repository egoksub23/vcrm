-- ============================================================
-- 160_sign_forms.sql
--
-- Doc Sign, phase 1B (forms in parts): a template version can carry a form definition (ordered parts, each
-- a list of data fields, each part assigned to a role), and a document keeps its own frozen copy, exactly as
-- it keeps its own copy of the fields and roles.
--
--   sign_template_versions.form   the form definition (JSON, NULL for a template that is only fields on the page)
--   sign_documents.form_snapshot  the same, copied when the draft is made and frozen once the document is sent
--   sign_documents_guard()        recreated with form_snapshot among the columns that cannot change after sending
--
-- The answers to a form are ordinary sign_answers rows (the field key is the data field's key), the files
-- a signer uploads are sign_document_files rows of kind 'signer_upload', and the new audit events (part
-- completed, part reopened, uploaded, written back) are ordinary sign_events: no other table changes.
--
-- Idempotent.
-- ============================================================

ALTER TABLE public.sign_template_versions
  ADD COLUMN IF NOT EXISTS form JSONB;
ALTER TABLE public.sign_documents
  ADD COLUMN IF NOT EXISTS form_snapshot JSONB;

-- A form is a JSON object, never an array or a scalar; the app validates its contents.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_template_versions_form_object') THEN
    ALTER TABLE public.sign_template_versions
      ADD CONSTRAINT sign_template_versions_form_object CHECK (form IS NULL OR (jsonb_typeof(form) = 'object' AND pg_column_size(form) <= 400000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_documents_form_object') THEN
    ALTER TABLE public.sign_documents
      ADD CONSTRAINT sign_documents_form_object CHECK (form_snapshot IS NULL OR (jsonb_typeof(form_snapshot) = 'object' AND pg_column_size(form_snapshot) <= 400000));
  END IF;
END $$;

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

NOTIFY pgrst, 'reload schema';
