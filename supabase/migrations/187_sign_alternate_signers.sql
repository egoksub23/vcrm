-- ============================================================
-- 187_sign_alternate_signers.sql
--
-- Secure Sign: an ALTERNATE signer. A sender may name two people for the same role (two finance contacts, or two directors of whom one is enough).
-- Both are invited together and each has a link of their own. Whoever finishes the role FIRST fills the places and signs; the other person's link
-- then says "this was already completed by someone else", they get no reminders, and the document does not wait for them.
--
--   sign_signers.alternate_of       NULL for everyone but the SECOND person of a role: the id of the first (the primary) row of the same role on the
--                                   same document. One alternate for each primary (a unique index), never an alternate of an alternate, never a
--                                   delegate (166), never a Halo countersigner (167), never a person of a collection (171). Fixed once set.
--   sign_signers.status             a new terminal value 'not_needed': the person was invited as an alternate and did not need to sign, because
--                                   the other person of their role completed it first. (Not 'declined': nobody refused anything.)
--
--   sign_signers_alternate_guard()  BEFORE INSERT OR UPDATE on sign_signers: an alternate is made only on a DRAFT document that is not in a
--                                   collection, on the same role, kind and step as the primary, with another address; nothing about the pair can
--                                   be changed into a shape the rest of the system does not expect.
--   sign_documents_alternate_guard() BEFORE UPDATE OF envelope_id on sign_documents: a document with an alternate cannot join a collection.
--   sign_complete_signer            recreated (from 171). The FIRST-WINS CLAIM is made here, under the lock the function already takes on the
--                                   document row: a person whose row is 'not_needed' is refused ('completed_by_other') whatever state the
--                                   document is in, so two people submitting in the same second cannot both complete (the second one, once the
--                                   lock is theirs, reads the row the first one marked). The winner marks the other person of the role, and any
--                                   part they had handed to a delegate, 'not_needed' in the same transaction, logs 'alternate_not_needed' for
--                                   each, and a step is finished (and the document is complete) when every person of it is signed or not_needed.
--                                   A document with no alternate behaves exactly as before.
--   sign_move_signer                recreated (from 166): a person with an alternate moves WITH their alternate (the pair is one step).
--   sign_answers_guard              recreated (from 168): the answers of a 'not_needed' person are frozen like those of a person who signed
--                                   (refused as 'completed_by_other'), so nothing the other person does can reach the role after it is complete.
--
-- Nothing else changes: a reminder, a resend and a change of recipient only ever act on 'sent'/'viewed' (and 'pending') rows, so they ignore a
-- 'not_needed' person without being touched. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Columns, checks, index
-- ------------------------------------------------------------
ALTER TABLE public.sign_signers
  ADD COLUMN IF NOT EXISTS alternate_of UUID;

-- the status list gains 'not_needed' (the constraint of 157 is inline, so find it by what it checks)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'public.sign_signers'::regclass AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%declined%' AND pg_get_constraintdef(c.oid) LIKE '%viewed%'
  LOOP
    EXECUTE format('ALTER TABLE public.sign_signers DROP CONSTRAINT %I', r.conname);
  END LOOP;
  ALTER TABLE public.sign_signers ADD CONSTRAINT sign_signers_status_check
    CHECK (status IN ('pending', 'sent', 'viewed', 'signed', 'declined', 'not_needed'));
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_signers_alternate_fk') THEN
    ALTER TABLE public.sign_signers ADD CONSTRAINT sign_signers_alternate_fk FOREIGN KEY (alternate_of, account_id)
      REFERENCES public.sign_signers (id, account_id) ON DELETE CASCADE;
  END IF;
  -- an alternate is a plain person of the role: not a delegate, not a person of a collection, not a Halo countersigner, not their own alternate
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_signers_alternate_shape') THEN
    ALTER TABLE public.sign_signers ADD CONSTRAINT sign_signers_alternate_shape CHECK (
      alternate_of IS NULL
      OR (alternate_of <> id AND part_keys IS NULL AND delegated_by IS NULL AND party_id IS NULL AND internal_user_id IS NULL));
  END IF;
END $$;

-- one alternate for each person
CREATE UNIQUE INDEX IF NOT EXISTS sign_signers_alternate_uq ON public.sign_signers (alternate_of) WHERE alternate_of IS NOT NULL;

