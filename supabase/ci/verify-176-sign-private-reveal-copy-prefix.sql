-- Verify migration 176 (Doc Sign: the Reveal capability, private documents, copy recipients for bulk send and registration forms, the COL- prefix).
-- Self-contained; run against an empty database or production with 157's to 176's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: (1) sign.reveal-sensitive is in the catalogue (database tier is not claimed: 'app'), the owner and the admin hold it and an agent and a
-- viewer do not; (2) is_private is a NOT NULL column that defaults to false on documents and collections; (3) a private document is seen by its
-- uploader, an admin, the owner and a Halo user named as a signer on it, and by nobody else with Doc Sign (another agent, a viewer, another
-- workspace, the signed-out role), in sign_documents and in everything that hangs off it (files, signers, step invites, answers, events, copy
-- recipients, the rows of a bulk batch and of a registration), and the chain check says "not found" to a person who cannot see it; a draft of
-- someone else's is not editable or deletable by a person who cannot see it, and a named signer reads a draft without editing it; only the
-- uploader or an admin marks a document private (a person's session), a sent document's flag is fixed; (4) the collection decides: the documents
-- of a private collection are private whatever they were inserted as, a document's own flag cannot override it, the flag moves with the collection,
-- is fixed once it is sent, a private document does not join a public collection, a person named on one document of a private collection sees that
-- document and the collection and not its other documents; (5) a registration form and a bulk batch carry a list of copy recipients that is checked
-- (at most 10, a name and an address like a signer's, each address once, case ignored) and that goes onto a document as ordinary copy recipients;
-- (6) a new collection's reference starts COL-, an ENV- reference stays valid and fixed; (7) the new functions: the helpers run for signed-in and
-- signed-out roles and say no to the signed-out one, the guards are not callable, every SECURITY DEFINER function pins its search_path.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();  -- owner of workspace A
  uAd     uuid := gen_random_uuid();  -- admin of A
  uU      uuid := gen_random_uuid();  -- an agent of A who uploads the private documents
  uN      uuid := gen_random_uuid();  -- an agent of A who is named as a Halo signer
  uO      uuid := gen_random_uuid();  -- another agent of A (sees Doc Sign, is neither of the above)
  uV      uuid := gen_random_uuid();  -- a viewer of A (no Doc Sign)
  uB      uuid := gen_random_uuid();  -- owner of workspace B
  acctA   uuid;
  acctB   uuid;
  docP    uuid;  -- a private draft of uU
  docPub  uuid;  -- a public draft of uU
  docS    uuid;  -- a private document that will be sent
  docJ    uuid;  -- a private draft that tries to join a collection
  docB    uuid;  -- a document of workspace B
  envP    uuid;  -- a private collection of uU
  envPub  uuid;  -- a public collection of uU
  envF    uuid;  -- a private collection that will be sent
  docE1   uuid;
  docE2   uuid;
  docPE   uuid;  -- a document of the public collection
  s1      uuid;  -- the Halo signer (uN) on docP
  s2      uuid;  -- an outside signer on docP
  sE1     uuid;
  sE2     uuid;
  formF   uuid;
  jobJ    uuid;
  v_res   text;
  v_n     int;
  v_txt   text;
  v_ref   text;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      -- a NULL person is a caller with no session at all (what the signed-out role is): auth.uid() is then null
      PERFORM set_config('request.jwt.claims', CASE WHEN u IS NULL THEN '' ELSE json_build_object('sub', u, 'role', r)::text END, true);
      PERFORM set_config('request.jwt.claim.sub', COALESCE(u::text, ''), true);
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
  -- how many rows of a table (that satisfy a condition) a person sees
  EXECUTE $f$
    CREATE FUNCTION pg_temp.seen(u UUID, tbl TEXT, cond TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE sql AS $b$
      SELECT pg_temp.run(u, format('SELECT count(*)::text FROM %s WHERE %s', tbl, cond), r);
    $b$;
  $f$;

  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'  || uA  || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uAd, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ad-' || uAd || '@example.invalid', '{"full_name":"Admin"}', now()),
    (uU,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u-'  || uU  || '@example.invalid', '{"full_name":"Uploader"}', now()),
    (uN,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'n-'  || uN  || '@example.invalid', '{"full_name":"Named signer"}', now()),
    (uO,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-'  || uO  || '@example.invalid', '{"full_name":"Other agent"}', now()),
    (uV,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'v-'  || uV  || '@example.invalid', '{"full_name":"Viewer"}', now()),
    (uB,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'  || uB  || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  UPDATE profiles SET account_id = acctA, account_role = 'admin'  WHERE user_id = uAd;
  UPDATE profiles SET account_id = acctA, account_role = 'agent'  WHERE user_id = uU;
  UPDATE profiles SET account_id = acctA, account_role = 'agent'  WHERE user_id = uN;
  UPDATE profiles SET account_id = acctA, account_role = 'agent'  WHERE user_id = uO;
  UPDATE profiles SET account_id = acctA, account_role = 'viewer' WHERE user_id = uV;
  PERFORM public.sign_ensure_defaults(acctA);
  PERFORM public.sign_ensure_defaults(acctB);

  -- 1. The capability: in the catalogue (app tier: the answers are read by the server), held by the owner and the admin only.
  IF NOT EXISTS (SELECT 1 FROM capability_catalogue WHERE capability = 'sign.reveal-sensitive' AND min_grant_role = 'agent' AND enforced_by = 'app') THEN
    RAISE EXCEPTION 'FAIL sign.reveal-sensitive is not in the catalogue as an agent-grantable app capability';
  END IF;
  IF (SELECT count(*) FROM role_capability_defaults WHERE capability = 'sign.reveal-sensitive') <> 2
     OR NOT EXISTS (SELECT 1 FROM role_capability_defaults WHERE capability = 'sign.reveal-sensitive' AND role = 'owner')
     OR NOT EXISTS (SELECT 1 FROM role_capability_defaults WHERE capability = 'sign.reveal-sensitive' AND role = 'admin') THEN
    RAISE EXCEPTION 'FAIL sign.reveal-sensitive should default to the owner and the admin only';
  END IF;
  FOREACH v_ref IN ARRAY ARRAY['uA', 'uAd'] LOOP
    v_res := pg_temp.run(CASE v_ref WHEN 'uA' THEN uA ELSE uAd END, format($q$SELECT has_capability(%L, 'sign.reveal-sensitive')::text$q$, acctA));
    IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL % should hold sign.reveal-sensitive (saw %)', v_ref, v_res; END IF;
  END LOOP;
  FOREACH v_ref IN ARRAY ARRAY['uU', 'uV'] LOOP
    v_res := pg_temp.run(CASE v_ref WHEN 'uU' THEN uU ELSE uV END, format($q$SELECT has_capability(%L, 'sign.reveal-sensitive')::text$q$, acctA));
    IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL % must not hold sign.reveal-sensitive by default (saw %)', v_ref, v_res; END IF;
  END LOOP;
  -- sending still does not give it (and the agent keeps sign.send)
  v_res := pg_temp.run(uU, format($q$SELECT (has_capability(%L, 'sign.send') AND NOT has_capability(%L, 'sign.reveal-sensitive'))::text$q$, acctA, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL an agent should send documents without being able to reveal answers (saw %)', v_res; END IF;

  -- 2. The columns: NOT NULL, default false, on both tables.
  SELECT string_agg(table_name || ':' || is_nullable || ':' || coalesce(column_default, ''), ', ' ORDER BY table_name) INTO v_txt
    FROM information_schema.columns
   WHERE table_schema = 'public' AND column_name = 'is_private' AND table_name IN ('sign_documents', 'sign_envelopes');
  IF v_txt IS DISTINCT FROM 'sign_documents:NO:false, sign_envelopes:NO:false' THEN RAISE EXCEPTION 'FAIL the is_private columns are %', v_txt; END IF;

  -- A document made the way the server makes the ones automations, bulk send and registration forms make (no flag) is not private.
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Made by a job', uAd) RETURNING id INTO docJ;
  IF (SELECT is_private FROM sign_documents WHERE id = docJ) THEN RAISE EXCEPTION 'FAIL a document made without the flag is private'; END IF;
  DELETE FROM sign_documents WHERE id = docJ;

  -- 3. A private document, made by an agent through the browser's own rules.
  v_res := pg_temp.run(uU, format($q$INSERT INTO sign_documents (account_id, title, created_by, is_private) VALUES (%L, 'Private one', %L, true)$q$, acctA, uU));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL an agent could not make a private draft: %', v_res; END IF;
  v_res := pg_temp.run(uU, format($q$INSERT INTO sign_documents (account_id, title, created_by) VALUES (%L, 'Public one', %L)$q$, acctA, uU));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL an agent could not make a public draft: %', v_res; END IF;
  SELECT id INTO docP   FROM sign_documents WHERE account_id = acctA AND title = 'Private one';
  SELECT id INTO docPub FROM sign_documents WHERE account_id = acctA AND title = 'Public one';
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctB, 'Other tenant', uB) RETURNING id INTO docB;
  -- everything that hangs off the private document
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, docP, 'merchant', 'Ali', 'ali@kedai.example.invalid', 1) RETURNING id INTO s2;
  INSERT INTO sign_document_files (account_id, document_id, kind, path, name) VALUES (acctA, docP, 'source', 'account-' || acctA || '/' || docP || '/base.pdf', 'base.pdf');
  INSERT INTO sign_step_invites (document_id, account_id, step) VALUES (docP, acctA, 1);
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, docP, s2, 'ic_number', '"900101015555"'::jsonb);
  PERFORM public.sign_log(docP, 'created', 'user', NULL, uU, '{}'::jsonb);
  PERFORM public.sign_log(docP, 'sensitive_viewed', 'user', NULL, uAd, '{"field":"ic_number"}'::jsonb);
  INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email, created_by) VALUES (acctA, docP, 'Siti Aminah', 'siti@copy.example.invalid', uU);
  -- and the same kind of rows on a public document, which everyone with Doc Sign keeps seeing
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, docPub, 'merchant', 'Bala', 'bala@kedai.example.invalid', 1);
  PERFORM public.sign_log(docPub, 'created', 'user', NULL, uU, '{}'::jsonb);

  -- who sees the document (and its row of every kind) before anyone is named: the uploader, the admin and the owner; nobody else
  FOREACH v_ref IN ARRAY ARRAY['sign_documents|id', 'sign_signers|document_id', 'sign_document_files|document_id', 'sign_step_invites|document_id', 'sign_answers|document_id', 'sign_events|document_id', 'sign_copy_recipients|document_id'] LOOP
    IF pg_temp.seen(uU,  split_part(v_ref, '|', 1), format('%I = %L', split_part(v_ref, '|', 2), docP)) <> (CASE WHEN split_part(v_ref, '|', 1) = 'sign_events' THEN '2' ELSE '1' END) THEN
      RAISE EXCEPTION 'FAIL the uploader did not see their private document in %', split_part(v_ref, '|', 1);
    END IF;
    FOREACH v_txt IN ARRAY ARRAY['uAd', 'uA'] LOOP
      IF pg_temp.seen(CASE v_txt WHEN 'uAd' THEN uAd ELSE uA END, split_part(v_ref, '|', 1), format('%I = %L', split_part(v_ref, '|', 2), docP)) = '0' THEN
        RAISE EXCEPTION 'FAIL % (an admin or the owner) did not see a private document in %', v_txt, split_part(v_ref, '|', 1);
      END IF;
    END LOOP;
    FOREACH v_txt IN ARRAY ARRAY['uN', 'uO', 'uV', 'uB'] LOOP
      v_res := pg_temp.seen(CASE v_txt WHEN 'uN' THEN uN WHEN 'uO' THEN uO WHEN 'uV' THEN uV ELSE uB END, split_part(v_ref, '|', 1), format('%I = %L', split_part(v_ref, '|', 2), docP));
      IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL % saw a private document in % (saw %)', v_txt, split_part(v_ref, '|', 1), v_res; END IF;
    END LOOP;
    v_res := pg_temp.seen(NULL::uuid, split_part(v_ref, '|', 1), format('%I = %L', split_part(v_ref, '|', 2), docP), 'anon');
    IF v_res NOT IN ('0') AND v_res NOT LIKE 'ERR 42501: permission denied for table%' THEN RAISE EXCEPTION 'FAIL the signed-out role touched % (saw %)', split_part(v_ref, '|', 1), v_res; END IF;
  END LOOP;
  -- the public document is still seen by every agent, and counted
  FOREACH v_txt IN ARRAY ARRAY['uU', 'uO', 'uN', 'uAd'] LOOP
    v_res := pg_temp.seen(CASE v_txt WHEN 'uU' THEN uU WHEN 'uO' THEN uO WHEN 'uN' THEN uN ELSE uAd END, 'sign_documents', format('id = %L', docPub));
    IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL % lost sight of a public document (saw %)', v_txt, v_res; END IF;
    v_res := pg_temp.seen(CASE v_txt WHEN 'uU' THEN uU WHEN 'uO' THEN uO WHEN 'uN' THEN uN ELSE uAd END, 'sign_signers', format('document_id = %L', docPub));
    IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL % lost sight of the signers of a public document (saw %)', v_txt, v_res; END IF;
  END LOOP;
  -- counts of the whole workspace follow the same rule (the list's own count)
  IF pg_temp.seen(uO, 'sign_documents', format('account_id = %L', acctA)) <> '1' THEN RAISE EXCEPTION 'FAIL another agent counted a private document in the workspace''s documents'; END IF;
  IF pg_temp.seen(uU, 'sign_documents', format('account_id = %L', acctA)) <> '2' THEN RAISE EXCEPTION 'FAIL the uploader did not count both their documents'; END IF;
  IF pg_temp.seen(uA, 'sign_documents', format('account_id = %L', acctA)) <> '2' THEN RAISE EXCEPTION 'FAIL the owner did not count both documents'; END IF;
  -- a viewer and another workspace see no document of this workspace at all
  IF pg_temp.seen(uV, 'sign_documents', format('account_id = %L', acctA)) <> '0' OR pg_temp.seen(uB, 'sign_documents', format('account_id = %L', acctA)) <> '0' THEN
    RAISE EXCEPTION 'FAIL a viewer or another workspace saw documents of this workspace';
  END IF;

  -- The helper itself answers for the caller; signed out it says no to everything.
  IF pg_temp.run(uU, format($q$SELECT public.sign_document_visible(%L)::text$q$, docP)) <> 'true'
     OR pg_temp.run(uO, format($q$SELECT public.sign_document_visible(%L)::text$q$, docP)) <> 'false'
     OR pg_temp.run(uO, format($q$SELECT public.sign_document_visible(%L)::text$q$, docPub)) <> 'true'
     OR pg_temp.run(NULL::uuid, format($q$SELECT public.sign_document_visible(%L)::text$q$, docPub), 'anon') NOT IN ('false')
     OR pg_temp.run(NULL::uuid, format($q$SELECT public.sign_document_visible(%L)::text$q$, docPub)) NOT IN ('false')
     OR pg_temp.run(uU, $q$SELECT public.sign_document_visible(gen_random_uuid())::text$q$) <> 'false' THEN
    RAISE EXCEPTION 'FAIL sign_document_visible does not answer as the caller';
  END IF;

  -- The chain check: the uploader, the admin and the owner get an answer; another agent is told the document is not there, as for one that is not.
  IF pg_temp.run(uU, format($q$SELECT (public.sign_verify_chain(%L) ->> 'ok')$q$, docP)) <> 'true'
     OR pg_temp.run(uAd, format($q$SELECT (public.sign_verify_chain(%L) ->> 'ok')$q$, docP)) <> 'true' THEN
    RAISE EXCEPTION 'FAIL the uploader or an admin could not check the chain of a private document';
  END IF;
  v_res := pg_temp.run(uO, format($q$SELECT (public.sign_verify_chain(%L) ->> 'ok')$q$, docP));
  IF v_res NOT LIKE 'ERR 22023: Document not found' THEN RAISE EXCEPTION 'FAIL another agent was not told "not found" about a private chain: %', v_res; END IF;
  v_res := pg_temp.run(uO, format($q$SELECT (public.sign_verify_chain(%L) ->> 'ok')$q$, docPub));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL another agent could not check a public chain: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT (public.sign_verify_chain(%L) ->> 'ok')$q$, docP));
  IF v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL another workspace could check a chain: %', v_res; END IF;

  -- A Halo user named as a signer sees it (and everything about it); another agent still does not.
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, internal_user_id) VALUES (acctA, docP, 'director', 'Named signer', 'n@example.invalid', 2, uN) RETURNING id INTO s1;
  FOREACH v_ref IN ARRAY ARRAY['sign_documents|id', 'sign_signers|document_id', 'sign_document_files|document_id', 'sign_step_invites|document_id', 'sign_answers|document_id', 'sign_events|document_id', 'sign_copy_recipients|document_id'] LOOP
    v_res := pg_temp.seen(uN, split_part(v_ref, '|', 1), format('%I = %L', split_part(v_ref, '|', 2), docP));
    IF v_res = '0' THEN RAISE EXCEPTION 'FAIL the named signer did not see the document in %', split_part(v_ref, '|', 1); END IF;
    v_res := pg_temp.seen(uO, split_part(v_ref, '|', 1), format('%I = %L', split_part(v_ref, '|', 2), docP));
    IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL naming a signer opened % to another agent (saw %)', split_part(v_ref, '|', 1), v_res; END IF;
  END LOOP;
  -- both signers' rows are visible to the named signer (the person who signs sees who signs)
  IF pg_temp.seen(uN, 'sign_signers', format('document_id = %L', docP)) <> '2' THEN RAISE EXCEPTION 'FAIL the named signer should see both signers of the document'; END IF;
  IF pg_temp.run(uN, format($q$SELECT (public.sign_verify_chain(%L) ->> 'ok')$q$, docP)) <> 'true' THEN RAISE EXCEPTION 'FAIL the named signer could not check the chain'; END IF;
  -- being named on a DIFFERENT document opens nothing here
  IF pg_temp.seen(uN, 'sign_documents', format('id = %L', docPub)) <> '1' THEN RAISE EXCEPTION 'FAIL the named signer lost a public document'; END IF;

  -- Editing and deleting a draft: whoever cannot see a private draft cannot change it; a named signer reads it without editing it.
  PERFORM pg_temp.run(uO, format($q$UPDATE sign_documents SET title = 'Changed by another agent' WHERE id = %L$q$, docP));
  PERFORM pg_temp.run(uN, format($q$UPDATE sign_documents SET title = 'Changed by the named signer' WHERE id = %L$q$, docP));
  IF (SELECT title FROM sign_documents WHERE id = docP) <> 'Private one' THEN RAISE EXCEPTION 'FAIL a person who may not edit a private draft changed it'; END IF;
  PERFORM pg_temp.run(uO, format($q$DELETE FROM sign_documents WHERE id = %L$q$, docP));
  PERFORM pg_temp.run(uN, format($q$DELETE FROM sign_documents WHERE id = %L$q$, docP));
  IF NOT EXISTS (SELECT 1 FROM sign_documents WHERE id = docP) THEN RAISE EXCEPTION 'FAIL a person who may not delete a private draft deleted it'; END IF;
  v_res := pg_temp.run(uU, format($q$UPDATE sign_documents SET title = 'Private one, renamed' WHERE id = %L$q$, docP));
  IF v_res <> 'OK' OR (SELECT title FROM sign_documents WHERE id = docP) <> 'Private one, renamed' THEN RAISE EXCEPTION 'FAIL the uploader could not edit their private draft'; END IF;
  v_res := pg_temp.run(uAd, format($q$UPDATE sign_documents SET title = 'Private one' WHERE id = %L$q$, docP));
  IF v_res <> 'OK' OR (SELECT title FROM sign_documents WHERE id = docP) <> 'Private one' THEN RAISE EXCEPTION 'FAIL an admin could not edit a private draft'; END IF;
  -- a public draft is still edited by any agent (nothing changed for what is not private)
  v_res := pg_temp.run(uO, format($q$UPDATE sign_documents SET title = 'Public one, renamed' WHERE id = %L$q$, docPub));
  IF v_res <> 'OK' OR (SELECT title FROM sign_documents WHERE id = docPub) <> 'Public one, renamed' THEN RAISE EXCEPTION 'FAIL another agent could not edit a public draft'; END IF;

  -- Marking private: only the uploader or an admin (the new row must pass the same test), and never by a person who cannot see it anyway.
  v_res := pg_temp.run(uO, format($q$UPDATE sign_documents SET is_private = true WHERE id = %L$q$, docPub));
  IF v_res NOT LIKE 'ERR 42501%' OR (SELECT is_private FROM sign_documents WHERE id = docPub) THEN RAISE EXCEPTION 'FAIL another agent marked someone else''s document private: %', v_res; END IF;
  v_res := pg_temp.run(uU, format($q$UPDATE sign_documents SET is_private = true WHERE id = %L$q$, docPub));
  IF v_res <> 'OK' OR NOT (SELECT is_private FROM sign_documents WHERE id = docPub) THEN RAISE EXCEPTION 'FAIL the uploader could not mark their document private: %', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$UPDATE sign_documents SET is_private = false WHERE id = %L$q$, docPub));
  IF v_res <> 'OK' OR (SELECT is_private FROM sign_documents WHERE id = docPub) THEN RAISE EXCEPTION 'FAIL an admin could not make a document public again: %', v_res; END IF;
  -- the server (no session) may set it on a draft; the trigger holds the rest: a sent document's flag is fixed, for everyone
  UPDATE sign_documents SET is_private = true WHERE id = docPub;
  UPDATE sign_documents SET is_private = false WHERE id = docPub;
  INSERT INTO sign_documents (account_id, title, created_by, is_private) VALUES (acctA, 'To be sent', uU, true) RETURNING id INTO docS;
  UPDATE sign_documents SET status = 'sent', base_path = 'base-sent', base_sha256 = repeat('a', 64) WHERE id = docS;
  BEGIN
    UPDATE sign_documents SET is_private = false WHERE id = docS;
    RAISE EXCEPTION 'FAIL the flag of a sent document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT (SELECT is_private FROM sign_documents WHERE id = docS) THEN RAISE EXCEPTION 'FAIL a sent private document stopped being private'; END IF;

  -- 4. Collections: the collection decides.
  INSERT INTO sign_envelopes (account_id, title, created_by, is_private) VALUES (acctA, 'Private pack', uU, true) RETURNING id INTO envP;
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Public pack', uU) RETURNING id INTO envPub;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'Pack one', uU, envP, 1) RETURNING id INTO docE1;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position, is_private) VALUES (acctA, 'Pack two', uU, envP, 2, false) RETURNING id INTO docE2;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position, is_private) VALUES (acctA, 'Open pack one', uU, envPub, 1, true) RETURNING id INTO docPE;
  IF NOT (SELECT bool_and(is_private) FROM sign_documents WHERE id IN (docE1, docE2)) THEN RAISE EXCEPTION 'FAIL the documents of a private collection are not private'; END IF;
  IF (SELECT is_private FROM sign_documents WHERE id = docPE) THEN RAISE EXCEPTION 'FAIL a document of a public collection kept a private flag of its own'; END IF;
  -- a document's own flag cannot override its collection's
  UPDATE sign_documents SET is_private = false WHERE id = docE1;
  IF NOT (SELECT is_private FROM sign_documents WHERE id = docE1) THEN RAISE EXCEPTION 'FAIL a document made itself public inside a private collection'; END IF;
  UPDATE sign_documents SET is_private = true WHERE id = docPE;
  IF (SELECT is_private FROM sign_documents WHERE id = docPE) THEN RAISE EXCEPTION 'FAIL a document made itself private inside a public collection'; END IF;
  -- who sees it: the uploader, the admin, the owner; not another agent, not a viewer, not another workspace
  IF pg_temp.seen(uU, 'sign_envelopes', format('id = %L', envP)) <> '1' OR pg_temp.seen(uAd, 'sign_envelopes', format('id = %L', envP)) <> '1' OR pg_temp.seen(uA, 'sign_envelopes', format('id = %L', envP)) <> '1' THEN
    RAISE EXCEPTION 'FAIL the uploader, an admin or the owner did not see a private collection';
  END IF;
  FOREACH v_txt IN ARRAY ARRAY['uN', 'uO', 'uV', 'uB'] LOOP
    v_res := pg_temp.seen(CASE v_txt WHEN 'uN' THEN uN WHEN 'uO' THEN uO WHEN 'uV' THEN uV ELSE uB END, 'sign_envelopes', format('id = %L', envP));
    IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL % saw a private collection (saw %)', v_txt, v_res; END IF;
    v_res := pg_temp.seen(CASE v_txt WHEN 'uN' THEN uN WHEN 'uO' THEN uO WHEN 'uV' THEN uV ELSE uB END, 'sign_documents', format('envelope_id = %L', envP));
    IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL % saw the documents of a private collection (saw %)', v_txt, v_res; END IF;
  END LOOP;
  IF pg_temp.seen(uO, 'sign_envelopes', format('id = %L', envPub)) <> '1' THEN RAISE EXCEPTION 'FAIL another agent lost sight of a public collection'; END IF;
  -- people who receive a copy of the collection follow the collection
  INSERT INTO sign_copy_recipients (account_id, envelope_id, full_name, email, created_by) VALUES (acctA, envP, 'Pack copy', 'pack@copy.example.invalid', uU);
  INSERT INTO sign_copy_recipients (account_id, envelope_id, full_name, email, created_by) VALUES (acctA, envPub, 'Open copy', 'open@copy.example.invalid', uU);
  IF pg_temp.seen(uO, 'sign_copy_recipients', format('envelope_id = %L', envP)) <> '0' OR pg_temp.seen(uU, 'sign_copy_recipients', format('envelope_id = %L', envP)) <> '1'
     OR pg_temp.seen(uO, 'sign_copy_recipients', format('envelope_id = %L', envPub)) <> '1' THEN
    RAISE EXCEPTION 'FAIL the people who receive a copy of a collection do not follow the collection''s privacy';
  END IF;
  -- named on ONE document of the collection: the collection is one thing, so that person sees the collection and EVERY document of it, and
  -- everything about each (their signers, their events); another agent still sees none of it
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, internal_user_id, party_id) VALUES (acctA, docE1, 'pp_n', 'Named signer', 'n@example.invalid', 1, uN, gen_random_uuid()) RETURNING id INTO sE1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, party_id) VALUES (acctA, docE2, 'pp_o', 'Someone else', 'o@example.invalid', 1, gen_random_uuid()) RETURNING id INTO sE2;
  PERFORM public.sign_log(docE2, 'created', 'user', NULL, uU, '{}'::jsonb);
  IF pg_temp.seen(uN, 'sign_envelopes', format('id = %L', envP)) <> '1' OR pg_temp.seen(uN, 'sign_documents', format('envelope_id = %L', envP)) <> '2' THEN
    RAISE EXCEPTION 'FAIL a Halo user named on a document of a private collection did not see the collection and every document of it';
  END IF;
  IF pg_temp.seen(uN, 'sign_signers', format('document_id = %L', docE2)) <> '1' OR pg_temp.seen(uN, 'sign_events', format('document_id = %L', docE2)) <> '1' THEN
    RAISE EXCEPTION 'FAIL the named signer did not see the progress of the collection''s other document';
  END IF;
  IF pg_temp.run(uN, format($q$SELECT (public.sign_verify_chain(%L) ->> 'ok')$q$, docE2)) <> 'true' THEN RAISE EXCEPTION 'FAIL the named signer could not check the chain of the collection''s other document'; END IF;
  IF pg_temp.seen(uO, 'sign_documents', format('envelope_id = %L', envP)) <> '0' OR pg_temp.seen(uO, 'sign_signers', format('document_id = %L', docE2)) <> '0' THEN
    RAISE EXCEPTION 'FAIL naming a person opened the collection to another agent';
  END IF;
  -- being named on a document of ANOTHER (private) collection opens nothing here
  INSERT INTO sign_envelopes (account_id, title, created_by, is_private) VALUES (acctA, 'Elsewhere', uU, true) RETURNING id INTO envF;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'Elsewhere one', uU, envF, 1) RETURNING id INTO docJ;
  IF pg_temp.seen(uN, 'sign_envelopes', format('id = %L', envF)) <> '0' OR pg_temp.seen(uN, 'sign_documents', format('id = %L', docJ)) <> '0' THEN
    RAISE EXCEPTION 'FAIL being named on one collection opened another';
  END IF;
  DELETE FROM sign_documents WHERE id = docJ;
  DELETE FROM sign_envelopes WHERE id = envF;
  -- the flag moves with the collection (a draft), by the server and by nobody else
  UPDATE sign_envelopes SET is_private = false WHERE id = envP;
  IF EXISTS (SELECT 1 FROM sign_documents WHERE envelope_id = envP AND is_private) THEN RAISE EXCEPTION 'FAIL the documents did not follow the collection to public'; END IF;
  IF pg_temp.seen(uO, 'sign_documents', format('envelope_id = %L', envP)) <> '2' THEN RAISE EXCEPTION 'FAIL the documents of a collection made public were not seen by another agent'; END IF;
  UPDATE sign_envelopes SET is_private = true WHERE id = envP;
  IF EXISTS (SELECT 1 FROM sign_documents WHERE envelope_id = envP AND NOT is_private) THEN RAISE EXCEPTION 'FAIL the documents did not follow the collection to private'; END IF;
  v_res := pg_temp.run(uO, format($q$UPDATE sign_envelopes SET is_private = false WHERE id = %L$q$, envPub));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in person changed a collection directly: %', v_res; END IF;
  -- fixed once the collection is sent
  INSERT INTO sign_envelopes (account_id, title, created_by, is_private) VALUES (acctA, 'To be sent pack', uU, true) RETURNING id INTO envF;
  UPDATE sign_envelopes SET status = 'sent' WHERE id = envF;
  BEGIN
    UPDATE sign_envelopes SET is_private = false WHERE id = envF;
    RAISE EXCEPTION 'FAIL the flag of a sent collection was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- a private document does not join a collection that is not private; a public one joins a private collection and becomes private with it
  INSERT INTO sign_documents (account_id, title, created_by, is_private) VALUES (acctA, 'Wants to join', uU, true) RETURNING id INTO docJ;
  BEGIN
    UPDATE sign_documents SET envelope_id = envPub, envelope_position = 2 WHERE id = docJ;
    RAISE EXCEPTION 'FAIL a private document joined a public collection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_documents SET envelope_id = envP, envelope_position = 3 WHERE id = docJ;
  IF NOT (SELECT is_private FROM sign_documents WHERE id = docJ) THEN RAISE EXCEPTION 'FAIL a private document stopped being private in a private collection'; END IF;

  -- The rows of a bulk batch and of a registration name the document they made; they follow the document.
  -- (finished batches: the function that makes one refuses a fourth that is queued or running)
  INSERT INTO sign_bulk_jobs (account_id, template_name, created_by, total_rows, status, options) VALUES (acctA, 'Template', uU, 2, 'done', '{}'::jsonb) RETURNING id INTO jobJ;
  INSERT INTO sign_bulk_rows (account_id, job_id, row_no, input, document_id) VALUES (acctA, jobJ, 1, '{"name":"Ali","email":"ali@kedai.example.invalid"}'::jsonb, docP);
  INSERT INTO sign_bulk_rows (account_id, job_id, row_no, input, document_id) VALUES (acctA, jobJ, 2, '{"name":"Bala","email":"bala@kedai.example.invalid"}'::jsonb, docPub);
  IF pg_temp.seen(uO, 'sign_bulk_rows', format('job_id = %L', jobJ)) <> '1' OR pg_temp.seen(uU, 'sign_bulk_rows', format('job_id = %L', jobJ)) <> '2' THEN
    RAISE EXCEPTION 'FAIL the rows of a bulk batch do not follow the privacy of their documents';
  END IF;
  INSERT INTO sign_registration_forms (account_id, slug, name, created_by) VALUES (acctA, 'verify-176-form', 'Form 176', uA) RETURNING id INTO formF;
  INSERT INTO sign_registrations (account_id, form_id, status, document_id) VALUES (acctA, formF, 'accepted', docP);
  INSERT INTO sign_registrations (account_id, form_id, status, document_id) VALUES (acctA, formF, 'accepted', docPub);
  INSERT INTO sign_registrations (account_id, form_id, status) VALUES (acctA, formF, 'rejected_spam');
  IF pg_temp.seen(uO, 'sign_registrations', format('form_id = %L', formF)) <> '2' OR pg_temp.seen(uU, 'sign_registrations', format('form_id = %L', formF)) <> '3' THEN
    RAISE EXCEPTION 'FAIL the registrations do not follow the privacy of their documents';
  END IF;

  -- 5. Copy recipients on a registration form and on a bulk batch.
  IF (SELECT copy_recipients FROM sign_registration_forms WHERE id = formF) <> '[]'::jsonb THEN RAISE EXCEPTION 'FAIL a form should start with no copy recipients'; END IF;
  IF NOT public.sign_copy_list_valid('[]'::jsonb) OR NOT public.sign_copy_list_valid('[{"fullName":"A","email":"a@copy.example.invalid"}]'::jsonb) THEN RAISE EXCEPTION 'FAIL a good list was refused'; END IF;
  FOREACH v_txt IN ARRAY ARRAY[
    '{"fullName":"A","email":"a@copy.example.invalid"}',                                                                   -- not an array
    '[{"fullName":"   ","email":"a@copy.example.invalid"}]',                                                               -- a blank name
    '[{"fullName":"A","email":"not-an-address"}]',                                                                         -- a bad address
    '[{"fullName":"A"}]',                                                                                                  -- no address
    '[{"email":"a@copy.example.invalid"}]',                                                                                -- no name
    '[{"fullName":1,"email":"a@copy.example.invalid"}]',                                                                   -- a name that is not text
    '["a@copy.example.invalid"]',                                                                                          -- not an object
    '[{"fullName":"A","email":"a@copy.example.invalid"},{"fullName":"B","email":"A@Copy.Example.Invalid"}]'               -- the same address twice
  ] LOOP
    IF public.sign_copy_list_valid(v_txt::jsonb) THEN RAISE EXCEPTION 'FAIL a bad list was accepted: %', v_txt; END IF;
  END LOOP;
  IF public.sign_copy_list_valid((SELECT jsonb_agg(jsonb_build_object('fullName', 'P' || n, 'email', 'p' || n || '@copy.example.invalid')) FROM generate_series(1, 11) n)) THEN
    RAISE EXCEPTION 'FAIL a list of 11 people was accepted';
  END IF;
  IF NOT public.sign_copy_list_valid((SELECT jsonb_agg(jsonb_build_object('fullName', 'P' || n, 'email', 'p' || n || '@copy.example.invalid')) FROM generate_series(1, 10) n)) THEN
    RAISE EXCEPTION 'FAIL a list of 10 people was refused';
  END IF;
  IF public.sign_copy_list_valid(jsonb_build_array(jsonb_build_object('fullName', repeat('x', 161), 'email', 'a@copy.example.invalid'))) THEN RAISE EXCEPTION 'FAIL a name over 160 characters was accepted'; END IF;
  -- the form: saved through the owner's own session (the audit trigger records who), checked by the table
  v_res := pg_temp.run(uA, format($q$UPDATE sign_registration_forms SET copy_recipients = '[{"fullName":"Siti Aminah","email":"siti@copy.example.invalid"},{"fullName":"Rahman","email":"rahman@copy.example.invalid"}]'::jsonb WHERE id = %L$q$, formF));
  IF v_res <> 'OK' OR jsonb_array_length((SELECT copy_recipients FROM sign_registration_forms WHERE id = formF)) <> 2 THEN RAISE EXCEPTION 'FAIL the owner could not save the form''s copy recipients: %', v_res; END IF;
  FOREACH v_txt IN ARRAY ARRAY[
    '[{"fullName":"A","email":"bad"}]',
    '{"fullName":"A","email":"a@copy.example.invalid"}',
    '[{"fullName":"A","email":"a@copy.example.invalid"},{"fullName":"B","email":"a@copy.example.invalid"}]'
  ] LOOP
    BEGIN
      UPDATE sign_registration_forms SET copy_recipients = v_txt::jsonb WHERE id = formF;
      RAISE EXCEPTION 'FAIL a form took a bad list of copy recipients: %', v_txt;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    UPDATE sign_registration_forms SET copy_recipients = (SELECT jsonb_agg(jsonb_build_object('fullName', 'P' || n, 'email', 'p' || n || '@copy.example.invalid')) FROM generate_series(1, 11) n) WHERE id = formF;
    RAISE EXCEPTION 'FAIL a form took 11 copy recipients';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_registration_forms SET copy_recipients = NULL WHERE id = formF;
    RAISE EXCEPTION 'FAIL a form took a null list';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  -- another agent (no sign.settings) cannot change it; a viewer cannot read it; another workspace cannot read it
  PERFORM pg_temp.run(uO, format($q$UPDATE sign_registration_forms SET copy_recipients = '[]'::jsonb WHERE id = %L$q$, formF));
  IF jsonb_array_length((SELECT copy_recipients FROM sign_registration_forms WHERE id = formF)) <> 2 THEN RAISE EXCEPTION 'FAIL an agent without sign.settings changed a form''s copy recipients'; END IF;
  IF pg_temp.seen(uV, 'sign_registration_forms', format('id = %L', formF)) <> '0' OR pg_temp.seen(uB, 'sign_registration_forms', format('id = %L', formF)) <> '0' THEN
    RAISE EXCEPTION 'FAIL a viewer or another workspace read a form with its copy recipients';
  END IF;
  -- the audit log has the form by name and never an address
  IF EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_id = formF AND (coalesce(summary::text, '') LIKE '%copy.example.invalid%' OR coalesce(entity_label, '') LIKE '%@%')) THEN
    RAISE EXCEPTION 'FAIL the audit log holds a copy recipient''s address';
  END IF;
  -- what the server does with the list: the same rows as a person adding them, once per person and document (175's guard still holds)
  INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email)
    SELECT acctA, docPub, e ->> 'fullName', e ->> 'email'
      FROM jsonb_array_elements((SELECT copy_recipients FROM sign_registration_forms WHERE id = formF)) AS e;
  IF (SELECT count(*) FROM sign_copy_recipients WHERE document_id = docPub AND notified_at IS NULL) <> 2 THEN RAISE EXCEPTION 'FAIL the form''s list did not become copy recipients of the document'; END IF;
  BEGIN
    INSERT INTO sign_copy_recipients (account_id, document_id, full_name, email) VALUES (acctA, docPub, 'Siti Again', 'SITI@copy.example.invalid');
    RAISE EXCEPTION 'FAIL the same person became a copy recipient of one document twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- the bulk batch: the list lives in the options (a batch never changes them) and is checked
  INSERT INTO sign_bulk_jobs (account_id, template_name, created_by, total_rows, status, options)
    VALUES (acctA, 'With copies', uU, 1, 'done', '{"copyTo":[{"fullName":"Siti Aminah","email":"siti@copy.example.invalid"}]}'::jsonb);
  INSERT INTO sign_bulk_jobs (account_id, template_name, created_by, total_rows, status, options) VALUES (acctA, 'Without copies', uU, 1, 'done', '{"title":"x"}'::jsonb);
  FOREACH v_txt IN ARRAY ARRAY[
    '{"copyTo":[{"fullName":"A","email":"bad"}]}',
    '{"copyTo":"a@copy.example.invalid"}',
    '{"copyTo":null}',
    '{"copyTo":[{"fullName":"A","email":"a@copy.example.invalid"},{"fullName":"B","email":"A@COPY.example.invalid"}]}'
  ] LOOP
    BEGIN
      INSERT INTO sign_bulk_jobs (account_id, template_name, created_by, total_rows, status, options) VALUES (acctA, 'Bad copies', uU, 1, 'done', v_txt::jsonb);
      RAISE EXCEPTION 'FAIL a batch took a bad list of copy recipients: %', v_txt;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    INSERT INTO sign_bulk_jobs (account_id, template_name, created_by, total_rows, status, options)
      VALUES (acctA, 'Too many', uU, 1, 'done', jsonb_build_object('copyTo', (SELECT jsonb_agg(jsonb_build_object('fullName', 'P' || n, 'email', 'p' || n || '@copy.example.invalid')) FROM generate_series(1, 11) n)));
    RAISE EXCEPTION 'FAIL a batch took 11 copy recipients';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_bulk_jobs SET options = '{}'::jsonb WHERE account_id = acctA AND template_name = 'With copies';
    RAISE EXCEPTION 'FAIL a batch''s copy recipients were changed after it was made';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- through the function the server creates a batch with (it passes the options on as they are)
  v_res := (SELECT public.sign_bulk_create(acctA, NULL, 'Via the function', uU, 'csv', 'x.csv',
              '{"copyTo":[{"fullName":"Siti Aminah","email":"siti@copy.example.invalid"}]}'::jsonb,
              '[{"row_no":1,"input":{"name":"Ali","email":"ali@kedai.example.invalid"}}]'::jsonb)::text);
  IF (SELECT options -> 'copyTo' -> 0 ->> 'email' FROM sign_bulk_jobs WHERE id = v_res::uuid) IS DISTINCT FROM 'siti@copy.example.invalid' THEN RAISE EXCEPTION 'FAIL the function did not keep a batch''s copy recipients'; END IF;
  BEGIN
    PERFORM public.sign_bulk_create(acctA, NULL, 'Via the function, bad', uU, 'csv', 'x.csv', '{"copyTo":[{"fullName":"A","email":"bad"}]}'::jsonb, '[{"row_no":1,"input":{"name":"Ali","email":"ali@kedai.example.invalid"}}]'::jsonb);
    RAISE EXCEPTION 'FAIL the function created a batch with a bad list of copy recipients';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 6. The reference of a new collection starts COL-; a stored ENV- reference stays valid and fixed.
  FOR v_ref IN SELECT reference FROM sign_envelopes WHERE account_id = acctA LOOP
    IF v_ref !~ '^COL-[0-9]{4}-[0-9]{6}$' THEN RAISE EXCEPTION 'FAIL a new collection''s reference is %, not COL-YYYY-nnnnnn', v_ref; END IF;
  END LOOP;
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctB, 'B first', uB) RETURNING reference INTO v_ref;
  IF v_ref !~ '^COL-[0-9]{4}-000001$' THEN RAISE EXCEPTION 'FAIL the other workspace should number its own collections from 000001 (got %)', v_ref; END IF;
  INSERT INTO sign_envelopes (account_id, title, created_by, reference) VALUES (acctB, 'An old one', uB, 'ENV-2025-000042');
  IF (SELECT count(*) FROM sign_envelopes WHERE account_id = acctB AND reference = 'ENV-2025-000042') <> 1 THEN RAISE EXCEPTION 'FAIL an ENV- reference is not found by its reference'; END IF;
  UPDATE sign_envelopes SET title = 'An old one, renamed' WHERE account_id = acctB AND reference = 'ENV-2025-000042';
  IF (SELECT title FROM sign_envelopes WHERE account_id = acctB AND reference = 'ENV-2025-000042') <> 'An old one, renamed' THEN RAISE EXCEPTION 'FAIL an ENV- collection could not be edited'; END IF;
  BEGIN
    UPDATE sign_envelopes SET reference = 'COL-2025-000042' WHERE account_id = acctB AND reference = 'ENV-2025-000042';
    RAISE EXCEPTION 'FAIL a stored reference was rewritten';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_envelopes (account_id, title, created_by, reference) VALUES (acctB, 'Same reference', uB, 'ENV-2025-000042');
    RAISE EXCEPTION 'FAIL the same reference was used twice in one workspace';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctB, 'B second', uB) RETURNING reference INTO v_ref;
  IF v_ref !~ '^COL-[0-9]{4}-000002$' THEN RAISE EXCEPTION 'FAIL the next collection after an ENV- one should carry on the count (got %)', v_ref; END IF;
  -- a document's reference is unchanged
  IF (SELECT reference FROM sign_documents WHERE id = docB) !~ '^SGN-[0-9]{4}-[0-9]{6}$' THEN RAISE EXCEPTION 'FAIL a document''s reference is no longer SGN-'; END IF;

  -- 7. The functions: the helpers answer for the caller and are executable by the roles a policy is evaluated for; the guards are not callable by anyone;
  --    every SECURITY DEFINER function pins its search_path.
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sign_is_named_signer', 'sign_is_named_on_envelope', 'sign_document_visible', 'sign_envelope_visible', 'sign_verify_chain')
     AND NOT (has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE'));
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL not callable by signed-in users or the server: %', v_txt; END IF;
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sign_is_named_signer', 'sign_is_named_on_envelope', 'sign_document_visible', 'sign_envelope_visible')
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL a policy helper is not executable by the signed-out role, which would turn an empty answer into an error: %', v_txt; END IF;
  IF has_function_privilege('anon', 'public.sign_verify_chain(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL the signed-out role can check a chain'; END IF;
  IF pg_temp.run(uO, format($q$SELECT public.sign_is_named_on_envelope(%L)::text$q$, envP)) <> 'false'
     OR pg_temp.run(uN, format($q$SELECT public.sign_is_named_on_envelope(%L)::text$q$, envP)) <> 'true'
     OR pg_temp.run(uO, format($q$SELECT public.sign_envelope_visible(%L)::text$q$, envP)) <> 'false'
     OR pg_temp.run(uU, format($q$SELECT public.sign_envelope_visible(%L)::text$q$, envP)) <> 'true'
     OR pg_temp.run(NULL::uuid, format($q$SELECT public.sign_envelope_visible(%L)::text$q$, envP), 'anon') <> 'false' THEN
    RAISE EXCEPTION 'FAIL the collection helpers do not answer as the caller';
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sign_documents_private_guard', 'sign_envelopes_private_guard', 'sign_envelopes_private_cascade', 'sign_envelopes_guard')
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL a trigger function is callable by signed-in or signed-out users: %', v_txt; END IF;
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND p.proname IN ('sign_is_named_signer', 'sign_is_named_on_envelope', 'sign_document_visible', 'sign_envelope_visible', 'sign_verify_chain', 'sign_documents_private_guard',
                       'sign_envelopes_private_guard', 'sign_envelopes_private_cascade', 'sign_envelopes_guard')
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL SECURITY DEFINER without a pinned search_path: %', v_txt; END IF;
  FOREACH v_txt IN ARRAY ARRAY['sign_documents|sign_documents_private_guard', 'sign_envelopes|sign_envelopes_private_guard', 'sign_envelopes|sign_envelopes_private_cascade', 'sign_envelopes|sign_envelopes_guard'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = ('public.' || split_part(v_txt, '|', 1))::regclass AND tgname = split_part(v_txt, '|', 2) AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'FAIL the trigger % is missing', v_txt;
    END IF;
  END LOOP;
  -- every select policy that names a document goes through the helper (no table was left on menu.sign alone)
  SELECT string_agg(p.tablename, ', ') INTO v_txt
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.cmd = 'SELECT'
     AND p.tablename IN ('sign_documents', 'sign_envelopes', 'sign_document_files', 'sign_signers', 'sign_step_invites', 'sign_answers', 'sign_events', 'sign_copy_recipients', 'sign_bulk_rows', 'sign_registrations')
     AND p.qual NOT LIKE '%sign\_%visible%' AND p.qual NOT LIKE '%is_private%' AND p.qual NOT LIKE '%sign\_is\_named%';
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL a select policy does not apply the private rule: %', v_txt; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: sign.reveal-sensitive is its own capability (owner and admin only, not sign.send); is_private is NOT NULL false on documents and collections; a private document and everything about it (files, signers, step invites, answers, events, copy recipients, bulk rows, registrations, the chain check) is seen only by its uploader, an admin, the owner and a named Halo signer, never by another agent, a viewer, another workspace or the signed-out role, while a public one is seen as before; a private draft is not edited or deleted by anyone who cannot see it and a named signer reads without editing; only the uploader or an admin marks a document private and a sent document''s flag is fixed; the documents of a private collection are private whatever they say, the flag moves with the collection, is fixed once sent, and a private document does not join a public collection; a person named on one document sees that document and the collection only; registration forms and bulk batches carry a checked list of at most 10 copy recipients that becomes ordinary copy recipients, kept out of the audit log; a new collection is COL- and an ENV- one stays valid, fixed and in the count; the helpers answer as the caller, the guards are not callable and every SECURITY DEFINER function pins its search_path';
END
$verify$;
