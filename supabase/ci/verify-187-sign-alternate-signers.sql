-- Verify migration 187 (Secure Sign: an alternate signer, the second person of a role; whoever completes the role first wins). Self-contained; run against an
-- empty database or production with 157's to 187's migration text concatenated in front when they are not applied yet. Ends in a deliberate error so
-- nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves:
--   * the column, the new status value (the old ones are kept), the foreign key, the shape check, the unique index (one alternate for each person), the two
--     guard triggers; the guard functions are not callable by signed-in or signed-out users and pin their search_path; the server can call the ceremony;
--   * the pair is made only as a draft document that is not in a collection, on the same role, kind and step as the first person, with another address;
--     never an alternate of an alternate, of a person of another document, of another role, of a Halo user, or a second alternate of one person; who
--     a person is an alternate of cannot change, an address cannot be changed into the other person's, and a document with an alternate cannot join a
--     collection;
--   * the FIRST-WINS claim: both people are invited together with a link each; the one who completes first signs, the other becomes 'not_needed' in the same
--     transaction with an 'alternate_not_needed' event; the other is then refused as 'completed_by_other' (also when the document is already sealing, and for
--     the person who was first named as well as for the alternate), cannot be reminded or have the link renewed, cannot decline, and their answers are
--     frozen (refused as 'completed_by_other') while the winner's are frozen as ever; the document does not wait for them;
--   * signing order: the two people are one person of their step; the next step is invited when ONE has completed, once, naming whoever signed;
--   * a part the first person had handed to a delegate goes with them ('not_needed') when the alternate completes;
--   * moving the first person to another step moves the alternate with them, and only while both have not been invited;
--   * a decline by either person still ends the document; the chain of a document with an alternate still verifies;
--   * a document with no alternate behaves exactly as before (no event, no row changed, the same result).
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();
  acctA  uuid;
  d1     uuid;  -- guard: a draft
  d2     uuid;  -- free order: ra (P2 + A2), rb (B2)
  d3     uuid;  -- one role with two people: the alternate wins and the document seals
  d4     uuid;  -- ordered: step 1 ra (P4 + A4), step 2 rb (B4); the first person wins
  d5     uuid;  -- ordered: same, the alternate wins
  d6     uuid;  -- a decline
  d7     uuid;  -- moving a pair
  d8     uuid;  -- a delegate of the first person
  d9     uuid;  -- one person only
  e1     uuid;
  c1     uuid;
  p1 uuid; a1 uuid; x1 uuid; o1 uuid;
  p2 uuid; a2 uuid; b2 uuid;
  p3 uuid; a3 uuid;
  p4 uuid; a4 uuid; b4 uuid;
  p5 uuid; a5 uuid; b5 uuid;
  p6 uuid; a6 uuid;
  p7 uuid; a7 uuid; s7 uuid;
  p8 uuid; a8 uuid; dg uuid;
  s9 uuid;
  r      jsonb;
  v_n    int;
  v_txt  text;
  v_json jsonb;
  v_fields jsonb := '[{"key":"sig","type":"signature","role":"ra","page":0,"x":0.1,"y":0.1,"w":0.2,"h":0.05,"required":true},
                      {"key":"note","type":"text","role":"ra","page":0,"x":0.1,"y":0.3,"w":0.2,"h":0.05,"required":false},
                      {"key":"sigb","type":"signature","role":"rb","page":0,"x":0.1,"y":0.5,"w":0.2,"h":0.05,"required":true}]'::jsonb;
  v_form   jsonb := '{"version":1,"parts":[
        {"key":"company","title":{"en":"Company"},"role":"merchant"},
        {"key":"bank","title":{"en":"Bank"},"role":"merchant"}],
      "fields":[
        {"key":"legalName","type":"text","part":"company","label":{"en":"Legal name"},"required":true},
        {"key":"accountNo","type":"text","part":"bank","label":{"en":"Account"},"required":true}]}'::jsonb;
