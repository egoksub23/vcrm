-- Verify migration 171 (Doc Sign, envelopes: several documents signed in one sitting). Self-contained; run against an empty database or
-- production with 157's to 171's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: the table is tenant-scoped (RLS, no direct write, a document cannot join another workspace's envelope); the reference is
-- numbered and fixed; a document joins only as a draft, never leaves, never allows forwarding and is never a test; the send function
-- refuses an envelope whose people or options are not sound, sends every document in one transaction and gives ONE invitation per
-- person with ONE link (a token only for the person's first document); the person's consent lands on every document with one
-- timestamp; the next step is invited only when the step is finished on EVERY document, once; sealing and completion are per document,
-- the envelope's status follows them, the envelope is settled once and the sender is told once; void is refused once a document is fully
-- signed and acts on the whole envelope otherwise; a person who declines declines every open document; a different person replaces
-- someone who has signed nothing; a single document of an envelope cannot be sent, voided or declined on its own; a document that is
-- not in an envelope behaves as it always did; none of the new functions is callable by a signed-in or signed-out user.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();
  uB      uuid := gen_random_uuid();
  acctA   uuid;
  acctB   uuid;
  envA    uuid;
  envB    uuid;
  e1      uuid;  -- the main envelope: 2 documents, 2 people, ordered
  d1      uuid;
  d2      uuid;
  dB      uuid;  -- a document of the other workspace
  ali1    uuid;  -- Ali on document 1 (his anchor)
  ali2    uuid;
  bala1   uuid;  -- Bala on document 1 (his anchor)
  bala2   uuid;
  e2      uuid;  -- an unordered envelope to void
  e2d1    uuid;
  e2d2    uuid;
  e2c1    uuid;
  e2c2    uuid;
  e3      uuid;  -- an envelope with one document completed
  e3d1    uuid;
  e3d2    uuid;
  e3p1    uuid;
  e3p2    uuid;
  e3q1    uuid;
  e3q2    uuid;
  e4      uuid;  -- three documents, one person declines
  e4d     uuid[];
  e4p     uuid[];
  e5      uuid;  -- a recipient to change
  e5d1    uuid;
  e5d2    uuid;
  e5a1    uuid;
  e5a2    uuid;
  e5b1    uuid;
  e5b2    uuid;
  pl      uuid;  -- a plain document with two ordered signers
  pl1     uuid;
  pl2     uuid;
  pls1    uuid;
  pls2    uuid;
  r       jsonb;
  r2      jsonb;
  v_txt   text;
  v_txt2  text;
  v_n     int;
  v_res   text;
  v_t1    timestamptz;
  v_t2    timestamptz;
  v_hash  text;
  v_sha   text := repeat('a', 64);
  v_docs  jsonb;
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

  -- the body sent for a list of documents: [{document_id, base_path, base_sha256, page_count}]
  EXECUTE $f$
    CREATE FUNCTION pg_temp.bodies(p_ids uuid[]) RETURNS jsonb LANGUAGE sql AS $b$
      SELECT jsonb_agg(jsonb_build_object('document_id', i, 'base_path', 'base-' || i, 'base_sha256', repeat('a', 64), 'page_count', 1)) FROM unnest(p_ids) i;
    $b$;
  $f$;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  PERFORM public.sign_ensure_defaults(acctA);
  PERFORM public.sign_ensure_defaults(acctB);

  -- 1. The table: row level security on, nothing for the signed-out role, members read their own workspace's, nobody writes directly.
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.sign_envelopes'::regclass AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'FAIL row level security is off on sign_envelopes';
  END IF;
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Onboarding pack', uA) RETURNING id INTO envA;
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctB, 'Other tenant pack', uB) RETURNING id INTO envB;
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM sign_envelopes$q$, 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the signed-out role touched sign_envelopes: %', v_res; END IF;
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM sign_envelopes$q$);
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL a member should see exactly their own workspace''s envelope, saw %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT count(*)::text FROM sign_envelopes WHERE id = %L$q$, envA));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL tenant B saw tenant A''s envelope: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_envelopes (account_id, title) VALUES (%L, 'Mine')$q$, acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a member wrote to sign_envelopes directly: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$UPDATE sign_envelopes SET title = 'x' WHERE id = %L$q$, envA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a member changed an envelope directly: %', v_res; END IF;

  -- 2. The reference is numbered per workspace and fixed; a title is required; the status starts as a draft.
  IF (SELECT reference FROM sign_envelopes WHERE id = envA) !~ '^ENV-[0-9]{4}-000001$' THEN
    RAISE EXCEPTION 'FAIL the first envelope reference should be ENV-YYYY-000001, got %', (SELECT reference FROM sign_envelopes WHERE id = envA);
  END IF;
  IF (SELECT reference FROM sign_envelopes WHERE id = envB) !~ '^ENV-[0-9]{4}-000001$' THEN RAISE EXCEPTION 'FAIL each workspace numbers its own envelopes'; END IF;
  BEGIN
    UPDATE sign_envelopes SET reference = 'ENV-X' WHERE id = envA;
    RAISE EXCEPTION 'FAIL the reference of an envelope was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_envelopes (account_id, title) VALUES (acctA, '   ');
    RAISE EXCEPTION 'FAIL an envelope without a title was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_envelopes (account_id, title, status) VALUES (acctA, 'Sent already', 'sent');
    RAISE EXCEPTION 'FAIL an envelope was created as sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3. A document joins only as a draft of an envelope of its own workspace, with a position; the position is unique; it never leaves.
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'Master agreement', uA, envA, 1) RETURNING id INTO d1;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'Fee schedule', uA, envA, 2) RETURNING id INTO d2;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctB, 'B document', uB) RETURNING id INTO dB;
  BEGIN
    INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'Same place', uA, envA, 2);
    RAISE EXCEPTION 'FAIL two documents took the same place in an envelope';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'Seventh', uA, envA, 7);
    RAISE EXCEPTION 'FAIL a seventh place in an envelope was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_documents (account_id, title, created_by, envelope_id) VALUES (acctA, 'No place', uA, envA);
    RAISE EXCEPTION 'FAIL a document in an envelope without a position was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'Cross tenant', uA, envB, 1);
    RAISE EXCEPTION 'FAIL a document joined another workspace''s envelope';
  EXCEPTION WHEN foreign_key_violation OR check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET envelope_id = envB, envelope_position = 3 WHERE id = d2;
    RAISE EXCEPTION 'FAIL a document moved to another envelope';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET envelope_position = 3 WHERE id = d2;
    RAISE EXCEPTION 'FAIL the position of a document in an envelope was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET allow_forwarding = TRUE WHERE id = d2;
    RAISE EXCEPTION 'FAIL forwarding was allowed on a document of an envelope';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET test = TRUE WHERE id = d2;
    RAISE EXCEPTION 'FAIL a document of an envelope became a test';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET envelope_id = envA, envelope_position = 3 WHERE id = dB;
    RAISE EXCEPTION 'FAIL another workspace''s document joined the envelope';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN NULL;
  END;
  -- a person's party only on a document of an envelope
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, kind, party_id)
    VALUES (acctB, dB, 'merchant', 'Stray', 'stray@example.invalid', 1, 'signer', gen_random_uuid());
    RAISE EXCEPTION 'FAIL a person of a document outside an envelope got a party';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- the envelope's status is derived from its documents: a draft while any document is a draft
  IF (SELECT status FROM sign_envelopes WHERE id = envA) <> 'draft' THEN RAISE EXCEPTION 'FAIL a new envelope should be a draft'; END IF;

  -- 4. People of the main envelope: Ali (step 1) and Bala (step 2) on both documents; each person has one row per document, the first
  --    document's row is the anchor.
  ali1 := gen_random_uuid(); ali2 := gen_random_uuid(); bala1 := gen_random_uuid(); bala2 := gen_random_uuid();
  INSERT INTO sign_signers (id, account_id, document_id, role_key, full_name, email, order_no, kind, party_id) VALUES
    (ali1,  acctA, d1, 'merchant', 'Ali',  'ali@example.invalid',  1, 'signer', ali1),
    (bala1, acctA, d1, 'director', 'Bala', 'bala@example.invalid', 2, 'signer', bala1),
    (ali2,  acctA, d2, 'merchant', 'Ali',  'ali@example.invalid',  1, 'signer', ali1),
    (bala2, acctA, d2, 'director', 'Bala', 'bala@example.invalid', 2, 'signer', bala1);
  UPDATE sign_envelopes SET sign_in_order = TRUE WHERE id = envA;
  e1 := envA;

  -- 5. The send function refuses an envelope that is not sound.
  -- (documents of the envelope do not all say the same about the order)
  BEGIN
    PERFORM public.sign_send_envelope(e1, pg_temp.bodies(ARRAY[d1, d2]), now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL an envelope whose documents disagree about signing order was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_documents SET sign_in_order = TRUE WHERE envelope_id = e1;
  -- (one code for all)
  UPDATE sign_documents SET code_required = TRUE WHERE id = d2;
  BEGIN
    PERFORM public.sign_send_envelope(e1, pg_temp.bodies(ARRAY[d1, d2]), now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL an envelope whose documents disagree about the code was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_documents SET code_required = FALSE WHERE id = d2;
  -- (the wrong number of documents in the call)
  BEGIN
    PERFORM public.sign_send_envelope(e1, pg_temp.bodies(ARRAY[d1]), now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL an envelope was sent with one of its documents missing from the call';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_send_envelope(e1, pg_temp.bodies(ARRAY[d1, dB]), now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL an envelope was sent with another workspace''s document in the call';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- (a person without a party)
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, kind) VALUES (acctA, d2, 'witness', 'Loose', 'loose@example.invalid', 2, 'filler');
  BEGIN
    PERFORM public.sign_send_envelope(e1, pg_temp.bodies(ARRAY[d1, d2]), now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL an envelope with a person who has no party was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  DELETE FROM sign_signers WHERE email = 'loose@example.invalid';
  -- (a person twice on one document)
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, kind, party_id) VALUES (acctA, d2, 'witness', 'Ali', 'ali@example.invalid', 1, 'filler', ali1);
  BEGIN
    PERFORM public.sign_send_envelope(e1, pg_temp.bodies(ARRAY[d1, d2]), now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL an envelope with one person twice on a document was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  DELETE FROM sign_signers WHERE document_id = d2 AND role_key = 'witness';
  -- (the same person on different steps)
  UPDATE sign_signers SET order_no = 2 WHERE id = ali2;
  BEGIN
    PERFORM public.sign_send_envelope(e1, pg_temp.bodies(ARRAY[d1, d2]), now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL an envelope with a person on different steps was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_signers SET order_no = 1 WHERE id = ali2;
  -- (a party whose anchor is on a later document than the person's first one)
  UPDATE sign_signers SET party_id = ali2 WHERE party_id = ali1;
  BEGIN
    PERFORM public.sign_send_envelope(e1, pg_temp.bodies(ARRAY[d1, d2]), now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL an envelope whose anchor is not on the first document was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_signers SET party_id = ali1 WHERE party_id = ali2;
  -- nothing was changed by the refusals
  IF EXISTS (SELECT 1 FROM sign_documents WHERE envelope_id = e1 AND status <> 'draft') OR EXISTS (SELECT 1 FROM sign_signer_secrets WHERE account_id = acctA) THEN
    RAISE EXCEPTION 'FAIL a refused envelope left something behind';
  END IF;
  -- one document of an envelope is never sent on its own
  BEGIN
    PERFORM public.sign_send_document(d1, 'base-' || d1, v_sha, 1, now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL a document of an envelope was sent on its own';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 6. The send: every document, one transaction, ONE invitation per person with ONE link. Signing order: only step 1 is invited.
  r := public.sign_send_envelope(e1, pg_temp.bodies(ARRAY[d1, d2]), now() + interval '14 days', uA);
  IF (SELECT status FROM sign_envelopes WHERE id = e1) <> 'sent' OR (SELECT sent_at FROM sign_envelopes WHERE id = e1) IS NULL THEN
    RAISE EXCEPTION 'FAIL the envelope should be sent: %', (SELECT to_jsonb(x) FROM sign_envelopes x WHERE id = e1);
  END IF;
  IF (SELECT count(*) FROM sign_documents WHERE envelope_id = e1 AND status = 'sent' AND base_path = 'base-' || id::text) <> 2 THEN
    RAISE EXCEPTION 'FAIL both documents should be sent with their frozen files';
  END IF;
  IF jsonb_array_length(r -> 'invited') <> 1 OR r -> 'invited' -> 0 ->> 'name' <> 'Ali' OR (r -> 'invited' -> 0 ->> 'token') IS NULL
     OR (r -> 'invited' -> 0 ->> 'signer_id')::uuid <> ali1 OR (r -> 'invited' -> 0 ->> 'envelope_id')::uuid <> e1 THEN
    RAISE EXCEPTION 'FAIL one invitation (Ali, on his first document) was expected: %', r -> 'invited';
  END IF;
  IF (SELECT count(*) FROM sign_signer_secrets WHERE account_id = acctA) <> 1 OR NOT EXISTS (SELECT 1 FROM sign_signer_secrets WHERE signer_id = ali1) THEN
    RAISE EXCEPTION 'FAIL only the anchor row should have a link';
  END IF;
  IF (SELECT status FROM sign_signers WHERE id = ali2) <> 'sent' OR (SELECT invited_at FROM sign_signers WHERE id = ali2) IS NULL THEN
    RAISE EXCEPTION 'FAIL Ali''s row on the second document should be invited too';
  END IF;
  IF (SELECT count(*) FROM sign_signers WHERE id IN (bala1, bala2) AND status = 'pending') <> 2 THEN
    RAISE EXCEPTION 'FAIL Bala (step 2) should not be invited yet';
  END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id IN (d1, d2) AND type = 'envelope_sent') <> 2
     OR (SELECT count(*) FROM sign_events WHERE document_id = d1 AND type = 'invited' AND signer_id = ali1) <> 1
     OR (SELECT count(*) FROM sign_events WHERE document_id = d2 AND type = 'invited' AND signer_id = ali2) <> 1 THEN
    RAISE EXCEPTION 'FAIL each chain should say the envelope was sent and that Ali was invited';
  END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id IN (d1, d2) AND type = 'sent' AND detail ->> 'envelope' = (SELECT reference FROM sign_envelopes WHERE id = e1)) <> 2 THEN
    RAISE EXCEPTION 'FAIL the sent event of each document should name the envelope';
  END IF;
  -- both documents count toward the monthly limit
  IF (public.account_usage(acctA) ->> 'sign_documents_month')::int <> 2 THEN
    RAISE EXCEPTION 'FAIL the two documents of the envelope should count as two sent: %', public.account_usage(acctA);
  END IF;
  -- the envelope cannot be sent twice
  BEGIN
    PERFORM public.sign_send_envelope(e1, pg_temp.bodies(ARRAY[d1, d2]), now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL an envelope was sent twice';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- what was frozen stays frozen
  BEGIN
    UPDATE sign_envelopes SET title = 'Changed' WHERE id = e1;
    RAISE EXCEPTION 'FAIL the title of a sent envelope was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET allow_forwarding = TRUE WHERE id = d1;
    RAISE EXCEPTION 'FAIL forwarding was allowed on a sent document of an envelope';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 7. The person's side: first look and consent, once, on every document, with one timestamp.
  IF NOT public.sign_envelope_mark_viewed(ali1, '1.2.3.4', 'test') THEN RAISE EXCEPTION 'FAIL the first look was not recorded'; END IF;
  IF public.sign_envelope_mark_viewed(ali1, '1.2.3.4', 'test') THEN RAISE EXCEPTION 'FAIL the first look was recorded twice'; END IF;
  IF (SELECT count(*) FROM sign_signers WHERE id IN (ali1, ali2) AND status = 'viewed') <> 2 OR (SELECT status FROM sign_signers WHERE id = bala1) <> 'pending' THEN
    RAISE EXCEPTION 'FAIL a look should mark all of Ali''s rows and nobody else''s';
  END IF;
  BEGIN
    PERFORM public.sign_complete_signer(ali1, NULL, NULL, 'en', 'v1');
    RAISE EXCEPTION 'FAIL a document was completed without the agreement to sign electronically';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_envelope_record_consent(bala1, 'default-v1-en', 'en', NULL, NULL);
    RAISE EXCEPTION 'FAIL consent was recorded for a person who is not invited yet';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT public.sign_envelope_record_consent(ali1, 'default-v1-en', 'en', '1.2.3.4', 'test') THEN RAISE EXCEPTION 'FAIL the consent was not recorded'; END IF;
  SELECT consented_at INTO v_t1 FROM sign_signers WHERE id = ali1;
  SELECT consented_at INTO v_t2 FROM sign_signers WHERE id = ali2;
  IF v_t1 IS NULL OR v_t1 IS DISTINCT FROM v_t2 THEN RAISE EXCEPTION 'FAIL the consent should carry one timestamp on both documents: % and %', v_t1, v_t2; END IF;
  IF (SELECT count(DISTINCT consent_version) FROM sign_signers WHERE id IN (ali1, ali2)) <> 1 OR (SELECT consent_version FROM sign_signers WHERE id = ali2) <> 'default-v1-en' THEN
    RAISE EXCEPTION 'FAIL the same wording should be recorded on both documents';
  END IF;
  IF (SELECT count(*) FROM sign_events WHERE type = 'consented' AND document_id IN (d1, d2) AND detail ->> 'envelope_id' = e1::text) <> 2 THEN
    RAISE EXCEPTION 'FAIL each chain should record the consent';
  END IF;
  IF public.sign_envelope_record_consent(ali1, 'other', 'en', NULL, NULL) THEN RAISE EXCEPTION 'FAIL the consent was recorded twice'; END IF;
  IF (SELECT consent_version FROM sign_signers WHERE id = ali1) <> 'default-v1-en' THEN RAISE EXCEPTION 'FAIL the first agreement should be the one that counts'; END IF;

  -- 8. Finishing in order. Ali finishes the first document: the step is not finished on the second, so nobody is invited.
  r := public.sign_complete_signer(ali1, '1.2.3.4', 'test', 'en', 'default-v1-en');
  IF jsonb_array_length(r -> 'invited') <> 0 OR (r ->> 'sealing')::boolean OR (r ->> 'envelope_id')::uuid <> e1 THEN
    RAISE EXCEPTION 'FAIL finishing one document of an envelope should invite nobody: %', r;
  END IF;
  IF (SELECT status FROM sign_signers WHERE id = bala1) <> 'pending' THEN RAISE EXCEPTION 'FAIL Bala was invited before Ali had finished every document'; END IF;
  IF (SELECT status FROM sign_documents WHERE id = d1) <> 'in_progress' THEN RAISE EXCEPTION 'FAIL the first document should be in progress'; END IF;
  -- finishing the same document twice is refused (the page can ask again after a failure)
  BEGIN
    PERFORM public.sign_complete_signer(ali1, NULL, NULL, 'en', 'v1');
    RAISE EXCEPTION 'FAIL a document was completed twice by the same person';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Ali finishes the second document: every document is signed by step 1, so step 2 is invited: ONE invitation for Bala, one link.
  r := public.sign_complete_signer(ali2, '1.2.3.4', 'test', 'en', 'default-v1-en');
  IF jsonb_array_length(r -> 'invited') <> 1 OR r -> 'invited' -> 0 ->> 'name' <> 'Bala' OR (r -> 'invited' -> 0 ->> 'signer_id')::uuid <> bala1
     OR (r -> 'invited' -> 0 ->> 'token') IS NULL OR (r -> 'invited' -> 0 ->> 'envelope_id')::uuid <> e1 OR (r ->> 'sealing')::boolean THEN
    RAISE EXCEPTION 'FAIL step 2 should be invited once, as ONE invitation for Bala, after Ali finished both documents: %', r;
  END IF;
  IF (SELECT count(*) FROM sign_signer_secrets WHERE account_id = acctA) <> 2 OR EXISTS (SELECT 1 FROM sign_signer_secrets WHERE signer_id = bala2) THEN
    RAISE EXCEPTION 'FAIL Bala should have one link, on his first document only';
  END IF;
  IF (SELECT count(*) FROM sign_signers WHERE id IN (bala1, bala2) AND status = 'sent') <> 2 THEN RAISE EXCEPTION 'FAIL both of Bala''s rows should be invited'; END IF;
  IF (SELECT count(*) FROM sign_events WHERE type = 'invited' AND signer_id IN (bala1, bala2)) <> 2
     OR NOT EXISTS (SELECT 1 FROM sign_events WHERE type = 'invited' AND signer_id = bala1 AND detail ->> 'because' = 'signer_finished' AND detail ->> 'finished_name' = 'Ali') THEN
    RAISE EXCEPTION 'FAIL each chain should say Bala was invited because Ali finished';
  END IF;

  -- 9. Bala's turn: one consent, then both documents finish; each document seals on its own.
  IF NOT public.sign_envelope_record_consent(bala1, 'default-v1-en', 'en', NULL, NULL) THEN RAISE EXCEPTION 'FAIL Bala''s consent was not recorded'; END IF;
  IF (SELECT count(*) FROM sign_signers WHERE id IN (bala1, bala2) AND consented_at IS NOT NULL) <> 2 THEN RAISE EXCEPTION 'FAIL Bala''s consent should be on both documents'; END IF;
  r := public.sign_complete_signer(bala1, NULL, NULL, 'en', 'default-v1-en');
  IF NOT (r ->> 'sealing')::boolean OR jsonb_array_length(r -> 'invited') <> 0 THEN RAISE EXCEPTION 'FAIL the first document should be sealing: %', r; END IF;
  IF (SELECT status FROM sign_documents WHERE id = d1) <> 'sealing' OR (SELECT status FROM sign_envelopes WHERE id = e1) <> 'in_progress' THEN
    RAISE EXCEPTION 'FAIL one document sealing and one waiting should read in progress, got %', (SELECT status FROM sign_envelopes WHERE id = e1);
  END IF;
  -- once a document is fully signed the sender cannot cancel the envelope
  BEGIN
    PERFORM public.sign_void_envelope(e1, 'too late', uA);
    RAISE EXCEPTION 'FAIL an envelope with a fully signed document was voided';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  r := public.sign_complete_signer(bala2, NULL, NULL, 'en', 'default-v1-en');
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL the second document should be sealing: %', r; END IF;
  IF (SELECT status FROM sign_envelopes WHERE id = e1) <> 'sealing' THEN RAISE EXCEPTION 'FAIL both documents sealing should read sealing'; END IF;
  -- sealing finishes document by document
  PERFORM public.sign_finish_sealing(d1, 'final-' || d1, repeat('c', 64));
  IF (SELECT status FROM sign_envelopes WHERE id = e1) = 'completed' THEN RAISE EXCEPTION 'FAIL the envelope completed with one document still sealing'; END IF;
  IF (public.sign_envelope_settle(e1) ->> 'completed')::boolean THEN RAISE EXCEPTION 'FAIL the envelope was settled before its last document completed'; END IF;
  IF (SELECT count(*) FROM notifications WHERE user_id = uA AND type = 'sign_completed' AND sign_document_id IN (d1, d2)) <> 0 THEN
    RAISE EXCEPTION 'FAIL the sender was told before the envelope was complete';
  END IF;
  PERFORM public.sign_finish_sealing(d2, 'final-' || d2, repeat('d', 64));
  IF (SELECT status FROM sign_envelopes WHERE id = e1) <> 'completed' THEN RAISE EXCEPTION 'FAIL the envelope should be completed, got %', (SELECT status FROM sign_envelopes WHERE id = e1); END IF;
  r := public.sign_envelope_settle(e1);
  IF NOT (r ->> 'completed')::boolean THEN RAISE EXCEPTION 'FAIL the first settle should claim the completion: %', r; END IF;
  r2 := public.sign_envelope_settle(e1);
  IF (r2 ->> 'completed')::boolean OR NOT (r2 ->> 'already')::boolean THEN RAISE EXCEPTION 'FAIL the second settle should find it already claimed: %', r2; END IF;
  IF (SELECT completed_at FROM sign_envelopes WHERE id = e1) IS NULL OR (SELECT count(*) FROM sign_events WHERE type = 'envelope_completed' AND document_id IN (d1, d2)) <> 2 THEN
    RAISE EXCEPTION 'FAIL each chain should say the envelope completed, once';
  END IF;
  IF (SELECT count(*) FROM notifications WHERE user_id = uA AND type = 'sign_completed' AND sign_document_id IN (d1, d2)) <> 1
     OR NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = uA AND type = 'sign_completed' AND title LIKE '%ENV-%') THEN
    RAISE EXCEPTION 'FAIL the sender should be told once, naming the envelope: %', (SELECT string_agg(title, '; ') FROM notifications WHERE user_id = uA);
  END IF;
  -- every chain still recomputes
  IF NOT (public.sign_verify_chain(d1) ->> 'ok')::boolean OR NOT (public.sign_verify_chain(d2) ->> 'ok')::boolean THEN RAISE EXCEPTION 'FAIL a chain is broken'; END IF;
  -- the envelope is read by a member of the workspace and by nobody else
  v_res := pg_temp.run(uA, format($q$SELECT status FROM sign_envelopes WHERE id = %L$q$, e1));
  IF v_res <> 'completed' THEN RAISE EXCEPTION 'FAIL a member could not read the envelope: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT status FROM sign_envelopes WHERE id = %L$q$, e1));
  IF v_res LIKE 'completed%' THEN RAISE EXCEPTION 'FAIL tenant B read tenant A''s envelope'; END IF;

  -- 10. Void: an unordered envelope, two people, both invited at once with one invitation each. Voided as a whole.
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'To void', uA) RETURNING id INTO e2;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'V1', uA, e2, 1) RETURNING id INTO e2d1;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'V2', uA, e2, 2) RETURNING id INTO e2d2;
  e2c1 := gen_random_uuid(); e2c2 := gen_random_uuid();
  INSERT INTO sign_signers (id, account_id, document_id, role_key, full_name, email, order_no, kind, party_id) VALUES
    (e2c1, acctA, e2d1, 'merchant', 'Cik Ani', 'ani@example.invalid', 1, 'signer', e2c1),
    (gen_random_uuid(), acctA, e2d2, 'merchant', 'Cik Ani', 'ani@example.invalid', 1, 'signer', e2c1),
    (e2c2, acctA, e2d1, 'director', 'En Zul', 'zul@example.invalid', 1, 'signer', e2c2),
    (gen_random_uuid(), acctA, e2d2, 'director', 'En Zul', 'zul@example.invalid', 1, 'signer', e2c2);
  r := public.sign_send_envelope(e2, pg_temp.bodies(ARRAY[e2d1, e2d2]), now() + interval '14 days', uA);
  IF jsonb_array_length(r -> 'invited') <> 2 OR (SELECT count(*) FROM jsonb_array_elements(r -> 'invited') i WHERE i ->> 'token' IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'FAIL without signing order each person gets one invitation at once: %', r -> 'invited';
  END IF;
  IF (SELECT count(*) FROM sign_signers s JOIN sign_documents d ON d.id = s.document_id WHERE d.envelope_id = e2 AND s.status = 'sent') <> 4 THEN
    RAISE EXCEPTION 'FAIL all four rows should be invited';
  END IF;
  -- one document alone can be neither voided nor declined
  BEGIN
    PERFORM public.sign_void_document(e2d1, 'x', uA);
    RAISE EXCEPTION 'FAIL one document of an envelope was voided on its own';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_decline_signer(e2c1, 'no', NULL, NULL);
    RAISE EXCEPTION 'FAIL one document of an envelope was declined on its own';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- a draft cannot be voided as an envelope
  BEGIN
    PERFORM public.sign_void_envelope(envB, 'x', uB);
    RAISE EXCEPTION 'FAIL an envelope that was never sent was voided';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  r := public.sign_void_envelope(e2, 'Wrong merchant', uA);
  IF (SELECT status FROM sign_envelopes WHERE id = e2) <> 'voided' OR (SELECT void_reason FROM sign_envelopes WHERE id = e2) <> 'Wrong merchant'
     OR (SELECT count(*) FROM sign_documents WHERE envelope_id = e2 AND status = 'voided') <> 2
     OR (SELECT count(*) FROM sign_events WHERE type = 'voided' AND document_id IN (e2d1, e2d2)) <> 2 THEN
    RAISE EXCEPTION 'FAIL voiding should cancel every document and say why';
  END IF;
  BEGIN
    PERFORM public.sign_void_envelope(e2, 'again', uA);
    RAISE EXCEPTION 'FAIL an envelope was voided twice';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- the setting that lets the envelope void its documents did not stay on after the call
  IF COALESCE(current_setting('vircle.envelope_op', true), '') = 'void' THEN RAISE EXCEPTION 'FAIL the void setting stayed on after the call'; END IF;

  -- 11. Once one document is fully signed the envelope cannot be voided; a person who declines declines what is left.
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Partly done', uA) RETURNING id INTO e3;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'P1', uA, e3, 1) RETURNING id INTO e3d1;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'P2', uA, e3, 2) RETURNING id INTO e3d2;
  e3p1 := gen_random_uuid(); e3q1 := gen_random_uuid(); e3p2 := gen_random_uuid(); e3q2 := gen_random_uuid();
  INSERT INTO sign_signers (id, account_id, document_id, role_key, full_name, email, order_no, kind, party_id) VALUES
    (e3p1, acctA, e3d1, 'merchant', 'Pn', 'pn@example.invalid', 1, 'signer', e3p1),
    (e3p2, acctA, e3d2, 'merchant', 'Pn', 'pn@example.invalid', 1, 'signer', e3p1),
    (e3q1, acctA, e3d1, 'director', 'Qn', 'qn@example.invalid', 1, 'signer', e3q1),
    (e3q2, acctA, e3d2, 'director', 'Qn', 'qn@example.invalid', 1, 'signer', e3q1);
  PERFORM public.sign_send_envelope(e3, pg_temp.bodies(ARRAY[e3d1, e3d2]), now() + interval '14 days', uA);
  PERFORM public.sign_envelope_record_consent(e3p1, 'default-v1-en', 'en', NULL, NULL);
  PERFORM public.sign_envelope_record_consent(e3q1, 'default-v1-en', 'en', NULL, NULL);
  PERFORM public.sign_complete_signer(e3p1, NULL, NULL, 'en', 'default-v1-en');
  r := public.sign_complete_signer(e3q1, NULL, NULL, 'en', 'default-v1-en');
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL the first document of the partly done envelope should be sealing'; END IF;
  BEGIN
    PERFORM public.sign_void_envelope(e3, 'x', uA);
    RAISE EXCEPTION 'FAIL an envelope with a fully signed document was voided (sealing)';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM public.sign_finish_sealing(e3d1, 'final-' || e3d1, repeat('e', 64));
  BEGIN
    PERFORM public.sign_void_envelope(e3, 'x', uA);
    RAISE EXCEPTION 'FAIL an envelope with a completed document was voided';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT status FROM sign_envelopes WHERE id = e3) <> 'in_progress' THEN RAISE EXCEPTION 'FAIL one completed, one open should read in progress'; END IF;
  -- Pn declines the second document: it is declined, the completed one is not touched
  r := public.sign_envelope_decline(e3p1, 'Not what we agreed', '9.9.9.9', 'test');
  IF (SELECT status FROM sign_documents WHERE id = e3d2) <> 'declined' OR (SELECT status FROM sign_documents WHERE id = e3d1) <> 'completed'
     OR (SELECT status FROM sign_signers WHERE id = e3p2) <> 'declined' OR (SELECT decline_reason FROM sign_signers WHERE id = e3p2) <> 'Not what we agreed' THEN
    RAISE EXCEPTION 'FAIL declining should decline the open document and leave the completed one';
  END IF;
  IF (SELECT status FROM sign_envelopes WHERE id = e3) <> 'declined' THEN RAISE EXCEPTION 'FAIL the envelope should read declined, got %', (SELECT status FROM sign_envelopes WHERE id = e3); END IF;
  IF (SELECT count(*) FROM notifications WHERE user_id = uA AND type = 'sign_declined' AND sign_document_id IN (e3d1, e3d2)) <> 1 THEN
    RAISE EXCEPTION 'FAIL the sender should be told of the decline once';
  END IF;
  BEGIN
    PERFORM public.sign_envelope_decline(e3p1, 'again', NULL, NULL);
    RAISE EXCEPTION 'FAIL a person declined twice';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- a decline reaches every open document, including one the person has no row on (that chain says the envelope was declined)
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Three', uA) RETURNING id INTO e4;
  e4d := ARRAY[]::uuid[];
  FOR v_n IN 1..3 LOOP
    INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'T' || v_n, uA, e4, v_n) RETURNING id INTO d1;
    e4d := e4d || d1;
  END LOOP;
  e4p := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  INSERT INTO sign_signers (id, account_id, document_id, role_key, full_name, email, order_no, kind, party_id) VALUES
    (e4p[1], acctA, e4d[1], 'merchant', 'Rina', 'rina@example.invalid', 1, 'signer', e4p[1]),
    (e4p[2], acctA, e4d[2], 'merchant', 'Rina', 'rina@example.invalid', 1, 'signer', e4p[1]),
    (e4p[3], acctA, e4d[3], 'director', 'Sam',  'sam@example.invalid',  1, 'signer', e4p[3]);
  PERFORM public.sign_send_envelope(e4, pg_temp.bodies(e4d), now() + interval '14 days', uA);
  PERFORM public.sign_envelope_decline(e4p[1], NULL, NULL, NULL);
  IF (SELECT count(*) FROM sign_documents WHERE envelope_id = e4 AND status = 'declined') <> 3 THEN RAISE EXCEPTION 'FAIL all three documents should be declined'; END IF;
  IF (SELECT count(*) FROM sign_events WHERE type = 'declined' AND document_id IN (e4d[1], e4d[2])) <> 2
     OR (SELECT count(*) FROM sign_events WHERE type = 'envelope_declined' AND document_id = e4d[3]) <> 1 THEN
    RAISE EXCEPTION 'FAIL the chains should say who declined and that the envelope was declined';
  END IF;
  IF (SELECT status FROM sign_signers WHERE id = e4p[3]) <> 'sent' THEN RAISE EXCEPTION 'FAIL another person''s row should be left as it was'; END IF;

  -- 12. Remind, resend and a different person act on the person across all their documents.
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Recipients', uA) RETURNING id INTO e5;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'R1', uA, e5, 1) RETURNING id INTO e5d1;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'R2', uA, e5, 2) RETURNING id INTO e5d2;
  e5a1 := gen_random_uuid(); e5a2 := gen_random_uuid(); e5b1 := gen_random_uuid(); e5b2 := gen_random_uuid();
  INSERT INTO sign_signers (id, account_id, document_id, role_key, full_name, email, order_no, kind, party_id) VALUES
    (e5a1, acctA, e5d1, 'merchant', 'Ahmad', 'ahmad@example.invalid', 1, 'signer', e5a1),
    (e5a2, acctA, e5d2, 'merchant', 'Ahmad', 'ahmad@example.invalid', 1, 'signer', e5a1),
    (e5b1, acctA, e5d1, 'director', 'Budi', 'budi@example.invalid', 1, 'signer', e5b1),
    (e5b2, acctA, e5d2, 'director', 'Budi', 'budi@example.invalid', 1, 'signer', e5b1);
  PERFORM public.sign_send_envelope(e5, pg_temp.bodies(ARRAY[e5d1, e5d2]), now() + interval '14 days', uA);
  SELECT token_hash INTO v_hash FROM sign_signer_secrets WHERE signer_id = e5b1;
  r := public.sign_envelope_rotate_token(e5b1, uA, 'reminded');
  IF (r ->> 'token') IS NULL OR (r ->> 'envelope_id')::uuid <> e5 OR (SELECT token_hash FROM sign_signer_secrets WHERE signer_id = e5b1) = v_hash THEN
    RAISE EXCEPTION 'FAIL a reminder should give a new link and kill the old one';
  END IF;
  IF (SELECT count(*) FROM sign_events WHERE type = 'reminded' AND document_id IN (e5d1, e5d2) AND signer_id IN (e5b1, e5b2)) <> 2 THEN
    RAISE EXCEPTION 'FAIL the reminder should be on both chains';
  END IF;
  BEGIN
    PERFORM public.sign_envelope_rotate_token(e5b2, uA, 'resent');
    RAISE EXCEPTION 'FAIL a link was issued for a row that is not the anchor';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM public.sign_envelope_record_consent(e5a1, 'default-v1-en', 'en', NULL, NULL);
  SELECT token_hash INTO v_hash FROM sign_signer_secrets WHERE signer_id = e5a1;
  r := public.sign_envelope_change_recipient(e5a1, 'Ahmad Faiz', 'faiz@example.invalid', '', 'email', uA);
  IF (r ->> 'token') IS NULL OR (SELECT token_hash FROM sign_signer_secrets WHERE signer_id = e5a1) = v_hash THEN RAISE EXCEPTION 'FAIL a new person should get a new link'; END IF;
  IF (SELECT count(*) FROM sign_signers WHERE id IN (e5a1, e5a2) AND full_name = 'Ahmad Faiz' AND email = 'faiz@example.invalid' AND consented_at IS NULL AND status = 'sent') <> 2 THEN
    RAISE EXCEPTION 'FAIL the new person should be on both documents, not yet agreed';
  END IF;
  IF (SELECT count(*) FROM sign_events WHERE type = 'recipient_changed' AND document_id IN (e5d1, e5d2)) <> 2 THEN RAISE EXCEPTION 'FAIL both chains should record the change'; END IF;
  IF (SELECT count(*) FROM sign_signers WHERE id IN (e5b1, e5b2) AND email = 'budi@example.invalid') <> 2 THEN RAISE EXCEPTION 'FAIL another person''s rows were changed'; END IF;
  -- once a person has signed one document they cannot be replaced
  PERFORM public.sign_envelope_record_consent(e5a1, 'default-v1-en', 'en', NULL, NULL);
  PERFORM public.sign_complete_signer(e5a1, NULL, NULL, 'en', 'default-v1-en');
  BEGIN
    PERFORM public.sign_envelope_change_recipient(e5a1, 'Someone Else', 'else@example.invalid', '', 'email', uA);
    RAISE EXCEPTION 'FAIL a person who had signed a document was replaced';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT public.sign_envelope_claim_end(e5) OR public.sign_envelope_claim_end(e5) THEN RAISE EXCEPTION 'FAIL the end of an envelope should be claimed once'; END IF;

  -- 13. Expiry: one date, each document expires, the envelope reads expired, the sender is told once.
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Expires', uA) RETURNING id INTO e2;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'X1', uA, e2, 1) RETURNING id INTO e2d1;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'X2', uA, e2, 2) RETURNING id INTO e2d2;
  e2c1 := gen_random_uuid();
  INSERT INTO sign_signers (id, account_id, document_id, role_key, full_name, email, order_no, kind, party_id) VALUES
    (e2c1, acctA, e2d1, 'merchant', 'Lina', 'lina@example.invalid', 1, 'signer', e2c1),
    (gen_random_uuid(), acctA, e2d2, 'merchant', 'Lina', 'lina@example.invalid', 1, 'signer', e2c1);
  PERFORM public.sign_send_envelope(e2, pg_temp.bodies(ARRAY[e2d1, e2d2]), now() + interval '1 day', uA);
  UPDATE sign_documents SET expires_at = now() - interval '1 minute' WHERE envelope_id = e2;
  r := public.sign_expire_due(10);
  IF (SELECT count(*) FROM sign_documents WHERE envelope_id = e2 AND status = 'expired') <> 2 OR (SELECT status FROM sign_envelopes WHERE id = e2) <> 'expired' THEN
    RAISE EXCEPTION 'FAIL both documents should expire and the envelope read expired';
  END IF;
  IF (SELECT count(*) FROM notifications WHERE user_id = uA AND type = 'sign_expired' AND sign_document_id IN (e2d1, e2d2)) <> 1 THEN
    RAISE EXCEPTION 'FAIL the sender should be told of the expiry once';
  END IF;

  -- 14. A document that is not in an envelope behaves as it always did: send, one step at a time, sealing.
  INSERT INTO sign_documents (account_id, title, created_by, sign_in_order) VALUES (acctA, 'Plain', uA, TRUE) RETURNING id INTO pl;
  pls1 := gen_random_uuid(); pls2 := gen_random_uuid();
  INSERT INTO sign_signers (id, account_id, document_id, role_key, full_name, email, order_no, kind) VALUES
    (pls1, acctA, pl, 'merchant', 'Wan', 'wan@example.invalid', 1, 'signer'),
    (pls2, acctA, pl, 'director', 'Yee', 'yee@example.invalid', 2, 'signer');
  r := public.sign_send_document(pl, 'base-plain', v_sha, 1, now() + interval '14 days', uA);
  IF jsonb_array_length(r -> 'invited') <> 1 OR (r -> 'invited' -> 0) ? 'envelope_id' OR (r -> 'invited' -> 0 ->> 'signer_id')::uuid <> pls1 THEN
    RAISE EXCEPTION 'FAIL a plain document should invite its first step with no envelope: %', r;
  END IF;
  PERFORM public.sign_record_consent(pls1, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(pls1, NULL, NULL, 'en', 'v1');
  IF jsonb_array_length(r -> 'invited') <> 1 OR (r -> 'invited' -> 0 ->> 'signer_id')::uuid <> pls2 OR r ? 'envelope_id' OR (r ->> 'sealing')::boolean THEN
    RAISE EXCEPTION 'FAIL a plain document should invite the next step: %', r;
  END IF;
  PERFORM public.sign_record_consent(pls2, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(pls2, NULL, NULL, 'en', 'v1');
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL a plain document should be sealing when everyone has signed'; END IF;
  -- and may still be voided on its own
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Plain 2', uA) RETURNING id INTO pl2;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, kind) VALUES (acctA, pl2, 'merchant', 'Wan', 'wan@example.invalid', 1, 'signer');
  PERFORM public.sign_send_document(pl2, 'base-plain2', v_sha, 1, now() + interval '14 days', uA);
  PERFORM public.sign_void_document(pl2, 'plain void', uA);
  IF (SELECT status FROM sign_documents WHERE id = pl2) <> 'voided' THEN RAISE EXCEPTION 'FAIL a plain document should be voidable'; END IF;

  -- 15. Grants: nothing new is callable by a signed-in or a signed-out user; the server can call the ones the app uses.
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.proname IN ('sign_send_core', 'sign_send_envelope', 'sign_send_document', 'sign_invite_step', 'sign_envelope_invite_step', 'sign_envelope_lock', 'sign_envelope_derive',
                       'sign_envelope_record_consent', 'sign_envelope_mark_viewed', 'sign_envelope_rotate_token', 'sign_envelope_change_recipient',
                       'sign_envelope_decline', 'sign_void_envelope', 'sign_envelope_settle', 'sign_envelope_claim_end', 'sign_complete_signer',
                       'sign_void_document', 'sign_decline_signer')
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL callable by signed-in or signed-out users: %', v_txt; END IF;
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.proname IN ('sign_send_envelope', 'sign_send_document', 'sign_envelope_record_consent', 'sign_envelope_mark_viewed', 'sign_envelope_rotate_token',
                       'sign_envelope_change_recipient', 'sign_envelope_decline', 'sign_void_envelope', 'sign_envelope_settle', 'sign_envelope_claim_end',
                       'sign_complete_signer', 'sign_void_document', 'sign_decline_signer')
     AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL the server cannot call: %', v_txt; END IF;
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
     AND (p.proname LIKE 'sign\_envelope%' OR p.proname IN ('sign_send_core', 'sign_send_envelope', 'sign_void_envelope', 'sign_documents_envelope_guard', 'sign_documents_envelope_status', 'sign_signers_party_guard', 'sign_envelopes_guard'))
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL SECURITY DEFINER without a pinned search_path: %', v_txt; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: RLS and no direct writes; numbered fixed reference; a document joins only as a draft of its own workspace''s envelope and never allows forwarding or testing; the send function refuses unsound envelopes and sends every document in one transaction with one invitation and one link per person; consent on every document with one timestamp; the next step only when finished on every document, once; per-document sealing, status derived, settled and notified once; void refused once a document is fully signed, whole-envelope otherwise; decline reaches every open document; remind, resend and change recipient act on the person; a single document of an envelope cannot be sent, voided or declined alone; plain documents unchanged; grants and search_path';
END
$verify$;
