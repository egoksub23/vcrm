-- ============================================================
-- 181_sign_cancel_completed.sql
--
-- Secure Sign: the person who made a completed document, or an admin, can CANCEL it (the owner's request: "in the listing page, if a document is
-- completed, the creator and admin can cancel it, and it can then be searched as a cancelled document").
--
-- A completed document is a sealed legal record, so cancelling NEVER touches it. The signed file, the certificate, the answers, the signers and the
-- hash-chained event log stay exactly as they were, `status` stays 'completed' (the sealing, the retention clock, the export, the verify page and the
-- frozen-content rule of sign_documents_guard all assume it), and the monthly usage count and the webhooks already sent are unchanged. The cancellation
-- is a separate stamp beside the record:
--
--   sign_documents.cancelled_at       when it was cancelled
--   sign_documents.cancelled_by       who (nullable: it becomes NULL if that login is deleted, like every actor column; the 'cancelled' event keeps the id)
--   sign_documents.cancel_reason      why, typed by the person (3 to 500 characters, trimmed)
--   sign_documents.cancel_notified_at the cancel notice (an email to the people, only when the canceller asked for it) was claimed: set once, so a retry
--                                     never sends it twice (the way end_notified_at works for an expired collection)
--   the same four on sign_envelopes   a document collection is cancelled as ONE unit: the collection and every document in it get the same stamp
--                                     (same instant, same person, same reason) in one transaction
--
-- THE RULES, held in the database:
--   * the first three move together (a CHECK): all set or all empty (the actor alone may later become NULL when the login is deleted);
--   * they can be set only on a document / collection that is COMPLETED (a CHECK, and the guard says it in words), exactly once, and only by the
--     functions below (a transaction-local flag, vircle.sign_cancel, which only they set);
--   * once set they never change and are never cleared. The one exception is the actor: when the person's login is deleted the foreign key sets
--     cancelled_by to NULL, and the guard lets exactly that through (the 'cancelled' event still carries the id);
--   * nothing is ever inserted with them;
--   * every other rule of the document guard (reference, mode, status moves, frozen content, signed file, certificate) is unchanged.
--
-- Who may cancel (the person who made it, or an admin or owner, who must also be able to see the document: private documents of 176) is decided in
-- the service layer, the way sign.void and the private rule are: the functions below are the service role's alone. The database holds what no caller
-- can talk its way round.
--
--   sign_documents_guard()        178's function with the rules above
--   sign_envelopes_guard()        176's function with the rules above
--   sign_cancel_one               (internal) stamps one document and appends its hash-chained 'cancelled' event
--   sign_cancel_document          cancels a document on its own (a document of a collection is refused: cancel the collection)
--   sign_cancel_envelope          cancels a collection: the collection and ALL its documents, together
--   sign_cancel_claim_notice      the once-only claim on the cancel notice; the caller that gets TRUE sends it
--
-- sign_verify_chain() is NOT changed: the 'cancelled' event is an ordinary row of the chain (appended by sign_log, under the per-document lock), so it
-- still recomputes. The new functions are for the service role only (not in the verify-guard-catalog allowlists) and pin their search_path.
--
-- Apply this migration BEFORE the code that goes with it is deployed. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The columns and their checks
-- ------------------------------------------------------------
ALTER TABLE public.sign_documents
  ADD COLUMN IF NOT EXISTS cancelled_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason      TEXT,
  ADD COLUMN IF NOT EXISTS cancel_notified_at TIMESTAMPTZ;

ALTER TABLE public.sign_envelopes
  ADD COLUMN IF NOT EXISTS cancelled_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason      TEXT,
  ADD COLUMN IF NOT EXISTS cancel_notified_at TIMESTAMPTZ;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sign_documents', 'sign_envelopes']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_cancel_together' AND conrelid = ('public.' || t)::regclass) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL) AND (cancelled_by IS NULL OR cancelled_at IS NOT NULL))',
                     t, t || '_cancel_together');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_cancel_reason_valid' AND conrelid = ('public.' || t)::regclass) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (cancel_reason IS NULL OR (cancel_reason = btrim(cancel_reason) AND char_length(cancel_reason) BETWEEN 3 AND 500))',
                     t, t || '_cancel_reason_valid');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_cancel_needs_completed' AND conrelid = ('public.' || t)::regclass) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (cancelled_at IS NULL OR status = %L)', t, t || '_cancel_needs_completed', 'completed');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_cancel_notice' AND conrelid = ('public.' || t)::regclass) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (cancel_notified_at IS NULL OR cancelled_at IS NOT NULL)', t, t || '_cancel_notice');
    END IF;
  END LOOP;
