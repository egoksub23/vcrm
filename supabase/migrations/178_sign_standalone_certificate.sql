-- ============================================================
-- 178_sign_standalone_certificate.sql
--
-- Secure Sign: the certificate of completion is a file of its own (the way DocuSign does it).
--
-- Until now every sealed PDF carried its certificate pages inside it. From the code that goes with this migration, a document that is sealed
-- from now on is sealed WITHOUT certificate pages, and its certificate is a second PDF, sealed with the same digital signature, stored beside
-- it. The certificate names the signed file it covers by that file's SHA-256, so the two can be checked against each other. A workspace can switch
-- on "Also embed the certificate inside the signed PDF" (default OFF), and then a new document has both.
--
-- What this adds:
--
--   sign_documents.certificate_path    where the standalone certificate is stored (the sign-documents bucket, the document's own folder)
--   sign_documents.certificate_sha256  its SHA-256 (64 lower-case hex characters)
--                                      Both are NULL for every document sealed before this migration: a NULL certificate_path means "the certificate
--                                      is embedded in the signed PDF" (the file is never touched, since changing a sealed file would break its seal),
--                                      and everything that reads these columns treats it so. The two are set together or not at all (a CHECK).
--   sign_settings.embed_certificate    the workspace's choice above (default FALSE)
--
--   sign_documents_guard()             169's function with three more rules, so nothing can set or change the certificate by any other road than
--                                      the sealing function:
--                                        * a document is never INSERTed with one;
--                                        * it is set only by the update that completes a document that was sealing (the same update that sets
--                                          the signed file), and a document that is already completed (sealed before this migration) can never
--                                          gain one;
--                                        * once set it is write-once (path and fingerprint), like final_path and final_sha256.
--
--   sign_finish_sealing()              158's function, taking the certificate with the signed file (two more arguments with default NULL, so a
--                                      call that names only the first three, which is what the code before this migration sends, keeps working
--                                      and produces a document with an embedded certificate). The path and the fingerprint are given together
--                                      or not at all; the document completes with both in ONE statement, so a document is never completed with a
--                                      certificate that was not recorded. The 'sealed' event carries the certificate's fingerprint.
--                                      158's three-argument function is dropped (two overloads would make a call that names three arguments
--                                      ambiguous) and the new one is granted to the service role only, as it was.
--
-- sign_verify_chain() is NOT changed: it recomputes the audit trail, which is the same for both layouts (the 'sealed' event just carries one more
-- detail), and it answers nothing about files.
--
-- The retention trigger of 165 (sign_document_files_retention) already protects file rows of kind 'certificate' like the signed file, and the
-- documents' own folder is what deletion and the workspace teardown remove, so the standalone certificate is kept and removed with its document.
--
-- Apply this migration BEFORE the code that goes with it is deployed (code that is already running keeps sealing, with embedded certificates).
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The columns
-- ------------------------------------------------------------
ALTER TABLE public.sign_documents ADD COLUMN IF NOT EXISTS certificate_path TEXT;
ALTER TABLE public.sign_documents ADD COLUMN IF NOT EXISTS certificate_sha256 TEXT
  CHECK (certificate_sha256 IS NULL OR certificate_sha256 ~ '^[0-9a-f]{64}$');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'sign_documents_certificate_pair' AND conrelid = 'public.sign_documents'::regclass
  ) THEN
    ALTER TABLE public.sign_documents
      ADD CONSTRAINT sign_documents_certificate_pair CHECK ((certificate_path IS NULL) = (certificate_sha256 IS NULL));
  END IF;
END $$;

ALTER TABLE public.sign_settings ADD COLUMN IF NOT EXISTS embed_certificate BOOLEAN NOT NULL DEFAULT FALSE;

-- ------------------------------------------------------------
-- 2. Documents: 169's guard, with the certificate rules
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
    -- a standalone certificate belongs to a sealed document: nothing starts with one
    IF NEW.certificate_path IS NOT NULL OR NEW.certificate_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'sign_document_certificate_is_set_at_completion' USING ERRCODE = '23514';
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

  -- The standalone certificate is written once, with the sealed file, and by nothing else: it can be set only by the update that completes a
  -- document that was sealing (a document sealed before 178 has its certificate inside the signed file and can never gain a second one).
  IF OLD.certificate_path IS NOT NULL AND (
       NEW.certificate_path   IS DISTINCT FROM OLD.certificate_path
    OR NEW.certificate_sha256 IS DISTINCT FROM OLD.certificate_sha256
  ) THEN
    RAISE EXCEPTION 'sign_document_certificate_is_write_once' USING ERRCODE = '23514';
  END IF;
  IF OLD.certificate_path IS NULL AND (NEW.certificate_path IS NOT NULL OR NEW.certificate_sha256 IS NOT NULL)
     AND NOT (OLD.status = 'sealing' AND NEW.status = 'completed') THEN
    RAISE EXCEPTION 'sign_document_certificate_is_set_at_completion' USING ERRCODE = '23514',
      DETAIL = 'The certificate file is recorded together with the signed file, when the document is completed.';
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
-- 3. Completing a sealed document: the signed file and, with it, the certificate
-- ------------------------------------------------------------
-- 158's function had three arguments. The new one has five (the last two default to NULL), so the old signature is dropped first: with both
-- present a call naming three arguments would match two functions and fail.
DROP FUNCTION IF EXISTS public.sign_finish_sealing(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.sign_finish_sealing(
  p_document           UUID,
  p_final_path         TEXT,
  p_final_sha256       TEXT,
  p_certificate_path   TEXT DEFAULT NULL,
  p_certificate_sha256 TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.sign_documents%ROWTYPE;
BEGIN
  -- the certificate's path and its fingerprint come together (the check on the table says the same; this says it before anything is read)
  IF (p_certificate_path IS NULL) <> (p_certificate_sha256 IS NULL) THEN
    RAISE EXCEPTION 'sign_certificate_needs_path_and_fingerprint' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO d FROM public.sign_documents WHERE id = p_document FOR UPDATE;
  IF NOT FOUND OR d.status <> 'sealing' THEN
    RAISE EXCEPTION 'document_not_sealing' USING ERRCODE = '23514';
  END IF;
  UPDATE public.sign_documents
     SET status = 'completed', final_path = p_final_path, final_sha256 = p_final_sha256,
         certificate_path = p_certificate_path, certificate_sha256 = p_certificate_sha256,
         seal_error = NULL,
         retain_until = COALESCE(retain_until,
           now() + make_interval(years => COALESCE(
             (SELECT c.retention_years FROM public.sign_categories c WHERE c.id = d.category_id AND c.account_id = d.account_id),
             (SELECT st.retention_years FROM public.sign_settings st WHERE st.account_id = d.account_id),
             7)))
   WHERE id = p_document;
  PERFORM public.sign_log(p_document, 'sealed', 'system', NULL, NULL,
    jsonb_build_object('final_sha256', p_final_sha256)
    || CASE WHEN p_certificate_sha256 IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('certificate_sha256', p_certificate_sha256) END);
  PERFORM public.sign_log(p_document, 'completed', 'system');
  RETURN jsonb_build_object('account_id', d.account_id, 'reference', d.reference);
END;
$$;
ALTER FUNCTION public.sign_finish_sealing(UUID, TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_finish_sealing(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_finish_sealing(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
