-- ============================================================
-- 158_sign_ceremony.sql
--
-- Doc Sign, work package 5 (send and sign): the state changes of a document in flight, done in the
-- database so each is one atomic step under a lock on the document row, whatever the app does.
-- The app never writes a signer's or a document's status itself; it calls these.
--
--   sign_send_document      draft -> sent: the frozen base file, the first invitations
--   sign_complete_signer    a signer finishes: the next step is invited once, or sealing starts
--   sign_decline_signer     a signer declines: the chain stops
--   sign_void_document      the sender cancels
--   sign_expire_due         documents past their expiry
--   sign_issue_token        (internal) a fresh link token; only its SHA-256 is stored
--   sign_rotate_token       resend: a new link, the old one dies
--   sign_change_recipient   a different name, email or phone for someone who has not signed
--   sign_mark_viewed        first time a signer opens their link
--   sign_claim_sealing      the sealing job takes documents, with a lease so two workers never share one
--   sign_finish_sealing / sign_fail_sealing
--
-- Link tokens are created when a signer is invited (not at send), so a signer whose turn has not come
-- has no link at all. The token is two random UUIDs (about 244 bits); the app receives it once, in the
-- result of the function that created it, and it exists nowhere else but the message sent.
--
-- Everything here is for the service role only. Idempotent.
-- ============================================================

ALTER TABLE public.sign_documents
  ADD COLUMN IF NOT EXISTS reminder_days       INTEGER[],
  ADD COLUMN IF NOT EXISTS sealing_started_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sealing_attempts    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seal_error          TEXT;

ALTER TABLE public.sign_signers
  ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_count   INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS sign_documents_sealing_idx ON public.sign_documents (sealing_started_at)
  WHERE status = 'sealing';