END $$;

-- "Show me the cancelled documents" and "Completed, not cancelled": cancelled ones are few, so a small partial index.
CREATE INDEX IF NOT EXISTS sign_documents_cancelled_idx ON public.sign_documents (account_id, cancelled_at DESC) WHERE cancelled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sign_envelopes_cancelled_idx ON public.sign_envelopes (account_id, cancelled_at DESC) WHERE cancelled_at IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Documents: 178's guard, with the cancel rules
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
    -- nor does anything start cancelled
    IF NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL OR NEW.cancel_reason IS NOT NULL OR NEW.cancel_notified_at IS NOT NULL THEN
      RAISE EXCEPTION 'sign_document_cancel_is_set_by_cancelling' USING ERRCODE = '23514';
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

  -- The cancellation (181) is written once, on a completed document, by the cancelling functions and by nothing else. It is never changed or cleared;
  -- the one thing that may happen to it is that the actor becomes NULL when that person's login is deleted (the foreign key does it).
  IF OLD.cancelled_at IS NOT NULL THEN
    IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
       OR (NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by AND NEW.cancelled_by IS NOT NULL) THEN
      RAISE EXCEPTION 'sign_document_cancel_is_write_once' USING ERRCODE = '23514',
        DETAIL = 'A document that was cancelled stays cancelled: the date, the reason and the person cannot be changed or cleared.';
    END IF;
  ELSIF NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN
    IF NOT (OLD.status = 'completed' AND NEW.status = 'completed') THEN
      RAISE EXCEPTION 'sign_document_cancel_needs_completed' USING ERRCODE = '23514',
        DETAIL = 'Only a completed document can be cancelled.';
    END IF;
    IF current_setting('vircle.sign_cancel', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'sign_document_cancel_is_set_by_cancelling' USING ERRCODE = '23514',
        DETAIL = 'A document is cancelled by the cancelling function, which records it in the history too.';
    END IF;
  END IF;
  -- the notice claim: set once, and only for a document that is cancelled
  IF NEW.cancel_notified_at IS DISTINCT FROM OLD.cancel_notified_at THEN
    IF OLD.cancel_notified_at IS NOT NULL THEN
      RAISE EXCEPTION 'sign_document_cancel_notice_is_write_once' USING ERRCODE = '23514';
    END IF;
    IF OLD.cancelled_at IS NULL THEN
      RAISE EXCEPTION 'sign_document_cancel_notice_needs_cancelled' USING ERRCODE = '23514';
    END IF;
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
-- 3. Collections: 176's guard, with the same cancel rules
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_envelopes_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'sign_envelope_must_start_as_draft' USING ERRCODE = '23514';
    END IF;
    IF NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL OR NEW.cancel_reason IS NOT NULL OR NEW.cancel_notified_at IS NOT NULL THEN
      RAISE EXCEPTION 'sign_envelope_cancel_is_set_by_cancelling' USING ERRCODE = '23514';
    END IF;
    IF NEW.reference IS NULL OR NEW.reference = '' THEN
      UPDATE public.accounts SET sign_envelope_seq = sign_envelope_seq + 1 WHERE id = NEW.account_id
        RETURNING sign_envelope_seq INTO v_seq;
      IF v_seq IS NULL THEN
        RAISE EXCEPTION 'Account % not found', NEW.account_id USING ERRCODE = '22023';
      END IF;
      NEW.reference := 'COL-' || to_char(now() AT TIME ZONE 'utc', 'YYYY') || '-' || lpad(v_seq::text, 6, '0');
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.reference IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION 'sign_envelope_reference_is_fixed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.title         IS DISTINCT FROM OLD.title
    OR NEW.message       IS DISTINCT FROM OLD.message
    OR NEW.locale        IS DISTINCT FROM OLD.locale
    OR NEW.sign_in_order IS DISTINCT FROM OLD.sign_in_order
    OR NEW.code_required IS DISTINCT FROM OLD.code_required
  ) THEN
    RAISE EXCEPTION 'sign_envelope_is_frozen' USING ERRCODE = '23514',
      DETAIL = 'A document collection that was sent cannot be edited. Void it and send a new one.';
  END IF;

  -- The cancellation (181): the same rules as a document's.
  IF OLD.cancelled_at IS NOT NULL THEN
    IF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
       OR (NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by AND NEW.cancelled_by IS NOT NULL) THEN
      RAISE EXCEPTION 'sign_envelope_cancel_is_write_once' USING ERRCODE = '23514',
        DETAIL = 'A collection that was cancelled stays cancelled: the date, the reason and the person cannot be changed or cleared.';
    END IF;
  ELSIF NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN
    IF NOT (OLD.status = 'completed' AND NEW.status = 'completed') THEN
      RAISE EXCEPTION 'sign_envelope_cancel_needs_completed' USING ERRCODE = '23514',
        DETAIL = 'Only a completed collection can be cancelled.';
    END IF;
    IF current_setting('vircle.sign_cancel', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'sign_envelope_cancel_is_set_by_cancelling' USING ERRCODE = '23514',
        DETAIL = 'A collection is cancelled by the cancelling function, which stamps its documents in the same step.';
    END IF;
  END IF;
  IF NEW.cancel_notified_at IS DISTINCT FROM OLD.cancel_notified_at THEN
    IF OLD.cancel_notified_at IS NOT NULL THEN
      RAISE EXCEPTION 'sign_envelope_cancel_notice_is_write_once' USING ERRCODE = '23514';
    END IF;
    IF OLD.cancelled_at IS NULL THEN
      RAISE EXCEPTION 'sign_envelope_cancel_notice_needs_cancelled' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_envelopes_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelopes_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_envelopes_guard ON public.sign_envelopes;
CREATE TRIGGER sign_envelopes_guard
  BEFORE INSERT OR UPDATE ON public.sign_envelopes
  FOR EACH ROW EXECUTE FUNCTION public.sign_envelopes_guard();

-- ------------------------------------------------------------
-- 4. Cancelling
-- ------------------------------------------------------------
-- Stamp ONE completed document and append its 'cancelled' event (the reason is free text typed by the person, kept in the event's detail the way a void or
-- a decline reason is; no name or address goes in). Internal: the two functions below call it, with the document row already locked.
CREATE OR REPLACE FUNCTION public.sign_cancel_one(p_document UUID, p_reason TEXT, p_actor UUID, p_at TIMESTAMPTZ, p_detail JSONB DEFAULT '{}'::jsonb)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('vircle.sign_cancel', 'on', true);
  UPDATE public.sign_documents
     SET cancelled_at = p_at, cancelled_by = p_actor, cancel_reason = p_reason
   WHERE id = p_document;
  PERFORM set_config('vircle.sign_cancel', '', true);
  PERFORM public.sign_log(p_document, 'cancelled', 'user', NULL, p_actor, jsonb_build_object('reason', p_reason) || COALESCE(p_detail, '{}'::jsonb));
END;
$$;
ALTER FUNCTION public.sign_cancel_one(UUID, TEXT, UUID, TIMESTAMPTZ, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_cancel_one(UUID, TEXT, UUID, TIMESTAMPTZ, JSONB) FROM PUBLIC, anon, authenticated, service_role;

-- A document on its own. A document of a collection is refused (it is cancelled with its collection, so the others are never left behind).
CREATE OR REPLACE FUNCTION public.sign_cancel_document(p_document UUID, p_reason TEXT, p_actor UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d        public.sign_documents%ROWTYPE;
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
  v_at     TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO d FROM public.sign_documents WHERE id = p_document FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found' USING ERRCODE = '22023';
  END IF;
  IF d.envelope_id IS NOT NULL THEN
    RAISE EXCEPTION 'document_in_envelope' USING ERRCODE = '23514', DETAIL = 'A document of a collection is cancelled with its collection.';
  END IF;
  IF d.status <> 'completed' THEN
    RAISE EXCEPTION 'document_not_completed' USING ERRCODE = '23514';
  END IF;
  IF d.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'document_already_cancelled' USING ERRCODE = '23514';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'cancel_reason_invalid' USING ERRCODE = '23514', DETAIL = 'The reason is 3 to 500 characters.';
  END IF;
  PERFORM public.sign_cancel_one(p_document, v_reason, p_actor, v_at);
  RETURN jsonb_build_object('account_id', d.account_id, 'reference', d.reference, 'document_id', p_document, 'cancelled_at', v_at);
END;
$$;
ALTER FUNCTION public.sign_cancel_document(UUID, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_cancel_document(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_cancel_document(UUID, TEXT, UUID) TO service_role;

-- A document collection: the collection and EVERY document in it, together, with the same stamp. Takes the collection's lock first and then the
-- documents' in position order (the order every collection-wide step uses), so two steps of one collection take turns.
CREATE OR REPLACE FUNCTION public.sign_cancel_envelope(p_envelope UUID, p_reason TEXT, p_actor UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e        public.sign_envelopes%ROWTYPE;
  d        RECORD;
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
  v_at     TIMESTAMPTZ := now();
  v_n      INTEGER;
  v_docs   JSONB := '[]'::jsonb;
BEGIN
  e := public.sign_envelope_lock(p_envelope);
  IF e.status <> 'completed' THEN
    RAISE EXCEPTION 'envelope_not_completed' USING ERRCODE = '23514';
  END IF;
  IF e.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'envelope_already_cancelled' USING ERRCODE = '23514';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'cancel_reason_invalid' USING ERRCODE = '23514', DETAIL = 'The reason is 3 to 500 characters.';
  END IF;
  PERFORM 1 FROM public.sign_documents x WHERE x.envelope_id = p_envelope ORDER BY x.envelope_position FOR UPDATE;
  SELECT count(*) INTO v_n FROM public.sign_documents x WHERE x.envelope_id = p_envelope;
  IF v_n = 0 OR EXISTS (SELECT 1 FROM public.sign_documents x WHERE x.envelope_id = p_envelope AND (x.status <> 'completed' OR x.cancelled_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'envelope_not_completed' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('vircle.sign_cancel', 'on', true);
  UPDATE public.sign_envelopes SET cancelled_at = v_at, cancelled_by = p_actor, cancel_reason = v_reason WHERE id = p_envelope;
  PERFORM set_config('vircle.sign_cancel', '', true);
  FOR d IN SELECT x.id, x.envelope_position FROM public.sign_documents x WHERE x.envelope_id = p_envelope ORDER BY x.envelope_position LOOP
    PERFORM public.sign_cancel_one(d.id, v_reason, p_actor, v_at,
      jsonb_build_object('envelope_id', p_envelope, 'reference', e.reference, 'position', d.envelope_position, 'count', v_n));
    v_docs := v_docs || to_jsonb(d.id);
  END LOOP;
  RETURN jsonb_build_object('account_id', e.account_id, 'reference', e.reference, 'envelope_id', p_envelope, 'documents', v_docs, 'cancelled_at', v_at);
END;
$$;
ALTER FUNCTION public.sign_cancel_envelope(UUID, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_cancel_envelope(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_cancel_envelope(UUID, TEXT, UUID) TO service_role;

-- The cancel notice (an email to the signers, the people who receive a copy and the sender, when the canceller ticked "Notify everyone"): the caller that
-- gets TRUE is the one that sends it. Exactly one of the two ids; a document or collection that is not cancelled, or whose notice was already claimed, gives FALSE.
CREATE OR REPLACE FUNCTION public.sign_cancel_claim_notice(p_document UUID DEFAULT NULL, p_envelope UUID DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  IF (p_document IS NULL) = (p_envelope IS NULL) THEN
    RAISE EXCEPTION 'cancel_notice_needs_one_target' USING ERRCODE = '22023';
  END IF;
  IF p_document IS NOT NULL THEN
    UPDATE public.sign_documents SET cancel_notified_at = now()
     WHERE id = p_document AND cancelled_at IS NOT NULL AND cancel_notified_at IS NULL;
  ELSE
    UPDATE public.sign_envelopes SET cancel_notified_at = now()
     WHERE id = p_envelope AND cancelled_at IS NOT NULL AND cancel_notified_at IS NULL;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;
ALTER FUNCTION public.sign_cancel_claim_notice(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_cancel_claim_notice(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_cancel_claim_notice(UUID, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
