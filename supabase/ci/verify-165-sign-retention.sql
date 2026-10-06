-- Verify migration 165 (Doc Sign: certificates from an authority, and retention). Self-contained; run against an
-- empty database or production with 157 to 160's and 165's migration text concatenated in front when they are not
-- applied yet. Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- What it proves:
--   (a) a completed document cannot be deleted before its retention date, as the owner, as the server (service
--       role), as the database owner; a document with no date is kept too; drafts are still deletable, everything
--       else that was sent still is not; the sealed file row of a retained document is protected, a source file is
--       not; TRUNCATE is refused; the date can be extended but never shortened or cleared
--   (b) once the date has passed the document can be deleted, and its files and history go with it
--   (c) the workspace teardown (delete_workspace_data, 153) still removes everything, retained documents included
--   (d) the exception cannot be reached from outside the teardown: neither the setting alone, nor the setting with
--       a deletion begun, from the server role or the database owner, nor by starting the cascade from the account
--   (e) the certificate functions: install swaps the default atomically, a document waiting for a certificate gives
--       its attempt back and logs once, the notification type is allowed, nothing here is callable by users
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();
  uB      uuid := gen_random_uuid();
  acctA   uuid;
  acctB   uuid;
  dDraft  uuid;
  dSent   uuid;
  dKept   uuid;
  dLapsed uuid;
  dNoDate uuid;
  dOther  uuid;
  dSeal   uuid;
  v_res   text;
  v_n     bigint;
  v_json  jsonb;
  v_id    uuid;
  v_old   uuid;
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

  -- A document made the way the server makes one: sent, signed by everyone, sealed. `p_retain` is written when it completes.
  EXECUTE $f$
    CREATE FUNCTION pg_temp.mkdoc(p_acct UUID, p_user UUID, p_title TEXT, p_complete BOOLEAN, p_retain TIMESTAMPTZ) RETURNS UUID
    LANGUAGE plpgsql AS $b$
    DECLARE v_doc UUID;
    BEGIN
      INSERT INTO public.sign_documents (account_id, title, created_by) VALUES (p_acct, p_title, p_user) RETURNING id INTO v_doc;
      IF p_complete THEN
        UPDATE public.sign_documents SET status = 'sent', base_path = 'account-x/doc/base.pdf', base_sha256 = repeat('a', 64) WHERE id = v_doc;
        UPDATE public.sign_documents SET status = 'in_progress' WHERE id = v_doc;
        UPDATE public.sign_documents SET status = 'sealing' WHERE id = v_doc;
        UPDATE public.sign_documents
           SET status = 'completed', final_path = 'account-x/doc/final.pdf', final_sha256 = repeat('c', 64), retain_until = p_retain
         WHERE id = v_doc;
        INSERT INTO public.sign_document_files (account_id, document_id, kind, path, name) VALUES
          (p_acct, v_doc, 'signed', 'account-x/doc/final.pdf', 'signed.pdf'),
          (p_acct, v_doc, 'source', 'account-x/doc/source.pdf', 'source.pdf');
        PERFORM public.sign_log(v_doc, 'sealed', 'system');
      END IF;
      RETURN v_doc;
    END $b$;
  $f$;

  -- ------------------------------------------------------------
  -- Fixtures: two workspaces
  -- ------------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Owner A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Owner B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  PERFORM public.sign_ensure_defaults(acctA);
  PERFORM public.sign_ensure_defaults(acctB);

  dDraft  := pg_temp.mkdoc(acctA, uA, 'Draft', false, NULL);
  dSent   := pg_temp.mkdoc(acctA, uA, 'Sent', false, NULL);
  UPDATE sign_documents SET status = 'sent', base_path = 'account-x/s/base.pdf', base_sha256 = repeat('b', 64) WHERE id = dSent;
  dKept   := pg_temp.mkdoc(acctA, uA, 'Kept for seven years', true, now() + interval '7 years');
  dLapsed := pg_temp.mkdoc(acctA, uA, 'Retention ended', true, now() - interval '1 day');
  dNoDate := pg_temp.mkdoc(acctA, uA, 'No retention date', true, NULL);
  dOther  := pg_temp.mkdoc(acctB, uB, 'Other workspace', true, now() + interval '1 year');

  -- ------------------------------------------------------------
  -- (a) nobody deletes a retained document
  -- ------------------------------------------------------------
  -- the workspace owner, through row level security: the row stays (and only a draft is even visible to the delete policy)
  v_res := pg_temp.run(uA, format($q$DELETE FROM sign_documents WHERE id = %L$q$, dKept));
  IF NOT EXISTS (SELECT 1 FROM sign_documents WHERE id = dKept) THEN RAISE EXCEPTION 'FAIL the owner deleted a retained document: %', v_res; END IF;
  -- the server (service role): refused with the retention error
  v_res := pg_temp.run(NULL, format($q$DELETE FROM sign_documents WHERE id = %L$q$, dKept), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%sign_document_retained%' OR NOT EXISTS (SELECT 1 FROM sign_documents WHERE id = dKept) THEN
    RAISE EXCEPTION 'FAIL the server could delete a retained document, or the error was not the retention error: %', v_res;
  END IF;
  -- the database owner (this script)
  BEGIN
    DELETE FROM sign_documents WHERE id = dKept;
    RAISE EXCEPTION 'FAIL the database owner deleted a retained document';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'sign_document_retained' THEN RAISE EXCEPTION 'FAIL wrong error for a retained document: %', SQLERRM; END IF;
  END;
  -- a completed document with no date is kept too (safe default)
  v_res := pg_temp.run(NULL, format($q$DELETE FROM sign_documents WHERE id = %L$q$, dNoDate), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%sign_document_retained%' THEN RAISE EXCEPTION 'FAIL a completed document without a date could be deleted: %', v_res; END IF;
  -- a document that was sent is still never deleted; a draft still can be
  v_res := pg_temp.run(NULL, format($q$DELETE FROM sign_documents WHERE id = %L$q$, dSent), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%sign_document_cannot_be_deleted%' THEN RAISE EXCEPTION 'FAIL a sent document could be deleted: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$DELETE FROM sign_documents WHERE id = %L$q$, dDraft));
  IF EXISTS (SELECT 1 FROM sign_documents WHERE id = dDraft) THEN RAISE EXCEPTION 'FAIL a draft could no longer be deleted: %', v_res; END IF;

  -- the sealed file row of a retained document, but not its other files
  v_res := pg_temp.run(NULL, format($q$DELETE FROM sign_document_files WHERE document_id = %L AND kind = 'signed'$q$, dKept), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%sign_document_retained%' THEN RAISE EXCEPTION 'FAIL the sealed file row of a retained document could be deleted: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$DELETE FROM sign_document_files WHERE document_id = %L AND kind = 'source'$q$, dKept), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a source file row could not be deleted: %', v_res; END IF;
  -- TRUNCATE
  BEGIN
    TRUNCATE public.sign_document_files;
    RAISE EXCEPTION 'FAIL the files table was truncated';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- the date can be extended, never shortened or cleared
  UPDATE sign_documents SET retain_until = retain_until + interval '1 year' WHERE id = dKept;
  BEGIN
    UPDATE sign_documents SET retain_until = now() WHERE id = dKept;
    RAISE EXCEPTION 'FAIL the retention date was shortened';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET retain_until = NULL WHERE id = dKept;
    RAISE EXCEPTION 'FAIL the retention date was cleared';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT retain_until FROM sign_documents WHERE id = dKept) < now() + interval '7 years 360 days' THEN
    RAISE EXCEPTION 'FAIL the extended retention date was lost';
  END IF;

  -- ------------------------------------------------------------
  -- (b) after the date the document can go, with its files and history
  -- ------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM sign_events WHERE document_id = dLapsed) THEN RAISE EXCEPTION 'FAIL the fixture has no history'; END IF;
  v_res := pg_temp.run(NULL, format($q$DELETE FROM sign_documents WHERE id = %L$q$, dLapsed), 'service_role');
  IF v_res <> 'OK' OR EXISTS (SELECT 1 FROM sign_documents WHERE id = dLapsed) THEN RAISE EXCEPTION 'FAIL a document past its retention date could not be deleted: %', v_res; END IF;
  IF EXISTS (SELECT 1 FROM sign_document_files WHERE document_id = dLapsed) OR EXISTS (SELECT 1 FROM sign_events WHERE document_id = dLapsed) THEN
    RAISE EXCEPTION 'FAIL the files or history of a deleted document remain';
  END IF;

  -- ------------------------------------------------------------
  -- (d) the exception cannot be reached from outside the teardown
  -- ------------------------------------------------------------
  -- Begin a deletion of workspace A, so the tombstone exists: the strongest position an outsider could be in.
  UPDATE account_platform SET deletion_due_at = now() - interval '1 minute' WHERE account_id = acctA;
  PERFORM public.workspace_deletion_begin(acctA);
  IF NOT EXISTS (SELECT 1 FROM workspace_deletions WHERE account_id = acctA AND deleted_at IS NULL) THEN RAISE EXCEPTION 'FAIL the deletion did not begin'; END IF;

  -- the server role sets the setting itself and deletes
  v_res := pg_temp.run(NULL, format($q$DO $d$ BEGIN PERFORM set_config('vircle.purge_account', %L, true); DELETE FROM public.sign_documents WHERE id = %L; END $d$$q$, acctA::text, dKept), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%' OR NOT EXISTS (SELECT 1 FROM sign_documents WHERE id = dKept) THEN RAISE EXCEPTION 'FAIL the server role bypassed retention with the setting: %', v_res; END IF;
  -- a signed-in user the same
  v_res := pg_temp.run(uA, format($q$DO $d$ BEGIN PERFORM set_config('vircle.purge_account', %L, true); DELETE FROM public.sign_documents WHERE id = %L; END $d$$q$, acctA::text, dKept));
  IF NOT EXISTS (SELECT 1 FROM sign_documents WHERE id = dKept) THEN RAISE EXCEPTION 'FAIL a signed-in user bypassed retention with the setting: %', v_res; END IF;
  -- the server role starts the cascade from the account row, with the setting (the cascade itself runs as the owner)
  v_res := pg_temp.run(NULL, format($q$DO $d$ BEGIN PERFORM set_config('vircle.purge_account', %L, true); DELETE FROM public.accounts WHERE id = %L; END $d$$q$, acctA::text, acctA), 'service_role');
  -- the cascade stops at whichever of the workspace's documents it reaches first: a retained one or one that was sent
  IF v_res NOT LIKE 'ERR 42501%' OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = acctA) OR NOT EXISTS (SELECT 1 FROM sign_documents WHERE id = dKept) THEN
    RAISE EXCEPTION 'FAIL a cascade started from outside the teardown removed a retained document: %', v_res;
  END IF;
  -- the database owner with the setting and the tombstone, but not inside delete_workspace_data
  BEGIN
    PERFORM set_config('vircle.purge_account', acctA::text, true);
    DELETE FROM sign_documents WHERE id = dKept;
    RAISE EXCEPTION 'FAIL the setting and a begun deletion were enough outside delete_workspace_data';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('vircle.purge_account', '', true);
  -- the setting without a begun deletion (workspace B): not enough either
  BEGIN
    PERFORM set_config('vircle.purge_account', acctB::text, true);
    DELETE FROM sign_documents WHERE id = dOther;
    RAISE EXCEPTION 'FAIL the setting alone was enough';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('vircle.purge_account', '', true);

  -- ------------------------------------------------------------
  -- (c) the teardown still removes everything of workspace A, retained documents included, and nothing of B
  -- ------------------------------------------------------------
  v_json := public.delete_workspace_data(acctA);
  SELECT (SELECT count(*) FROM sign_documents WHERE account_id = acctA)
       + (SELECT count(*) FROM sign_document_files WHERE account_id = acctA)
       + (SELECT count(*) FROM sign_events WHERE account_id = acctA)
       + (SELECT count(*) FROM sign_signers WHERE account_id = acctA)
       + (SELECT count(*) FROM accounts WHERE id = acctA)
    INTO v_n;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL the teardown left % Doc Sign row(s) behind', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM sign_documents WHERE id = dOther) OR NOT EXISTS (SELECT 1 FROM sign_document_files WHERE document_id = dOther AND kind = 'signed') THEN
    RAISE EXCEPTION 'FAIL the teardown of A touched workspace B';
  END IF;
  -- and B's retained document is still protected after A's teardown
  v_res := pg_temp.run(NULL, format($q$DELETE FROM sign_documents WHERE id = %L$q$, dOther), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%sign_document_retained%' THEN RAISE EXCEPTION 'FAIL workspace B lost its protection: %', v_res; END IF;

  -- ------------------------------------------------------------
  -- (e) certificates and the notification type
  -- ------------------------------------------------------------
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sign_certificates' AND column_name = 'source') IS NULL THEN
    RAISE EXCEPTION 'FAIL sign_certificates.source is missing';
  END IF;
  -- nothing callable by users; the server may call them
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sign_install_certificate', 'sign_hold_sealing')
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL % certificate function(s) are callable by users', v_n; END IF;
  IF NOT has_function_privilege('service_role', 'public.sign_install_certificate(uuid,text,text,timestamptz,text,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sign_hold_sealing(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the server cannot call the certificate functions';
  END IF;

  INSERT INTO sign_certificates (account_id, name, p12_enc, passphrase_enc, is_default) VALUES (acctB, 'Halo self-signed (not trusted by PDF readers)', 'enc', 'pp', TRUE) RETURNING id INTO v_old;
  IF (SELECT source FROM sign_certificates WHERE id = v_old) <> 'generated' THEN RAISE EXCEPTION 'FAIL a certificate Halo made should be marked generated'; END IF;
  v_id := public.sign_install_certificate(acctB, 'Uploaded: Kedai Runcit Ali', 'Kedai Runcit Ali', now() + interval '1 year', 'enc2', 'pp2', uB);
  IF (SELECT count(*) FROM sign_certificates WHERE account_id = acctB) <> 2
     OR (SELECT count(*) FROM sign_certificates WHERE account_id = acctB AND is_default) <> 1
     OR NOT (SELECT is_default FROM sign_certificates WHERE id = v_id)
     OR (SELECT is_default FROM sign_certificates WHERE id = v_old)
     OR (SELECT source FROM sign_certificates WHERE id = v_id) <> 'uploaded'
     OR (SELECT certificate_id FROM sign_settings WHERE account_id = acctB) IS DISTINCT FROM v_id THEN
    RAISE EXCEPTION 'FAIL installing a certificate did not swap the default and point the settings at it';
  END IF;
  BEGIN
    UPDATE sign_certificates SET expiry_notified_days = 5 WHERE id = v_id;
    RAISE EXCEPTION 'FAIL an unknown warning threshold was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_certificates SET expiry_notified_days = 30 WHERE id = v_id;

  -- a document that waits for a certificate
  dSeal := pg_temp.mkdoc(acctB, uB, 'Waiting for a certificate', false, NULL);
  UPDATE sign_documents SET status = 'sent', base_path = 'account-x/w/base.pdf', base_sha256 = repeat('d', 64) WHERE id = dSeal;
  UPDATE sign_documents SET status = 'in_progress' WHERE id = dSeal;
  -- two earlier faults used two attempts; the job claimed it a third time (attempts = 3) and found the certificate expired
  UPDATE sign_documents SET status = 'sealing', sealing_attempts = 3 WHERE id = dSeal;
  PERFORM public.sign_hold_sealing(dSeal, 'The sealing certificate expired on 2026-10-05.');
  IF (SELECT sealing_attempts FROM sign_documents WHERE id = dSeal) <> 2 THEN
    RAISE EXCEPTION 'FAIL holding should give the attempt back: %', (SELECT sealing_attempts FROM sign_documents WHERE id = dSeal);
  END IF;
  IF (SELECT status FROM sign_documents WHERE id = dSeal) <> 'sealing' OR (SELECT seal_error FROM sign_documents WHERE id = dSeal) NOT LIKE 'The sealing certificate expired%' THEN
    RAISE EXCEPTION 'FAIL a held document should stay in sealing with the reason';
  END IF;
  -- claimed again after the lease; held again with the same reason: the history gets the reason once, not at every try
  UPDATE sign_documents SET sealing_started_at = now() - interval '10 minutes' WHERE id = dSeal;
  v_json := public.sign_claim_sealing(1000, 300, 5);
  IF NOT (v_json @> jsonb_build_array(jsonb_build_object('document_id', dSeal, 'account_id', acctB, 'attempt', 3))) THEN
    RAISE EXCEPTION 'FAIL a held document was not claimed again with its attempts intact: %', v_json;
  END IF;
  PERFORM public.sign_hold_sealing(dSeal, 'The sealing certificate expired on 2026-10-05.');
  IF (SELECT sealing_attempts FROM sign_documents WHERE id = dSeal) <> 2 THEN RAISE EXCEPTION 'FAIL a second hold changed the attempts'; END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id = dSeal AND type = 'seal_attempt_failed') <> 1 THEN
    RAISE EXCEPTION 'FAIL the reason should be logged once, not at every try: %', (SELECT count(*) FROM sign_events WHERE document_id = dSeal AND type = 'seal_attempt_failed');
  END IF;

  -- the new notification type, and the old ones still allowed
  INSERT INTO notifications (account_id, user_id, type, title) VALUES (acctB, uB, 'sign_certificate_expiring', 'Sealing certificate expires in 14 days');
  INSERT INTO notifications (account_id, user_id, type, title) VALUES (acctB, uB, 'sign_completed', 'Signed by everyone');
  BEGIN
    INSERT INTO notifications (account_id, user_id, type, title) VALUES (acctB, uB, 'not_a_type', 'x');
    RAISE EXCEPTION 'FAIL an unknown notification type was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  RAISE EXCEPTION 'ROLLBACK-OK: a retained document cannot be deleted by the owner, the server or the database owner until its date has passed, then it can, with its files and history; sent documents and sealed file rows stay protected; the date can only be extended; the workspace teardown still removes every row; neither the setting, a begun deletion, the server role nor a cascade started from outside reaches the exception; installing a certificate swaps the default atomically; a document waiting for a certificate keeps its attempts and logs once; nothing new is callable by users';
END
$verify$;
