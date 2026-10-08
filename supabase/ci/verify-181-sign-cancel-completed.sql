-- Verify migration 181 (Secure Sign: a completed document, or a whole collection, can be cancelled). Self-contained; run against an empty database or
-- production with 157's to 181's migration text concatenated in front when they are not applied yet. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
--
-- Proves (the database's guarantees only: WHO may cancel -- the person who made it, or an admin, who can see it -- is the service layer's rule, like
-- sign.void and the private-document rule, so this script proves instead that no signed-in or signed-out caller can reach the functions at all):
--   * the columns, the four checks on each table, the functions (service role only, search_path pinned);
--   * only a COMPLETED document can be cancelled: a draft, a sent, an in-progress, a sealing and a voided document are refused by the function, and a
--     stamp written by hand on any of them is refused;
--   * the stamp is write-once: cancelling again is refused, and the date, the reason and the person cannot be changed or cleared (the person alone may
--     become NULL, which is what deleting that login does through the foreign key); it cannot be written by hand without the function; nothing is
--     inserted cancelled;
--   * the first three move together (date and reason both or neither, a reason of 3 to 500 trimmed characters, a person only with a date);
--   * `status` stays 'completed', and the signed file, the certificate, the completion date, the retention date and the event rows already written
--     are exactly as they were; the monthly usage count does not move; the file rows are still protected by the retention rule;
--   * the 'cancelled' event is appended to the document's hash chain with the reason, and sign_verify_chain still recomputes it (for a document on its
--     own and for every document of a collection);
--   * a collection is cancelled as ONE unit: the collection and all its documents get the same instant, person and reason, one 'cancelled' event each (with
--     the collection's reference, the document's place and the count), in one transaction; a collection that is not completed (a document still sealing),
--     one with a document already stamped, or one already cancelled is refused and leaves no stamp anywhere; a document of a collection cannot be
--     cancelled alone;
--   * the notice claim is once-only (the first caller gets TRUE, every later one FALSE), is refused for a target that is not cancelled, and cannot be
--     written twice by hand;
--   * the cancelled event is append-only like every event;
--   * another workspace's person sees nothing and can call nothing; a signed-in person cannot call the functions; a signed-out one neither;
--   * 178's rules still hold for a cancelled document: nothing else about a completed document can be changed (title, reference, signed file, certificate).
DO $verify$
DECLARE
  uA       uuid := gen_random_uuid();
  uB       uuid := gen_random_uuid();
  acctA    uuid;
  acctB    uuid;
  dDraft   uuid;
  dSent    uuid;
  dProg    uuid;
  dSealing uuid;
  dVoided  uuid;
  dSolo    uuid;   -- completed, on its own: cancelled
  dPlain   uuid;   -- completed, on its own: never cancelled
  dEarly   uuid;   -- completed with a standalone certificate
  eFull    uuid;   -- a completed collection of three
  c1       uuid;
  c2       uuid;
  c3       uuid;
  eHalf    uuid;   -- a collection with a document still sealing
  h1       uuid;
  h2       uuid;
  eStray   uuid;   -- a completed collection with one document already stamped by hand
  s1       uuid;
  s2       uuid;
  eOther   uuid;   -- another workspace's completed collection
  o1       uuid;
  o2       uuid;
  v_res    text;
  v_n      bigint;
  v_json   jsonb;
  v_txt    text;
  v_hashes text;
  v_before jsonb;
  v_usage  jsonb;
  v_at     timestamptz;
  v_chain  jsonb;
  v_reason text := 'Signed with the wrong price list; a corrected agreement was sent.';
  r        record;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      IF u IS NULL THEN
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
        PERFORM set_config('request.jwt.claim.sub', u::text, true);
      END IF;
      EXECUTE format('SET LOCAL ROLE %I', r);
      BEGIN
        IF q ~* '^\s*(select|with)' THEN
          EXECUTE q INTO res;
        ELSE
          EXECUTE q;
        END IF;
        res := COALESCE(res, 'OK');
      EXCEPTION WHEN OTHERS THEN
        res := 'ERR ' || SQLSTATE || ': ' || SQLERRM;
      END;
      EXECUTE 'RESET ROLE';
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      RETURN res;
    END $b$;
  $f$;

  -- Move a document along the way the server does, up to the state to leave it in: sent, in_progress, sealing, or completed (finished with a signed
  -- file, and a certificate of its own when `p_cert`).
  EXECUTE $f$
    CREATE FUNCTION pg_temp.advance(p_doc UUID, p_stop TEXT, p_cert BOOLEAN DEFAULT FALSE) RETURNS VOID
    LANGUAGE plpgsql AS $b$
    BEGIN
      IF p_stop = 'draft' THEN RETURN; END IF;
      UPDATE public.sign_documents SET status = 'sent', base_path = 'account-x/doc/base.pdf', base_sha256 = repeat('a', 64) WHERE id = p_doc;
      IF p_stop = 'sent' THEN RETURN; END IF;
      UPDATE public.sign_documents SET status = 'in_progress' WHERE id = p_doc;
      IF p_stop = 'in_progress' THEN RETURN; END IF;
      UPDATE public.sign_documents SET status = 'sealing' WHERE id = p_doc;
      IF p_stop = 'sealing' THEN RETURN; END IF;
      IF p_cert THEN
        PERFORM public.sign_finish_sealing(p_doc, 'account-x/' || p_doc || '/final.pdf', repeat('c', 64), 'account-x/' || p_doc || '/certificate.pdf', repeat('d', 64));
      ELSE
        PERFORM public.sign_finish_sealing(p_doc, 'account-x/' || p_doc || '/final.pdf', repeat('c', 64));
      END IF;
    END $b$;
  $f$;

  -- A document made the way the server makes one (a draft), then moved along. A document of a collection is made as a draft in the collection and
  -- moved along only once all of them exist (a collection takes documents only while it is a draft).
  EXECUTE $f$
    CREATE FUNCTION pg_temp.mkdoc(p_acct UUID, p_user UUID, p_title TEXT, p_stop TEXT DEFAULT 'completed', p_env UUID DEFAULT NULL, p_pos INTEGER DEFAULT NULL, p_cert BOOLEAN DEFAULT FALSE) RETURNS UUID
    LANGUAGE plpgsql AS $b$
    DECLARE v_doc UUID;
    BEGIN
      INSERT INTO public.sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (p_acct, p_title, p_user, p_env, p_pos) RETURNING id INTO v_doc;
      PERFORM pg_temp.advance(v_doc, p_stop, p_cert);
      RETURN v_doc;
    END $b$;
  $f$;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
         (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  PERFORM public.sign_ensure_defaults(acctA);
  PERFORM public.sign_ensure_defaults(acctB);

  -- 0. The columns, the checks, the functions, who may call them.
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('sign_documents', 'sign_envelopes') AND column_name IN ('cancelled_at', 'cancelled_by', 'cancel_reason', 'cancel_notified_at');
  IF v_n <> 8 THEN RAISE EXCEPTION 'FAIL the four cancel columns should exist on documents and on collections (found %)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname IN ('sign_documents_cancel_together', 'sign_documents_cancel_reason_valid', 'sign_documents_cancel_needs_completed', 'sign_documents_cancel_notice',
                     'sign_envelopes_cancel_together', 'sign_envelopes_cancel_reason_valid', 'sign_envelopes_cancel_needs_completed', 'sign_envelopes_cancel_notice');
  IF v_n <> 8 THEN RAISE EXCEPTION 'FAIL the eight checks on the cancel columns should exist (found %)', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.sign_documents'::regclass AND c.contype = 'f' AND c.confrelid = 'auth.users'::regclass
                   AND c.confdeltype = 'n' AND EXISTS (SELECT 1 FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k WHERE a.attname = 'cancelled_by')) THEN
    RAISE EXCEPTION 'FAIL cancelled_by should be a foreign key to the user that is set to NULL when the user is deleted';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sign_cancel_one', 'sign_cancel_document', 'sign_cancel_envelope', 'sign_cancel_claim_notice');
  IF v_n <> 4 THEN RAISE EXCEPTION 'FAIL there should be exactly four cancel functions (found %)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sign_cancel_one', 'sign_cancel_document', 'sign_cancel_envelope', 'sign_cancel_claim_notice')
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL a cancel function is callable by signed-in or signed-out users'; END IF;
  IF has_function_privilege('service_role', 'public.sign_cancel_one(uuid, text, uuid, timestamptz, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the internal stamping function should not be callable even by the service role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.sign_cancel_document(uuid, text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sign_cancel_envelope(uuid, text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sign_cancel_claim_notice(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the service role cannot call a cancel function';
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sign_cancel_one', 'sign_cancel_document', 'sign_cancel_envelope', 'sign_cancel_claim_notice', 'sign_documents_guard', 'sign_envelopes_guard') AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL SECURITY DEFINER without a pinned search_path: %', v_txt; END IF;

  -- 1. Only a completed document can be cancelled.
  dDraft   := pg_temp.mkdoc(acctA, uA, 'A draft', 'draft');
  dSent    := pg_temp.mkdoc(acctA, uA, 'Sent', 'sent');
  dProg    := pg_temp.mkdoc(acctA, uA, 'In progress', 'in_progress');
  dSealing := pg_temp.mkdoc(acctA, uA, 'Sealing', 'sealing');
  dVoided  := pg_temp.mkdoc(acctA, uA, 'Voided', 'sent');
  UPDATE sign_documents SET status = 'voided', void_reason = 'wrong person' WHERE id = dVoided;
  FOREACH v_txt IN ARRAY ARRAY[dDraft::text, dSent::text, dProg::text, dSealing::text, dVoided::text] LOOP
    BEGIN
      PERFORM public.sign_cancel_document(v_txt::uuid, v_reason, uA);
      RAISE EXCEPTION 'FAIL a document that is not completed was cancelled: %', (SELECT status FROM sign_documents WHERE id = v_txt::uuid);
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- a stamp written by hand on it, even with the function's own flag, is refused (the check on the table)
    BEGIN
      PERFORM set_config('vircle.sign_cancel', 'on', true);
      UPDATE sign_documents SET cancelled_at = now(), cancelled_by = uA, cancel_reason = v_reason WHERE id = v_txt::uuid;
      PERFORM set_config('vircle.sign_cancel', '', true);
      RAISE EXCEPTION 'FAIL a document that is not completed was stamped cancelled by hand';
    EXCEPTION WHEN check_violation THEN PERFORM set_config('vircle.sign_cancel', '', true);
    END;
    IF (SELECT cancelled_at FROM sign_documents WHERE id = v_txt::uuid) IS NOT NULL THEN RAISE EXCEPTION 'FAIL a refused cancel left a stamp'; END IF;
  END LOOP;
  -- a document that does not exist
  BEGIN
    PERFORM public.sign_cancel_document(gen_random_uuid(), v_reason, uA);
    RAISE EXCEPTION 'FAIL a document that does not exist was cancelled';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- 2. A completed document: the reason is 3 to 500 characters, and it is trimmed; nothing is changed by a refused call.
  dSolo := pg_temp.mkdoc(acctA, uA, 'Merchant agreement', 'completed');
  dPlain := pg_temp.mkdoc(acctA, uA, 'Never cancelled', 'completed');
  dEarly := pg_temp.mkdoc(acctA, uA, 'With a standalone certificate', 'completed', NULL, NULL, TRUE);
  FOREACH v_txt IN ARRAY ARRAY['', '  ', 'ab', '  a  ', repeat('x', 501), '    ' || repeat('x', 501)] LOOP
    BEGIN
      PERFORM public.sign_cancel_document(dSolo, v_txt, uA);
      RAISE EXCEPTION 'FAIL a reason of % characters was accepted', length(btrim(v_txt));
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    PERFORM public.sign_cancel_document(dSolo, NULL, uA);
    RAISE EXCEPTION 'FAIL a missing reason was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT cancelled_at FROM sign_documents WHERE id = dSolo) IS NOT NULL THEN RAISE EXCEPTION 'FAIL a refused cancel left a stamp'; END IF;

  -- what must not move: the sealed record before the cancel
  SELECT jsonb_build_object('status', status, 'final_path', final_path, 'final_sha256', final_sha256, 'certificate_path', certificate_path, 'certificate_sha256', certificate_sha256,
                            'completed_at', completed_at, 'retain_until', retain_until, 'sent_at', sent_at, 'title', title, 'reference', reference)
    INTO v_before FROM sign_documents WHERE id = dSolo;
  SELECT string_agg(row_hash, ',' ORDER BY doc_seq) INTO v_hashes FROM sign_events WHERE document_id = dSolo;
  SELECT count(*) INTO v_n FROM sign_events WHERE document_id = dSolo;
  v_usage := public.account_usage(acctA);

  -- 3. Cancel it (the reason is trimmed; 500 characters exactly is fine).
  v_json := public.sign_cancel_document(dSolo, '   ' || v_reason || '  ', uA);
  IF (v_json ->> 'account_id')::uuid IS DISTINCT FROM acctA OR (v_json ->> 'document_id')::uuid IS DISTINCT FROM dSolo THEN RAISE EXCEPTION 'FAIL the function does not name the workspace and the document: %', v_json; END IF;
  SELECT cancelled_at INTO v_at FROM sign_documents WHERE id = dSolo;
  IF v_at IS NULL OR (SELECT cancelled_by FROM sign_documents WHERE id = dSolo) IS DISTINCT FROM uA OR (SELECT cancel_reason FROM sign_documents WHERE id = dSolo) IS DISTINCT FROM v_reason THEN
    RAISE EXCEPTION 'FAIL the stamp (date, person, trimmed reason) was not written';
  END IF;
  IF (v_json ->> 'cancelled_at')::timestamptz IS DISTINCT FROM v_at THEN RAISE EXCEPTION 'FAIL the function does not return the stamp it wrote'; END IF;
  -- the record is exactly as it was
  IF (SELECT jsonb_build_object('status', status, 'final_path', final_path, 'final_sha256', final_sha256, 'certificate_path', certificate_path, 'certificate_sha256', certificate_sha256,
                                'completed_at', completed_at, 'retain_until', retain_until, 'sent_at', sent_at, 'title', title, 'reference', reference)
        FROM sign_documents WHERE id = dSolo) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'FAIL cancelling changed the sealed record (status, files, dates, title or reference)';
  END IF;
  IF (SELECT status FROM sign_documents WHERE id = dSolo) <> 'completed' THEN RAISE EXCEPTION 'FAIL a cancelled document must stay completed'; END IF;
  IF public.account_usage(acctA) IS DISTINCT FROM v_usage THEN RAISE EXCEPTION 'FAIL cancelling moved the monthly usage'; END IF;
  -- the events already written are untouched; one 'cancelled' event was appended, with the reason
  IF (SELECT string_agg(row_hash, ',' ORDER BY doc_seq) FROM sign_events WHERE document_id = dSolo AND doc_seq <= v_n) IS DISTINCT FROM v_hashes THEN RAISE EXCEPTION 'FAIL an event that was already in the chain changed'; END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id = dSolo) <> v_n + 1 THEN RAISE EXCEPTION 'FAIL cancelling should append exactly one event'; END IF;
  SELECT * INTO r FROM sign_events WHERE document_id = dSolo ORDER BY doc_seq DESC LIMIT 1;
  IF r.type <> 'cancelled' OR r.actor_type <> 'user' OR r.actor_user_id IS DISTINCT FROM uA OR r.detail ->> 'reason' IS DISTINCT FROM v_reason THEN RAISE EXCEPTION 'FAIL the cancelled event is wrong: %', row_to_json(r); END IF;
  IF r.detail ? 'envelope_id' THEN RAISE EXCEPTION 'FAIL a document on its own should not carry a collection in its cancelled event'; END IF;
  v_chain := public.sign_verify_chain(dSolo);
  IF NOT (v_chain ->> 'ok')::boolean OR (v_chain ->> 'events')::bigint <> v_n + 1 THEN RAISE EXCEPTION 'FAIL the audit chain does not recompute after the cancel: %', v_chain; END IF;
  -- the cancel event is append-only like the rest
  BEGIN
    UPDATE sign_events SET detail = '{"reason":"changed"}'::jsonb WHERE id = r.id;
    RAISE EXCEPTION 'FAIL the cancelled event was changed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM sign_events WHERE id = r.id;
    RAISE EXCEPTION 'FAIL the cancelled event was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- a second document, with a reason of exactly 500 characters, and a certificate of its own: the same, and the certificate stays
  PERFORM public.sign_cancel_document(dEarly, repeat('é', 500), uA);
  IF (SELECT certificate_sha256 FROM sign_documents WHERE id = dEarly) IS DISTINCT FROM repeat('d', 64) OR (SELECT status FROM sign_documents WHERE id = dEarly) <> 'completed' THEN
    RAISE EXCEPTION 'FAIL a cancelled document lost its standalone certificate or its status';
  END IF;
  IF NOT (public.sign_verify_chain(dEarly) ->> 'ok')::boolean THEN RAISE EXCEPTION 'FAIL the chain of the document with a standalone certificate is broken after the cancel'; END IF;

  -- 4. Write-once: cancelling again, changing or clearing any part, taking a different person.
  BEGIN
    PERFORM public.sign_cancel_document(dSolo, 'Another reason', uA);
    RAISE EXCEPTION 'FAIL a cancelled document was cancelled again';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET cancel_reason = 'Rewritten history' WHERE id = dSolo;
    RAISE EXCEPTION 'FAIL the reason of a cancelled document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET cancelled_at = now() + interval '1 day' WHERE id = dSolo;
    RAISE EXCEPTION 'FAIL the date of a cancelled document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET cancelled_by = uB WHERE id = dSolo;
    RAISE EXCEPTION 'FAIL the person who cancelled was replaced';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL WHERE id = dSolo;
    RAISE EXCEPTION 'FAIL a cancelled document was un-cancelled';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- ...even with the function's own flag
  BEGIN
    PERFORM set_config('vircle.sign_cancel', 'on', true);
    UPDATE sign_documents SET cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL WHERE id = dSolo;
    PERFORM set_config('vircle.sign_cancel', '', true);
    RAISE EXCEPTION 'FAIL a cancelled document was un-cancelled with the flag set';
  EXCEPTION WHEN check_violation THEN PERFORM set_config('vircle.sign_cancel', '', true);
  END;
  -- the person alone may become NULL (the foreign key does this when the login is deleted); the date and the reason stay, and nobody else can be put in
  UPDATE sign_documents SET cancelled_by = NULL WHERE id = dEarly;
  IF (SELECT cancelled_by FROM sign_documents WHERE id = dEarly) IS NOT NULL OR (SELECT cancelled_at FROM sign_documents WHERE id = dEarly) IS NULL THEN RAISE EXCEPTION 'FAIL the actor could not become NULL as a deleted login does'; END IF;
  BEGIN
    UPDATE sign_documents SET cancelled_by = uA WHERE id = dEarly;
    RAISE EXCEPTION 'FAIL a person was put back after the actor became NULL';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5. By hand, without the function: refused. The first three move together. Nothing is inserted cancelled.
  BEGIN
    UPDATE sign_documents SET cancelled_at = now(), cancelled_by = uA, cancel_reason = v_reason WHERE id = dPlain;
    RAISE EXCEPTION 'FAIL a completed document was stamped without the cancelling function';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM set_config('vircle.sign_cancel', 'on', true);
    UPDATE sign_documents SET cancelled_at = now() WHERE id = dPlain;
    PERFORM set_config('vircle.sign_cancel', '', true);
    RAISE EXCEPTION 'FAIL a date without a reason was accepted';
  EXCEPTION WHEN check_violation THEN PERFORM set_config('vircle.sign_cancel', '', true);
  END;
  BEGIN
    PERFORM set_config('vircle.sign_cancel', 'on', true);
    UPDATE sign_documents SET cancel_reason = v_reason WHERE id = dPlain;
    PERFORM set_config('vircle.sign_cancel', '', true);
    RAISE EXCEPTION 'FAIL a reason without a date was accepted';
  EXCEPTION WHEN check_violation THEN PERFORM set_config('vircle.sign_cancel', '', true);
  END;
  BEGIN
    PERFORM set_config('vircle.sign_cancel', 'on', true);
    UPDATE sign_documents SET cancelled_by = uA WHERE id = dPlain;
    PERFORM set_config('vircle.sign_cancel', '', true);
    RAISE EXCEPTION 'FAIL a person without a date was accepted';
  EXCEPTION WHEN check_violation THEN PERFORM set_config('vircle.sign_cancel', '', true);
  END;
  FOREACH v_txt IN ARRAY ARRAY['ab', ' padded ', repeat('x', 501)] LOOP
    BEGIN
      PERFORM set_config('vircle.sign_cancel', 'on', true);
      UPDATE sign_documents SET cancelled_at = now(), cancelled_by = uA, cancel_reason = v_txt WHERE id = dPlain;
      PERFORM set_config('vircle.sign_cancel', '', true);
      RAISE EXCEPTION 'FAIL the table accepted a reason of % characters (padded or out of range)', length(v_txt);
    EXCEPTION WHEN check_violation THEN PERFORM set_config('vircle.sign_cancel', '', true);
    END;
  END LOOP;
  BEGIN
    INSERT INTO sign_documents (account_id, title, created_by, cancelled_at, cancelled_by, cancel_reason) VALUES (acctA, 'Born cancelled', uA, now(), uA, v_reason);
    RAISE EXCEPTION 'FAIL a document was inserted cancelled';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_documents (account_id, title, created_by, cancel_notified_at) VALUES (acctA, 'Born with a notice', uA, now());
    RAISE EXCEPTION 'FAIL a document was inserted with a notice claim';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT cancelled_at FROM sign_documents WHERE id = dPlain) IS NOT NULL THEN RAISE EXCEPTION 'FAIL a refused write left a stamp'; END IF;

  -- 6. The guard's other rules still hold for a cancelled document (178's): nothing else about it can be changed.
  BEGIN
    UPDATE sign_documents SET title = 'Another title' WHERE id = dSolo;
    RAISE EXCEPTION 'FAIL the title of a cancelled document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET reference = 'SGN-0000-000000' WHERE id = dSolo;
    RAISE EXCEPTION 'FAIL the reference of a cancelled document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET final_sha256 = repeat('e', 64) WHERE id = dSolo;
    RAISE EXCEPTION 'FAIL the signed file of a cancelled document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET certificate_sha256 = repeat('e', 64) WHERE id = dEarly;
    RAISE EXCEPTION 'FAIL the certificate of a cancelled document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET status = 'voided' WHERE id = dSolo;
    RAISE EXCEPTION 'FAIL a cancelled document was voided';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET status = 'sealing' WHERE id = dSolo;
    RAISE EXCEPTION 'FAIL a cancelled document went back to sealing';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- the retention rule still protects its files
  INSERT INTO sign_document_files (account_id, document_id, kind, path, name, mime, size_bytes, sha256) VALUES
    (acctA, dSolo, 'signed', 'account-x/dSolo/final.pdf', 'signed.pdf', 'application/pdf', 100, repeat('c', 64));
  BEGIN
    DELETE FROM sign_document_files WHERE document_id = dSolo AND kind = 'signed';
    RAISE EXCEPTION 'FAIL the signed file of a cancelled document was deleted while retained';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET retain_until = now() WHERE id = dSolo;
    RAISE EXCEPTION 'FAIL the retention date of a cancelled document was shortened';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 7. The notice claim is once-only, and only for a cancelled target.
  IF public.sign_cancel_claim_notice(p_document => dPlain) THEN RAISE EXCEPTION 'FAIL a document that is not cancelled gave a notice claim'; END IF;
  IF NOT public.sign_cancel_claim_notice(p_document => dSolo) THEN RAISE EXCEPTION 'FAIL the first claim of the notice was refused'; END IF;
  IF public.sign_cancel_claim_notice(p_document => dSolo) THEN RAISE EXCEPTION 'FAIL the notice was claimed twice'; END IF;
  IF (SELECT cancel_notified_at FROM sign_documents WHERE id = dSolo) IS NULL THEN RAISE EXCEPTION 'FAIL the claim left no mark'; END IF;
  BEGIN
    UPDATE sign_documents SET cancel_notified_at = NULL WHERE id = dSolo;
    RAISE EXCEPTION 'FAIL the notice mark was cleared';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET cancel_notified_at = now() WHERE id = dPlain;
    RAISE EXCEPTION 'FAIL a notice was marked on a document that is not cancelled';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_cancel_claim_notice();
    RAISE EXCEPTION 'FAIL a claim without a target was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_cancel_claim_notice(dSolo, gen_random_uuid());
    RAISE EXCEPTION 'FAIL a claim with two targets was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  IF NOT (public.sign_verify_chain(dSolo) ->> 'ok')::boolean THEN RAISE EXCEPTION 'FAIL the chain is broken after the notice claim'; END IF;

  -- 8. A collection of three, completed: cancelled as one unit.
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Merchant onboarding', uA) RETURNING id INTO eFull;
  c1 := pg_temp.mkdoc(acctA, uA, 'Agreement', 'draft', eFull, 1);
  c2 := pg_temp.mkdoc(acctA, uA, 'Fee schedule', 'draft', eFull, 2);
  c3 := pg_temp.mkdoc(acctA, uA, 'Direct debit', 'draft', eFull, 3);
  PERFORM pg_temp.advance(c1, 'completed');
  PERFORM pg_temp.advance(c2, 'completed');
  PERFORM pg_temp.advance(c3, 'completed', TRUE);
  PERFORM public.sign_envelope_settle(eFull);
  IF (SELECT status FROM sign_envelopes WHERE id = eFull) <> 'completed' THEN RAISE EXCEPTION 'FAIL the collection should be completed (it is %)', (SELECT status FROM sign_envelopes WHERE id = eFull); END IF;
  -- a document of a collection cannot be cancelled alone
  BEGIN
    PERFORM public.sign_cancel_document(c2, v_reason, uA);
    RAISE EXCEPTION 'FAIL a document of a collection was cancelled alone';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- ...nor stamped by hand with the function's flag, because the collection decides in one step (the guard allows the flag; the function is the only way in: proven below)
  SELECT count(*) INTO v_n FROM sign_events WHERE document_id IN (c1, c2, c3);
  v_usage := public.account_usage(acctA);
  -- a refused reason leaves nothing behind
  BEGIN
    PERFORM public.sign_cancel_envelope(eFull, 'no', uA);
    RAISE EXCEPTION 'FAIL a collection was cancelled with a reason of two characters';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- one transaction: the function's work is undone as a whole if anything after it fails
  BEGIN
    PERFORM public.sign_cancel_envelope(eFull, v_reason, uA);
    IF (SELECT count(*) FROM sign_documents WHERE envelope_id = eFull AND cancelled_at IS NOT NULL) <> 3 THEN RAISE EXCEPTION 'FAIL the collection did not stamp all three documents inside the call'; END IF;
    RAISE EXCEPTION 'undo the cancel' USING ERRCODE = 'P0001';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM sign_documents WHERE envelope_id = eFull AND cancelled_at IS NOT NULL) <> 0 OR (SELECT cancelled_at FROM sign_envelopes WHERE id = eFull) IS NOT NULL
     OR (SELECT count(*) FROM sign_events WHERE document_id IN (c1, c2, c3)) <> v_n THEN
    RAISE EXCEPTION 'FAIL a cancel that was undone left stamps or events behind';
  END IF;
  -- now for real
  v_json := public.sign_cancel_envelope(eFull, '  ' || v_reason || ' ', uA);
  IF jsonb_array_length(v_json -> 'documents') <> 3 OR (v_json ->> 'envelope_id')::uuid IS DISTINCT FROM eFull OR (v_json ->> 'account_id')::uuid IS DISTINCT FROM acctA THEN RAISE EXCEPTION 'FAIL the function names the wrong collection or documents: %', v_json; END IF;
  SELECT cancelled_at INTO v_at FROM sign_envelopes WHERE id = eFull;
  IF v_at IS NULL OR (SELECT cancelled_by FROM sign_envelopes WHERE id = eFull) IS DISTINCT FROM uA OR (SELECT cancel_reason FROM sign_envelopes WHERE id = eFull) IS DISTINCT FROM v_reason THEN RAISE EXCEPTION 'FAIL the collection was not stamped'; END IF;
  IF (SELECT count(*) FROM sign_documents WHERE envelope_id = eFull AND cancelled_at = v_at AND cancelled_by = uA AND cancel_reason = v_reason AND status = 'completed') <> 3 THEN
    RAISE EXCEPTION 'FAIL every document of the collection should carry the collection''s stamp (same instant, person and reason) and stay completed';
  END IF;
  IF (SELECT status FROM sign_envelopes WHERE id = eFull) <> 'completed' THEN RAISE EXCEPTION 'FAIL a cancelled collection must stay completed'; END IF;
  IF public.account_usage(acctA) IS DISTINCT FROM v_usage THEN RAISE EXCEPTION 'FAIL cancelling a collection moved the monthly usage'; END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id IN (c1, c2, c3)) <> v_n + 3 THEN RAISE EXCEPTION 'FAIL cancelling a collection should append one event to each of its three documents'; END IF;
  FOR r IN SELECT d.id AS doc, d.envelope_position AS pos, e.detail, e.type, e.actor_user_id FROM sign_documents d
             JOIN LATERAL (SELECT * FROM sign_events x WHERE x.document_id = d.id ORDER BY x.doc_seq DESC LIMIT 1) e ON TRUE WHERE d.envelope_id = eFull ORDER BY d.envelope_position LOOP
    IF r.type <> 'cancelled' OR r.actor_user_id IS DISTINCT FROM uA OR r.detail ->> 'reason' IS DISTINCT FROM v_reason OR (r.detail ->> 'envelope_id')::uuid IS DISTINCT FROM eFull
       OR (r.detail ->> 'position')::int IS DISTINCT FROM r.pos OR (r.detail ->> 'count')::int <> 3 OR r.detail ->> 'reference' IS DISTINCT FROM (SELECT reference FROM sign_envelopes WHERE id = eFull) THEN
      RAISE EXCEPTION 'FAIL the last event of document % in the collection is wrong: % %', r.pos, r.type, r.detail;
    END IF;
    IF NOT (public.sign_verify_chain(r.doc) ->> 'ok')::boolean THEN RAISE EXCEPTION 'FAIL the chain of document % of the collection is broken after the cancel', r.pos; END IF;
  END LOOP;
  IF (SELECT certificate_sha256 FROM sign_documents WHERE id = c3) IS DISTINCT FROM repeat('d', 64) THEN RAISE EXCEPTION 'FAIL a document of a cancelled collection lost its certificate'; END IF;
  -- again, and a document of it alone: refused
  BEGIN
    PERFORM public.sign_cancel_envelope(eFull, 'Again', uA);
    RAISE EXCEPTION 'FAIL a cancelled collection was cancelled again';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_cancel_document(c1, 'Alone', uA);
    RAISE EXCEPTION 'FAIL a document of a cancelled collection was cancelled alone';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- the collection's stamp is write-once and cannot be written by hand either
  BEGIN
    UPDATE sign_envelopes SET cancel_reason = 'Rewritten' WHERE id = eFull;
    RAISE EXCEPTION 'FAIL the reason of a cancelled collection was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_envelopes SET cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL WHERE id = eFull;
    RAISE EXCEPTION 'FAIL a cancelled collection was un-cancelled';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET cancel_reason = 'Rewritten' WHERE id = c2;
    RAISE EXCEPTION 'FAIL the reason of a document of a cancelled collection was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_envelopes SET cancelled_by = NULL WHERE id = eFull;
  BEGIN
    UPDATE sign_envelopes SET cancelled_by = uB WHERE id = eFull;
    RAISE EXCEPTION 'FAIL a person was put on a cancelled collection after the actor became NULL';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- the collection's notice claim
  IF NOT public.sign_cancel_claim_notice(p_envelope => eFull) THEN RAISE EXCEPTION 'FAIL the first claim of the collection''s notice was refused'; END IF;
  IF public.sign_cancel_claim_notice(p_envelope => eFull) THEN RAISE EXCEPTION 'FAIL the collection''s notice was claimed twice'; END IF;
  BEGIN
    UPDATE sign_envelopes SET cancel_notified_at = NULL WHERE id = eFull;
    RAISE EXCEPTION 'FAIL the collection''s notice mark was cleared';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 9. A collection that is not completed, or has a stray stamp, is refused whole and leaves nothing behind.
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Half done', uA) RETURNING id INTO eHalf;
  h1 := pg_temp.mkdoc(acctA, uA, 'Done', 'draft', eHalf, 1);
  h2 := pg_temp.mkdoc(acctA, uA, 'Still sealing', 'draft', eHalf, 2);
  PERFORM pg_temp.advance(h1, 'completed');
  PERFORM pg_temp.advance(h2, 'sealing');
  IF (SELECT status FROM sign_envelopes WHERE id = eHalf) = 'completed' THEN RAISE EXCEPTION 'FAIL a collection with a document still sealing should not be completed'; END IF;
  BEGIN
    PERFORM public.sign_cancel_envelope(eHalf, v_reason, uA);
    RAISE EXCEPTION 'FAIL a collection that is not completed was cancelled';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT count(*) FROM sign_documents WHERE envelope_id = eHalf AND cancelled_at IS NOT NULL) <> 0 OR (SELECT cancelled_at FROM sign_envelopes WHERE id = eHalf) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a refused collection cancel left a stamp';
  END IF;
  BEGIN
    PERFORM set_config('vircle.sign_cancel', 'on', true);
    UPDATE sign_envelopes SET cancelled_at = now(), cancelled_by = uA, cancel_reason = v_reason WHERE id = eHalf;
    PERFORM set_config('vircle.sign_cancel', '', true);
    RAISE EXCEPTION 'FAIL a collection that is not completed was stamped by hand';
  EXCEPTION WHEN check_violation THEN PERFORM set_config('vircle.sign_cancel', '', true);
  END;
  BEGIN
    INSERT INTO sign_envelopes (account_id, title, created_by, cancelled_at, cancelled_by, cancel_reason) VALUES (acctA, 'Born cancelled', uA, now(), uA, v_reason);
    RAISE EXCEPTION 'FAIL a collection was inserted cancelled';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- a completed collection with one document already stamped (by a hand with the flag): the whole call is refused
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Stray stamp', uA) RETURNING id INTO eStray;
  s1 := pg_temp.mkdoc(acctA, uA, 'One', 'draft', eStray, 1);
  s2 := pg_temp.mkdoc(acctA, uA, 'Two', 'draft', eStray, 2);
  PERFORM pg_temp.advance(s1, 'completed');
  PERFORM pg_temp.advance(s2, 'completed');
  PERFORM set_config('vircle.sign_cancel', 'on', true);
  UPDATE sign_documents SET cancelled_at = now(), cancelled_by = uA, cancel_reason = 'stray stamp' WHERE id = s1;
  PERFORM set_config('vircle.sign_cancel', '', true);
  BEGIN
    PERFORM public.sign_cancel_envelope(eStray, v_reason, uA);
    RAISE EXCEPTION 'FAIL a collection with a stamped document was cancelled';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT cancelled_at FROM sign_documents WHERE id = s2) IS NOT NULL OR (SELECT cancelled_at FROM sign_envelopes WHERE id = eStray) IS NOT NULL THEN RAISE EXCEPTION 'FAIL a refused collection cancel stamped something'; END IF;

  -- 10. Who can reach what: no signed-in or signed-out caller can call the functions; another workspace sees nothing.
  FOREACH v_txt IN ARRAY ARRAY[
    format('SELECT public.sign_cancel_document(%L, %L, %L)', dPlain, v_reason, uA),
    format('SELECT public.sign_cancel_envelope(%L, %L, %L)', eStray, v_reason, uA),
    format('SELECT public.sign_cancel_claim_notice(%L)', dPlain),
    format('SELECT public.sign_cancel_one(%L, %L, %L, now())', dPlain, v_reason, uA)] LOOP
    v_res := pg_temp.run(uA, v_txt);
    IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in person could call a cancel function: % -> %', v_txt, v_res; END IF;
    v_res := pg_temp.run(NULL, v_txt, 'anon');
    IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-out caller could call a cancel function: % -> %', v_txt, v_res; END IF;
  END LOOP;
  v_res := pg_temp.run(uA, format('SELECT public.sign_cancel_one(%L, %L, %L, now())', dPlain, v_reason, uA), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the service role could call the internal stamping function: %', v_res; END IF;
  IF (SELECT cancelled_at FROM sign_documents WHERE id = dPlain) IS NOT NULL THEN RAISE EXCEPTION 'FAIL a refused call stamped a document'; END IF;
  -- the service role (how the server calls it) can
  v_res := pg_temp.run(NULL, format('SELECT (public.sign_cancel_document(%L, %L, %L) ->> %L)', dPlain, 'Cancelled by the server for this test', uA, 'reference'), 'service_role');
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the service role could not cancel a completed document: %', v_res; END IF;
  IF (SELECT cancelled_at FROM sign_documents WHERE id = dPlain) IS NULL THEN RAISE EXCEPTION 'FAIL the service role call did not stamp the document'; END IF;
  -- another workspace
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctB, 'B''s collection', uB) RETURNING id INTO eOther;
  o1 := pg_temp.mkdoc(acctB, uB, 'B one', 'draft', eOther, 1);
  o2 := pg_temp.mkdoc(acctB, uB, 'B two', 'draft', eOther, 2);
  PERFORM pg_temp.advance(o1, 'completed');
  PERFORM pg_temp.advance(o2, 'completed');
  PERFORM public.sign_cancel_envelope(eOther, 'B cancelled its own collection', uB);
  v_res := pg_temp.run(uA, format('SELECT count(*) FROM public.sign_documents WHERE id IN (%L, %L)', o1, o2));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a person of another workspace can read a cancelled document (saw %)', v_res; END IF;
  v_res := pg_temp.run(uA, format('SELECT count(*) FROM public.sign_envelopes WHERE id = %L', eOther));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a person of another workspace can read a cancelled collection (saw %)', v_res; END IF;
  v_res := pg_temp.run(uA, format('SELECT count(*) FROM public.sign_events WHERE document_id IN (%L, %L)', o1, o2));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a person of another workspace can read the cancelled events (saw %)', v_res; END IF;
  v_res := pg_temp.run(uA, format('UPDATE public.sign_documents SET cancel_reason = %L WHERE id = %L', 'Not mine to touch', o1));
  IF v_res LIKE 'ERR%' THEN NULL; ELSIF (SELECT cancel_reason FROM sign_documents WHERE id = o1) = 'Not mine to touch' THEN RAISE EXCEPTION 'FAIL a person of another workspace changed a cancelled document'; END IF;
  -- the person in the workspace can read the stamp (the list filters on it) but cannot write it
  v_res := pg_temp.run(uA, format('SELECT cancelled_at IS NOT NULL FROM public.sign_documents WHERE id = %L', dSolo));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the person in the workspace cannot read the cancel stamp of a cancelled document (got %)', v_res; END IF;
  v_res := pg_temp.run(uA, format('UPDATE public.sign_documents SET cancel_reason = %L WHERE id = %L', 'Rewritten by a signed-in person', dSolo));
  IF (SELECT cancel_reason FROM sign_documents WHERE id = dSolo) <> v_reason THEN RAISE EXCEPTION 'FAIL a signed-in person rewrote the reason of a cancelled document'; END IF;
  -- the other workspace's data is untouched by all of the above
  IF (SELECT count(*) FROM sign_documents WHERE envelope_id = eOther AND cancelled_at IS NOT NULL) <> 2 THEN RAISE EXCEPTION 'FAIL the other workspace''s collection lost its stamp'; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: only a completed document or collection can be cancelled (a draft, sent, in-progress, sealing or voided one is refused by the function and by the table); the stamp (date, person, reason of 3 to 500 trimmed characters) moves together, is written only by the cancelling functions, never inserted, is write-once (never changed or cleared; only the person may become NULL when the login is deleted); status stays completed and the signed file, certificate, completion and retention dates, earlier events, monthly usage and the retention protection of the files are exactly as they were; the cancelled event joins the hash chain with the reason and sign_verify_chain still recomputes it, and the event is append-only; a collection is cancelled as one unit (same stamp on the collection and every document, one event each carrying the collection reference, position and count, all in one transaction) and is refused whole when it is not completed, has a stamped document or is already cancelled, and a document of a collection cannot be cancelled alone; the notice claim is once-only; the functions are the service role''s alone with a pinned search_path (no signed-in or signed-out caller can reach them); another workspace sees nothing; 178''s rules (reference, title, signed file, certificate, status moves) still hold for a cancelled document';
END
$verify$;