-- ------------------------------------------------------------
-- A link token. Internal: nothing but the functions below calls it.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_issue_token(p_signer UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token   TEXT := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_account UUID;
BEGIN
  SELECT s.account_id INTO v_account FROM public.sign_signers s WHERE s.id = p_signer;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'signer_not_found' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.sign_signer_secrets (signer_id, account_id, token_hash)
  VALUES (p_signer, v_account, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'))
  ON CONFLICT (signer_id) DO UPDATE
    SET token_hash = EXCLUDED.token_hash, code_hash = NULL, code_expires_at = NULL, code_attempts = 0, updated_at = now();
  RETURN v_token;
END;
$$;
ALTER FUNCTION public.sign_issue_token(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_issue_token(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- A signer as the app needs it to send the invitation.
CREATE OR REPLACE FUNCTION public.sign_signer_brief(p_signer UUID, p_token TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'signer_id', s.id, 'token', p_token, 'name', s.full_name, 'email', s.email, 'phone', s.phone,
    'channel', s.channel, 'role_key', s.role_key, 'kind', s.kind, 'order_no', s.order_no)
    FROM public.sign_signers s WHERE s.id = p_signer;
$$;
REVOKE ALL ON FUNCTION public.sign_signer_brief(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- Add an event to a document's chain.
CREATE OR REPLACE FUNCTION public.sign_log(
  p_document UUID, p_type TEXT, p_actor_type TEXT, p_signer UUID DEFAULT NULL, p_user UUID DEFAULT NULL,
  p_detail JSONB DEFAULT '{}'::jsonb, p_ip TEXT DEFAULT NULL, p_device TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.sign_events (account_id, document_id, type, actor_type, signer_id, actor_user_id, detail, ip, device)
  SELECT d.account_id, d.id, p_type, p_actor_type, p_signer, p_user, COALESCE(p_detail, '{}'::jsonb), p_ip, p_device
    FROM public.sign_documents d WHERE d.id = p_document;
$$;
ALTER FUNCTION public.sign_log(UUID, TEXT, TEXT, UUID, UUID, JSONB, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_log(UUID, TEXT, TEXT, UUID, UUID, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_log(UUID, TEXT, TEXT, UUID, UUID, JSONB, TEXT, TEXT) TO service_role;

-- Invite the signers of one step. Internal.
CREATE OR REPLACE FUNCTION public.sign_invite_step(p_document UUID, p_step INTEGER, p_ordered BOOLEAN, p_user UUID)
RETURNS JSONB
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
     WHERE s.document_id = p_document AND s.status = 'pending'
       AND (NOT p_ordered OR s.order_no = p_step)
     ORDER BY s.order_no, s.created_at
  LOOP
    v_token := public.sign_issue_token(r.id);
    UPDATE public.sign_signers SET status = 'sent', invited_at = now() WHERE id = r.id;
    PERFORM public.sign_log(p_document, 'invited', CASE WHEN p_user IS NULL THEN 'system' ELSE 'user' END, r.id, p_user,
                            jsonb_build_object('step', p_step));
    v_out := v_out || public.sign_signer_brief(r.id, v_token);
  END LOOP;
  RETURN v_out;
END;
$$;
ALTER FUNCTION public.sign_invite_step(UUID, INTEGER, BOOLEAN, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_invite_step(UUID, INTEGER, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- draft -> sent
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
  IF NOT EXISTS (SELECT 1 FROM public.sign_signers s WHERE s.document_id = p_document AND s.kind = 'signer') THEN
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
                       'signers', (SELECT count(*) FROM public.sign_signers s WHERE s.document_id = p_document)));

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
-- A signer opens their link for the first time
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_mark_viewed(p_signer UUID, p_ip TEXT, p_device TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.sign_signers%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.sign_signers WHERE id = p_signer FOR UPDATE;
  IF NOT FOUND OR s.status <> 'sent' THEN
    RETURN FALSE;
  END IF;
  UPDATE public.sign_signers SET status = 'viewed', viewed_at = now(), ip = COALESCE(p_ip, ip), device = COALESCE(p_device, device)
   WHERE id = p_signer;
  PERFORM public.sign_log(s.document_id, 'viewed', 'signer', p_signer, NULL, '{}'::jsonb, p_ip, p_device);
  RETURN TRUE;
END;
$$;
ALTER FUNCTION public.sign_mark_viewed(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_mark_viewed(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_mark_viewed(UUID, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- A signer finishes
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
  s      public.sign_signers%ROWTYPE;
  d      public.sign_documents%ROWTYPE;
  v_next INTEGER;
  v_in   JSONB := '[]'::jsonb;
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

  -- With signing order, the next step is invited once this step is complete.
  IF d.sign_in_order
     AND NOT EXISTS (SELECT 1 FROM public.sign_signers x WHERE x.document_id = d.id AND x.order_no = s.order_no AND x.status <> 'signed') THEN
    SELECT min(x.order_no) INTO v_next FROM public.sign_signers x WHERE x.document_id = d.id AND x.order_no > s.order_no;
    IF v_next IS NOT NULL THEN
      v_in := public.sign_invite_step(d.id, v_next, TRUE, NULL);
    END IF;
  END IF;
  RETURN jsonb_build_object('sealing', false, 'invited', v_in, 'account_id', d.account_id, 'reference', d.reference);
END;
$$;
ALTER FUNCTION public.sign_complete_signer(UUID, TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_complete_signer(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_complete_signer(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- A signer declines; the chain stops and every link stops working
-- ------------------------------------------------------------
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
  -- Links of people who have not finished stop working; signed signers keep theirs (to see the outcome).
  DELETE FROM public.sign_signer_secrets k
   USING public.sign_signers x
   WHERE k.signer_id = x.id AND x.document_id = d.id AND x.status <> 'signed';
  RETURN jsonb_build_object('account_id', d.account_id, 'reference', d.reference, 'document_id', d.id);
END;
$$;
ALTER FUNCTION public.sign_decline_signer(UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_decline_signer(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_decline_signer(UUID, TEXT, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- The sender cancels
-- ------------------------------------------------------------
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
  IF d.status IN ('completed', 'declined', 'expired', 'voided') THEN
    RAISE EXCEPTION 'document_already_final' USING ERRCODE = '23514';
  END IF;
  UPDATE public.sign_documents SET status = 'voided', void_reason = left(NULLIF(btrim(p_reason), ''), 1000) WHERE id = p_document;
  PERFORM public.sign_log(p_document, 'voided', 'user', NULL, p_actor, jsonb_build_object('reason', left(NULLIF(btrim(p_reason), ''), 1000)));
  DELETE FROM public.sign_signer_secrets k
   USING public.sign_signers x
   WHERE k.signer_id = x.id AND x.document_id = p_document;
  RETURN jsonb_build_object('account_id', d.account_id, 'reference', d.reference, 'was', d.status);
END;
$$;
ALTER FUNCTION public.sign_void_document(UUID, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_void_document(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_void_document(UUID, TEXT, UUID) TO service_role;

-- ------------------------------------------------------------
-- Expiry
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_expire_due(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r     RECORD;
  v_out JSONB := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT d.id, d.account_id, d.reference
      FROM public.sign_documents d
     WHERE d.status IN ('sent', 'in_progress') AND d.expires_at IS NOT NULL AND d.expires_at < now()
     ORDER BY d.expires_at
     LIMIT GREATEST(p_limit, 1)
       FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.sign_documents SET status = 'expired' WHERE id = r.id;
    PERFORM public.sign_log(r.id, 'expired', 'system');
    DELETE FROM public.sign_signer_secrets k USING public.sign_signers x
     WHERE k.signer_id = x.id AND x.document_id = r.id AND x.status <> 'signed';
    v_out := v_out || jsonb_build_object('document_id', r.id, 'account_id', r.account_id, 'reference', r.reference);
  END LOOP;
  RETURN v_out;
END;
$$;
ALTER FUNCTION public.sign_expire_due(INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_expire_due(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_expire_due(INTEGER) TO service_role;

-- ------------------------------------------------------------
-- Resend (a new link, the old one stops) and change of recipient
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_rotate_token(p_signer UUID, p_actor UUID, p_reason TEXT DEFAULT 'resent')
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
  IF d.status NOT IN ('sent', 'in_progress') OR s.status NOT IN ('sent', 'viewed') THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  PERFORM public.sign_log(d.id, p_reason, 'user', p_signer, p_actor);
  RETURN public.sign_signer_brief(p_signer, public.sign_issue_token(p_signer));
END;
$$;
ALTER FUNCTION public.sign_rotate_token(UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_rotate_token(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_rotate_token(UUID, UUID, TEXT) TO service_role;

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
  IF d.status NOT IN ('sent', 'in_progress') OR s.status NOT IN ('sent', 'viewed') THEN
    RAISE EXCEPTION 'signer_not_open' USING ERRCODE = '23514';
  END IF;
  UPDATE public.sign_signers
     SET full_name = btrim(p_name), email = btrim(p_email), phone = NULLIF(btrim(p_phone), ''),
         channel = COALESCE(p_channel, channel), status = 'sent', viewed_at = NULL
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
-- Sealing: the job takes documents with a lease, finishes or fails them
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_claim_sealing(p_limit INTEGER DEFAULT 2, p_lease_seconds INTEGER DEFAULT 300, p_max_attempts INTEGER DEFAULT 5)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r     RECORD;
  v_out JSONB := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT d.id, d.account_id, d.sealing_attempts
      FROM public.sign_documents d
     WHERE d.status = 'sealing'
       AND (d.sealing_started_at IS NULL OR d.sealing_started_at < now() - make_interval(secs => GREATEST(p_lease_seconds, 30)))
     ORDER BY COALESCE(d.sealing_started_at, '-infinity'::timestamptz), d.created_at
     LIMIT GREATEST(p_limit, 1)
       FOR UPDATE SKIP LOCKED
  LOOP
    IF r.sealing_attempts >= p_max_attempts THEN
      UPDATE public.sign_documents SET status = 'failed', seal_error = COALESCE(seal_error, 'Sealing did not finish') WHERE id = r.id;
      PERFORM public.sign_log(r.id, 'seal_failed', 'system', NULL, NULL, jsonb_build_object('attempts', r.sealing_attempts));
      CONTINUE;
    END IF;
    UPDATE public.sign_documents SET sealing_started_at = now(), sealing_attempts = sealing_attempts + 1 WHERE id = r.id;
    v_out := v_out || jsonb_build_object('document_id', r.id, 'account_id', r.account_id, 'attempt', r.sealing_attempts + 1);
  END LOOP;
  RETURN v_out;
END;
$$;
ALTER FUNCTION public.sign_claim_sealing(INTEGER, INTEGER, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_claim_sealing(INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_claim_sealing(INTEGER, INTEGER, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.sign_finish_sealing(p_document UUID, p_final_path TEXT, p_final_sha256 TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.sign_documents%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.sign_documents WHERE id = p_document FOR UPDATE;
  IF NOT FOUND OR d.status <> 'sealing' THEN
    RAISE EXCEPTION 'document_not_sealing' USING ERRCODE = '23514';
  END IF;
  UPDATE public.sign_documents
     SET status = 'completed', final_path = p_final_path, final_sha256 = p_final_sha256, seal_error = NULL,
         retain_until = COALESCE(retain_until,
           now() + make_interval(years => COALESCE((SELECT st.retention_years FROM public.sign_settings st WHERE st.account_id = d.account_id), 7)))
   WHERE id = p_document;
  PERFORM public.sign_log(p_document, 'sealed', 'system', NULL, NULL, jsonb_build_object('final_sha256', p_final_sha256));
  PERFORM public.sign_log(p_document, 'completed', 'system');
  RETURN jsonb_build_object('account_id', d.account_id, 'reference', d.reference);
END;
$$;
ALTER FUNCTION public.sign_finish_sealing(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_finish_sealing(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_finish_sealing(UUID, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.sign_fail_sealing(p_document UUID, p_error TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Leave the document in 'sealing' so the job retries it after the lease; record why it failed.
  UPDATE public.sign_documents SET seal_error = left(p_error, 500), sealing_started_at = now() WHERE id = p_document AND status = 'sealing';
  PERFORM public.sign_log(p_document, 'seal_attempt_failed', 'system', NULL, NULL, jsonb_build_object('error', left(p_error, 200)));
END;
$$;
ALTER FUNCTION public.sign_fail_sealing(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_fail_sealing(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_fail_sealing(UUID, TEXT) TO service_role;
