-- ============================================================
-- 166_sign_forward_parallel.sql
--
-- Doc Sign, work package 18: signers who share an order number form one STEP, and a signer may forward their
-- turn, or one part of a form, to someone else.
--
-- Parallel steps. The ceremony already treats every signer with the same order_no as one step (158 invites all
-- of them together and invites the next step only when every one has finished); phase 1 stopped the sender
-- from giving two people one number. What changes here is the wording of the audit trail: an invitation now
-- says what it followed ("because {name} finished", or "because the previous step finished"), and a signer who
-- has not been invited yet can be renamed, re-addressed or moved to a later step (F-70).
--
-- Forwarding (F-95). Two kinds, both decided here under the lock on the document:
--
--   a turn   the new person becomes the signer for that role at the same position (the same row, so the
--            role, the step and the history stay put). The old link dies at once, the forwarder's name is
--            kept as history, nothing the forwarder agreed to carries over (the new person gives their own
--            consent) and no signature the forwarder drew is kept. At most `p_max` forwards per position.
--   a part   the signer keeps the signing role and hands one part of the form to a delegate: a FILLER row of
--            the same role restricted by `part_keys` to that part (they never sign), invited at once and
--            sharing the step of the signer. The signer cannot finish while a delegate is open, and can take
--            a part back before it is completed (the work already typed becomes theirs).
--
--   sign_signers.part_keys         NULL for everyone but a delegate: the parts a delegate may see and fill
--   sign_signers.delegated_by      the signer who handed the part over
--   sign_signers.forward_count     how many forwards this position has made (turn or part)
--   sign_signers.forward_history   [{ "name", "at" }] the names that held a position before a forward
--   sign_documents.allow_forwarding  the sender's switch, off by default; the template's own default lives in
--                                    its version's `defaults` JSON (template versions never change)
--
--   sign_invite_step        recreated: says why each person was invited
--   sign_complete_signer    recreated: a signer with an open delegate cannot finish; names the cause of the next step
--   sign_change_recipient   recreated: also for a person not yet invited; the new person gives their own consent
--   sign_move_signer        a person not yet invited moves to a later step
--   sign_forward_turn / sign_forward_part / sign_take_back_part
--
-- Everything here is for the service role only. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Columns
-- ------------------------------------------------------------
ALTER TABLE public.sign_documents
  ADD COLUMN IF NOT EXISTS allow_forwarding BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.sign_signers
  ADD COLUMN IF NOT EXISTS part_keys       TEXT[],
  ADD COLUMN IF NOT EXISTS delegated_by    UUID,
  ADD COLUMN IF NOT EXISTS forward_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS forward_history JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_signers_forward_count') THEN
    ALTER TABLE public.sign_signers ADD CONSTRAINT sign_signers_forward_count CHECK (forward_count BETWEEN 0 AND 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_signers_forward_history') THEN
    ALTER TABLE public.sign_signers ADD CONSTRAINT sign_signers_forward_history
      CHECK (jsonb_typeof(forward_history) = 'array' AND jsonb_array_length(forward_history) <= 10);
  END IF;
  -- a delegate is a filler of a signer's role, restricted to the parts they were given; nobody else has either column
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_signers_delegate_shape') THEN
    ALTER TABLE public.sign_signers ADD CONSTRAINT sign_signers_delegate_shape CHECK (
      (part_keys IS NULL) = (delegated_by IS NULL)
      AND (part_keys IS NULL OR (kind = 'filler' AND cardinality(part_keys) BETWEEN 1 AND 20)));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_signers_delegator_fk') THEN
    ALTER TABLE public.sign_signers ADD CONSTRAINT sign_signers_delegator_fk FOREIGN KEY (delegated_by, account_id)
      REFERENCES public.sign_signers (id, account_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sign_signers_delegator_idx ON public.sign_signers (delegated_by) WHERE delegated_by IS NOT NULL;

-- ------------------------------------------------------------
-- 2. The sender is told inside Halo when a turn is forwarded
-- ------------------------------------------------------------
DO $$
DECLARE
  v_def   TEXT;
  v_types TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';

  -- The live definition is either ANY ('{a,b}'::text[]) or ANY (ARRAY['a'::text, 'b'::text]); read both.
  IF v_def ~ '\{[^}]*\}' THEN
    v_types := string_to_array(substring(v_def FROM '\{([^}]*)\}'), ',');
  ELSE
    SELECT COALESCE(array_agg(DISTINCT m[1]), ARRAY[]::text[])
      INTO v_types
      FROM regexp_matches(COALESCE(v_def, ''), '''([^'']+)''::text', 'g') AS m;
  END IF;
  v_types := (SELECT array_agg(DISTINCT replace(x, '"', '') ORDER BY replace(x, '"', ''))
                FROM unnest(v_types || ARRAY['sign_forwarded']) AS x);

  IF EXISTS (SELECT 1 FROM public.notifications n WHERE n.type IS NOT NULL AND NOT (n.type = ANY (v_types))) THEN
    RAISE EXCEPTION 'notifications_type_check rebuild would drop a type in use: %', v_def;
  END IF;

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

-- ------------------------------------------------------------
-- 3. Internal helpers
-- ------------------------------------------------------------
-- An address as the audit trail shows it: a***@example.com
CREATE OR REPLACE FUNCTION public.sign_mask_email(p_email TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE WHEN position('@' IN COALESCE(p_email, '')) > 1
              THEN left(p_email, 1) || '***' || substr(p_email, position('@' IN p_email))
              ELSE '***' END;
$$;
REVOKE ALL ON FUNCTION public.sign_mask_email(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- The rules every forward obeys, in one place. `p_except` is a delegate the same person already is (a second
-- part handed to the same person goes to their existing row).
CREATE OR REPLACE FUNCTION public.sign_forward_check(
  d public.sign_documents, s public.sign_signers, p_name TEXT, p_email TEXT, p_max INTEGER, p_except UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF d.status NOT IN ('sent', 'in_progress') OR s.status NOT IN ('sent', 'viewed') THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  IF NOT d.allow_forwarding THEN
    RAISE EXCEPTION 'forward_not_allowed' USING ERRCODE = '23514';
  END IF;
  -- a delegate was handed a part to complete; handing it on again would be a chain
  IF s.part_keys IS NOT NULL THEN
    RAISE EXCEPTION 'delegate_cannot_forward' USING ERRCODE = '23514';
  END IF;
  IF s.forward_count >= p_max THEN
    RAISE EXCEPTION 'forward_limit' USING ERRCODE = '23514';
  END IF;
  IF p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 160 OR p_email IS NULL
     OR p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(p_email) > 254 THEN
    RAISE EXCEPTION 'forward_details' USING ERRCODE = '23514';
  END IF;
  IF lower(p_email) = lower(s.email) THEN
    RAISE EXCEPTION 'forward_same_person' USING ERRCODE = '23514';
  END IF;
  -- not someone already on the document for this role (and, with signing order, not anyone already on it)
  IF EXISTS (
    SELECT 1 FROM public.sign_signers x
     WHERE x.document_id = d.id AND x.id <> s.id AND x.id IS DISTINCT FROM p_except
       AND lower(x.email) = lower(p_email) AND (x.role_key = s.role_key OR d.sign_in_order)
  ) THEN
    RAISE EXCEPTION 'forward_already_signer' USING ERRCODE = '23514';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.sign_forward_check(public.sign_documents, public.sign_signers, TEXT, TEXT, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Invite the signers of one step, saying why
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.sign_invite_step(UUID, INTEGER, BOOLEAN, UUID);

CREATE OR REPLACE FUNCTION public.sign_invite_step(
  p_document UUID, p_step INTEGER, p_ordered BOOLEAN, p_user UUID, p_because JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_out     JSONB := '[]'::jsonb;
  r         RECORD;
  v_token   TEXT;
  v_n       INTEGER;
BEGIN
  SELECT account_id INTO v_account FROM public.sign_documents WHERE id = p_document;
  INSERT INTO public.sign_step_invites (document_id, account_id, step) VALUES (p_document, v_account, p_step)
  ON CONFLICT (document_id, step) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN v_out; -- this step was already invited (two signers finished at the same moment)
  END IF;
  FOR r IN
    SELECT s.id FROM public.sign_signers s
     WHERE s.document_id = p_document AND s.status = 'pending' AND s.part_keys IS NULL
       AND (NOT p_ordered OR s.order_no = p_step)
     ORDER BY s.order_no, s.created_at
  LOOP
    v_token := public.sign_issue_token(r.id);
    UPDATE public.sign_signers SET status = 'sent', invited_at = now() WHERE id = r.id;
    PERFORM public.sign_log(p_document, 'invited', CASE WHEN p_user IS NULL THEN 'system' ELSE 'user' END, r.id, p_user,
                            jsonb_build_object('step', p_step) || COALESCE(p_because, '{}'::jsonb));
    v_out := v_out || public.sign_signer_brief(r.id, v_token);
  END LOOP;
  RETURN v_out;
END;
$$;
ALTER FUNCTION public.sign_invite_step(UUID, INTEGER, BOOLEAN, UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_invite_step(UUID, INTEGER, BOOLEAN, UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 5. A signer finishes
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

  UPDATE public.sign_signers
     SET status = 'signed', signed_at = now(), ip = COALESCE(p_ip, ip), device = COALESCE(p_device, device),
         locale = COALESCE(p_locale, locale), consent_version = COALESCE(p_consent, consent_version)
   WHERE id = p_signer;
  IF d.status = 'sent' THEN
    UPDATE public.sign_documents SET status = 'in_progress' WHERE id = d.id;
  END IF;
  PERFORM public.sign_log(d.id, CASE WHEN s.kind = 'filler' THEN 'submitted' ELSE 'signed' END, 'signer', p_signer, NULL,
                          jsonb_build_object('role', s.role_key, 'consent', p_consent), p_ip, p_device);

  -- Everyone done: sealing starts.
  IF NOT EXISTS (SELECT 1 FROM public.sign_signers x WHERE x.document_id = d.id AND x.status <> 'signed') THEN
    UPDATE public.sign_documents SET status = 'sealing', sealing_started_at = NULL, sealing_attempts = 0, seal_error = NULL WHERE id = d.id;
    PERFORM public.sign_log(d.id, 'all_signed', 'system');
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
-- 6. A different person for someone, now also for a person not yet invited (no link until their step)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_change_recipient(
  p_signer UUID, p_name TEXT, p_email TEXT, p_phone TEXT, p_channel TEXT, p_actor UUID
) RETURNS JSONB
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
  IF d.status NOT IN ('sent', 'in_progress') OR s.status NOT IN ('pending', 'sent', 'viewed') THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  IF s.status = 'pending' THEN
    -- not invited yet: the details change and there is still no link (a different person is no longer a Halo countersigner)
    UPDATE public.sign_signers
       SET full_name = btrim(p_name), email = btrim(p_email), phone = NULLIF(btrim(p_phone), ''),
           channel = COALESCE(p_channel, channel), internal_user_id = NULL
     WHERE id = p_signer;
    PERFORM public.sign_log(d.id, 'recipient_changed', 'user', p_signer, p_actor,
                            jsonb_build_object('from_email', s.email, 'to_email', btrim(p_email)));
    RETURN public.sign_signer_brief(p_signer, NULL);
  END IF;
  -- the new person agrees to sign electronically themselves: nothing the earlier person agreed to carries over
  UPDATE public.sign_signers
     SET full_name = btrim(p_name), email = btrim(p_email), phone = NULLIF(btrim(p_phone), ''),
         channel = COALESCE(p_channel, channel), status = 'sent', viewed_at = NULL,
         consented_at = NULL, consent_version = NULL, internal_user_id = NULL
   WHERE id = p_signer;
  PERFORM public.sign_log(d.id, 'recipient_changed', 'user', p_signer, p_actor,
                          jsonb_build_object('from_email', s.email, 'to_email', btrim(p_email)));
  RETURN public.sign_signer_brief(p_signer, public.sign_issue_token(p_signer));
END;
$$;
ALTER FUNCTION public.sign_change_recipient(UUID, TEXT, TEXT, TEXT, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_change_recipient(UUID, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_change_recipient(UUID, TEXT, TEXT, TEXT, TEXT, UUID) TO service_role;

-- ------------------------------------------------------------
-- 7. A person whose step has not begun moves to a later step
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_move_signer(p_signer UUID, p_order_no INTEGER, p_actor UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s       public.sign_signers%ROWTYPE;
  d       public.sign_documents%ROWTYPE;
  v_began INTEGER;
BEGIN
  SELECT document_id INTO STRICT d.id FROM public.sign_signers WHERE id = p_signer;
  SELECT * INTO d FROM public.sign_documents WHERE id = d.id FOR UPDATE;
  SELECT * INTO s FROM public.sign_signers WHERE id = p_signer;
  IF d.status NOT IN ('sent', 'in_progress') OR s.status <> 'pending' OR s.part_keys IS NOT NULL OR NOT d.sign_in_order THEN
    RAISE EXCEPTION 'step_not_movable' USING ERRCODE = '23514';
  END IF;
  -- only into a step that has not begun: after the last step that was invited
  SELECT COALESCE(max(i.step), 0) INTO v_began FROM public.sign_step_invites i WHERE i.document_id = d.id;
  IF p_order_no IS NULL OR p_order_no < 1 OR p_order_no > 100 OR p_order_no <= v_began THEN
    RAISE EXCEPTION 'step_not_movable' USING ERRCODE = '23514';
  END IF;
  UPDATE public.sign_signers SET order_no = p_order_no WHERE id = p_signer;
  PERFORM public.sign_log(d.id, 'signer_moved', 'user', p_signer, p_actor,
                          jsonb_build_object('from_step', s.order_no, 'to_step', p_order_no));
  RETURN jsonb_build_object('signer_id', p_signer, 'order_no', p_order_no);
END;
$$;
ALTER FUNCTION public.sign_move_signer(UUID, INTEGER, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_move_signer(UUID, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_move_signer(UUID, INTEGER, UUID) TO service_role;

-- ------------------------------------------------------------
-- 8. Forward the whole turn
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_forward_turn(
  p_signer UUID, p_name TEXT, p_email TEXT, p_max INTEGER, p_ip TEXT, p_device TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s       public.sign_signers%ROWTYPE;
  d       public.sign_documents%ROWTYPE;
  v_name  TEXT := btrim(p_name);
  v_email TEXT := btrim(p_email);
  v_sig   TEXT[];
BEGIN
  SELECT document_id INTO STRICT d.id FROM public.sign_signers WHERE id = p_signer;
  SELECT * INTO d FROM public.sign_documents WHERE id = d.id FOR UPDATE;
  SELECT * INTO s FROM public.sign_signers WHERE id = p_signer;
  PERFORM public.sign_forward_check(d, s, v_name, v_email, p_max);

  -- A signature is a personal act: the forwarder's drawn or typed signature and initials are not kept. The rest of
  -- what they entered stays as a starting point, marked as forwarded, for the new person to read and change.
  SELECT COALESCE(array_agg(f ->> 'key'), ARRAY[]::text[]) INTO v_sig
    FROM jsonb_array_elements(COALESCE(d.fields_snapshot, '[]'::jsonb)) f
   WHERE f ->> 'type' IN ('signature', 'initials');
  DELETE FROM public.sign_answers WHERE document_id = d.id AND signer_id = p_signer AND field_key = ANY (v_sig);
  UPDATE public.sign_answers SET source = 'forwarded' WHERE document_id = d.id AND signer_id = p_signer AND source = 'signer';

  UPDATE public.sign_signers
     SET forward_history = forward_history || jsonb_build_array(jsonb_build_object('name', s.full_name, 'at', now())),
         forward_count = forward_count + 1,
         full_name = v_name, email = v_email, phone = NULL, channel = 'email', internal_user_id = NULL,
         status = 'sent', invited_at = now(), viewed_at = NULL, consented_at = NULL, consent_version = NULL,
         ip = NULL, device = NULL, locale = NULL, last_reminded_at = NULL, reminder_count = 0
   WHERE id = p_signer;

  PERFORM public.sign_log(d.id, 'forwarded', 'signer', p_signer, NULL,
                          jsonb_build_object('scope', 'turn', 'from_name', s.full_name, 'to_name', v_name,
                                             'to_email', public.sign_mask_email(v_email), 'count', s.forward_count + 1),
                          p_ip, p_device);

  -- Tell the sender inside Halo. A notification never undoes or blocks the forward itself.
  IF d.created_by IS NOT NULL AND EXISTS (SELECT 1 FROM public.profiles WHERE user_id = d.created_by AND account_id = d.account_id) THEN
    BEGIN
      INSERT INTO public.notifications (account_id, user_id, type, title, body, sign_document_id)
      VALUES (d.account_id, d.created_by, 'sign_forwarded',
              left('Forwarded: ' || COALESCE(d.reference, d.title), 200),
              left(s.full_name || ' forwarded their turn to ' || v_name, 200), d.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not create the Doc Sign forward notification for document %: %', d.id, SQLERRM;
    END;
  END IF;

  RETURN public.sign_signer_brief(p_signer, public.sign_issue_token(p_signer))
         || jsonb_build_object('forwarded_by', s.full_name, 'document_id', d.id, 'account_id', d.account_id, 'reference', d.reference);
END;
$$;
ALTER FUNCTION public.sign_forward_turn(UUID, TEXT, TEXT, INTEGER, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_forward_turn(UUID, TEXT, TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_forward_turn(UUID, TEXT, TEXT, INTEGER, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 9. Forward one part to a delegate
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_forward_part(
  p_signer UUID, p_part TEXT, p_name TEXT, p_email TEXT, p_max INTEGER, p_ip TEXT, p_device TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s          public.sign_signers%ROWTYPE;
  d          public.sign_documents%ROWTYPE;
  v_name     TEXT := btrim(p_name);
  v_email    TEXT := btrim(p_email);
  v_part     JSONB;
  v_delegate UUID;
BEGIN
  SELECT document_id INTO STRICT d.id FROM public.sign_signers WHERE id = p_signer;
  SELECT * INTO d FROM public.sign_documents WHERE id = d.id FOR UPDATE;
  SELECT * INTO s FROM public.sign_signers WHERE id = p_signer;

  -- a second part for someone who already holds one of this signer's parts goes to the same row
  SELECT x.id INTO v_delegate FROM public.sign_signers x
   WHERE x.delegated_by = p_signer AND lower(x.email) = lower(v_email) AND x.status IN ('sent', 'viewed')
   LIMIT 1;
  PERFORM public.sign_forward_check(d, s, v_name, v_email, p_max, v_delegate);

  SELECT p INTO v_part FROM jsonb_array_elements(COALESCE(d.form_snapshot -> 'parts', '[]'::jsonb)) p WHERE p ->> 'key' = p_part;
  IF v_part IS NULL OR v_part ->> 'role' IS DISTINCT FROM s.role_key THEN
    RAISE EXCEPTION 'forward_part_unknown' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sign_signers x WHERE x.document_id = d.id AND x.part_keys IS NOT NULL AND p_part = ANY (x.part_keys)) THEN
    RAISE EXCEPTION 'part_already_forwarded' USING ERRCODE = '23514';
  END IF;

  IF v_delegate IS NOT NULL THEN
    UPDATE public.sign_signers SET part_keys = array_append(part_keys, p_part) WHERE id = v_delegate;
  ELSE
    INSERT INTO public.sign_signers (account_id, document_id, role_key, kind, full_name, email, channel, order_no, status, invited_at, part_keys, delegated_by)
    VALUES (d.account_id, d.id, s.role_key, 'filler', v_name, v_email, 'email', s.order_no, 'sent', now(), ARRAY[p_part], s.id)
    RETURNING id INTO v_delegate;
  END IF;
  UPDATE public.sign_signers SET forward_count = forward_count + 1 WHERE id = p_signer;

  PERFORM public.sign_log(d.id, 'part_forwarded', 'signer', p_signer, NULL,
                          jsonb_build_object('part', p_part, 'from_name', s.full_name, 'to_name', v_name,
                                             'to_email', public.sign_mask_email(v_email), 'delegate', v_delegate::text,
                                             'count', s.forward_count + 1),
                          p_ip, p_device);

  RETURN public.sign_signer_brief(v_delegate, public.sign_issue_token(v_delegate))
         || jsonb_build_object('forwarded_by', s.full_name, 'part', p_part, 'document_id', d.id, 'account_id', d.account_id, 'reference', d.reference);
END;
$$;
ALTER FUNCTION public.sign_forward_part(UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_forward_part(UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_forward_part(UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 10. Take a part back (before the delegate has completed it)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_take_back_part(p_signer UUID, p_part TEXT, p_ip TEXT, p_device TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s      public.sign_signers%ROWTYPE;
  d      public.sign_documents%ROWTYPE;
  x      public.sign_signers%ROWTYPE;
  v_keys TEXT[];
  v_gone BOOLEAN := FALSE;
BEGIN
  SELECT document_id INTO STRICT d.id FROM public.sign_signers WHERE id = p_signer;
  SELECT * INTO d FROM public.sign_documents WHERE id = d.id FOR UPDATE;
  SELECT * INTO s FROM public.sign_signers WHERE id = p_signer;
  IF d.status NOT IN ('sent', 'in_progress') OR s.status NOT IN ('sent', 'viewed') THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO x FROM public.sign_signers WHERE delegated_by = p_signer AND p_part = ANY (part_keys);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'part_not_forwarded' USING ERRCODE = '23514';
  END IF;
  IF x.status = 'signed' THEN
    RAISE EXCEPTION 'part_already_completed' USING ERRCODE = '23514';
  END IF;

  -- What the delegate already typed for the part becomes the signer's (their own older answer to the same field gives way).
  SELECT COALESCE(array_agg(f ->> 'key'), ARRAY[]::text[]) INTO v_keys
    FROM jsonb_array_elements(COALESCE(d.form_snapshot -> 'fields', '[]'::jsonb)) f
   WHERE f ->> 'part' = p_part;
  DELETE FROM public.sign_answers a
   WHERE a.document_id = d.id AND a.signer_id = p_signer AND a.field_key = ANY (v_keys)
     AND EXISTS (SELECT 1 FROM public.sign_answers b WHERE b.document_id = d.id AND b.signer_id = x.id AND b.field_key = a.field_key);
  UPDATE public.sign_answers SET signer_id = p_signer, source = 'forwarded'
   WHERE document_id = d.id AND signer_id = x.id AND field_key = ANY (v_keys);
  -- the files uploaded for the part go with the answers
  UPDATE public.sign_document_files f SET signer_id = p_signer
   WHERE f.document_id = d.id AND f.signer_id = x.id
     AND f.id IN (SELECT (fl ->> 'id')::uuid
                    FROM public.sign_answers a,
                         jsonb_array_elements(CASE WHEN jsonb_typeof(a.value -> 'files') = 'array' THEN a.value -> 'files' ELSE '[]'::jsonb END) fl
                   WHERE a.document_id = d.id AND a.signer_id = p_signer AND a.field_key = ANY (v_keys));

  IF cardinality(x.part_keys) > 1 THEN
    UPDATE public.sign_signers SET part_keys = array_remove(part_keys, p_part) WHERE id = x.id;
  ELSE
    DELETE FROM public.sign_signers WHERE id = x.id; -- the link goes with the row
    v_gone := TRUE;
  END IF;

  PERFORM public.sign_log(d.id, 'part_taken_back', 'signer', p_signer, NULL,
                          jsonb_build_object('part', p_part, 'from_name', x.full_name, 'delegate', x.id::text), p_ip, p_device);
  RETURN jsonb_build_object('document_id', d.id, 'part', p_part, 'removed_delegate', v_gone);
END;
$$;
ALTER FUNCTION public.sign_take_back_part(UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_take_back_part(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_take_back_part(UUID, TEXT, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