BEGIN
  -- production is invite only (134); the whole script is rolled back, so opening sign-up for its fixtures leaves nothing behind
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA,'00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  PERFORM public.sign_ensure_defaults(acctA);

  -- 0. The shape of the schema.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sign_signers' AND column_name = 'alternate_of') THEN
    RAISE EXCEPTION 'FAIL sign_signers.alternate_of is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sign_signers'::regclass AND conname = 'sign_signers_status_check'
                   AND pg_get_constraintdef(oid) LIKE '%not_needed%' AND pg_get_constraintdef(oid) LIKE '%pending%' AND pg_get_constraintdef(oid) LIKE '%viewed%'
                   AND pg_get_constraintdef(oid) LIKE '%signed%' AND pg_get_constraintdef(oid) LIKE '%declined%') THEN
    RAISE EXCEPTION 'FAIL the status check does not list not_needed beside the earlier values';
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint WHERE conrelid = 'public.sign_signers'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%declined%' AND pg_get_constraintdef(oid) LIKE '%viewed%';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL there should be exactly one status check (found %)', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_signers_alternate_fk') OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_signers_alternate_shape') THEN
    RAISE EXCEPTION 'FAIL the foreign key or the shape check of alternate_of is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'sign_signers' AND indexname = 'sign_signers_alternate_uq') THEN
    RAISE EXCEPTION 'FAIL the unique index (one alternate for each person) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.sign_signers'::regclass AND tgname = 'sign_signers_alternate_guard' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.sign_documents'::regclass AND tgname = 'sign_documents_alternate_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FAIL a guard trigger is missing';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sign_signers_alternate_guard', 'sign_documents_alternate_guard', 'sign_answers_guard', 'sign_complete_signer', 'sign_move_signer')
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL % of the functions are callable by signed-in or signed-out users', v_n; END IF;
  IF NOT has_function_privilege('service_role', 'public.sign_complete_signer(uuid,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sign_move_signer(uuid,integer,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the server cannot call the ceremony';
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sign_signers_alternate_guard', 'sign_documents_alternate_guard', 'sign_answers_guard', 'sign_complete_signer', 'sign_move_signer') AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL SECURITY DEFINER without a pinned search_path: %', v_txt; END IF;

  -- 1. The pair is made only on a draft, with the same role, kind and step, another address.
  INSERT INTO sign_documents (account_id, title, created_by, fields_snapshot) VALUES (acctA, 'Guard', uA, v_fields) RETURNING id INTO d1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d1, 'ra', 'First Person', 'first@example.invalid', 1) RETURNING id INTO p1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d1, 'ra', 'Second Person', 'second@example.invalid', 1, p1) RETURNING id INTO a1;
  -- a second alternate of the same person
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d1, 'ra', 'Third Person', 'third@example.invalid', 1, p1);
    RAISE EXCEPTION 'FAIL a person got two alternates';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- an alternate of an alternate
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d1, 'ra', 'Third Person', 'third@example.invalid', 1, a1);
    RAISE EXCEPTION 'FAIL an alternate got an alternate';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- another role than the person's
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d1, 'rb', 'Other Role', 'other@example.invalid', 2) RETURNING id INTO o1;
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d1, 'ra', 'Wrong Role', 'wrong@example.invalid', 2, o1);
    RAISE EXCEPTION 'FAIL an alternate was made for a person of another role';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- the same address as the person
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d1, 'rb', 'Same Person', 'OTHER@example.invalid', 2, o1);
    RAISE EXCEPTION 'FAIL an alternate had the address of the person they can sign instead of';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- another step
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d1, 'rb', 'Late Person', 'late@example.invalid', 5, o1);
    RAISE EXCEPTION 'FAIL an alternate was put in another step than the person';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- another kind
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, kind, full_name, email, order_no, alternate_of) VALUES (acctA, d1, 'rb', 'filler', 'Filler Person', 'filler@example.invalid', 2, o1);
    RAISE EXCEPTION 'FAIL an alternate was of another kind than the person';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- a Halo user cannot be an alternate, and cannot have one
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of, internal_user_id) VALUES (acctA, d1, 'rb', 'Halo Person', 'halo@example.invalid', 2, o1, uA);
    RAISE EXCEPTION 'FAIL an alternate was a Halo user';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_signers SET internal_user_id = uA WHERE id = p1;
    RAISE EXCEPTION 'FAIL a person with an alternate was made a Halo user';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- a person of another document
  INSERT INTO sign_documents (account_id, title, created_by, fields_snapshot) VALUES (acctA, 'Other', uA, v_fields) RETURNING id INTO d9;
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d9, 'ra', 'Cross Person', 'cross@example.invalid', 1, p1);
    RAISE EXCEPTION 'FAIL an alternate was made for a person of another document';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- who a person is an alternate of never changes; neither does the address into the other person's
  BEGIN
    UPDATE sign_signers SET alternate_of = NULL WHERE id = a1;
    RAISE EXCEPTION 'FAIL an alternate was made an ordinary person';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_signers SET alternate_of = p1 WHERE id = o1;
    RAISE EXCEPTION 'FAIL a person was made an alternate afterwards';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_signers SET email = 'First@Example.invalid' WHERE id = a1;
    RAISE EXCEPTION 'FAIL the alternate was given the address of the first person';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_signers SET email = 'second@example.invalid' WHERE id = p1;
    RAISE EXCEPTION 'FAIL the first person was given the address of the alternate';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- a change of address that does not clash is fine, and so is one on a person with no alternate
  UPDATE sign_signers SET email = 'first.new@example.invalid' WHERE id = p1;
  UPDATE sign_signers SET email = 'other.new@example.invalid' WHERE id = o1;
  -- a status that does not exist
  BEGIN
    UPDATE sign_signers SET status = 'nobody_needs_me' WHERE id = o1;
    RAISE EXCEPTION 'FAIL a status that does not exist was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_signers SET status = 'not_needed' WHERE id = o1;
  UPDATE sign_signers SET status = 'pending' WHERE id = o1;
  -- a document with an alternate cannot join a collection; an alternate cannot be made on a document of a collection
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Collection', uA) RETURNING id INTO e1;
  BEGIN
    UPDATE sign_documents SET envelope_id = e1, envelope_position = 1 WHERE id = d1;
    RAISE EXCEPTION 'FAIL a document with an alternate joined a collection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position, fields_snapshot) VALUES (acctA, 'In a collection', uA, e1, 1, v_fields) RETURNING id INTO c1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, c1, 'ra', 'Collection Person', 'cp@example.invalid', 1) RETURNING id INTO x1;
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, c1, 'ra', 'Collection Alternate', 'ca@example.invalid', 1, x1);
    RAISE EXCEPTION 'FAIL an alternate was made on a document of a collection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 2. Free order: both people of ra are invited with a link each; the alternate completes first and wins.
  INSERT INTO sign_documents (account_id, title, created_by, fields_snapshot) VALUES (acctA, 'Free order', uA, v_fields) RETURNING id INTO d2;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d2, 'ra', 'P Two', 'p2@example.invalid', 1) RETURNING id INTO p2;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d2, 'ra', 'A Two', 'a2@example.invalid', 1, p2) RETURNING id INTO a2;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d2, 'rb', 'B Two', 'b2@example.invalid', 2) RETURNING id INTO b2;
  r := public.sign_send_document(d2, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
  IF jsonb_array_length(r -> 'invited') <> 3 THEN RAISE EXCEPTION 'FAIL the two people of a role and the third person should all be invited (got %)', jsonb_array_length(r -> 'invited'); END IF;
  IF (SELECT count(*) FROM sign_signer_secrets WHERE signer_id IN (p2, a2)) <> 2 THEN RAISE EXCEPTION 'FAIL each person of the role needs a link of their own'; END IF;
  IF (SELECT count(DISTINCT token_hash) FROM sign_signer_secrets WHERE signer_id IN (p2, a2)) <> 2 THEN RAISE EXCEPTION 'FAIL the two people share a link'; END IF;
  -- an alternate cannot be made once the document is sent
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d2, 'rb', 'Late Alternate', 'late2@example.invalid', 2, b2);
    RAISE EXCEPTION 'FAIL an alternate was made on a document that was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM public.sign_record_consent(p2, 'v1', 'en', NULL, NULL);
  PERFORM public.sign_record_consent(a2, 'v1', 'en', NULL, NULL);
  -- both have typed something on the role's place
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d2, p2, 'note', '{"text":"typed by P"}'::jsonb);
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d2, a2, 'note', '{"text":"typed by A"}'::jsonb);
  r := public.sign_complete_signer(a2, '203.0.113.7', 'Chrome', 'en', 'v1');
  IF (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL the document sealed while the third person has not signed'; END IF;
  IF (SELECT status FROM sign_signers WHERE id = a2) <> 'signed' THEN RAISE EXCEPTION 'FAIL the alternate who completed is not signed'; END IF;
  IF (SELECT status FROM sign_signers WHERE id = p2) <> 'not_needed' THEN RAISE EXCEPTION 'FAIL the first person was not marked not_needed'; END IF;
  IF (SELECT signed_at FROM sign_signers WHERE id = p2) IS NOT NULL THEN RAISE EXCEPTION 'FAIL the person who did not sign has a signing time'; END IF;
  IF (SELECT status FROM sign_signers WHERE id = b2) <> 'sent' THEN RAISE EXCEPTION 'FAIL the third person was touched'; END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id = d2 AND type = 'alternate_not_needed' AND signer_id = p2) <> 1 THEN RAISE EXCEPTION 'FAIL the alternate_not_needed event is missing or doubled'; END IF;
  IF (SELECT detail ->> 'completed_by' FROM sign_events WHERE document_id = d2 AND type = 'alternate_not_needed') <> a2::text
     OR (SELECT detail ->> 'completed_by_name' FROM sign_events WHERE document_id = d2 AND type = 'alternate_not_needed') <> 'A Two' THEN
    RAISE EXCEPTION 'FAIL the alternate_not_needed event does not say who completed the role';
  END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id = d2 AND type = 'signed' AND signer_id = a2) <> 1 THEN RAISE EXCEPTION 'FAIL the signature of the alternate is not in the history'; END IF;
  -- the first person is refused as "completed by the other", whatever they had done
  v_txt := NULL;
  BEGIN PERFORM public.sign_complete_signer(p2, NULL, NULL, 'en', 'v1'); EXCEPTION WHEN check_violation THEN v_txt := SQLERRM; END;
  IF v_txt IS DISTINCT FROM 'completed_by_other' THEN RAISE EXCEPTION 'FAIL the first person was not refused as completed_by_other (got %)', v_txt; END IF;
  -- and cannot be reminded, sent a new link, or decline
  v_txt := NULL;
  BEGIN PERFORM public.sign_rotate_token(p2, uA, 'reminded'); EXCEPTION WHEN check_violation THEN v_txt := SQLERRM; END;
  IF v_txt IS DISTINCT FROM 'signer_not_open' THEN RAISE EXCEPTION 'FAIL a person who is not needed could be reminded (got %)', v_txt; END IF;
  v_txt := NULL;
  BEGIN PERFORM public.sign_decline_signer(p2, 'no', NULL, NULL); EXCEPTION WHEN check_violation THEN v_txt := SQLERRM; END;
  IF v_txt IS DISTINCT FROM 'document_not_open' THEN RAISE EXCEPTION 'FAIL a person who is not needed could decline (got %)', v_txt; END IF;
  IF (SELECT status FROM sign_documents WHERE id = d2) <> 'in_progress' THEN RAISE EXCEPTION 'FAIL the document should be in progress, not %', (SELECT status FROM sign_documents WHERE id = d2); END IF;
  -- the answers: the winner's are frozen as ever, the other person's can no longer change and nothing new can be added
  v_txt := NULL;
  BEGIN UPDATE sign_answers SET value = '{"text":"changed"}'::jsonb WHERE document_id = d2 AND signer_id = a2 AND field_key = 'note'; EXCEPTION WHEN check_violation THEN v_txt := SQLERRM; END;
  IF v_txt IS DISTINCT FROM 'sign_answer_is_frozen' THEN RAISE EXCEPTION 'FAIL the answer of the person who signed could change (got %)', v_txt; END IF;
  v_txt := NULL;
  BEGIN UPDATE sign_answers SET value = '{"text":"changed"}'::jsonb WHERE document_id = d2 AND signer_id = p2 AND field_key = 'note'; EXCEPTION WHEN check_violation THEN v_txt := SQLERRM; END;
  IF v_txt IS DISTINCT FROM 'completed_by_other' THEN RAISE EXCEPTION 'FAIL the answer of a person who is not needed could change (got %)', v_txt; END IF;
  v_txt := NULL;
  BEGIN INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d2, p2, 'sig', '{"typed":"P"}'::jsonb); EXCEPTION WHEN check_violation THEN v_txt := SQLERRM; END;
  IF v_txt IS DISTINCT FROM 'completed_by_other' THEN RAISE EXCEPTION 'FAIL a person who is not needed could add an answer (got %)', v_txt; END IF;
  IF (SELECT value ->> 'text' FROM sign_answers WHERE document_id = d2 AND signer_id = p2 AND field_key = 'note') <> 'typed by P' THEN RAISE EXCEPTION 'FAIL what the first person had typed was changed or lost'; END IF;
  -- the third person finishes: the document does not wait for the first person
  PERFORM public.sign_record_consent(b2, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(b2, NULL, NULL, 'en', 'v1');
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL the document waited for a person who was not needed'; END IF;
  IF (SELECT status FROM sign_documents WHERE id = d2) <> 'sealing' THEN RAISE EXCEPTION 'FAIL the document should be sealing'; END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id = d2 AND type = 'all_signed') <> 1 THEN RAISE EXCEPTION 'FAIL all_signed should be logged once'; END IF;
  IF NOT (public.sign_verify_chain(d2) ->> 'ok')::boolean THEN RAISE EXCEPTION 'FAIL the chain of a document with an alternate does not verify'; END IF;
  -- the person who is not needed is not claimed by expiry, void, or the sealing queue as someone waited for: nothing waits on a not_needed row
  IF EXISTS (SELECT 1 FROM sign_signers WHERE document_id = d2 AND status IN ('sent', 'viewed')) THEN RAISE EXCEPTION 'FAIL somebody is still waited for on a sealing document'; END IF;

  -- 3. The first person is the last to finish and the document is already sealing: the alternate who lost is told "completed by the other", not "not open".
  INSERT INTO sign_documents (account_id, title, created_by, fields_snapshot) VALUES (acctA, 'One role', uA, v_fields) RETURNING id INTO d3;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d3, 'ra', 'P Three', 'p3@example.invalid', 1) RETURNING id INTO p3;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d3, 'ra', 'A Three', 'a3@example.invalid', 1, p3) RETURNING id INTO a3;
  PERFORM public.sign_send_document(d3, 'p', repeat('b', 64), 1, NULL, uA);
  PERFORM public.sign_record_consent(p3, 'v1', 'en', NULL, NULL);
  PERFORM public.sign_record_consent(a3, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(p3, NULL, NULL, 'en', 'v1');
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL the only role was completed by its first person but the document is not sealing'; END IF;
  IF (SELECT status FROM sign_signers WHERE id = a3) <> 'not_needed' THEN RAISE EXCEPTION 'FAIL the alternate was not marked not_needed'; END IF;
  v_txt := NULL;
  BEGIN PERFORM public.sign_complete_signer(a3, NULL, NULL, 'en', 'v1'); EXCEPTION WHEN check_violation THEN v_txt := SQLERRM; END;
  IF v_txt IS DISTINCT FROM 'completed_by_other' THEN RAISE EXCEPTION 'FAIL the alternate of a sealing document was refused with % instead of completed_by_other', v_txt; END IF;
  IF (SELECT status FROM sign_signers WHERE id = a3) <> 'not_needed' OR (SELECT status FROM sign_signers WHERE id = p3) <> 'signed' THEN RAISE EXCEPTION 'FAIL a refused completion changed a row'; END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id = d3 AND type IN ('signed', 'all_signed')) <> 2 THEN RAISE EXCEPTION 'FAIL a role completed by two people, or a signature logged twice'; END IF;

  -- 4. Signing order: step 1 is ra (two people), step 2 is rb. One person finishing step 1 invites step 2 once, naming who signed.
  INSERT INTO sign_documents (account_id, title, created_by, sign_in_order, fields_snapshot) VALUES (acctA, 'Ordered', uA, true, v_fields) RETURNING id INTO d4;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d4, 'ra', 'P Four', 'p4@example.invalid', 1) RETURNING id INTO p4;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d4, 'ra', 'A Four', 'a4@example.invalid', 1, p4) RETURNING id INTO a4;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d4, 'rb', 'B Four', 'b4@example.invalid', 2) RETURNING id INTO b4;
  r := public.sign_send_document(d4, 'p', repeat('c', 64), 1, NULL, uA);
  IF jsonb_array_length(r -> 'invited') <> 2 THEN RAISE EXCEPTION 'FAIL step 1 should invite both people of ra and nobody else (got %)', jsonb_array_length(r -> 'invited'); END IF;
  IF (SELECT status FROM sign_signers WHERE id = b4) <> 'pending' THEN RAISE EXCEPTION 'FAIL step 2 was invited early'; END IF;
  PERFORM public.sign_record_consent(p4, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(p4, NULL, NULL, 'en', 'v1');
  IF jsonb_array_length(r -> 'invited') <> 1 OR (r -> 'invited' -> 0 ->> 'signer_id') <> b4::text THEN RAISE EXCEPTION 'FAIL step 2 was not invited once the first person of step 1 had signed'; END IF;
  IF (SELECT status FROM sign_signers WHERE id = a4) <> 'not_needed' THEN RAISE EXCEPTION 'FAIL the alternate of step 1 was not closed'; END IF;
  IF (SELECT detail ->> 'because' FROM sign_events WHERE document_id = d4 AND type = 'invited' AND signer_id = b4) <> 'signer_finished'
     OR (SELECT detail ->> 'finished_name' FROM sign_events WHERE document_id = d4 AND type = 'invited' AND signer_id = b4) <> 'P Four' THEN
    RAISE EXCEPTION 'FAIL step 2 was not invited because P Four finished (the two people of a role are one person of the step)';
  END IF;
  IF jsonb_array_length(public.sign_invite_step(d4, 2, true, NULL)) <> 0 THEN RAISE EXCEPTION 'FAIL step 2 was invited twice'; END IF;
  -- the same, the alternate winning: the name is the alternate's
  INSERT INTO sign_documents (account_id, title, created_by, sign_in_order, fields_snapshot) VALUES (acctA, 'Ordered B', uA, true, v_fields) RETURNING id INTO d5;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d5, 'ra', 'P Five', 'p5@example.invalid', 1) RETURNING id INTO p5;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d5, 'ra', 'A Five', 'a5@example.invalid', 1, p5) RETURNING id INTO a5;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d5, 'rb', 'B Five', 'b5@example.invalid', 2) RETURNING id INTO b5;
  PERFORM public.sign_send_document(d5, 'p', repeat('d', 64), 1, NULL, uA);
  PERFORM public.sign_record_consent(a5, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(a5, NULL, NULL, 'en', 'v1');
  IF (SELECT detail ->> 'finished_name' FROM sign_events WHERE document_id = d5 AND type = 'invited' AND signer_id = b5) <> 'A Five' THEN RAISE EXCEPTION 'FAIL step 2 should name the alternate who signed'; END IF;
  IF (SELECT status FROM sign_signers WHERE id = p5) <> 'not_needed' THEN RAISE EXCEPTION 'FAIL the first person was not closed when the alternate won'; END IF;
  PERFORM public.sign_record_consent(b5, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(b5, NULL, NULL, 'en', 'v1');
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL the ordered document did not seal'; END IF;

  -- 5. A decline by either person still ends the document.
  INSERT INTO sign_documents (account_id, title, created_by, fields_snapshot) VALUES (acctA, 'Decline', uA, v_fields) RETURNING id INTO d6;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d6, 'ra', 'P Six', 'p6@example.invalid', 1) RETURNING id INTO p6;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d6, 'ra', 'A Six', 'a6@example.invalid', 1, p6) RETURNING id INTO a6;
  PERFORM public.sign_send_document(d6, 'p', repeat('e', 64), 1, NULL, uA);
  PERFORM public.sign_decline_signer(a6, 'not mine', NULL, NULL);
  IF (SELECT status FROM sign_documents WHERE id = d6) <> 'declined' THEN RAISE EXCEPTION 'FAIL a decline by the alternate did not end the document'; END IF;
  IF (SELECT status FROM sign_signers WHERE id = p6) = 'not_needed' THEN RAISE EXCEPTION 'FAIL a decline marked the other person as not needed'; END IF;

  -- 6. Moving the pair: they move together, and only while neither has been invited.
  INSERT INTO sign_documents (account_id, title, created_by, sign_in_order, fields_snapshot) VALUES (acctA, 'Move', uA, true, v_fields) RETURNING id INTO d7;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d7, 'rb', 'S Seven', 's7@example.invalid', 1) RETURNING id INTO s7;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d7, 'ra', 'P Seven', 'p7@example.invalid', 2) RETURNING id INTO p7;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d7, 'ra', 'A Seven', 'a7@example.invalid', 2, p7) RETURNING id INTO a7;
  PERFORM public.sign_send_document(d7, 'p', repeat('f', 64), 1, NULL, uA);
  PERFORM public.sign_move_signer(a7, 3, uA);
  IF (SELECT count(*) FROM sign_signers WHERE document_id = d7 AND role_key = 'ra' AND order_no = 3) <> 2 THEN RAISE EXCEPTION 'FAIL moving one person of the pair did not move both'; END IF;
  PERFORM public.sign_move_signer(p7, 4, uA);
  IF (SELECT count(*) FROM sign_signers WHERE document_id = d7 AND role_key = 'ra' AND order_no = 4) <> 2 THEN RAISE EXCEPTION 'FAIL moving the first person of the pair did not move both'; END IF;
  BEGIN
    PERFORM public.sign_move_signer(p7, 1, uA);
    RAISE EXCEPTION 'FAIL the pair was moved into a step that has begun';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 7. A part the first person handed to someone goes with them when the alternate completes the role.
  INSERT INTO sign_documents (account_id, title, created_by, allow_forwarding, form_snapshot) VALUES (acctA, 'Delegate', uA, true, v_form) RETURNING id INTO d8;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d8, 'merchant', 'P Eight', 'p8@example.invalid', 1) RETURNING id INTO p8;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, alternate_of) VALUES (acctA, d8, 'merchant', 'A Eight', 'a8@example.invalid', 1, p8) RETURNING id INTO a8;
  PERFORM public.sign_send_document(d8, 'p', repeat('1', 64), 1, NULL, uA);
  PERFORM public.sign_record_consent(p8, 'v1', 'en', NULL, NULL);
  PERFORM public.sign_record_consent(a8, 'v1', 'en', NULL, NULL);
  v_json := public.sign_forward_part(p8, 'bank', 'Bank Clerk', 'clerk@example.invalid', 2, NULL, NULL);
  SELECT id INTO dg FROM sign_signers WHERE document_id = d8 AND delegated_by = p8;
  IF dg IS NULL THEN RAISE EXCEPTION 'FAIL the part was not handed to a delegate'; END IF;
  r := public.sign_complete_signer(a8, NULL, NULL, 'en', 'v1');
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL the document waited for a delegate of a person who was not needed'; END IF;
  IF (SELECT status FROM sign_signers WHERE id = p8) <> 'not_needed' OR (SELECT status FROM sign_signers WHERE id = dg) <> 'not_needed' THEN
    RAISE EXCEPTION 'FAIL the first person and their delegate were not both closed';
  END IF;
  v_txt := NULL;
  BEGIN INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d8, dg, 'accountNo', '{"text":"123"}'::jsonb); EXCEPTION WHEN check_violation THEN v_txt := SQLERRM; END;
  IF v_txt IS DISTINCT FROM 'completed_by_other' THEN RAISE EXCEPTION 'FAIL the delegate of a person who was not needed could still answer (got %)', v_txt; END IF;

  -- 8. A document with one person per role is exactly as before: no event, nobody marked.
  INSERT INTO sign_documents (account_id, title, created_by, fields_snapshot) VALUES (acctA, 'Plain', uA, v_fields) RETURNING id INTO d9;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d9, 'ra', 'Plain A', 'plain.a@example.invalid', 1) RETURNING id INTO s9;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d9, 'rb', 'Plain B', 'plain.b@example.invalid', 2) RETURNING id INTO o1;
  PERFORM public.sign_send_document(d9, 'p', repeat('2', 64), 1, NULL, uA);
  PERFORM public.sign_record_consent(s9, 'v1', 'en', NULL, NULL);
  PERFORM public.sign_record_consent(o1, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(s9, NULL, NULL, 'en', 'v1');
  IF (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL a document with one person per role sealed early'; END IF;
  r := public.sign_complete_signer(o1, NULL, NULL, 'en', 'v1');
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL a document with one person per role did not seal'; END IF;
  IF EXISTS (SELECT 1 FROM sign_events WHERE document_id = d9 AND type = 'alternate_not_needed') OR EXISTS (SELECT 1 FROM sign_signers WHERE document_id = d9 AND status = 'not_needed') THEN
    RAISE EXCEPTION 'FAIL a document with no alternate marked somebody';
  END IF;
  v_txt := NULL;
  BEGIN PERFORM public.sign_complete_signer(s9, NULL, NULL, 'en', 'v1'); EXCEPTION WHEN check_violation THEN v_txt := SQLERRM; END;
  IF v_txt IS DISTINCT FROM 'document_not_open' THEN RAISE EXCEPTION 'FAIL completing a sealing document by a single person said % instead of document_not_open', v_txt; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: the second person of a role is an alternate (one for each person, same role, kind and step, another address, a draft document that is not in a collection, never a Halo user, a delegate or an alternate, fixed once set); the first person to complete the role wins under the document lock, the other becomes not_needed in the same transaction with an alternate_not_needed event, is refused as completed_by_other (also on a sealing document), cannot be reminded or decline, and has frozen answers; the document, the step and the next invitation do not wait for them (once, naming whoever signed); their delegate goes with them; the pair moves together; a decline still ends the document; the chain verifies; a document with no alternate behaves as before';
END
$verify$;
