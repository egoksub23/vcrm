-- Verify migration 157 (Doc Sign foundation). Self-contained (builds its own workspaces), so it runs
-- against an empty database as well as production. Concatenate 157's migration text in front when
-- the database does not have it yet, then run it. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA    uuid := gen_random_uuid();
  uAg   uuid := gen_random_uuid();
  uV    uuid := gen_random_uuid();
  uB    uuid := gen_random_uuid();
  acctA uuid;
  acctB uuid;
  docA1 uuid;
  docA2 uuid;
  docB1 uuid;
  tplA  uuid;
  verA  uuid;
  sigA  uuid;
  catA  uuid;
  v_res text;
  v_n   int;
  v_ref text;
  v_json jsonb;
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

  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'  || uA  || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uAg, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ag-' || uAg || '@example.invalid', '{"full_name":"Agent"}', now()),
    (uV,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'v-'  || uV  || '@example.invalid', '{"full_name":"Viewer"}', now()),
    (uB,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'  || uB  || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  UPDATE profiles SET account_id = acctA, account_role = 'agent'  WHERE user_id = uAg;
  UPDATE profiles SET account_id = acctA, account_role = 'viewer' WHERE user_id = uV;

  -- 1. Flags: a workspace created now starts with both off, and every existing one carries both keys.
  IF (SELECT features ->> 'sign' FROM account_platform WHERE account_id = acctA) IS DISTINCT FROM 'false'
     OR (SELECT features ->> 'sign_merchant' FROM account_platform WHERE account_id = acctA) IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'FAIL a new workspace should start with sign and sign_merchant off';
  END IF;
  IF EXISTS (SELECT 1 FROM account_platform WHERE NOT (features ? 'sign') OR NOT (features ? 'sign_merchant')) THEN
    RAISE EXCEPTION 'FAIL every workspace should carry explicit sign and sign_merchant flags';
  END IF;

  -- 2. Capabilities: owner everything, agent sees and sends, viewer nothing.
  SELECT count(*) INTO v_n FROM capability_catalogue WHERE capability IN
    ('menu.sign', 'sign.send', 'sign.void', 'sign.templates', 'sign.settings', 'sign.sign');
  IF v_n <> 6 THEN RAISE EXCEPTION 'FAIL expected 6 sign capabilities, found %', v_n; END IF;
  FOR v_ref IN SELECT unnest(ARRAY['menu.sign', 'sign.send', 'sign.void', 'sign.templates', 'sign.settings', 'sign.sign']) LOOP
    v_res := pg_temp.run(uA, format($q$SELECT has_capability(%L, %L)::text$q$, acctA, v_ref));
    IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the owner should hold % (saw %)', v_ref, v_res; END IF;
  END LOOP;
  v_res := pg_temp.run(uAg, format($q$SELECT (has_capability(%L, 'menu.sign') AND has_capability(%L, 'sign.send'))::text$q$, acctA, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL an agent should see Doc Sign and send (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAg, format($q$SELECT (has_capability(%L, 'sign.templates') OR has_capability(%L, 'sign.settings') OR has_capability(%L, 'sign.void'))::text$q$, acctA, acctA, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL an agent must not manage templates, settings or void by default (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, format($q$SELECT has_capability(%L, 'menu.sign')::text$q$, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL a viewer must not see Doc Sign (saw %)', v_res; END IF;

  -- 3. Starting categories and settings: created by the server function, once.
  v_res := pg_temp.run(uA, format($q$SELECT public.sign_ensure_defaults(%L)::text$q$, acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in user could call sign_ensure_defaults: %', v_res; END IF;
  PERFORM public.sign_ensure_defaults(acctA);
  PERFORM public.sign_ensure_defaults(acctA);
  SELECT count(*) INTO v_n FROM sign_categories WHERE account_id = acctA;
  IF v_n <> 4 THEN RAISE EXCEPTION 'FAIL expected the 4 starting categories, found %', v_n; END IF;
  IF (SELECT count(*) FROM sign_categories WHERE account_id = acctA AND key IN ('merchant_agreements', 'nda', 'partnership', 'sales')) <> 4 THEN
    RAISE EXCEPTION 'FAIL the starting categories are not Merchant agreements, NDA, Partnership and Sales';
  END IF;
  IF (SELECT count(*) FROM sign_settings WHERE account_id = acctA) <> 1 THEN RAISE EXCEPTION 'FAIL expected one settings row'; END IF;
  IF EXISTS (SELECT 1 FROM sign_categories WHERE account_id = acctA AND (sign_in_order OR code_required)) THEN
    RAISE EXCEPTION 'FAIL no category should force signing order or a code by default';
  END IF;
  SELECT id INTO catA FROM sign_categories WHERE account_id = acctA AND key = 'nda';

  -- 4. Categories and settings: whoever holds sign.settings writes; an agent reads only.
  v_res := pg_temp.run(uAg, format($q$UPDATE sign_categories SET name = 'Renamed' WHERE id = %L$q$, catA));
  IF (SELECT name FROM sign_categories WHERE id = catA) <> 'NDA' THEN RAISE EXCEPTION 'FAIL an agent renamed a category'; END IF;
  v_res := pg_temp.run(uA, format($q$UPDATE sign_categories SET name = 'Non-disclosure' WHERE id = %L$q$, catA));
  IF (SELECT name FROM sign_categories WHERE id = catA) <> 'Non-disclosure' THEN RAISE EXCEPTION 'FAIL the owner could not rename a category'; END IF;
  v_res := pg_temp.run(uV, $q$SELECT count(*)::text FROM sign_categories$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer read categories (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, $q$SELECT count(*)::text FROM sign_categories$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace read categories (saw %)', v_res; END IF;

  -- 5. Server-only tables: nobody signed in can touch them, certificates included.
  FOR v_ref IN SELECT unnest(ARRAY['sign_certificates', 'sign_signer_secrets']) LOOP
    v_res := pg_temp.run(uA, format('SELECT count(*)::text FROM %I', v_ref));
    IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in owner could read %: %', v_ref, v_res; END IF;
  END LOOP;

  -- 6. Documents: a person creates drafts; the reference is assigned and counts per workspace.
  v_res := pg_temp.run(uAg, format($q$INSERT INTO sign_documents (account_id, title, created_by, category_id) VALUES (%L, 'NDA with Kedai', %L, %L)$q$, acctA, uAg, catA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL an agent should create a draft: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_documents (account_id, title, created_by) VALUES (%L, 'Partnership', %L)$q$, acctA, uA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the owner should create a draft: %', v_res; END IF;
  SELECT id INTO docA1 FROM sign_documents WHERE account_id = acctA AND title = 'NDA with Kedai';
  SELECT id INTO docA2 FROM sign_documents WHERE account_id = acctA AND title = 'Partnership';
  IF (SELECT reference FROM sign_documents WHERE id = docA1) NOT LIKE 'SGN-' || to_char(now() AT TIME ZONE 'utc', 'YYYY') || '-000001'
     OR (SELECT reference FROM sign_documents WHERE id = docA2) NOT LIKE 'SGN-' || to_char(now() AT TIME ZONE 'utc', 'YYYY') || '-000002' THEN
    RAISE EXCEPTION 'FAIL references were % and %', (SELECT reference FROM sign_documents WHERE id = docA1), (SELECT reference FROM sign_documents WHERE id = docA2);
  END IF;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctB, 'Other tenant', uB) RETURNING id INTO docB1;
  IF (SELECT reference FROM sign_documents WHERE id = docB1) NOT LIKE '%-000001' THEN
    RAISE EXCEPTION 'FAIL another workspace should start its own count at 1';
  END IF;
  v_res := pg_temp.run(uV, format($q$INSERT INTO sign_documents (account_id, title, created_by) VALUES (%L, 'x', %L)$q$, acctA, uV));
  IF v_res NOT LIKE 'ERR 42501%' AND v_res NOT LIKE 'ERR %row-level security%' THEN
    RAISE EXCEPTION 'FAIL a viewer created a document: %', v_res;
  END IF;
  v_res := pg_temp.run(uAg, format($q$INSERT INTO sign_documents (account_id, title, created_by, status) VALUES (%L, 'x', %L, 'sent')$q$, acctA, uAg));
  IF v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL a document was created already sent'; END IF;
  v_res := pg_temp.run(uAg, format($q$INSERT INTO sign_documents (account_id, title, created_by) VALUES (%L, 'x', %L)$q$, acctB, uAg));
  IF v_res NOT LIKE 'ERR 42501%' AND v_res NOT LIKE 'ERR %row-level security%' THEN
    RAISE EXCEPTION 'FAIL an agent created a document in another workspace: %', v_res;
  END IF;
  v_res := pg_temp.run(uB, $q$SELECT count(*)::text FROM sign_documents WHERE title <> 'Other tenant'$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace read these documents (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, $q$SELECT count(*)::text FROM sign_documents$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer read documents (saw %)', v_res; END IF;
  -- A reference cannot be changed, not even by the server.
  BEGIN
    UPDATE sign_documents SET reference = 'SGN-1999-000001' WHERE id = docA1;
    RAISE EXCEPTION 'FAIL a reference was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 7. Status moves are checked by the database.
  BEGIN
    UPDATE sign_documents SET status = 'completed' WHERE id = docA1;
    RAISE EXCEPTION 'FAIL a draft jumped to completed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET status = 'sent' WHERE id = docA1;
    RAISE EXCEPTION 'FAIL a document without a base file was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- A person cannot send (or void) by writing the table: only drafts are theirs to change.
  v_res := pg_temp.run(uA, format($q$UPDATE sign_documents SET status = 'sent', base_path = 'x', base_sha256 = repeat('a', 64) WHERE id = %L$q$, docA1));
  IF v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL a person sent a document straight through the table: %', v_res; END IF;
  UPDATE sign_documents
     SET status = 'sent', base_path = 'account-x/doc/base.pdf', base_sha256 = repeat('a', 64), page_count = 2,
         sign_in_order = true, fields_snapshot = '[{"key":"sig1"}]'::jsonb
   WHERE id = docA1;
  IF (SELECT sent_at FROM sign_documents WHERE id = docA1) IS NULL THEN RAISE EXCEPTION 'FAIL sent_at was not set'; END IF;
  -- Once sent: frozen content, no edits by people, no deleting.
  BEGIN
    UPDATE sign_documents SET sign_in_order = false WHERE id = docA1;
    RAISE EXCEPTION 'FAIL the signing order of a sent document changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET base_sha256 = repeat('b', 64) WHERE id = docA1;
    RAISE EXCEPTION 'FAIL the base file fingerprint of a sent document changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET title = 'Edited' WHERE id = docA1;
    RAISE EXCEPTION 'FAIL the title of a sent document changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  v_res := pg_temp.run(uA, format($q$UPDATE sign_documents SET void_reason = 'sneaky' WHERE id = %L$q$, docA1));
  IF (SELECT void_reason FROM sign_documents WHERE id = docA1) IS NOT NULL THEN RAISE EXCEPTION 'FAIL a person edited a sent document'; END IF;
  v_res := pg_temp.run(uA, format($q$DELETE FROM sign_documents WHERE id = %L$q$, docA1));
  IF NOT EXISTS (SELECT 1 FROM sign_documents WHERE id = docA1) THEN RAISE EXCEPTION 'FAIL a person deleted a sent document'; END IF;
  BEGIN
    DELETE FROM sign_documents WHERE id = docA1;
    RAISE EXCEPTION 'FAIL the server deleted a sent document';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE sign_documents SET status = 'in_progress' WHERE id = docA1;
  UPDATE sign_documents SET status = 'sealing' WHERE id = docA1;
  BEGIN
    UPDATE sign_documents SET status = 'completed' WHERE id = docA1;
    RAISE EXCEPTION 'FAIL a document completed without a final file';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_documents SET status = 'failed' WHERE id = docA1;
  UPDATE sign_documents SET status = 'sealing' WHERE id = docA1;
  UPDATE sign_documents SET status = 'completed', final_path = 'account-x/doc/final.pdf', final_sha256 = repeat('c', 64) WHERE id = docA1;
  IF (SELECT completed_at FROM sign_documents WHERE id = docA1) IS NULL THEN RAISE EXCEPTION 'FAIL completed_at was not set'; END IF;
  BEGIN
    UPDATE sign_documents SET final_sha256 = repeat('d', 64) WHERE id = docA1;
    RAISE EXCEPTION 'FAIL the final file fingerprint was rewritten';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET status = 'voided' WHERE id = docA1;
    RAISE EXCEPTION 'FAIL a completed document was voided';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- A draft can be deleted by whoever may send.
  v_res := pg_temp.run(uA, format($q$DELETE FROM sign_documents WHERE id = %L$q$, docA2));
  IF EXISTS (SELECT 1 FROM sign_documents WHERE id = docA2) THEN RAISE EXCEPTION 'FAIL a draft could not be deleted: %', v_res; END IF;

  -- 8. Children carry their document's workspace (no cross-tenant attachment).
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no)
  VALUES (acctA, docA1, 'merchant', 'Ali bin Ahmad', 'ali@example.invalid', 1) RETURNING id INTO sigA;
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email) VALUES (acctB, docA1, 'x', 'X', 'x@example.invalid');
    RAISE EXCEPTION 'FAIL a signer was attached to another workspace''s document';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email) VALUES (acctA, docA1, 'x', 'X', 'not-an-email');
    RAISE EXCEPTION 'FAIL a malformed email was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO sign_signer_secrets (signer_id, account_id, token_hash) VALUES (sigA, acctA, repeat('e', 64));
  BEGIN
    INSERT INTO sign_signer_secrets (signer_id, account_id, token_hash) VALUES (sigA, acctB, repeat('f', 64));
    RAISE EXCEPTION 'FAIL a signer secret was filed under another workspace';
  EXCEPTION WHEN foreign_key_violation OR unique_violation THEN NULL;
  END;
  INSERT INTO sign_step_invites (document_id, account_id, step) VALUES (docA1, acctA, 1);
  BEGIN
    INSERT INTO sign_step_invites (document_id, account_id, step) VALUES (docA1, acctA, 1);
    RAISE EXCEPTION 'FAIL a step was invited twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, docA1, sigA, 'sig1', '"Ali"'::jsonb);
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, docA1, sigA, 'sig1', '"Again"'::jsonb);
    RAISE EXCEPTION 'FAIL one field was answered twice by the same signer';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Reading: the agent sees them; a viewer and another workspace do not; nobody writes from the browser.
  v_res := pg_temp.run(uAg, $q$SELECT (SELECT count(*) FROM sign_signers)::text || '/' || (SELECT count(*) FROM sign_answers)::text$q$);
  IF v_res <> '1/1' THEN RAISE EXCEPTION 'FAIL an agent should read signers and answers (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, $q$SELECT (SELECT count(*) FROM sign_signers)::text$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer read signers (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, $q$SELECT (SELECT count(*) FROM sign_signers)::text$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace read signers (saw %)', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$UPDATE sign_signers SET status = 'signed' WHERE id = %L$q$, sigA));
  IF (SELECT status FROM sign_signers WHERE id = sigA) <> 'pending' THEN RAISE EXCEPTION 'FAIL a person marked a signer as signed'; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email) VALUES (%L, %L, 'x', 'X', 'x@example.invalid')$q$, acctA, docA1));
  IF v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL a person added a signer straight through the table'; END IF;

  -- 9. The audit chain: linked, verifiable, append-only, tamper-evident.
  INSERT INTO sign_events (account_id, document_id, type, actor_type, actor_user_id, detail, doc_seq, prev_hash, row_hash)
  VALUES (acctA, docA1, 'created', 'user', uAg, '{"title":"NDA"}'::jsonb, 99, 'forged', 'forged');
  INSERT INTO sign_events (account_id, document_id, type, actor_type, signer_id, detail, ip)
  VALUES (acctA, docA1, 'viewed', 'signer', sigA, '{}'::jsonb, '203.0.113.9');
  INSERT INTO sign_events (account_id, document_id, type, actor_type, signer_id, detail)
  VALUES (acctA, docA1, 'signed', 'signer', sigA, '{"fields":["sig1"]}'::jsonb);
  IF (SELECT array_agg(doc_seq ORDER BY doc_seq) FROM sign_events WHERE document_id = docA1) IS DISTINCT FROM ARRAY[1, 2, 3] THEN
    RAISE EXCEPTION 'FAIL events are not numbered 1, 2, 3 (a writer-supplied number must be ignored)';
  END IF;
  IF (SELECT prev_hash FROM sign_events WHERE document_id = docA1 AND doc_seq = 1) <> repeat('0', 64)
     OR (SELECT prev_hash FROM sign_events WHERE document_id = docA1 AND doc_seq = 2) <> (SELECT row_hash FROM sign_events WHERE document_id = docA1 AND doc_seq = 1)
     OR (SELECT row_hash FROM sign_events WHERE document_id = docA1 AND doc_seq = 1) = 'forged' THEN
    RAISE EXCEPTION 'FAIL the events are not linked into a chain';
  END IF;
  v_json := public.sign_verify_chain(docA1);
  IF NOT (v_json ->> 'ok')::boolean OR (v_json ->> 'events')::int <> 3 THEN RAISE EXCEPTION 'FAIL the chain should verify: %', v_json; END IF;
  v_res := pg_temp.run(uAg, format($q$SELECT (public.sign_verify_chain(%L) ->> 'ok')$q$, docA1));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL an agent should be able to verify the chain (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT (public.sign_verify_chain(%L) ->> 'ok')$q$, docA1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL another workspace verified a chain: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_events (account_id, document_id, type, actor_type) VALUES (%L, %L, 'x', 'user')$q$, acctA, docA1));
  IF v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL a person wrote an audit event from the browser'; END IF;
  v_res := pg_temp.run(uAg, $q$SELECT count(*)::text FROM sign_events$q$);
  IF v_res <> '3' THEN RAISE EXCEPTION 'FAIL an agent should read the 3 events (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, $q$SELECT count(*)::text FROM sign_events$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer read events (saw %)', v_res; END IF;
  BEGIN
    UPDATE sign_events SET detail = '{"x":1}'::jsonb WHERE document_id = docA1 AND doc_seq = 2;
    RAISE EXCEPTION 'FAIL an event was updated';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM sign_events WHERE document_id = docA1 AND doc_seq = 3;
    RAISE EXCEPTION 'FAIL an event was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    TRUNCATE sign_events;
    RAISE EXCEPTION 'FAIL the events were truncated';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Tampering that gets past the trigger (a database owner disabling it) is still caught by the chain.
  ALTER TABLE sign_events DISABLE TRIGGER sign_events_no_change;
  UPDATE sign_events SET detail = '{"fields":["something else"]}'::jsonb WHERE document_id = docA1 AND doc_seq = 3;
  ALTER TABLE sign_events ENABLE TRIGGER sign_events_no_change;
  v_json := public.sign_verify_chain(docA1);
  IF (v_json ->> 'ok')::boolean OR (v_json ->> 'broken_at')::int <> 3 THEN RAISE EXCEPTION 'FAIL an edited event was not detected: %', v_json; END IF;

  -- 10. A deleted draft takes its events with it; a purge removes a whole workspace's.
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Short-lived draft', uA) RETURNING id INTO docA2;
  INSERT INTO sign_events (account_id, document_id, type, actor_type) VALUES (acctA, docA2, 'created', 'user');
  DELETE FROM sign_documents WHERE id = docA2;
  IF EXISTS (SELECT 1 FROM sign_events WHERE document_id = docA2) THEN RAISE EXCEPTION 'FAIL a deleted draft left events behind'; END IF;

  -- 11. Templates: versions are immutable; deleting a template leaves its sent documents intact.
  INSERT INTO sign_templates (account_id, name, category_id, status, created_by) VALUES (acctA, 'Mutual NDA', catA, 'active', uA) RETURNING id INTO tplA;
  INSERT INTO sign_template_versions (account_id, template_id, version_no, source_path, source_sha256, page_count, created_by)
  VALUES (acctA, tplA, 1, 'account-x/tpl/v1.pdf', repeat('1', 64), 2, uA) RETURNING id INTO verA;
  UPDATE sign_templates SET current_version_id = verA WHERE id = tplA;
  BEGIN
    UPDATE sign_template_versions SET page_count = 3 WHERE id = verA;
    RAISE EXCEPTION 'FAIL a template version was edited';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_template_versions (account_id, template_id, version_no, source_path, source_sha256, page_count)
    VALUES (acctB, tplA, 2, 'x', repeat('2', 64), 1);
    RAISE EXCEPTION 'FAIL a version was filed under another workspace''s template';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  v_res := pg_temp.run(uAg, format($q$INSERT INTO sign_templates (account_id, name, created_by) VALUES (%L, 'Agent template', %L)$q$, acctA, uAg));
  IF v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL an agent created a template without sign.templates'; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_templates (account_id, name, created_by) VALUES (%L, 'Owner template', %L)$q$, acctA, uA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the owner should create a template: %', v_res; END IF;
  -- sent document remembers the version; deleting the template must not trip the frozen-document rule
  -- (a sent document may only have its template reference cleared).
  BEGIN
    ALTER TABLE sign_documents DISABLE TRIGGER sign_documents_guard;
    UPDATE sign_documents SET template_version_id = verA WHERE id = docA1;
    ALTER TABLE sign_documents ENABLE TRIGGER sign_documents_guard;
  END;
  DELETE FROM sign_templates WHERE id = tplA;
  IF (SELECT template_version_id FROM sign_documents WHERE id = docA1) IS NOT NULL THEN RAISE EXCEPTION 'FAIL the template reference should be cleared'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sign_documents WHERE id = docA1 AND status = 'completed') THEN RAISE EXCEPTION 'FAIL deleting a template changed its document'; END IF;

  -- 12. Storage: a private bucket with no policies for anyone signed in.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'sign-documents' AND NOT public AND file_size_limit = 26214400) THEN
    RAISE EXCEPTION 'FAIL sign-documents should be a private 25 MB bucket';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
              AND (qual ILIKE '%sign-documents%' OR with_check ILIKE '%sign-documents%')) THEN
    RAISE EXCEPTION 'FAIL there should be no storage policy for sign-documents (the server alone reads and writes it)';
  END IF;

  -- 13. Usage: documents sent this month are counted for the limit.
  v_json := public.account_usage(acctA);
  IF (v_json ->> 'sign_documents_month')::int <> 1 THEN RAISE EXCEPTION 'FAIL expected 1 document sent this month: %', v_json; END IF;
  IF (public.account_usage(acctB) ->> 'sign_documents_month')::int <> 0 THEN RAISE EXCEPTION 'FAIL another workspace''s count leaked'; END IF;

  -- 14. Deleting the workspace removes everything, including the append-only chain and sent documents.
  BEGIN
    DELETE FROM accounts WHERE id = acctA;
    RAISE EXCEPTION 'FAIL a workspace with sent documents was deleted without a purge';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('vircle.hard_delete', 'on', true);
  PERFORM set_config('vircle.purge_account', acctA::text, true);
  -- the things that RESTRICT what they point at go first, as delete_workspace_data() (153) does
  DELETE FROM ticket_sla_policies WHERE account_id = acctA;
  DELETE FROM incident_escalation_policies WHERE account_id = acctA;
  DELETE FROM deals WHERE account_id = acctA;
  DELETE FROM accounts WHERE id = acctA;
  SELECT count(*) INTO v_n FROM sign_documents WHERE account_id = acctA;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL documents survived the purge'; END IF;
  SELECT count(*) INTO v_n FROM sign_events WHERE account_id = acctA;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL events survived the purge'; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: Doc Sign capabilities and flags (off for every workspace); starting categories; server-only secrets and certificates; references per workspace; drafts only for people; status moves, frozen content and write-once final file enforced; children cannot cross workspaces; audit chain linked, verifiable, append-only and tamper-evident; template versions immutable; private bucket; usage counted; purge removes the workspace';
END
$verify$;
