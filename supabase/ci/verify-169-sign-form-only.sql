-- Verify migration 169 (Doc Sign, a form without a signature). Self-contained; run against an empty database or production
-- with 157's to 169's migration text concatenated in front when they are not applied yet (164's registration table is needed).
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: the mode on templates, versions and documents (default sign, only sign or form, fixed once made); a form document needs
-- only fillers, no signature place and a form with a part; it completes without any signature (everyone submits, sealing starts,
-- the sealed record is its final file and the "completed needs a final file" guard still holds); the history says submitted;
-- the agreement path is unchanged; the registration form takes mode form only with a template of that mode; the in-Halo
-- notification says "Submitted"; the grants of the functions are the ones of 158 and 166; and one workspace cannot see or reach
-- another's.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();
  uB      uuid := gen_random_uuid();
  acctA   uuid;
  acctB   uuid;
  tplS    uuid;  -- an agreement template (mode sign)
  tplF    uuid;  -- a form template (mode form)
  tplFB   uuid;  -- a form template of the other workspace
  verS    uuid;
  verF    uuid;
  dF      uuid;  -- a form document
  dF2     uuid;
  dS      uuid;  -- an agreement document
  sF1     uuid;
  sF2     uuid;
  sS1     uuid;
  f1      uuid;
  r       jsonb;
  v_txt   text;
  v_n     int;
  v_res   text;
  v_form  jsonb := '{"version":1,"parts":[{"key":"p1","title":{"en":"Company"},"role":"applicant"},{"key":"p2","title":{"en":"Bank"},"role":"accounts"}],"fields":[]}'::jsonb;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
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

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  PERFORM public.sign_ensure_defaults(acctA);
  PERFORM public.sign_ensure_defaults(acctB);

  -- 1. The mode columns: default sign, only sign or form.
  FOR v_txt IN SELECT unnest(ARRAY['sign_templates', 'sign_template_versions', 'sign_documents']) LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = v_txt AND column_name = 'mode' AND column_default LIKE '%sign%' AND is_nullable = 'NO') THEN
      RAISE EXCEPTION 'FAIL %.mode is missing, nullable, or does not default to sign', v_txt;
    END IF;
  END LOOP;
  INSERT INTO sign_templates (account_id, name, created_by) VALUES (acctA, 'Agreement', uA) RETURNING id INTO tplS;
  IF (SELECT mode FROM sign_templates WHERE id = tplS) <> 'sign' THEN RAISE EXCEPTION 'FAIL a template should be an agreement by default'; END IF;
  BEGIN
    INSERT INTO sign_templates (account_id, name, created_by, mode) VALUES (acctA, 'Odd', uA, 'survey');
    RAISE EXCEPTION 'FAIL an unknown template mode was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_documents (account_id, title, created_by, mode) VALUES (acctA, 'Odd', uA, 'survey');
    RAISE EXCEPTION 'FAIL an unknown document mode was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 2. A template's mode is fixed; a version has its template's mode and no signature on the page of a form.
  INSERT INTO sign_templates (account_id, name, created_by, mode) VALUES (acctA, 'E-invoice details', uA, 'form') RETURNING id INTO tplF;
  INSERT INTO sign_templates (account_id, name, created_by, mode) VALUES (acctB, 'Other tenant form', uB, 'form') RETURNING id INTO tplFB;
  BEGIN
    UPDATE sign_templates SET mode = 'sign' WHERE id = tplF;
    RAISE EXCEPTION 'FAIL the mode of a template was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_templates SET name = 'E-invoice and tax details', mode = 'form' WHERE id = tplF; -- the same mode again is no change
  BEGIN
    INSERT INTO sign_template_versions (account_id, template_id, version_no, source_path, source_sha256, page_count, mode) VALUES (acctA, tplF, 1, 'p', repeat('a', 64), 1, 'sign');
    RAISE EXCEPTION 'FAIL a version of another mode than its template was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_template_versions (account_id, template_id, version_no, source_path, source_sha256, page_count, mode, fields)
    VALUES (acctA, tplF, 1, 'p', repeat('a', 64), 1, 'form', '[{"key":"s1","type":"signature","role":"applicant"}]'::jsonb);
    RAISE EXCEPTION 'FAIL a form version with a signature place was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO sign_template_versions (account_id, template_id, version_no, source_path, source_sha256, page_count, mode, form)
  VALUES (acctA, tplF, 1, 'p', repeat('a', 64), 1, 'form', v_form) RETURNING id INTO verF;
  INSERT INTO sign_template_versions (account_id, template_id, version_no, source_path, source_sha256, page_count)
  VALUES (acctA, tplS, 1, 'p', repeat('b', 64), 1) RETURNING id INTO verS;
  IF (SELECT mode FROM sign_template_versions WHERE id = verS) <> 'sign' THEN RAISE EXCEPTION 'FAIL an agreement version should be mode sign'; END IF;

  -- 3. A form document: only fillers, no signature place, a form with a part. Each rule is held when it is sent.
  INSERT INTO sign_documents (account_id, title, created_by, mode, template_version_id, form_snapshot)
  VALUES (acctA, 'No people', uA, 'form', verF, v_form) RETURNING id INTO dF2;
  BEGIN
    PERFORM public.sign_send_document(dF2, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL a form without anybody was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, kind) VALUES (acctA, dF2, 'applicant', 'Ali', 'ali@example.invalid', 1, 'signer');
  BEGIN
    PERFORM public.sign_send_document(dF2, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL a form with a person who signs was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  DELETE FROM sign_signers WHERE document_id = dF2;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, kind) VALUES (acctA, dF2, 'applicant', 'Ali', 'ali@example.invalid', 1, 'filler');
  UPDATE sign_documents SET fields_snapshot = '[{"key":"s1","type":"initials","role":"applicant"}]'::jsonb WHERE id = dF2;
  BEGIN
    PERFORM public.sign_send_document(dF2, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL a form with a place to sign was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_documents SET fields_snapshot = '[]'::jsonb, form_snapshot = '{"version":1,"parts":[],"fields":[]}'::jsonb WHERE id = dF2;
  BEGIN
    PERFORM public.sign_send_document(dF2, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL a form with no part was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- the mode of a document is fixed, from the day it is made
  BEGIN
    UPDATE sign_documents SET mode = 'sign' WHERE id = dF2;
    RAISE EXCEPTION 'FAIL the mode of a document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 4. A good form document: sent with a filler and nobody signing; the history marks it as a form.
  INSERT INTO sign_documents (account_id, title, created_by, mode, template_version_id, form_snapshot)
  VALUES (acctA, 'E-invoice details: Kedai Ali', uA, 'form', verF, v_form) RETURNING id INTO dF;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, kind) VALUES (acctA, dF, 'applicant', 'Ali', 'ali@example.invalid', 1, 'filler') RETURNING id INTO sF1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, kind) VALUES (acctA, dF, 'accounts', 'Siti', 'siti@example.invalid', 2, 'filler') RETURNING id INTO sF2;
  r := public.sign_send_document(dF, 'p', repeat('c', 64), 1, now() + interval '14 days', uA);
  IF jsonb_array_length(r -> 'invited') <> 2 THEN RAISE EXCEPTION 'FAIL both people should be invited at once when there is no signing order: %', r; END IF;
  IF (SELECT detail ->> 'mode' FROM sign_events WHERE document_id = dF AND type = 'sent') IS DISTINCT FROM 'form' THEN RAISE EXCEPTION 'FAIL the sent event should say it is a form'; END IF;
  IF (SELECT mode FROM sign_documents WHERE id = dF) <> 'form' OR (SELECT status FROM sign_documents WHERE id = dF) <> 'sent' THEN RAISE EXCEPTION 'FAIL the form document should be sent and stay a form'; END IF;
  -- once sent it is frozen like any other
  BEGIN
    UPDATE sign_documents SET form_snapshot = '{"version":1,"parts":[],"fields":[]}'::jsonb WHERE id = dF;
    RAISE EXCEPTION 'FAIL the form of a sent document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5. Agreeing is recorded as agreeing to submit; submitting needs the agreement; nobody signs.
  BEGIN
    PERFORM public.sign_complete_signer(sF1, '198.51.100.1', 'Chrome', 'en', 'v1');
    RAISE EXCEPTION 'FAIL a person submitted without agreeing';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM public.sign_record_consent(sF1, 'default-form-v1-en', 'en', '198.51.100.1', 'Chrome');
  IF (SELECT detail ->> 'mode' FROM sign_events WHERE document_id = dF AND type = 'consented') IS DISTINCT FROM 'form' THEN RAISE EXCEPTION 'FAIL the consent event should say it is a form'; END IF;
  r := public.sign_complete_signer(sF1, '198.51.100.1', 'Chrome', 'en', 'default-form-v1-en');
  IF (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL sealing started before the second person submitted'; END IF;
  IF (SELECT status FROM sign_documents WHERE id = dF) <> 'in_progress' THEN RAISE EXCEPTION 'FAIL the form should be in progress'; END IF;
  PERFORM public.sign_record_consent(sF2, 'default-form-v1-en', 'en', NULL, NULL);
  r := public.sign_complete_signer(sF2, '198.51.100.2', 'Safari', 'en', 'default-form-v1-en');
  IF NOT (r ->> 'sealing')::boolean OR (SELECT status FROM sign_documents WHERE id = dF) <> 'sealing' THEN RAISE EXCEPTION 'FAIL sealing should start when the last person submits: %', r; END IF;

  -- 6. Completing needs the sealed record, exactly as it needs the sealed copy of an agreement.
  BEGIN
    UPDATE sign_documents SET status = 'completed' WHERE id = dF;
    RAISE EXCEPTION 'FAIL a form completed without its sealed record';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  v_txt := public.sign_claim_sealing(2, 300, 5)::text;
  PERFORM public.sign_finish_sealing(dF, 'account-x/dF/final.pdf', repeat('f', 64));
  IF (SELECT status FROM sign_documents WHERE id = dF) <> 'completed' OR (SELECT final_sha256 FROM sign_documents WHERE id = dF) <> repeat('f', 64)
     OR (SELECT retain_until FROM sign_documents WHERE id = dF) IS NULL THEN
    RAISE EXCEPTION 'FAIL the form should be completed with its record kept';
  END IF;
  BEGIN
    UPDATE sign_documents SET final_path = 'elsewhere' WHERE id = dF;
    RAISE EXCEPTION 'FAIL the record of a completed form was replaced';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT string_agg(type, ',' ORDER BY doc_seq) FROM sign_events WHERE document_id = dF)
     <> 'sent,invited,invited,consented,submitted,consented,submitted,all_submitted,sealed,completed' THEN
    RAISE EXCEPTION 'FAIL unexpected event sequence for a form: %', (SELECT string_agg(type, ',' ORDER BY doc_seq) FROM sign_events WHERE document_id = dF);
  END IF;
  IF EXISTS (SELECT 1 FROM sign_events WHERE document_id = dF AND type IN ('signed', 'all_signed')) THEN RAISE EXCEPTION 'FAIL a form without a signature logged a signature'; END IF;
  IF NOT (public.sign_verify_chain(dF) ->> 'ok')::boolean THEN RAISE EXCEPTION 'FAIL the chain of a form is not intact'; END IF;

  -- 7. The sender is told inside Halo, in the words of a form.
  SELECT title INTO v_txt FROM notifications WHERE sign_document_id = dF AND type = 'sign_completed';
  IF v_txt IS NULL OR v_txt NOT LIKE 'Submitted: %' THEN RAISE EXCEPTION 'FAIL the notification of a completed form should say Submitted (got %)', v_txt; END IF;

  -- 8. An agreement is unchanged: it needs a signer, signs, logs signed and all_signed, and says "Signed by everyone".
  INSERT INTO sign_documents (account_id, title, created_by, template_version_id) VALUES (acctA, 'Agreement: Kedai Ali', uA, verS) RETURNING id INTO dS;
  IF (SELECT mode FROM sign_documents WHERE id = dS) <> 'sign' THEN RAISE EXCEPTION 'FAIL an agreement document should be mode sign'; END IF;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, kind) VALUES (acctA, dS, 'merchant', 'Ali', 'ali@example.invalid', 1, 'filler');
  BEGIN
    PERFORM public.sign_send_document(dS, 'p', repeat('d', 64), 1, now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL an agreement with nobody who signs was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  DELETE FROM sign_signers WHERE document_id = dS;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, dS, 'merchant', 'Ali', 'ali@example.invalid', 1) RETURNING id INTO sS1;
  PERFORM public.sign_send_document(dS, 'p', repeat('d', 64), 1, now() + interval '14 days', uA);
  IF (SELECT detail ? 'mode' FROM sign_events WHERE document_id = dS AND type = 'sent') THEN RAISE EXCEPTION 'FAIL the history of an agreement should not carry a mode'; END IF;
  PERFORM public.sign_record_consent(sS1, 'default-v1-en', 'en', NULL, NULL);
  r := public.sign_complete_signer(sS1, '198.51.100.3', 'Chrome', 'en', 'default-v1-en');
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL the agreement should be sealing: %', r; END IF;
  PERFORM public.sign_finish_sealing(dS, 'account-x/dS/final.pdf', repeat('e', 64));
  IF (SELECT string_agg(type, ',' ORDER BY doc_seq) FROM sign_events WHERE document_id = dS) <> 'sent,invited,consented,signed,all_signed,sealed,completed' THEN
    RAISE EXCEPTION 'FAIL unexpected event sequence for an agreement: %', (SELECT string_agg(type, ',' ORDER BY doc_seq) FROM sign_events WHERE document_id = dS);
  END IF;
  IF (SELECT detail ? 'mode' FROM sign_events WHERE document_id = dS AND type = 'consented') THEN RAISE EXCEPTION 'FAIL the consent of an agreement should not carry a mode'; END IF;
  SELECT title INTO v_txt FROM notifications WHERE sign_document_id = dS AND type = 'sign_completed';
  IF v_txt IS NULL OR v_txt NOT LIKE 'Signed by everyone: %' THEN RAISE EXCEPTION 'FAIL the notification of a completed agreement changed (got %)', v_txt; END IF;

  -- 9. The registration form (164): mode form only with a template that is a form (and the other way round); anything else is refused.
  INSERT INTO sign_registration_forms (account_id, slug, name, created_by, template_id, applicant_role_key)
  VALUES (acctA, 'merchant-signup-7k2m9x4q', 'Merchant sign-up', uA, tplS, 'merchant') RETURNING id INTO f1;
  IF (SELECT mode FROM sign_registration_forms WHERE id = f1) <> 'sign' THEN RAISE EXCEPTION 'FAIL a registration form should still start as mode sign'; END IF;
  BEGIN UPDATE sign_registration_forms SET mode = 'other' WHERE id = f1; RAISE EXCEPTION 'FAIL an unknown registration mode was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET mode = 'form' WHERE id = f1; RAISE EXCEPTION 'FAIL mode form was accepted with an agreement template'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET template_id = tplF WHERE id = f1; RAISE EXCEPTION 'FAIL a form template was accepted for mode sign'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE sign_registration_forms SET mode = 'form', template_id = tplF, applicant_role_key = 'applicant' WHERE id = f1;
  IF (SELECT mode FROM sign_registration_forms WHERE id = f1) <> 'form' THEN RAISE EXCEPTION 'FAIL mode form was not stored'; END IF;
  BEGIN UPDATE sign_registration_forms SET template_id = tplS WHERE id = f1; RAISE EXCEPTION 'FAIL an agreement template was accepted for mode form'; EXCEPTION WHEN check_violation THEN NULL; END;
  -- a form that only takes the details sends no document, so its template does not matter
  UPDATE sign_registration_forms SET send_document = FALSE, template_id = tplS WHERE id = f1;
  -- another workspace's template is still refused, whatever the mode
  BEGIN UPDATE sign_registration_forms SET send_document = TRUE, mode = 'form', template_id = tplFB WHERE id = f1; RAISE EXCEPTION 'FAIL another workspace''s template was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

  -- 10. Isolation and grants. Another workspace sees none of this and cannot change a mode; the functions are the server's alone.
  IF pg_temp.run(uB, 'select count(*)::text from sign_documents') <> '0' THEN RAISE EXCEPTION 'FAIL workspace B can see workspace A''s documents'; END IF;
  IF pg_temp.run(uB, 'select count(*)::text from sign_templates where mode = ''form'' and account_id = ''' || acctA::text || '''') <> '0' THEN RAISE EXCEPTION 'FAIL workspace B can see workspace A''s form templates'; END IF;
  v_res := pg_temp.run(uB, format('update sign_templates set mode = ''sign'' where id = %L', tplF));
  IF v_res <> 'OK' AND v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL unexpected answer %', v_res; END IF;
  IF (SELECT mode FROM sign_templates WHERE id = tplF) <> 'form' THEN RAISE EXCEPTION 'FAIL workspace B changed the mode of workspace A''s template'; END IF;
  v_res := pg_temp.run(uA, format('update sign_templates set mode = ''sign'' where id = %L', tplF));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL the owner of the workspace changed a template''s mode through the API roles (%)', v_res; END IF;

  -- (sign_verify_chain and the registration counts are meant for signed-in people: they check the caller / run as the caller)
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname LIKE 'sign\_%' AND p.prokind = 'f'
     AND p.proname NOT IN ('sign_verify_chain', 'sign_registration_counts') AND p.prorettype <> 'trigger'::regtype
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL sign_ function(s) are callable by signed-in or signed-out users: %', v_txt; END IF;
  IF NOT has_function_privilege('service_role', 'public.sign_complete_signer(uuid,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sign_send_document(uuid,text,text,integer,timestamptz,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sign_record_consent(uuid,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the server cannot call a function this migration recreated';
  END IF;
  IF has_function_privilege('anon', 'public.notify_sign_document_finished()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.notify_sign_document_finished()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the notification trigger function is callable by the API roles';
  END IF;
  -- every SECURITY DEFINER function here pins its search_path
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('sign_templates_mode_guard', 'sign_template_versions_mode_guard', 'sign_documents_guard', 'sign_send_document', 'sign_record_consent', 'sign_complete_signer', 'notify_sign_document_finished', 'sign_registration_forms_guard')
       AND p.prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'FAIL a SECURITY DEFINER function of this migration has no pinned search_path';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: mode on templates, versions and documents (default sign, fixed); a form needs only fillers, no signature place and a part; it completes with everyone submitting and the sealed record as its final file, the history and the notification say submitted; the agreement path is unchanged; registration forms take mode form with a form template; isolation and grants hold';
END
$verify$;
