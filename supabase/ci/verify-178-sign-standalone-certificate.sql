-- Verify migration 178 (Secure Sign: the certificate is a file of its own). Self-contained; run against an empty database or production with 157's to
-- 178's migration text concatenated in front when they are not applied yet. Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means
-- every check passed.
--
-- Proves: the columns exist (certificate_path and certificate_sha256 on documents, embed_certificate on settings, default off); the path and the
-- fingerprint are kept together (a CHECK); a document is never inserted with a certificate and a certificate is never put on a draft or on a document
-- that is not completing; sign_finish_sealing completes a sealing document with the signed file AND the certificate in one statement, refuses one
-- without the other, refuses a document that is not sealing, records the certificate's fingerprint on the 'sealed' event, and still works with only
-- the three arguments 158 had (the code that was running before this migration), which gives a document with an embedded certificate (NULL path);
-- once a document is completed its certificate can be neither changed nor removed, and a document completed without one can never gain one; the
-- audit chain recomputes for both layouts; a retried document (sealing, failed, sealing again) completes with its certificate too; the file row of
-- a standalone certificate is protected by the retention rule like the signed file; the function is the service role's alone and pins its search_path;
-- exactly one sign_finish_sealing exists (no ambiguous overload); and 169's rules (reference fixed, signed file written once, frozen content)
-- still hold.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();
  acctA   uuid;
  dDraft  uuid;
  dNew    uuid;  -- sealed with a standalone certificate
  dOld    uuid;  -- sealed the way it was before 178 (three arguments): the certificate is embedded
  dHalf   uuid;  -- finish refused for half a certificate
  dRetry  uuid;  -- sealing, failed, sealing again, then completed with a certificate
  dPos    uuid;  -- completed by the positional three-argument call
  dSvc    uuid;  -- completed by the service role
  v_res   text;
  v_n     bigint;
  v_json  jsonb;
  v_txt   text;
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

  -- A document made the way the server makes one, up to the point where the sealing job takes it.
  EXECUTE $f$
    CREATE FUNCTION pg_temp.mkseal(p_acct UUID, p_user UUID, p_title TEXT) RETURNS UUID
    LANGUAGE plpgsql AS $b$
    DECLARE v_doc UUID;
    BEGIN
      INSERT INTO public.sign_documents (account_id, title, created_by) VALUES (p_acct, p_title, p_user) RETURNING id INTO v_doc;
      UPDATE public.sign_documents SET status = 'sent', base_path = 'account-x/doc/base.pdf', base_sha256 = repeat('a', 64) WHERE id = v_doc;
      UPDATE public.sign_documents SET status = 'in_progress' WHERE id = v_doc;
      UPDATE public.sign_documents SET status = 'sealing' WHERE id = v_doc;
      RETURN v_doc;
    END $b$;
  $f$;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  PERFORM public.sign_ensure_defaults(acctA);

  -- 0. The columns, the check, the default, and the one function.
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sign_documents' AND column_name IN ('certificate_path', 'certificate_sha256');
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL sign_documents lacks the certificate columns (found %)', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sign_settings' AND column_name = 'embed_certificate' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'FAIL sign_settings.embed_certificate is missing or can be NULL';
  END IF;
  IF (SELECT embed_certificate FROM sign_settings WHERE account_id = acctA) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL embedding the certificate in the signed PDF should be OFF for a workspace that has not chosen';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_documents_certificate_pair' AND conrelid = 'public.sign_documents'::regclass) THEN
    RAISE EXCEPTION 'FAIL the check that keeps the certificate path and fingerprint together is missing';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'sign_finish_sealing';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL there should be exactly one sign_finish_sealing (found %): a second overload makes a call that names three arguments ambiguous', v_n; END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sign_finish_sealing', 'sign_documents_guard')
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL sealing or the guard is callable by signed-in or signed-out users'; END IF;
  IF NOT has_function_privilege('service_role', 'public.sign_finish_sealing(uuid, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the service role cannot complete a sealed document';
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sign_finish_sealing', 'sign_documents_guard') AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL SECURITY DEFINER without a pinned search_path: %', v_txt; END IF;

  -- 1. A document is never made with a certificate; a draft never gets one; one half of a certificate is refused.
  BEGIN
    INSERT INTO sign_documents (account_id, title, created_by, certificate_path, certificate_sha256) VALUES (acctA, 'Born with one', uA, 'account-x/c.pdf', repeat('d', 64));
    RAISE EXCEPTION 'FAIL a document was inserted with a certificate';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'A draft', uA) RETURNING id INTO dDraft;
  BEGIN
    UPDATE sign_documents SET certificate_path = 'account-x/c.pdf', certificate_sha256 = repeat('d', 64) WHERE id = dDraft;
    RAISE EXCEPTION 'FAIL a draft was given a certificate';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET certificate_path = 'account-x/c.pdf' WHERE id = dDraft;
    RAISE EXCEPTION 'FAIL a certificate path was stored without its fingerprint';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET certificate_sha256 = repeat('d', 64) WHERE id = dDraft;
    RAISE EXCEPTION 'FAIL a certificate fingerprint was stored without its path';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET certificate_path = 'account-x/c.pdf', certificate_sha256 = 'not-a-fingerprint' WHERE id = dDraft;
    RAISE EXCEPTION 'FAIL a fingerprint that is not 64 hex characters was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT certificate_path FROM sign_documents WHERE id = dDraft) IS NOT NULL THEN RAISE EXCEPTION 'FAIL a refused certificate left something behind'; END IF;

  -- 2. A sealing document: the certificate cannot be put on it by an update that does not complete it.
  dNew := pg_temp.mkseal(acctA, uA, 'Sealed with a standalone certificate');
  BEGIN
    UPDATE sign_documents SET certificate_path = 'account-x/c.pdf', certificate_sha256 = repeat('d', 64) WHERE id = dNew;
    RAISE EXCEPTION 'FAIL a certificate was put on a document that was still sealing';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- half a certificate is refused by the function, before anything is read or changed
  dHalf := pg_temp.mkseal(acctA, uA, 'Half a certificate');
  BEGIN
    PERFORM public.sign_finish_sealing(dHalf, 'account-x/d/final.pdf', repeat('c', 64), 'account-x/d/cert.pdf', NULL);
    RAISE EXCEPTION 'FAIL a certificate path without its fingerprint was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_finish_sealing(dHalf, 'account-x/d/final.pdf', repeat('c', 64), NULL, repeat('d', 64));
    RAISE EXCEPTION 'FAIL a certificate fingerprint without its path was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT status FROM sign_documents WHERE id = dHalf) <> 'sealing' THEN RAISE EXCEPTION 'FAIL a refused finish changed the document'; END IF;

  -- 3. Finish with the signed file and the certificate: one statement, both recorded, the fingerprint on the 'sealed' event.
  v_json := public.sign_finish_sealing(dNew, 'account-x/dNew/final/' || repeat('c', 64) || '.pdf', repeat('c', 64), 'account-x/dNew/certificate/' || repeat('d', 64) || '.pdf', repeat('d', 64));
  IF (v_json ->> 'account_id')::uuid IS DISTINCT FROM acctA THEN RAISE EXCEPTION 'FAIL the function does not name the workspace: %', v_json; END IF;
  IF (SELECT status FROM sign_documents WHERE id = dNew) <> 'completed' THEN RAISE EXCEPTION 'FAIL the document should be completed'; END IF;
  IF (SELECT certificate_sha256 FROM sign_documents WHERE id = dNew) IS DISTINCT FROM repeat('d', 64)
     OR (SELECT certificate_path FROM sign_documents WHERE id = dNew) IS NULL OR (SELECT certificate_path FROM sign_documents WHERE id = dNew) NOT LIKE 'account-x/dNew/certificate/%' THEN
    RAISE EXCEPTION 'FAIL the certificate was not recorded with the signed file';
  END IF;
  IF (SELECT final_sha256 FROM sign_documents WHERE id = dNew) IS DISTINCT FROM repeat('c', 64) THEN RAISE EXCEPTION 'FAIL the signed file was not recorded'; END IF;
  IF (SELECT retain_until FROM sign_documents WHERE id = dNew) IS NULL OR (SELECT retain_until FROM sign_documents WHERE id = dNew) < now() + interval '6 years 360 days' THEN RAISE EXCEPTION 'FAIL retention should still default to 7 years'; END IF;
  IF (SELECT detail ->> 'certificate_sha256' FROM sign_events WHERE document_id = dNew AND type = 'sealed') IS DISTINCT FROM repeat('d', 64)
     OR (SELECT detail ->> 'final_sha256' FROM sign_events WHERE document_id = dNew AND type = 'sealed') IS DISTINCT FROM repeat('c', 64) THEN
    RAISE EXCEPTION 'FAIL the sealed event does not carry both fingerprints';
  END IF;
  IF NOT (public.sign_verify_chain(dNew) ->> 'ok')::boolean THEN RAISE EXCEPTION 'FAIL the audit chain of a document with a standalone certificate is not intact'; END IF;
  -- it cannot be completed twice
  BEGIN
    PERFORM public.sign_finish_sealing(dNew, 'x', repeat('e', 64), 'y', repeat('e', 64));
    RAISE EXCEPTION 'FAIL a completed document was sealed again';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 4. Write-once: neither the path nor the fingerprint can be changed, nor taken away; the signed file is still write-once too.
  BEGIN
    UPDATE sign_documents SET certificate_path = 'account-x/other.pdf', certificate_sha256 = repeat('e', 64) WHERE id = dNew;
    RAISE EXCEPTION 'FAIL the certificate of a completed document was replaced';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET certificate_sha256 = repeat('e', 64) WHERE id = dNew;
    RAISE EXCEPTION 'FAIL the fingerprint of the certificate was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET certificate_path = NULL, certificate_sha256 = NULL WHERE id = dNew;
    RAISE EXCEPTION 'FAIL the certificate of a completed document was taken away';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET final_sha256 = repeat('e', 64) WHERE id = dNew;
    RAISE EXCEPTION 'FAIL the signed file of a completed document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET reference = 'SGN-0000-000000' WHERE id = dNew;
    RAISE EXCEPTION 'FAIL the reference was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET title = 'Another title' WHERE id = dNew;
    RAISE EXCEPTION 'FAIL the title of a sent document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5. The way it was before 178: three arguments. The document is completed with a NULL certificate (it is embedded), and it can never gain one.
  dOld := pg_temp.mkseal(acctA, uA, 'Sealed before 178');
  PERFORM public.sign_finish_sealing(p_document => dOld, p_final_path => 'account-x/dOld/final.pdf', p_final_sha256 => repeat('c', 64));
  IF (SELECT status FROM sign_documents WHERE id = dOld) <> 'completed' THEN RAISE EXCEPTION 'FAIL the three-argument call no longer completes a document'; END IF;
  IF (SELECT certificate_path FROM sign_documents WHERE id = dOld) IS NOT NULL OR (SELECT certificate_sha256 FROM sign_documents WHERE id = dOld) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a document sealed without a standalone certificate has one';
  END IF;
  IF (SELECT detail ->> 'certificate_sha256' FROM sign_events WHERE document_id = dOld AND type = 'sealed') IS NOT NULL THEN RAISE EXCEPTION 'FAIL the sealed event of an embedded-certificate document names a certificate file'; END IF;
  BEGIN
    UPDATE sign_documents SET certificate_path = 'account-x/late.pdf', certificate_sha256 = repeat('d', 64) WHERE id = dOld;
    RAISE EXCEPTION 'FAIL a document that was completed with an embedded certificate gained a second one';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT (public.sign_verify_chain(dOld) ->> 'ok')::boolean THEN RAISE EXCEPTION 'FAIL the audit chain of a document with an embedded certificate is not intact'; END IF;
  -- the same call written positionally (as 158's verify script and a psql user write it) is the same call
  dPos := pg_temp.mkseal(acctA, uA, 'Sealed before 178, positional');
  PERFORM public.sign_finish_sealing(dPos, 'account-x/dPos/final.pdf', repeat('c', 64));
  IF (SELECT status FROM sign_documents WHERE id = dPos) <> 'completed' OR (SELECT certificate_path FROM sign_documents WHERE id = dPos) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL the positional three-argument call does not complete a document with an embedded certificate';
  END IF;
  -- the two layouts are told apart by the path alone
  IF (SELECT count(*) FROM sign_documents WHERE account_id = acctA AND status = 'completed' AND certificate_path IS NULL) <> 2
     OR (SELECT count(*) FROM sign_documents WHERE account_id = acctA AND status = 'completed' AND certificate_path IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'FAIL the layouts are not told apart by the certificate path';
  END IF;

  -- 6. A document that failed and was put back to be sealed completes with its certificate like any other.
  dRetry := pg_temp.mkseal(acctA, uA, 'Retried');
  UPDATE sign_documents SET status = 'failed', seal_error = 'storage unavailable' WHERE id = dRetry;
  UPDATE sign_documents SET status = 'sealing', seal_error = NULL WHERE id = dRetry;
  PERFORM public.sign_finish_sealing(dRetry, 'account-x/dRetry/final.pdf', repeat('c', 64), 'account-x/dRetry/cert.pdf', repeat('d', 64));
  IF (SELECT certificate_sha256 FROM sign_documents WHERE id = dRetry) IS DISTINCT FROM repeat('d', 64) THEN RAISE EXCEPTION 'FAIL a retried document did not get its certificate'; END IF;

  -- 7. The file row of a standalone certificate is kept like the signed file while the document is retained (165's rule names kind 'certificate').
  INSERT INTO sign_document_files (account_id, document_id, kind, path, name, mime, size_bytes, sha256) VALUES
    (acctA, dNew, 'signed', 'account-x/dNew/final.pdf', 'signed.pdf', 'application/pdf', 100, repeat('c', 64)),
    (acctA, dNew, 'certificate', 'account-x/dNew/certificate.pdf', 'certificate.pdf', 'application/pdf', 50, repeat('d', 64));
  BEGIN
    DELETE FROM sign_document_files WHERE document_id = dNew AND kind = 'certificate';
    RAISE EXCEPTION 'FAIL the certificate file of a retained document was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM sign_document_files WHERE document_id = dNew AND kind = 'signed';
    RAISE EXCEPTION 'FAIL the signed file of a retained document was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (SELECT count(*) FROM sign_document_files WHERE document_id = dNew) <> 2 THEN RAISE EXCEPTION 'FAIL a refused delete removed a file row'; END IF;

  -- 8. Who may call it: the service role, not a signed-in person and not a signed-out one.
  dSvc := pg_temp.mkseal(acctA, uA, 'Completed by the server');
  v_res := pg_temp.run(uA, format('SELECT public.sign_finish_sealing(%L, %L, %L, %L, %L)', dSvc, 'account-x/dSvc/final.pdf', repeat('c', 64), 'account-x/dSvc/cert.pdf', repeat('d', 64)));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in person could complete a sealed document: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format('SELECT public.sign_finish_sealing(%L, %L, %L, %L, %L)', dSvc, 'account-x/dSvc/final.pdf', repeat('c', 64), 'account-x/dSvc/cert.pdf', repeat('d', 64)), 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-out caller could complete a sealed document: %', v_res; END IF;
  IF (SELECT status FROM sign_documents WHERE id = dSvc) <> 'sealing' THEN RAISE EXCEPTION 'FAIL a refused call changed the document'; END IF;
  v_res := pg_temp.run(NULL, format('SELECT public.sign_finish_sealing(%L, %L, %L, %L, %L)', dSvc, 'account-x/dSvc/final.pdf', repeat('c', 64), 'account-x/dSvc/cert.pdf', repeat('d', 64)), 'service_role');
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the service role could not complete a sealed document: %', v_res; END IF;
  IF (SELECT certificate_sha256 FROM sign_documents WHERE id = dSvc) IS DISTINCT FROM repeat('d', 64) THEN RAISE EXCEPTION 'FAIL the service role call did not record the certificate'; END IF;

  -- 9. The workspace's switch: off by default, can be turned on and back.
  UPDATE sign_settings SET embed_certificate = true WHERE account_id = acctA;
  IF (SELECT embed_certificate FROM sign_settings WHERE account_id = acctA) IS NOT TRUE THEN RAISE EXCEPTION 'FAIL the embed switch cannot be turned on'; END IF;
  UPDATE sign_settings SET embed_certificate = false WHERE account_id = acctA;
  IF (SELECT embed_certificate FROM sign_settings WHERE account_id = acctA) IS NOT FALSE THEN RAISE EXCEPTION 'FAIL the embed switch cannot be turned off'; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: the certificate path and fingerprint are kept together and are NULL for a document sealed before 178 (embedded certificate); a document is never made with one and a draft or a document that is not completing never gets one; sign_finish_sealing completes with the signed file and the certificate in one statement, refuses half a certificate or a document that is not sealing, still works with three arguments (embedded layout), and records the certificate on the sealed event; once completed the certificate is write-once and a document completed without one never gains one; the audit chain recomputes for both layouts; a retried document completes with its certificate; the certificate file row is kept like the signed file while retained; the function is the service role''s alone with a pinned search_path and is the only sign_finish_sealing; the embed switch is off by default; 169''s rules (reference, signed file, frozen content) still hold';
END
$verify$;