-- ------------------------------------------------------------
-- 2. The pair is made only as a draft, and stays a sound pair
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_signers_alternate_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p  public.sign_signers%ROWTYPE;
  d  public.sign_documents%ROWTYPE;
  v_partner UUID;
  v_other   public.sign_signers%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.alternate_of IS DISTINCT FROM OLD.alternate_of THEN
    RAISE EXCEPTION 'sign_alternate_is_fixed' USING ERRCODE = '23514',
      DETAIL = 'Who a person is an alternate of is set when the row is made and never changes.';
  END IF;

  IF NEW.alternate_of IS NOT NULL THEN
    SELECT * INTO p FROM public.sign_signers WHERE id = NEW.alternate_of AND account_id = NEW.account_id;
    IF NOT FOUND OR p.document_id <> NEW.document_id OR p.alternate_of IS NOT NULL OR p.part_keys IS NOT NULL
       OR p.internal_user_id IS NOT NULL OR p.role_key <> NEW.role_key OR p.kind <> NEW.kind THEN
      RAISE EXCEPTION 'sign_alternate_invalid' USING ERRCODE = '23514',
        DETAIL = 'An alternate shares the role and the kind of one other person of the same document, who is not a delegate, a Halo user or an alternate.';
    END IF;
    IF lower(btrim(p.email)) = lower(btrim(NEW.email)) THEN
      RAISE EXCEPTION 'sign_alternate_same_person' USING ERRCODE = '23514',
        DETAIL = 'The alternate has to be another person than the one they can sign instead of.';
    END IF;
    IF TG_OP = 'INSERT' THEN
      SELECT * INTO d FROM public.sign_documents WHERE id = NEW.document_id AND account_id = NEW.account_id;
      IF NOT FOUND OR d.status <> 'draft' OR d.envelope_id IS NOT NULL THEN
        RAISE EXCEPTION 'sign_alternate_needs_a_draft_document' USING ERRCODE = '23514',
          DETAIL = 'An alternate is named on a draft document that is not part of a document collection.';
      END IF;
      IF p.order_no <> NEW.order_no THEN
        RAISE EXCEPTION 'sign_alternate_invalid' USING ERRCODE = '23514',
          DETAIL = 'The two people of a role are in the same step.';
      END IF;
    END IF;
  END IF;

  -- a pair stays a pair: neither person can be made a Halo user, given another role or kind, or the other person's address
  IF TG_OP = 'UPDATE' THEN
    v_partner := CASE WHEN NEW.alternate_of IS NOT NULL THEN NEW.alternate_of
                      ELSE (SELECT x.id FROM public.sign_signers x WHERE x.alternate_of = NEW.id LIMIT 1) END;
    IF v_partner IS NOT NULL THEN
      SELECT * INTO v_other FROM public.sign_signers WHERE id = v_partner;
      IF FOUND THEN
        IF NEW.role_key IS DISTINCT FROM OLD.role_key OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.internal_user_id IS NOT NULL
           OR NEW.part_keys IS NOT NULL THEN
          RAISE EXCEPTION 'sign_alternate_invalid' USING ERRCODE = '23514',
            DETAIL = 'The two people of a role keep the same role and kind, and neither is a Halo user.';
        END IF;
        IF lower(btrim(NEW.email)) = lower(btrim(v_other.email)) THEN
          RAISE EXCEPTION 'sign_alternate_same_person' USING ERRCODE = '23514',
            DETAIL = 'The two people of a role have to be two different people.';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_signers_alternate_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_signers_alternate_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_signers_alternate_guard ON public.sign_signers;
CREATE TRIGGER sign_signers_alternate_guard
  BEFORE INSERT OR UPDATE OF alternate_of, role_key, kind, email, internal_user_id, part_keys ON public.sign_signers
  FOR EACH ROW EXECUTE FUNCTION public.sign_signers_alternate_guard();

-- a document with an alternate cannot join a collection (a collection's people are one person across several documents)
CREATE OR REPLACE FUNCTION public.sign_documents_alternate_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sign_signers s WHERE s.document_id = NEW.id AND s.alternate_of IS NOT NULL) THEN
    RAISE EXCEPTION 'sign_alternate_not_in_collection' USING ERRCODE = '23514',
      DETAIL = 'A document with an alternate signer cannot be part of a document collection.';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_documents_alternate_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_documents_alternate_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_documents_alternate_guard ON public.sign_documents;
CREATE TRIGGER sign_documents_alternate_guard
  BEFORE UPDATE OF envelope_id ON public.sign_documents
  FOR EACH ROW
  WHEN (NEW.envelope_id IS NOT NULL AND NEW.envelope_id IS DISTINCT FROM OLD.envelope_id)
  EXECUTE FUNCTION public.sign_documents_alternate_guard();

