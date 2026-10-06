-- ============================================================
-- 171_sign_envelopes.sql
--
-- Doc Sign, work package 16 (feature F-18): ENVELOPES, several documents signed in one sitting
-- (docs/sign-envelopes-design.md). An envelope groups 2 to 6 ordinary documents for the same people. Every document stays a
-- normal sign_documents row (its own file, fields, form, answers, seal, certificate, audit chain, retention); the envelope holds
-- what is shared, and each PERSON gets one invitation and one link for the whole envelope.
--
--   sign_envelopes                  title, reference (ENV-2026-000012), contact, message, expiry, code, order, language, times, and a
--                                   status the database derives from its documents (sign_envelope_derive, a trigger)
--   sign_documents.envelope_id      which envelope a document is in, and its position (1 to 6); fixed once set, set only on a draft
--   sign_signers.party_id           the rows that are one person across the documents share it; the person's row on their first
--                                   document is the ANCHOR (party_id = its own id) and the only row with a link token
--   accounts.sign_envelope_seq      the counter behind the envelope reference
--
--   sign_send_core                  (internal) 169's draft -> sent steps for one document, shared by the two senders below
--   sign_send_document              recreated (from 169): the same, and a document of an envelope is refused (send the envelope)
--   sign_send_envelope              every document sent in ONE transaction, then one step invited with one invitation per person
--   sign_invite_step                recreated (from 166): a person's row on a later document gets no token and no message of its own
--   sign_envelope_invite_step       (internal) the same step on every document of an envelope
--   sign_complete_signer            recreated (from 169): an envelope's next step begins when the step is finished on EVERY document
--   sign_envelope_record_consent    the agreement to sign electronically, recorded once for all of a person's documents
--   sign_envelope_mark_viewed       first time a person opens their link
--   sign_envelope_rotate_token      resend or remind: one new link for the person; the old one dies
--   sign_envelope_change_recipient  a different person for someone who has signed nothing yet, on all their documents
--   sign_envelope_decline           a person declines: every document that is not yet fully signed is declined
--   sign_void_envelope              the sender cancels, only while no document is fully signed
--   sign_envelope_settle            the last document completed: the envelope is completed, and the combined message is claimed once
--   sign_envelope_claim_end         an envelope that ended without completing tells its people once
--   sign_void_document / sign_decline_signer
--                                   recreated (from 158): a document of an envelope is refused unless the envelope's own function acts
--   notify_sign_document_finished   recreated (from 169): an envelope tells its sender once
--
-- A document of an envelope may not allow forwarding and may not be a test (a trigger holds both). Everything here is for the
-- service role only, with the grants of 158. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The counter, the table, the columns
-- ------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS sign_envelope_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.sign_envelopes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  reference       TEXT,
  title           TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  -- Derived from the documents by sign_envelope_derive (a trigger on sign_documents keeps it); the words are the documents'.
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                    ('draft', 'sent', 'in_progress', 'sealing', 'completed', 'declined', 'expired', 'voided', 'failed')),
  contact_id      UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  message         TEXT CHECK (message IS NULL OR length(message) <= 2000),
  locale          TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ms', 'zh', 'ko')),
  -- One signing order and one code for every document: the send function refuses an envelope whose documents disagree.
  sign_in_order   BOOLEAN NOT NULL DEFAULT FALSE,
  code_required   BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_days   INTEGER[],
  expires_at      TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  void_reason     TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 1000),
  -- Set once when the people of an envelope that ended without completing were told (expiry): one message each, not one per document.
  end_notified_at TIMESTAMPTZ,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_envelopes_id_account UNIQUE (id, account_id),
  CONSTRAINT sign_envelopes_reference UNIQUE (account_id, reference)
);
CREATE INDEX IF NOT EXISTS sign_envelopes_list_idx ON public.sign_envelopes (account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS sign_envelopes_contact_idx ON public.sign_envelopes (contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE public.sign_documents
  ADD COLUMN IF NOT EXISTS envelope_id       UUID,
  ADD COLUMN IF NOT EXISTS envelope_position INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_documents_envelope_fk') THEN
    ALTER TABLE public.sign_documents
      ADD CONSTRAINT sign_documents_envelope_fk FOREIGN KEY (envelope_id, account_id)
      REFERENCES public.sign_envelopes (id, account_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_documents_envelope_position') THEN
    ALTER TABLE public.sign_documents
      ADD CONSTRAINT sign_documents_envelope_position CHECK (
        (envelope_id IS NULL) = (envelope_position IS NULL) AND (envelope_position IS NULL OR envelope_position BETWEEN 1 AND 6));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS sign_documents_envelope_position_idx ON public.sign_documents (envelope_id, envelope_position)
  WHERE envelope_id IS NOT NULL;

-- A person's rows across the documents of an envelope share this id; the anchor row's own id is the value.
ALTER TABLE public.sign_signers
  ADD COLUMN IF NOT EXISTS party_id UUID;
CREATE INDEX IF NOT EXISTS sign_signers_party_idx ON public.sign_signers (party_id) WHERE party_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Row level security: members with menu.sign read; the server writes
-- ------------------------------------------------------------
ALTER TABLE public.sign_envelopes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sign_envelopes_select ON public.sign_envelopes;
CREATE POLICY sign_envelopes_select ON public.sign_envelopes
  FOR SELECT USING (has_capability(account_id, 'menu.sign'));

REVOKE ALL ON public.sign_envelopes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sign_envelopes TO authenticated;
GRANT ALL ON public.sign_envelopes TO service_role;

DROP TRIGGER IF EXISTS set_updated_at ON public.sign_envelopes;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.sign_envelopes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS audit_row_change ON public.sign_envelopes;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_envelopes
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'sign_envelope', 'title', 'title,status', 'message', '', 'created_by');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sign_envelopes') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.sign_envelopes;
    END IF;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Integrity
-- ------------------------------------------------------------
-- The reference is numbered here; it and what the people were shown never change once the envelope is sent.
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
    IF NEW.reference IS NULL OR NEW.reference = '' THEN
      UPDATE public.accounts SET sign_envelope_seq = sign_envelope_seq + 1 WHERE id = NEW.account_id
        RETURNING sign_envelope_seq INTO v_seq;
      IF v_seq IS NULL THEN
        RAISE EXCEPTION 'Account % not found', NEW.account_id USING ERRCODE = '22023';
      END IF;
      NEW.reference := 'ENV-' || to_char(now() AT TIME ZONE 'utc', 'YYYY') || '-' || lpad(v_seq::text, 6, '0');
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
      DETAIL = 'An envelope that was sent cannot be edited. Void it and send a new one.';
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

-- A document joins an envelope only as a draft, only an envelope that is still a draft, and never leaves it. In an envelope a
-- document does not allow forwarding (a turn handed over would split one person's rows) and is not a test.
CREATE OR REPLACE FUNCTION public.sign_documents_envelope_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.sign_envelopes%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.envelope_id IS NOT NULL THEN
      IF NEW.envelope_id IS DISTINCT FROM OLD.envelope_id OR NEW.envelope_position IS DISTINCT FROM OLD.envelope_position THEN
        RAISE EXCEPTION 'sign_document_envelope_is_fixed' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.envelope_id IS NOT NULL AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'sign_document_envelope_is_fixed' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.envelope_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR OLD.envelope_id IS NULL THEN
    SELECT * INTO e FROM public.sign_envelopes WHERE id = NEW.envelope_id AND account_id = NEW.account_id;
    IF NOT FOUND OR e.status <> 'draft' THEN
      RAISE EXCEPTION 'sign_envelope_not_open_for_documents' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.allow_forwarding THEN
    RAISE EXCEPTION 'sign_envelope_no_forwarding' USING ERRCODE = '23514';
  END IF;
  IF NEW.test THEN
    RAISE EXCEPTION 'sign_envelope_no_test' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_documents_envelope_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_documents_envelope_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_documents_envelope_guard ON public.sign_documents;
CREATE TRIGGER sign_documents_envelope_guard
  BEFORE INSERT OR UPDATE OF envelope_id, envelope_position, allow_forwarding, test ON public.sign_documents
  FOR EACH ROW EXECUTE FUNCTION public.sign_documents_envelope_guard();

-- A person's rows of an envelope exist only on documents of an envelope.
CREATE OR REPLACE FUNCTION public.sign_signers_party_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.party_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.sign_documents d WHERE d.id = NEW.document_id AND d.account_id = NEW.account_id AND d.envelope_id IS NOT NULL) THEN
    RAISE EXCEPTION 'sign_signer_party_needs_an_envelope' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_signers_party_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_signers_party_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_signers_party_guard ON public.sign_signers;
CREATE TRIGGER sign_signers_party_guard
  BEFORE INSERT OR UPDATE OF party_id ON public.sign_signers
  FOR EACH ROW
  WHEN (NEW.party_id IS NOT NULL)
  EXECUTE FUNCTION public.sign_signers_party_guard();

-- ------------------------------------------------------------
-- 4. The envelope's status, derived from its documents
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_envelope_derive(p_envelope UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN count(*) = 0                                          THEN 'draft'
    WHEN bool_or(d.status = 'draft')                           THEN 'draft'
    WHEN bool_and(d.status = 'voided')                         THEN 'voided'
    WHEN bool_and(d.status = 'completed')                      THEN 'completed'
    WHEN bool_or(d.status = 'declined')                        THEN 'declined'
    WHEN bool_or(d.status = 'expired')                         THEN 'expired'
    WHEN bool_or(d.status = 'voided')                          THEN 'voided'
    WHEN bool_or(d.status = 'failed')                          THEN 'failed'
    WHEN bool_and(d.status IN ('sealing', 'completed'))        THEN 'sealing'
    WHEN bool_or(d.status IN ('in_progress', 'sealing', 'completed')) THEN 'in_progress'
    ELSE 'sent'
  END
  FROM public.sign_documents d WHERE d.envelope_id = p_envelope;
$$;
REVOKE ALL ON FUNCTION public.sign_envelope_derive(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sign_documents_envelope_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  v_status := public.sign_envelope_derive(NEW.envelope_id);
  UPDATE public.sign_envelopes SET status = v_status
   WHERE id = NEW.envelope_id AND account_id = NEW.account_id AND status IS DISTINCT FROM v_status;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_documents_envelope_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_documents_envelope_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_documents_envelope_status ON public.sign_documents;
CREATE TRIGGER sign_documents_envelope_status
  AFTER UPDATE OF status ON public.sign_documents
  FOR EACH ROW
  WHEN (NEW.envelope_id IS NOT NULL AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.sign_documents_envelope_status();

-- The lock every envelope-wide step takes FIRST (then the document rows, in position order), so two steps of one envelope take turns
-- and cannot deadlock on each other.
CREATE OR REPLACE FUNCTION public.sign_envelope_lock(p_envelope UUID)
RETURNS public.sign_envelopes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.sign_envelopes%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.sign_envelopes WHERE id = p_envelope FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'envelope_not_found' USING ERRCODE = '22023';
  END IF;
  RETURN e;
END;
$$;
ALTER FUNCTION public.sign_envelope_lock(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelope_lock(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Inviting: a person's row on a later document has no link and no message of its own
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_invite_step(
  p_document UUID, p_step INTEGER, p_ordered BOOLEAN, p_user UUID, p_because JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account  UUID;
  v_envelope UUID;
  v_out      JSONB := '[]'::jsonb;
  r          RECORD;
  v_token    TEXT;
  v_n        INTEGER;
BEGIN
  SELECT account_id, envelope_id INTO v_account, v_envelope FROM public.sign_documents WHERE id = p_document;
  INSERT INTO public.sign_step_invites (document_id, account_id, step) VALUES (p_document, v_account, p_step)
  ON CONFLICT (document_id, step) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN v_out; -- this step was already invited (two signers finished at the same moment)
  END IF;
  FOR r IN
    SELECT s.id, s.party_id FROM public.sign_signers s
     WHERE s.document_id = p_document AND s.status = 'pending' AND s.part_keys IS NULL
       AND (NOT p_ordered OR s.order_no = p_step)
     ORDER BY s.order_no, s.created_at
  LOOP
    IF r.party_id IS NOT NULL AND r.party_id <> r.id THEN
      -- one person, one link: this row is served by the link of the person's first document (the anchor)
      UPDATE public.sign_signers SET status = 'sent', invited_at = now() WHERE id = r.id;
      PERFORM public.sign_log(p_document, 'invited', CASE WHEN p_user IS NULL THEN 'system' ELSE 'user' END, r.id, p_user,
                              jsonb_build_object('step', p_step) || COALESCE(p_because, '{}'::jsonb));
      CONTINUE;
    END IF;
    v_token := public.sign_issue_token(r.id);
    UPDATE public.sign_signers SET status = 'sent', invited_at = now() WHERE id = r.id;
    PERFORM public.sign_log(p_document, 'invited', CASE WHEN p_user IS NULL THEN 'system' ELSE 'user' END, r.id, p_user,
                            jsonb_build_object('step', p_step) || COALESCE(p_because, '{}'::jsonb));
    v_out := v_out || (public.sign_signer_brief(r.id, v_token)
                       || CASE WHEN r.party_id IS NOT NULL THEN jsonb_build_object('envelope_id', v_envelope) ELSE '{}'::jsonb END);
  END LOOP;
  RETURN v_out;
END;
$$;
ALTER FUNCTION public.sign_invite_step(UUID, INTEGER, BOOLEAN, UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_invite_step(UUID, INTEGER, BOOLEAN, UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;

-- The same step on every open document of an envelope, in position order: one invitation per person comes back.
CREATE OR REPLACE FUNCTION public.sign_envelope_invite_step(p_envelope UUID, p_step INTEGER, p_user UUID, p_because JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d     RECORD;
  v_out JSONB := '[]'::jsonb;
BEGIN
  FOR d IN
    SELECT x.id, x.sign_in_order FROM public.sign_documents x
     WHERE x.envelope_id = p_envelope AND x.status IN ('sent', 'in_progress')
     ORDER BY x.envelope_position
  LOOP
    v_out := v_out || public.sign_invite_step(d.id, p_step, d.sign_in_order, p_user, p_because);
  END LOOP;
  RETURN v_out;
END;
$$;
ALTER FUNCTION public.sign_envelope_invite_step(UUID, INTEGER, UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelope_invite_step(UUID, INTEGER, UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 6. draft -> sent: 169's steps for one document, shared
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_send_core(
  p_document    UUID,
  p_base_path   TEXT,
  p_base_sha256 TEXT,
  p_page_count  INTEGER,
  p_expires_at  TIMESTAMPTZ,
  p_actor       UUID,
  p_extra       JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.sign_documents%ROWTYPE;
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
    || CASE WHEN d.mode = 'form' THEN jsonb_build_object('mode', 'form') ELSE '{}'::jsonb END
    || COALESCE(p_extra, '{}'::jsonb));
  RETURN jsonb_build_object('reference', d.reference, 'account_id', d.account_id, 'sign_in_order', d.sign_in_order, 'envelope_id', d.envelope_id);
END;
$$;
ALTER FUNCTION public.sign_send_core(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_send_core(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;

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
  v_env     UUID;
  v_core    JSONB;
  v_step    INTEGER := 1;
  v_ordered BOOLEAN;
  v_in      JSONB;
BEGIN
  SELECT envelope_id INTO v_env FROM public.sign_documents WHERE id = p_document;
  IF v_env IS NOT NULL THEN
    RAISE EXCEPTION 'document_in_envelope' USING ERRCODE = '23514', DETAIL = 'A document of an envelope is sent with its envelope.';
  END IF;
  v_core := public.sign_send_core(p_document, p_base_path, p_base_sha256, p_page_count, p_expires_at, p_actor);
  v_ordered := (v_core ->> 'sign_in_order')::boolean;
  IF v_ordered THEN
    SELECT min(s.order_no) INTO v_step FROM public.sign_signers s WHERE s.document_id = p_document;
  END IF;
  v_in := public.sign_invite_step(p_document, v_step, v_ordered, p_actor);
  RETURN jsonb_build_object('reference', v_core ->> 'reference', 'account_id', v_core ->> 'account_id', 'step', v_step, 'invited', v_in);
END;
$$;
ALTER FUNCTION public.sign_send_document(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_send_document(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_send_document(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID) TO service_role;

-- Every document of an envelope in one transaction. `p_docs` is [{document_id, base_path, base_sha256, page_count}], one for each
-- document of the envelope.
CREATE OR REPLACE FUNCTION public.sign_send_envelope(
  p_envelope   UUID,
  p_docs       JSONB,
  p_expires_at TIMESTAMPTZ,
  p_actor      UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e         public.sign_envelopes%ROWTYPE;
  x         JSONB;
  d         public.sign_documents%ROWTYPE;
  p         RECORD;
  v_n       INTEGER;
  v_step    INTEGER := 1;
  v_in      JSONB;
  v_sent    JSONB := '[]'::jsonb;
  v_core    JSONB;
  v_ids     UUID[] := '{}';
BEGIN
  e := public.sign_envelope_lock(p_envelope);
  IF e.status <> 'draft' THEN
    RAISE EXCEPTION 'envelope_not_draft' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO v_n FROM public.sign_documents WHERE envelope_id = p_envelope;
  IF v_n < 2 OR v_n > 6 THEN
    RAISE EXCEPTION 'envelope_needs_2_to_6_documents' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(p_docs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_docs) <> v_n THEN
    RAISE EXCEPTION 'envelope_documents_mismatch' USING ERRCODE = '23514';
  END IF;
  -- one signing order and one code for the whole envelope, and nothing that would split a person's rows
  IF EXISTS (SELECT 1 FROM public.sign_documents x2
              WHERE x2.envelope_id = p_envelope
                AND (x2.sign_in_order <> e.sign_in_order OR x2.code_required <> e.code_required OR x2.allow_forwarding OR x2.test)) THEN
    RAISE EXCEPTION 'envelope_options_differ' USING ERRCODE = '23514';
  END IF;

  -- the people: every row of an envelope document belongs to a person (party); one anchor per person, on their first document;
  -- at most one row per document; the same step on every document
  IF EXISTS (SELECT 1 FROM public.sign_signers s JOIN public.sign_documents dd ON dd.id = s.document_id
              WHERE dd.envelope_id = p_envelope AND s.party_id IS NULL) THEN
    RAISE EXCEPTION 'envelope_person_without_party' USING ERRCODE = '23514';
  END IF;
  FOR p IN
    SELECT s.party_id,
           count(*) AS rows_n,
           count(DISTINCT s.document_id) AS docs_n,
           count(DISTINCT s.order_no) AS orders_n,
           count(*) FILTER (WHERE s.id = s.party_id) AS anchors_n,
           min(dd.envelope_position) AS first_pos,
           min(dd.envelope_position) FILTER (WHERE s.id = s.party_id) AS anchor_pos
      FROM public.sign_signers s JOIN public.sign_documents dd ON dd.id = s.document_id
     WHERE dd.envelope_id = p_envelope
     GROUP BY s.party_id
  LOOP
    IF p.rows_n <> p.docs_n THEN
      RAISE EXCEPTION 'envelope_person_twice_on_a_document' USING ERRCODE = '23514';
    END IF;
    IF p.orders_n > 1 THEN
      RAISE EXCEPTION 'envelope_person_steps_differ' USING ERRCODE = '23514';
    END IF;
    IF p.anchors_n <> 1 OR p.anchor_pos IS DISTINCT FROM p.first_pos THEN
      RAISE EXCEPTION 'envelope_person_anchor_wrong' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  -- every document, in position order (the same order every lock is taken in)
  FOR d IN SELECT * FROM public.sign_documents WHERE envelope_id = p_envelope ORDER BY envelope_position LOOP
    SELECT elem INTO x FROM jsonb_array_elements(p_docs) elem WHERE (elem ->> 'document_id')::uuid = d.id;
    IF x IS NULL OR d.id = ANY (v_ids) THEN
      RAISE EXCEPTION 'envelope_documents_mismatch' USING ERRCODE = '23514';
    END IF;
    v_ids := v_ids || d.id;
    v_core := public.sign_send_core(d.id, x ->> 'base_path', x ->> 'base_sha256', (x ->> 'page_count')::integer, p_expires_at, p_actor,
                                    jsonb_build_object('envelope_id', e.id, 'envelope', e.reference, 'position', d.envelope_position, 'count', v_n));
    PERFORM public.sign_log(d.id, 'envelope_sent', 'user', NULL, p_actor,
                            jsonb_build_object('envelope_id', e.id, 'reference', e.reference, 'position', d.envelope_position, 'count', v_n));
    v_sent := v_sent || jsonb_build_object('document_id', d.id, 'reference', v_core ->> 'reference', 'position', d.envelope_position);
  END LOOP;

  UPDATE public.sign_envelopes SET status = 'sent', sent_at = now(), expires_at = p_expires_at WHERE id = p_envelope;

  IF e.sign_in_order THEN
    SELECT min(s.order_no) INTO v_step FROM public.sign_signers s JOIN public.sign_documents dd ON dd.id = s.document_id WHERE dd.envelope_id = p_envelope;
  END IF;
  v_in := public.sign_envelope_invite_step(p_envelope, v_step, p_actor);
  RETURN jsonb_build_object('reference', e.reference, 'account_id', e.account_id, 'envelope_id', e.id, 'step', v_step, 'documents', v_sent, 'invited', v_in);
END;
$$;
ALTER FUNCTION public.sign_send_envelope(UUID, JSONB, TIMESTAMPTZ, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_send_envelope(UUID, JSONB, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_send_envelope(UUID, JSONB, TIMESTAMPTZ, UUID) TO service_role;

-- ------------------------------------------------------------
-- 7. A person finishes a document (169's function). In an envelope the next step begins when the step is finished on EVERY
--    document; one invitation per person comes back.
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
  v_env     UUID;
  v_next    INTEGER;
  v_in      JSONB := '[]'::jsonb;
  v_people  INTEGER;
  v_name    TEXT;
  v_because JSONB;
  v_sealing BOOLEAN := FALSE;
BEGIN
  SELECT document_id INTO STRICT d.id FROM public.sign_signers WHERE id = p_signer;
  -- An envelope's steps take turns: its lock first, then the document row (the document row is the lock for a document alone).
  SELECT envelope_id INTO v_env FROM public.sign_documents WHERE id = d.id;
  IF v_env IS NOT NULL THEN
    PERFORM public.sign_envelope_lock(v_env);
  END IF;
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

  IF NOT EXISTS (SELECT 1 FROM public.sign_signers x WHERE x.document_id = d.id AND x.status <> 'signed') THEN
    -- Everyone done: sealing starts.
    UPDATE public.sign_documents SET status = 'sealing', sealing_started_at = NULL, sealing_attempts = 0, seal_error = NULL WHERE id = d.id;
    PERFORM public.sign_log(d.id, CASE WHEN d.mode = 'form' THEN 'all_submitted' ELSE 'all_signed' END, 'system');
    v_sealing := TRUE;
    IF v_env IS NULL THEN
      RETURN jsonb_build_object('sealing', true, 'invited', v_in, 'account_id', d.account_id, 'reference', d.reference);
    END IF;
  ELSIF v_env IS NULL AND d.sign_in_order
     AND NOT EXISTS (SELECT 1 FROM public.sign_signers x WHERE x.document_id = d.id AND x.order_no = s.order_no AND x.status <> 'signed') THEN
    -- With signing order, the next step is invited once every signer of this step is done (a delegate is part of
    -- its signer's step, not a person of their own).
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

  -- An envelope has one step for all its documents: it begins when every person of the step has finished on every document
  -- (a document that is sealing or completed has everybody signed already).
  IF v_env IS NOT NULL AND d.sign_in_order
     AND NOT EXISTS (SELECT 1 FROM public.sign_signers x JOIN public.sign_documents xd ON xd.id = x.document_id
                      WHERE xd.envelope_id = v_env AND x.order_no = s.order_no AND x.status <> 'signed') THEN
    SELECT min(x.order_no) INTO v_next FROM public.sign_signers x JOIN public.sign_documents xd ON xd.id = x.document_id
     WHERE xd.envelope_id = v_env AND x.order_no > s.order_no;
    IF v_next IS NOT NULL THEN
      SELECT count(DISTINCT COALESCE(x.party_id, x.id)) INTO v_people FROM public.sign_signers x JOIN public.sign_documents xd ON xd.id = x.document_id
       WHERE xd.envelope_id = v_env AND x.order_no = s.order_no;
      IF v_people > 1 THEN
        v_because := jsonb_build_object('because', 'step_finished', 'previous_step', s.order_no);
      ELSE
        v_because := jsonb_build_object('because', 'signer_finished', 'previous_step', s.order_no, 'finished_name', s.full_name);
      END IF;
      v_in := public.sign_envelope_invite_step(v_env, v_next, NULL, v_because);
    END IF;
  END IF;
  RETURN jsonb_build_object('sealing', v_sealing, 'invited', v_in, 'account_id', d.account_id, 'reference', d.reference)
         || CASE WHEN v_env IS NOT NULL THEN jsonb_build_object('envelope_id', v_env) ELSE '{}'::jsonb END;
END;
$$;
ALTER FUNCTION public.sign_complete_signer(UUID, TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_complete_signer(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_complete_signer(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 8. The person's side of an envelope: consent, first look, a new link, a different person
-- ------------------------------------------------------------
-- The agreement to sign electronically, once, on every open row of the person: one transaction, so the version, the language and the
-- time are the same on every document's record.
CREATE OR REPLACE FUNCTION public.sign_envelope_record_consent(p_anchor UUID, p_version TEXT, p_locale TEXT, p_ip TEXT, p_device TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a      public.sign_signers%ROWTYPE;
  v_env  UUID;
  r      RECORD;
  v_open BOOLEAN := FALSE;
  v_did  BOOLEAN := FALSE;
BEGIN
  SELECT * INTO a FROM public.sign_signers WHERE id = p_anchor;
  IF NOT FOUND OR a.party_id IS NULL THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  SELECT envelope_id INTO v_env FROM public.sign_documents WHERE id = a.document_id;
  PERFORM public.sign_envelope_lock(v_env);
  FOR r IN
    SELECT s.id, s.document_id, s.consented_at, d.mode
      FROM public.sign_signers s JOIN public.sign_documents d ON d.id = s.document_id
     WHERE s.party_id = a.party_id AND s.account_id = a.account_id AND d.envelope_id = v_env
       AND d.status IN ('sent', 'in_progress') AND s.status IN ('sent', 'viewed')
     ORDER BY d.envelope_position
  LOOP
    v_open := TRUE;
    PERFORM 1 FROM public.sign_documents WHERE id = r.document_id FOR UPDATE;
    IF r.consented_at IS NOT NULL THEN
      CONTINUE; -- already recorded; the first agreement is the one that counts
    END IF;
    UPDATE public.sign_signers
       SET consented_at = now(), consent_version = p_version, locale = COALESCE(p_locale, locale),
           ip = COALESCE(p_ip, ip), device = COALESCE(p_device, device)
     WHERE id = r.id;
    PERFORM public.sign_log(r.document_id, 'consented', 'signer', r.id, NULL,
                            jsonb_build_object('version', p_version, 'envelope_id', v_env) || CASE WHEN r.mode = 'form' THEN jsonb_build_object('mode', 'form') ELSE '{}'::jsonb END,
                            p_ip, p_device);
    v_did := TRUE;
  END LOOP;
  IF NOT v_open THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  RETURN v_did;
END;
$$;
ALTER FUNCTION public.sign_envelope_record_consent(UUID, TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelope_record_consent(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_envelope_record_consent(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- The first time a person opens their link: every row of theirs that was sent becomes viewed.
CREATE OR REPLACE FUNCTION public.sign_envelope_mark_viewed(p_anchor UUID, p_ip TEXT, p_device TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a     public.sign_signers%ROWTYPE;
  r     RECORD;
  v_did BOOLEAN := FALSE;
BEGIN
  SELECT * INTO a FROM public.sign_signers WHERE id = p_anchor;
  IF NOT FOUND OR a.party_id IS NULL THEN
    RETURN FALSE;
  END IF;
  FOR r IN
    SELECT s.id, s.document_id
      FROM public.sign_signers s JOIN public.sign_documents d ON d.id = s.document_id
     WHERE s.party_id = a.party_id AND s.account_id = a.account_id AND s.status = 'sent' AND d.status IN ('sent', 'in_progress')
     ORDER BY d.envelope_position
       FOR UPDATE OF s
  LOOP
    UPDATE public.sign_signers SET status = 'viewed', viewed_at = now(), ip = COALESCE(p_ip, ip), device = COALESCE(p_device, device) WHERE id = r.id;
    PERFORM public.sign_log(r.document_id, 'viewed', 'signer', r.id, NULL, '{}'::jsonb, p_ip, p_device);
    v_did := TRUE;
  END LOOP;
  RETURN v_did;
END;
$$;
ALTER FUNCTION public.sign_envelope_mark_viewed(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelope_mark_viewed(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_envelope_mark_viewed(UUID, TEXT, TEXT) TO service_role;

-- A new link for a person who still has something to do (resend, or a reminder): the old one dies. One event on each document
-- the person has not finished.
CREATE OR REPLACE FUNCTION public.sign_envelope_rotate_token(p_anchor UUID, p_actor UUID, p_reason TEXT DEFAULT 'resent')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a      public.sign_signers%ROWTYPE;
  v_env  UUID;
  r      RECORD;
  v_open BOOLEAN := FALSE;
BEGIN
  SELECT * INTO a FROM public.sign_signers WHERE id = p_anchor;
  IF NOT FOUND OR a.party_id IS NULL OR a.id <> a.party_id THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  SELECT envelope_id INTO v_env FROM public.sign_documents WHERE id = a.document_id;
  PERFORM public.sign_envelope_lock(v_env);
  FOR r IN
    SELECT s.id, s.document_id
      FROM public.sign_signers s JOIN public.sign_documents d ON d.id = s.document_id
     WHERE s.party_id = a.party_id AND s.account_id = a.account_id AND s.status IN ('sent', 'viewed') AND d.status IN ('sent', 'in_progress')
     ORDER BY d.envelope_position
  LOOP
    v_open := TRUE;
    PERFORM public.sign_log(r.document_id, p_reason, 'user', r.id, p_actor);
  END LOOP;
  IF NOT v_open THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  RETURN public.sign_signer_brief(p_anchor, public.sign_issue_token(p_anchor)) || jsonb_build_object('envelope_id', v_env);
END;
$$;
ALTER FUNCTION public.sign_envelope_rotate_token(UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelope_rotate_token(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_envelope_rotate_token(UUID, UUID, TEXT) TO service_role;

-- A different person for someone who has signed nothing yet, on every document they are on. The new person agrees for
-- themselves; a person who has signed one of the documents cannot be replaced (their signed pages and answers would be shown to
-- the new person through the same link): void the envelope and send a new one.
CREATE OR REPLACE FUNCTION public.sign_envelope_change_recipient(
  p_anchor UUID, p_name TEXT, p_email TEXT, p_phone TEXT, p_channel TEXT, p_actor UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a      public.sign_signers%ROWTYPE;
  v_env  UUID;
  r      RECORD;
  v_open BOOLEAN := FALSE;
BEGIN
  SELECT * INTO a FROM public.sign_signers WHERE id = p_anchor;
  IF NOT FOUND OR a.party_id IS NULL OR a.id <> a.party_id THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  SELECT envelope_id INTO v_env FROM public.sign_documents WHERE id = a.document_id;
  PERFORM public.sign_envelope_lock(v_env);
  IF EXISTS (SELECT 1 FROM public.sign_signers s WHERE s.party_id = a.party_id AND s.account_id = a.account_id AND s.status IN ('signed', 'declined')) THEN
    RAISE EXCEPTION 'envelope_person_has_signed' USING ERRCODE = '23514';
  END IF;
  FOR r IN
    SELECT s.id, s.document_id, s.status, s.email
      FROM public.sign_signers s JOIN public.sign_documents d ON d.id = s.document_id
     WHERE s.party_id = a.party_id AND s.account_id = a.account_id AND d.status IN ('sent', 'in_progress')
     ORDER BY d.envelope_position
  LOOP
    v_open := TRUE;
    UPDATE public.sign_signers
       SET full_name = btrim(p_name), email = btrim(p_email), phone = NULLIF(btrim(p_phone), ''),
           channel = COALESCE(p_channel, channel), internal_user_id = NULL,
           status = CASE WHEN r.status = 'pending' THEN 'pending' ELSE 'sent' END,
           viewed_at = NULL,
           consented_at = CASE WHEN r.status = 'pending' THEN consented_at ELSE NULL END,
           consent_version = CASE WHEN r.status = 'pending' THEN consent_version ELSE NULL END
     WHERE id = r.id;
    PERFORM public.sign_log(r.document_id, 'recipient_changed', 'user', r.id, p_actor,
                            jsonb_build_object('from_email', r.email, 'to_email', btrim(p_email)));
  END LOOP;
  IF NOT v_open THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  -- not invited yet (a later step): the details change and there is still no link
  IF (SELECT status FROM public.sign_signers WHERE id = p_anchor) = 'pending' THEN
    RETURN public.sign_signer_brief(p_anchor, NULL) || jsonb_build_object('envelope_id', v_env);
  END IF;
  RETURN public.sign_signer_brief(p_anchor, public.sign_issue_token(p_anchor)) || jsonb_build_object('envelope_id', v_env);
END;
$$;
ALTER FUNCTION public.sign_envelope_change_recipient(UUID, TEXT, TEXT, TEXT, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelope_change_recipient(UUID, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_envelope_change_recipient(UUID, TEXT, TEXT, TEXT, TEXT, UUID) TO service_role;

-- ------------------------------------------------------------
-- 9. Ending an envelope: a person declines, the sender voids, the last document completes
-- ------------------------------------------------------------
-- A person declines: every document that is not yet fully signed is declined (a document that is sealing or completed is not
-- touched). The document the person has a row on records their decline; the others record that the envelope was declined.
CREATE OR REPLACE FUNCTION public.sign_envelope_decline(p_anchor UUID, p_reason TEXT, p_ip TEXT, p_device TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a      public.sign_signers%ROWTYPE;
  e      public.sign_envelopes%ROWTYPE;
  d      public.sign_documents%ROWTYPE;
  s      public.sign_signers%ROWTYPE;
  v_env  UUID;
  v_why  TEXT := left(NULLIF(btrim(p_reason), ''), 1000);
  v_open BOOLEAN := FALSE;
  v_docs JSONB := '[]'::jsonb;
BEGIN
  SELECT * INTO a FROM public.sign_signers WHERE id = p_anchor;
  IF NOT FOUND OR a.party_id IS NULL THEN
    RAISE EXCEPTION 'document_not_open' USING ERRCODE = '23514';
  END IF;
  SELECT envelope_id INTO v_env FROM public.sign_documents WHERE id = a.document_id;
  e := public.sign_envelope_lock(v_env);
  -- the person must still have something to do
  IF NOT EXISTS (SELECT 1 FROM public.sign_signers x JOIN public.sign_documents xd ON xd.id = x.document_id
                  WHERE x.party_id = a.party_id AND x.account_id = a.account_id AND x.status IN ('sent', 'viewed') AND xd.status IN ('sent', 'in_progress')) THEN
    RAISE EXCEPTION 'document_not_open' USING ERRCODE = '23514';
  END IF;
  FOR d IN SELECT * FROM public.sign_documents WHERE envelope_id = v_env AND status IN ('sent', 'in_progress') ORDER BY envelope_position FOR UPDATE LOOP
    v_open := TRUE;
    SELECT * INTO s FROM public.sign_signers x WHERE x.document_id = d.id AND x.party_id = a.party_id;
    IF FOUND AND s.status IN ('sent', 'viewed') THEN
      UPDATE public.sign_signers
         SET status = 'declined', declined_at = now(), decline_reason = v_why, ip = COALESCE(p_ip, ip), device = COALESCE(p_device, device)
       WHERE id = s.id;
      UPDATE public.sign_documents SET status = 'declined' WHERE id = d.id;
      PERFORM public.sign_log(d.id, 'declined', 'signer', s.id, NULL, jsonb_build_object('reason', v_why, 'envelope_id', v_env), p_ip, p_device);
    ELSE
      UPDATE public.sign_documents SET status = 'declined' WHERE id = d.id;
      PERFORM public.sign_log(d.id, 'envelope_declined', 'system', NULL, NULL,
                              jsonb_build_object('reason', v_why, 'envelope_id', v_env, 'reference', e.reference, 'by_name', a.full_name), p_ip, p_device);
    END IF;
    v_docs := v_docs || to_jsonb(d.id);
  END LOOP;
  IF NOT v_open THEN
    RAISE EXCEPTION 'document_not_open' USING ERRCODE = '23514';
  END IF;
  RETURN jsonb_build_object('account_id', e.account_id, 'reference', e.reference, 'envelope_id', v_env, 'documents', v_docs, 'anchor_id', a.id);
END;
$$;
ALTER FUNCTION public.sign_envelope_decline(UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelope_decline(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_envelope_decline(UUID, TEXT, TEXT, TEXT) TO service_role;

-- The sender cancels, only while no document is fully signed.
CREATE OR REPLACE FUNCTION public.sign_void_envelope(p_envelope UUID, p_reason TEXT, p_actor UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e      public.sign_envelopes%ROWTYPE;
  d      RECORD;
  v_docs JSONB := '[]'::jsonb;
BEGIN
  e := public.sign_envelope_lock(p_envelope);
  IF e.status = 'draft' THEN
    RAISE EXCEPTION 'envelope_not_sent' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sign_documents x WHERE x.envelope_id = p_envelope AND x.status IN ('sent', 'in_progress')) THEN
    RAISE EXCEPTION 'document_already_final' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sign_documents x WHERE x.envelope_id = p_envelope AND x.status IN ('sealing', 'completed', 'failed')) THEN
    RAISE EXCEPTION 'envelope_partly_completed' USING ERRCODE = '23514',
      DETAIL = 'A document of this envelope was already signed by everyone, so the envelope cannot be cancelled.';
  END IF;
  PERFORM set_config('vircle.envelope_op', 'void', true);
  FOR d IN SELECT x.id FROM public.sign_documents x WHERE x.envelope_id = p_envelope AND x.status IN ('sent', 'in_progress') ORDER BY x.envelope_position LOOP
    PERFORM public.sign_void_document(d.id, p_reason, p_actor);
    v_docs := v_docs || to_jsonb(d.id);
  END LOOP;
  PERFORM set_config('vircle.envelope_op', '', true);
  UPDATE public.sign_envelopes SET void_reason = left(NULLIF(btrim(p_reason), ''), 1000) WHERE id = p_envelope;
  RETURN jsonb_build_object('account_id', e.account_id, 'reference', e.reference, 'envelope_id', p_envelope, 'documents', v_docs);
END;
$$;
ALTER FUNCTION public.sign_void_envelope(UUID, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_void_envelope(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_void_envelope(UUID, TEXT, UUID) TO service_role;

-- The sender's own void and the person's own decline (158's functions): a document of an envelope is refused unless the
-- envelope's function is the one acting, so a single document can never be cancelled or declined out from under the others.
CREATE OR REPLACE FUNCTION public.sign_void_document(p_document UUID, p_reason TEXT, p_actor UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.sign_documents%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.sign_documents WHERE id = p_document FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_not_found' USING ERRCODE = '22023';
  END IF;
  IF d.envelope_id IS NOT NULL AND current_setting('vircle.envelope_op', true) IS DISTINCT FROM 'void' THEN
    RAISE EXCEPTION 'document_in_envelope' USING ERRCODE = '23514', DETAIL = 'A document of an envelope is cancelled with its envelope.';
  END IF;
  IF d.status IN ('completed', 'declined', 'expired', 'voided') THEN
    RAISE EXCEPTION 'document_already_final' USING ERRCODE = '23514';
  END IF;
  UPDATE public.sign_documents SET status = 'voided', void_reason = left(NULLIF(btrim(p_reason), ''), 1000) WHERE id = p_document;
  PERFORM public.sign_log(p_document, 'voided', 'user', NULL, p_actor, jsonb_build_object('reason', left(NULLIF(btrim(p_reason), ''), 1000)));
  RETURN jsonb_build_object('account_id', d.account_id, 'reference', d.reference, 'was', d.status);
END;
$$;
ALTER FUNCTION public.sign_void_document(UUID, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_void_document(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_void_document(UUID, TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.sign_decline_signer(p_signer UUID, p_reason TEXT, p_ip TEXT, p_device TEXT)
RETURNS JSONB
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
  IF d.envelope_id IS NOT NULL THEN
    RAISE EXCEPTION 'document_in_envelope' USING ERRCODE = '23514', DETAIL = 'A person declines an envelope, not one of its documents.';
  END IF;
  IF d.status NOT IN ('sent', 'in_progress') OR s.status NOT IN ('sent', 'viewed') THEN
    RAISE EXCEPTION 'document_not_open' USING ERRCODE = '23514';
  END IF;
  UPDATE public.sign_signers
     SET status = 'declined', declined_at = now(), decline_reason = left(NULLIF(btrim(p_reason), ''), 1000),
         ip = COALESCE(p_ip, ip), device = COALESCE(p_device, device)
   WHERE id = p_signer;
  UPDATE public.sign_documents SET status = 'declined' WHERE id = d.id;
  PERFORM public.sign_log(d.id, 'declined', 'signer', p_signer, NULL,
                          jsonb_build_object('reason', left(NULLIF(btrim(p_reason), ''), 1000)), p_ip, p_device);
  -- The links stay, so each opens a page that says how the document ended; signing needs an open document.
  RETURN jsonb_build_object('account_id', d.account_id, 'reference', d.reference, 'document_id', d.id);
END;
$$;
ALTER FUNCTION public.sign_decline_signer(UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_decline_signer(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_decline_signer(UUID, TEXT, TEXT, TEXT) TO service_role;

-- The last document of an envelope is completed: the envelope is completed (once), each chain says so, and the caller that
-- gets `completed: true` is the one that sends the combined message.
CREATE OR REPLACE FUNCTION public.sign_envelope_settle(p_envelope UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e   public.sign_envelopes%ROWTYPE;
  d   RECORD;
  v_n INTEGER;
BEGIN
  e := public.sign_envelope_lock(p_envelope);
  IF e.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('completed', false, 'already', true);
  END IF;
  SELECT count(*) INTO v_n FROM public.sign_documents WHERE envelope_id = p_envelope;
  IF v_n = 0 OR EXISTS (SELECT 1 FROM public.sign_documents x WHERE x.envelope_id = p_envelope AND x.status <> 'completed') THEN
    RETURN jsonb_build_object('completed', false);
  END IF;
  UPDATE public.sign_envelopes SET completed_at = now(), status = 'completed' WHERE id = p_envelope;
  FOR d IN SELECT x.id, x.envelope_position FROM public.sign_documents x WHERE x.envelope_id = p_envelope ORDER BY x.envelope_position LOOP
    PERFORM public.sign_log(d.id, 'envelope_completed', 'system', NULL, NULL,
                            jsonb_build_object('envelope_id', p_envelope, 'reference', e.reference, 'position', d.envelope_position, 'count', v_n));
  END LOOP;
  RETURN jsonb_build_object('completed', true, 'account_id', e.account_id, 'reference', e.reference, 'envelope_id', p_envelope);
END;
$$;
ALTER FUNCTION public.sign_envelope_settle(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelope_settle(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_envelope_settle(UUID) TO service_role;

-- An envelope that ended without completing (expired): the caller that gets true tells the people, once.
CREATE OR REPLACE FUNCTION public.sign_envelope_claim_end(p_envelope UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  UPDATE public.sign_envelopes SET end_notified_at = now() WHERE id = p_envelope AND end_notified_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;
ALTER FUNCTION public.sign_envelope_claim_end(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelope_claim_end(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_envelope_claim_end(UUID) TO service_role;

-- ------------------------------------------------------------
-- 10. The sender is told inside Halo once for an envelope (169's function): the first document to be declined or to expire, and
--     the last to complete.
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
  IF NEW.envelope_id IS NOT NULL THEN
    IF NEW.status = 'completed' THEN
      IF EXISTS (SELECT 1 FROM public.sign_documents x WHERE x.envelope_id = NEW.envelope_id AND x.status <> 'completed') THEN
        RETURN NEW; -- the envelope is not finished yet
      END IF;
    ELSIF EXISTS (SELECT 1 FROM public.sign_documents x WHERE x.envelope_id = NEW.envelope_id AND x.id <> NEW.id AND x.status = NEW.status) THEN
      RETURN NEW; -- another document of the envelope already told the sender
    END IF;
    v_ref := COALESCE((SELECT e.reference FROM public.sign_envelopes e WHERE e.id = NEW.envelope_id), v_ref);
  END IF;
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

NOTIFY pgrst, 'reload schema';
