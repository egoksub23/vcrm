-- Verify migration 175 (Doc Sign: people who receive a copy). Self-contained; run against an empty database or production with 157's to 175's
-- migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: the table is tenant-scoped (row level security on, nothing for the signed-out role, members read their own workspace's rows, nobody
-- writes directly); a row has exactly one target (a document or a collection); a target of another workspace is refused; the name and the
-- address are checked like a signer's; one address once per target (case ignored) but the same address may be on another target; at most 10
-- for one target and the eleventh is refused; a document of a collection takes none of its own; a person is added only while the target is a
-- draft, sent or in progress (not sealing, completed or voided); a row never changes except notified_at, which still moves after the target
-- closed; deleting a draft target deletes its rows; the audit log has the person by name and never the address; the guard is not callable by
-- anyone and keeps a pinned search_path.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();
  uB      uuid := gen_random_uuid();
  acctA   uuid;
  acctB   uuid;
  docA    uuid;  -- a draft document on its own
  docA2   uuid;  -- another document on its own (to show the same address can be on two targets)
  docC    uuid;  -- a document of a collection
  docV    uuid;  -- a document that will be voided
  docS    uuid;  -- a document that was sent
  docB    uuid;  -- a document of the other workspace
  envA    uuid;  -- a draft collection
  envC    uuid;  -- a collection whose status is moved around
  envB    uuid;  -- a collection of the other workspace
  c1      uuid;
  c2      uuid;
  v_res   text;
  v_n     int;
  v_txt   text;
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

  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Collection A', uA) RETURNING id INTO envA;
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Collection C', uA) RETURNING id INTO envC;
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctB, 'Collection B', uB) RETURNING id INTO envB;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Plain one', uA) RETURNING id INTO docA;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Plain two', uA) RETURNING id INTO docA2;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'To void', uA) RETURNING id INTO docV;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Sent one', uA) RETURNING id INTO docS;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'In a collection', uA, envA, 1) RETURNING id INTO docC;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctB, 'Other tenant', uB) RETURNING id INTO docB;

  -- 1. Row level security on; the signed-out role has nothing; members read their own workspace's rows only; nobody writes directly.
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.sign_copy_recipients'::regclass AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'FAIL row level security is off on sign_copy_recipients';
  END IF;
  INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email, created_by) VALUES (acctA, docA, 'Siti Aminah', 'siti@copy.example.invalid', uA) RETURNING id INTO c1;
  INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctB, docB, 'Other Person', 'other@copy.example.invalid');
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM sign_copy_recipients$q$, 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the signed-out role touched sign_copy_recipients: %', v_res; END IF;
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM sign_copy_recipients$q$);
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL a member should see exactly their own workspace''s row, saw %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT count(*)::text FROM sign_copy_recipients WHERE id = %L$q$, c1));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL tenant B saw tenant A''s copy recipient: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (%L, %L, 'Mine', 'mine@copy.example.invalid')$q$, acctA, docA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a member added a copy recipient directly: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$UPDATE sign_copy_recipients SET notified_at = now() WHERE id = %L$q$, c1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a member changed a copy recipient directly: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$DELETE FROM sign_copy_recipients WHERE id = %L$q$, c1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a member removed a copy recipient directly: %', v_res; END IF;

  -- 2. Exactly one target.
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, full_name, email) VALUES (acctA, 'No target', 'none@copy.example.invalid');
    RAISE EXCEPTION 'FAIL a row without a target was accepted';
  -- the guard trigger answers first (22023) when no target exists; the table's CHECK holds for any row that gets past it
  EXCEPTION WHEN check_violation OR invalid_parameter_value THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, document_id, envelope_id, full_name, email) VALUES (acctA, docA, envA, 'Two targets', 'two@copy.example.invalid');
    RAISE EXCEPTION 'FAIL a row with two targets was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3. A target of another workspace is refused (the composite key).
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docB, 'Cross', 'cross@copy.example.invalid');
    RAISE EXCEPTION 'FAIL a copy recipient was put on another workspace''s document';
  EXCEPTION WHEN foreign_key_violation OR sqlstate '22023' THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, envelope_id, full_name, email) VALUES (acctA, envB, 'Cross', 'cross@copy.example.invalid');
    RAISE EXCEPTION 'FAIL a copy recipient was put on another workspace''s collection';
  EXCEPTION WHEN foreign_key_violation OR sqlstate '22023' THEN NULL;
  END;

  -- 4. The name and the address are checked like a signer's.
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docA, '   ', 'blank@copy.example.invalid');
    RAISE EXCEPTION 'FAIL a blank name was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docA, 'Bad Address', 'not-an-address');
    RAISE EXCEPTION 'FAIL a bad address was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docA, repeat('x', 161), 'long@copy.example.invalid');
    RAISE EXCEPTION 'FAIL a name over 160 characters was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5. One address once per target (case ignored); the same address may be on another target.
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docA, 'Siti Again', 'SITI@copy.example.invalid');
    RAISE EXCEPTION 'FAIL the same address twice on one document was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docA2, 'Siti Aminah', 'siti@copy.example.invalid');
  INSERT INTO sign_copy_recipients (account_id, envelope_id, full_name, email) VALUES (acctA, envA, 'Siti Aminah', 'siti@copy.example.invalid');
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, envelope_id, full_name, email) VALUES (acctA, envA, 'Siti Twice', 'Siti@Copy.Example.Invalid');
    RAISE EXCEPTION 'FAIL the same address twice on one collection was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 6. At most 10 for one target: the tenth is taken, the eleventh refused, and a place frees up when someone is removed.
  FOR v_n IN 2..10 LOOP
    INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docA, 'Person ' || v_n, 'p' || v_n || '@copy.example.invalid');
  END LOOP;
  IF (SELECT count(*) FROM sign_copy_recipients WHERE document_id = docA) <> 10 THEN RAISE EXCEPTION 'FAIL the tenth person was not taken'; END IF;
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docA, 'Person 11', 'p11@copy.example.invalid');
    RAISE EXCEPTION 'FAIL an eleventh person was accepted for one document';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- another target is counted on its own
  INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docA2, 'Person 11', 'p11@copy.example.invalid');
  DELETE FROM sign_copy_recipients WHERE document_id = docA AND email = 'p10@copy.example.invalid';
  INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docA, 'Person 11', 'p11@copy.example.invalid');
  -- the limit is for collections too
  FOR v_n IN 2..10 LOOP
    INSERT INTO sign_copy_recipients (account_id, envelope_id, full_name, email) VALUES (acctA, envA, 'Person ' || v_n, 'p' || v_n || '@copy.example.invalid');
  END LOOP;
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, envelope_id, full_name, email) VALUES (acctA, envA, 'Person 11', 'p11@copy.example.invalid');
    RAISE EXCEPTION 'FAIL an eleventh person was accepted for one collection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 7. A document of a collection takes none of its own: they belong to the collection.
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docC, 'Member doc', 'member@copy.example.invalid');
    RAISE EXCEPTION 'FAIL a document of a collection took a copy recipient of its own';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 8. Added only while the target is a draft, sent or in progress.
  UPDATE sign_documents SET status = 'voided' WHERE id = docV;
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docV, 'Too late', 'late@copy.example.invalid');
    RAISE EXCEPTION 'FAIL a person was added to a voided document';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_documents SET status = 'sent', base_path = 'base-sent', base_sha256 = repeat('a', 64) WHERE id = docS;
  INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docS, 'While sent', 'sent@copy.example.invalid');
  UPDATE sign_documents SET status = 'in_progress' WHERE id = docS;
  INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docS, 'While open', 'open@copy.example.invalid');
  UPDATE sign_documents SET status = 'sealing' WHERE id = docS;
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docS, 'While sealing', 'sealing@copy.example.invalid');
    RAISE EXCEPTION 'FAIL a person was added to a document that is being sealed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- a collection: the same, by its own status
  UPDATE sign_envelopes SET status = 'sent' WHERE id = envC;
  INSERT INTO sign_copy_recipients (account_id, envelope_id, full_name, email) VALUES (acctA, envC, 'Coll sent', 'csent@copy.example.invalid');
  UPDATE sign_envelopes SET status = 'in_progress' WHERE id = envC;
  INSERT INTO sign_copy_recipients (account_id, envelope_id, full_name, email) VALUES (acctA, envC, 'Coll open', 'copen@copy.example.invalid');
  FOREACH v_txt IN ARRAY ARRAY['sealing', 'completed', 'voided', 'declined', 'expired']::text[] LOOP
    UPDATE sign_envelopes SET status = v_txt WHERE id = envC;
    BEGIN
      INSERT INTO sign_copy_recipients (account_id, envelope_id, full_name, email) VALUES (acctA, envC, 'Coll late', 'clate@copy.example.invalid');
      RAISE EXCEPTION 'FAIL a person was added to a collection that is %', v_txt;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  -- 9. A row never changes except notified_at, which still moves after the target has closed.
  BEGIN
    UPDATE sign_copy_recipients SET email = 'changed@copy.example.invalid' WHERE id = c1;
    RAISE EXCEPTION 'FAIL the address of a copy recipient was changed in place';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_copy_recipients SET full_name = 'Renamed' WHERE id = c1;
    RAISE EXCEPTION 'FAIL the name of a copy recipient was changed in place';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_copy_recipients SET document_id = docA2 WHERE id = c1;
    RAISE EXCEPTION 'FAIL a copy recipient was moved to another document';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_copy_recipients SET notified_at = now() WHERE id = c1;
  UPDATE sign_copy_recipients SET notified_at = now() WHERE document_id = docS;
  IF (SELECT notified_at FROM sign_copy_recipients WHERE id = c1) IS NULL THEN RAISE EXCEPTION 'FAIL notified_at did not move'; END IF;
  -- the first claim wins: a second claim of an already-notified row matches nothing
  WITH claimed AS (UPDATE sign_copy_recipients SET notified_at = now() WHERE id = c1 AND notified_at IS NULL RETURNING id)
  SELECT count(*) INTO v_n FROM claimed;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL a person who was already told was claimed again'; END IF;

  -- 10. Deleting a draft target deletes its rows (the cascade); another target's rows stay.
  SELECT id INTO c2 FROM sign_copy_recipients WHERE document_id = docA2 LIMIT 1;
  DELETE FROM sign_documents WHERE id = docA2;
  IF EXISTS (SELECT 1 FROM sign_copy_recipients WHERE document_id = docA2) THEN RAISE EXCEPTION 'FAIL the rows of a deleted document stayed'; END IF;
  IF (SELECT count(*) FROM sign_copy_recipients WHERE document_id = docA) <> 10 THEN RAISE EXCEPTION 'FAIL another document''s rows changed'; END IF;
  DELETE FROM sign_documents WHERE id = docC;
  DELETE FROM sign_envelopes WHERE id = envA;
  IF EXISTS (SELECT 1 FROM sign_copy_recipients WHERE envelope_id = envA) THEN RAISE EXCEPTION 'FAIL the rows of a deleted collection stayed'; END IF;

  -- 11. The audit log has the person by name and by who added them, and never the address.
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_type = 'sign_copy_recipient' AND entity_id = c1 AND action = 'created' AND entity_label = 'Siti Aminah' AND actor_id = uA) THEN
    RAISE EXCEPTION 'FAIL the person was not audited by name with who added them';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_type = 'sign_copy_recipient' AND (summary::text LIKE '%copy.example.invalid%' OR entity_label LIKE '%@%')) THEN
    RAISE EXCEPTION 'FAIL the audit log carries an address';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_type = 'sign_copy_recipient' AND entity_id = c1 AND action = 'updated') THEN
    RAISE EXCEPTION 'FAIL the record of a message sent was audited as a change to the person';
  END IF;
  DELETE FROM sign_copy_recipients WHERE id = c1;
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_type = 'sign_copy_recipient' AND entity_id = c1 AND action = 'deleted') THEN
    RAISE EXCEPTION 'FAIL the removal was not audited';
  END IF;

  -- 12. The guard is not callable by anyone, and keeps a pinned search_path; the trigger is there.
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sign_copy_recipients_guard'
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL callable by signed-in or signed-out users: %', v_txt; END IF;
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef AND p.proname = 'sign_copy_recipients_guard'
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL SECURITY DEFINER without a pinned search_path: %', v_txt; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.sign_copy_recipients'::regclass AND tgname = 'sign_copy_recipients_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FAIL the guard trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.sign_copy_recipients'::regclass AND tgname = 'audit_row_change' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FAIL the audit trigger is missing';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: row level security on, members read their own workspace only, nobody writes directly; exactly one target; another workspace''s target refused; name and address checked; one address once per target (case ignored); at most 10 per target; a document of a collection takes none of its own; added only while the target is a draft, sent or in progress; only notified_at ever changes and the first claim wins; a deleted target takes its rows; the audit log has the name and never the address; the guard is not callable and pins search_path';
END
$verify$;