-- ------------------------------------------------------------
-- 3. The answers of a person who is not needed are frozen (168's guard, with 'not_needed' beside 'signed')
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_answers_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- moving a row to another person (forwarding a part), the source and the time are not a change of the answer;
    -- neither is a new ciphertext for the same answer (re-encryption under a newer key)
    IF NEW.value IS NOT DISTINCT FROM OLD.value
       AND NEW.sensitive = OLD.sensitive
       AND NEW.field_key = OLD.field_key
       AND (NEW.value_enc IS NULL) = (OLD.value_enc IS NULL) THEN
      RETURN NEW;
    END IF;
    SELECT status INTO v_status FROM public.sign_signers WHERE id = OLD.signer_id AND account_id = OLD.account_id;
  ELSE
    SELECT status INTO v_status FROM public.sign_signers WHERE id = NEW.signer_id AND account_id = NEW.account_id;
  END IF;

  IF v_status = 'signed' THEN
    RAISE EXCEPTION 'sign_answer_is_frozen' USING ERRCODE = '23514',
      DETAIL = 'The answers of a person who has signed cannot change.';
  END IF;
  -- the other person of the role completed it: nothing this person does can reach the role any more
  IF v_status = 'not_needed' THEN
    RAISE EXCEPTION 'completed_by_other' USING ERRCODE = '23514',
      DETAIL = 'This role was completed by the other person, so these answers can no longer change.';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_answers_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_answers_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_answers_guard ON public.sign_answers;
CREATE TRIGGER sign_answers_guard
  BEFORE INSERT OR UPDATE ON public.sign_answers
  FOR EACH ROW EXECUTE FUNCTION public.sign_answers_guard();

-- ------------------------------------------------------------
-- 4. A person finishes a document (171's function), with the first-wins claim for a role that has an alternate
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
  v_primary UUID;
  r         RECORD;
BEGIN
  SELECT document_id INTO STRICT d.id FROM public.sign_signers WHERE id = p_signer;
  -- An envelope's steps take turns: its lock first, then the document row (the document row is the lock for a document alone).
  SELECT envelope_id INTO v_env FROM public.sign_documents WHERE id = d.id;
  IF v_env IS NOT NULL THEN
    PERFORM public.sign_envelope_lock(v_env);
  END IF;
  -- The document row is the lock: signers finishing together take turns here. The person's own row is read AFTER the lock is ours, so a person
  -- whose alternate finished first reads the status that person's completion left on their row.
  SELECT * INTO d FROM public.sign_documents WHERE id = d.id FOR UPDATE;
  SELECT * INTO s FROM public.sign_signers WHERE id = p_signer;

  -- The first-wins claim: the other person of the role finished first. Said before anything about the document, because by now the document
  -- may already be sealing (the winner may have been the last person to finish).
  IF s.status = 'not_needed' THEN
    RAISE EXCEPTION 'completed_by_other' USING ERRCODE = '23514';
  END IF;
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
  -- (belt and braces: the other person of the role has signed but this row was not marked, which this function never leaves behind)
  v_primary := COALESCE(s.alternate_of, s.id);
  IF s.part_keys IS NULL AND EXISTS (
       SELECT 1 FROM public.sign_signers x
        WHERE x.document_id = d.id AND x.id <> p_signer AND x.status = 'signed' AND x.part_keys IS NULL
          AND (x.id = v_primary OR x.alternate_of = v_primary)) THEN
    RAISE EXCEPTION 'completed_by_other' USING ERRCODE = '23514';
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

  -- The role is complete: the other person of it (and any part they had handed to someone) is not needed any more. Marked in this same
  -- transaction, so every later reader of the document sees the role as done, and the other person's link says so.
  IF s.part_keys IS NULL THEN
    FOR r IN
      SELECT x.id FROM public.sign_signers x
       WHERE x.document_id = d.id AND x.id <> p_signer AND x.status IN ('pending', 'sent', 'viewed')
         AND (x.id = v_primary OR x.alternate_of = v_primary
              OR x.delegated_by IN (SELECT y.id FROM public.sign_signers y
                                     WHERE y.document_id = d.id AND y.id <> p_signer AND (y.id = v_primary OR y.alternate_of = v_primary)))
       ORDER BY x.created_at
    LOOP
      UPDATE public.sign_signers SET status = 'not_needed' WHERE id = r.id;
      PERFORM public.sign_log(d.id, 'alternate_not_needed', 'system', r.id, NULL,
                              jsonb_build_object('role', s.role_key, 'completed_by', p_signer::text, 'completed_by_name', s.full_name));
    END LOOP;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.sign_signers x WHERE x.document_id = d.id AND x.status NOT IN ('signed', 'not_needed')) THEN
    -- Everyone done: sealing starts.
    UPDATE public.sign_documents SET status = 'sealing', sealing_started_at = NULL, sealing_attempts = 0, seal_error = NULL WHERE id = d.id;
    PERFORM public.sign_log(d.id, CASE WHEN d.mode = 'form' THEN 'all_submitted' ELSE 'all_signed' END, 'system');
    v_sealing := TRUE;
    IF v_env IS NULL THEN
      RETURN jsonb_build_object('sealing', true, 'invited', v_in, 'account_id', d.account_id, 'reference', d.reference);
    END IF;
  ELSIF v_env IS NULL AND d.sign_in_order
     AND NOT EXISTS (SELECT 1 FROM public.sign_signers x WHERE x.document_id = d.id AND x.order_no = s.order_no AND x.status NOT IN ('signed', 'not_needed')) THEN
    -- With signing order, the next step is invited once every signer of this step is done (a delegate is part of
    -- its signer's step, not a person of their own; the two people of a role are one person of the step).
    SELECT min(x.order_no) INTO v_next FROM public.sign_signers x WHERE x.document_id = d.id AND x.order_no > s.order_no;
    IF v_next IS NOT NULL THEN
      SELECT count(*) INTO v_people FROM public.sign_signers x
       WHERE x.document_id = d.id AND x.order_no = s.order_no AND x.part_keys IS NULL AND x.alternate_of IS NULL;
      IF v_people > 1 THEN
        v_because := jsonb_build_object('because', 'step_finished', 'previous_step', s.order_no);
      ELSE
        SELECT x.full_name INTO v_name FROM public.sign_signers x
         WHERE x.document_id = d.id AND x.order_no = s.order_no AND x.part_keys IS NULL
         ORDER BY (x.status = 'signed') DESC, x.created_at LIMIT 1;
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
-- 5. A person whose step has not begun moves to a later step (166's function): the two people of a role move together
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_move_signer(p_signer UUID, p_order_no INTEGER, p_actor UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s         public.sign_signers%ROWTYPE;
  d         public.sign_documents%ROWTYPE;
  v_began   INTEGER;
  v_primary UUID;
BEGIN
  SELECT document_id INTO STRICT d.id FROM public.sign_signers WHERE id = p_signer;
  SELECT * INTO d FROM public.sign_documents WHERE id = d.id FOR UPDATE;
  SELECT * INTO s FROM public.sign_signers WHERE id = p_signer;
  IF d.status NOT IN ('sent', 'in_progress') OR s.status <> 'pending' OR s.part_keys IS NOT NULL OR NOT d.sign_in_order THEN
    RAISE EXCEPTION 'step_not_movable' USING ERRCODE = '23514';
  END IF;
  v_primary := COALESCE(s.alternate_of, s.id);
  -- the pair is one step: the other person of the role has to be able to move too
  IF EXISTS (SELECT 1 FROM public.sign_signers x
              WHERE x.document_id = d.id AND x.id <> p_signer AND (x.id = v_primary OR x.alternate_of = v_primary) AND x.status <> 'pending') THEN
    RAISE EXCEPTION 'step_not_movable' USING ERRCODE = '23514';
  END IF;
  -- only into a step that has not begun: after the last step that was invited
  SELECT COALESCE(max(i.step), 0) INTO v_began FROM public.sign_step_invites i WHERE i.document_id = d.id;
  IF p_order_no IS NULL OR p_order_no < 1 OR p_order_no > 100 OR p_order_no <= v_began THEN
    RAISE EXCEPTION 'step_not_movable' USING ERRCODE = '23514';
  END IF;
  UPDATE public.sign_signers SET order_no = p_order_no
   WHERE document_id = d.id AND (id = v_primary OR alternate_of = v_primary);
  PERFORM public.sign_log(d.id, 'signer_moved', 'user', p_signer, p_actor,
                          jsonb_build_object('from_step', s.order_no, 'to_step', p_order_no));
  RETURN jsonb_build_object('signer_id', p_signer, 'order_no', p_order_no);
END;
$$;
ALTER FUNCTION public.sign_move_signer(UUID, INTEGER, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_move_signer(UUID, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_move_signer(UUID, INTEGER, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
