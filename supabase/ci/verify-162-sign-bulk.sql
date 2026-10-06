-- Verify migration 162 (Doc Sign bulk send). Self-contained (builds its own workspaces), so it runs against an empty
-- database as well as production. Concatenate 157's to 162's migration text in front when the database does not have
-- them yet, then run it. Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA    uuid := gen_random_uuid();
  uAg   uuid := gen_random_uuid();
  uV    uuid := gen_random_uuid();
  uB    uuid := gen_random_uuid();
  acctA uuid;
  acctB uuid;
  tplA  uuid;
  tplB  uuid;
  j1    uuid;
  j2    uuid;
  j3    uuid;
  jB    uuid;
  dA    uuid;
  dB    uuid;
  r1    uuid;
  r2    uuid;
  v_res text;
  v_fn  text;
  v_n   int;
  v_ids uuid[];
  v_ids2 uuid[];
  v_json jsonb;
  v_opts jsonb := '{"personRole": "merchant", "channel": "email", "fixedSigners": [{"roleKey": "director", "fullName": "Fixed Person", "email": "fixed@example.invalid", "channel": "email"}]}'::jsonb;
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
  -- N people as the rows argument of sign_bulk_create
  EXECUTE $f$
    CREATE FUNCTION pg_temp.people(n INT) RETURNS JSONB LANGUAGE sql AS $b$
      SELECT jsonb_agg(jsonb_build_object('row_no', g, 'input', jsonb_build_object('name', 'P' || g, 'email', 'p' || g || '@example.invalid', 'merge', '{}'::jsonb)) ORDER BY g)
        FROM generate_series(1, n) g
    $b$;
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
  PERFORM public.sign_ensure_defaults(acctA);
  PERFORM public.sign_ensure_defaults(acctB);

  INSERT INTO sign_templates (account_id, name, status, created_by) VALUES (acctA, 'Merchant Agreement', 'active', uA) RETURNING id INTO tplA;
  INSERT INTO sign_templates (account_id, name, status, created_by) VALUES (acctB, 'Other tenant template', 'active', uB) RETURNING id INTO tplB;

  -- 1. Both tables exist, row level security is on, and nothing is granted to the signed-out role.
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid IN ('public.sign_bulk_jobs'::regclass, 'public.sign_bulk_rows'::regclass) AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION 'FAIL row level security is off for the bulk tables';
  END IF;
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM sign_bulk_jobs$q$, 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the signed-out role touched sign_bulk_jobs: %', v_res; END IF;

  -- 2. Creating a batch: the job and every row in one go; a person found invalid at the preview is recorded as skipped.
  v_res := pg_temp.run(uA, format($q$SELECT public.sign_bulk_create(%L, %L, 'x', %L, 'csv', NULL, '{}'::jsonb, '[]'::jsonb)::text$q$, acctA, tplA, uA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in user called sign_bulk_create: %', v_res; END IF;
  j1 := public.sign_bulk_create(acctA, tplA, 'Merchant Agreement', uA, 'csv', 'list.csv', v_opts,
    (SELECT jsonb_agg(e) FROM (
       SELECT jsonb_build_object('row_no', 1, 'input', jsonb_build_object('name', 'Ali', 'email', 'ali@example.invalid', 'merge', '{}'::jsonb)) AS e
       UNION ALL SELECT jsonb_build_object('row_no', 2, 'input', jsonb_build_object('name', 'Siti', 'email', 'siti@example.invalid', 'merge', '{}'::jsonb))
       UNION ALL SELECT jsonb_build_object('row_no', 3, 'input', jsonb_build_object('name', 'Bad', 'email', 'nope', 'merge', '{}'::jsonb),
                                           'state', 'skipped', 'error_code', 'email_invalid', 'error_message', 'The email address is not valid.')
    ) x));
  IF (SELECT status FROM sign_bulk_jobs WHERE id = j1) <> 'queued' OR (SELECT total_rows FROM sign_bulk_jobs WHERE id = j1) <> 3
     OR (SELECT skipped_count FROM sign_bulk_jobs WHERE id = j1) <> 1 THEN
    RAISE EXCEPTION 'FAIL the batch should be queued with 3 rows and 1 skipped: %', (SELECT to_jsonb(j) FROM sign_bulk_jobs j WHERE id = j1);
  END IF;
  SELECT count(*) INTO v_n FROM sign_bulk_rows WHERE job_id = j1 AND state = 'pending';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL expected 2 pending rows, found %', v_n; END IF;
  IF (SELECT error_code FROM sign_bulk_rows WHERE job_id = j1 AND row_no = 3) <> 'email_invalid' OR (SELECT claimed_until FROM sign_bulk_rows WHERE job_id = j1 AND row_no = 3) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL the skipped row lost its reason';
  END IF;
  -- every row is for the batch's workspace
  IF EXISTS (SELECT 1 FROM sign_bulk_rows WHERE job_id = j1 AND account_id <> acctA) THEN RAISE EXCEPTION 'FAIL a row carries another workspace'; END IF;
  -- the batch was audited, with who started it, and its options (people's addresses) are not in the log
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_type = 'sign_bulk_job' AND entity_id = j1 AND action = 'created' AND entity_label = 'Merchant Agreement' AND actor_id = uA) THEN
    RAISE EXCEPTION 'FAIL the batch was not audited with its starter';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_type = 'sign_bulk_job' AND summary::text LIKE '%example.invalid%') THEN
    RAISE EXCEPTION 'FAIL the audit log carries the fixed people''s addresses';
  END IF;

  -- 3. Limits of a batch: 1 to 500 rows, a template of its own workspace, three active batches at a time.
  BEGIN
    PERFORM public.sign_bulk_create(acctA, tplA, 'T', uA, 'csv', NULL, v_opts, '[]'::jsonb);
    RAISE EXCEPTION 'FAIL a batch with no rows was created';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_bulk_create(acctA, tplA, 'T', uA, 'csv', NULL, v_opts, pg_temp.people(501));
    RAISE EXCEPTION 'FAIL a batch of 501 rows was created';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_bulk_create(acctA, tplB, 'T', uA, 'csv', NULL, v_opts, pg_temp.people(1));
    RAISE EXCEPTION 'FAIL a batch used another workspace''s template';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  j2 := public.sign_bulk_create(acctA, tplA, 'Second', uA, 'csv', NULL, v_opts, pg_temp.people(2));
  j3 := public.sign_bulk_create(acctA, tplA, 'Third', uA, 'contacts', NULL, v_opts, pg_temp.people(2));
  BEGIN
    PERFORM public.sign_bulk_create(acctA, tplA, 'Fourth', uA, 'csv', NULL, v_opts, pg_temp.people(1));
    RAISE EXCEPTION 'FAIL a fourth active batch was created';
  EXCEPTION WHEN SQLSTATE '53400' THEN NULL;
  END;
  jB := public.sign_bulk_create(acctB, tplB, 'Tenant B batch', uB, 'csv', NULL, v_opts, pg_temp.people(3));

  -- 4. Reading: members with menu.sign read; a viewer and another workspace see nothing.
  v_res := pg_temp.run(uA,  $q$SELECT count(*)::text FROM sign_bulk_jobs$q$);
  IF v_res <> '3' THEN RAISE EXCEPTION 'FAIL the owner should read the 3 batches and no more (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAg, format($q$SELECT count(*)::text FROM sign_bulk_rows WHERE job_id = %L$q$, j1));
  IF v_res <> '3' THEN RAISE EXCEPTION 'FAIL an agent should read the rows (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV,  $q$SELECT ((SELECT count(*) FROM sign_bulk_jobs) + (SELECT count(*) FROM sign_bulk_rows))::text$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer read the batches (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT count(*)::text FROM sign_bulk_jobs WHERE id IN (%L, %L, %L)$q$, j1, j2, j3));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace read these batches (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT count(*)::text FROM sign_bulk_rows WHERE job_id = %L$q$, j1));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace read these rows (saw %)', v_res; END IF;

  -- 5. Writing: nobody signed in writes the tables, not even the owner, not even to their own workspace.
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_bulk_jobs (account_id, template_name, total_rows) VALUES (%L, 'x', 1)$q$, acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner inserted a batch: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_bulk_rows (account_id, job_id, row_no, input) VALUES (%L, %L, 9, '{}'::jsonb)$q$, acctA, j1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner inserted a row: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$UPDATE sign_bulk_rows SET state = 'sent' WHERE job_id = %L$q$, j1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner changed a result: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$DELETE FROM sign_bulk_jobs WHERE id = %L$q$, j1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner deleted a batch: %', v_res; END IF;
  FOREACH v_fn IN ARRAY ARRAY['sign_bulk_claim(5, 5, 300, 3)', 'sign_bulk_release(ARRAY[]::uuid[])', 'sign_bulk_settle(ARRAY[]::uuid[])'] LOOP
    v_res := pg_temp.run(uA, format('SELECT public.%s::text', v_fn));
    IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in user called a bulk function: %', v_res; END IF;
  END LOOP;

  -- 6. A row's integrity: what the file said never changes; sent, failed and skipped are final; a document is never swapped
  --    or taken from another workspace.
  SELECT id INTO r1 FROM sign_bulk_rows WHERE job_id = j1 AND row_no = 1;
  SELECT id INTO r2 FROM sign_bulk_rows WHERE job_id = j1 AND row_no = 2;
  BEGIN
    UPDATE sign_bulk_rows SET input = '{"name": "Changed"}'::jsonb WHERE id = r1;
    RAISE EXCEPTION 'FAIL a row''s input was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_bulk_rows SET row_no = 7 WHERE id = r1;
    RAISE EXCEPTION 'FAIL a row''s number was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Draft for row 1', uA) RETURNING id INTO dA;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctB, 'Tenant B draft', uB) RETURNING id INTO dB;
  BEGIN
    UPDATE sign_bulk_rows SET document_id = dB WHERE id = r1;
    RAISE EXCEPTION 'FAIL a row took another workspace''s document';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_bulk_rows SET document_id = dA WHERE id = r1;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Another draft', uA);
  BEGIN
    UPDATE sign_bulk_rows SET document_id = (SELECT id FROM sign_documents WHERE account_id = acctA AND title = 'Another draft') WHERE id = r1;
    RAISE EXCEPTION 'FAIL a row''s document was swapped';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_bulk_rows (account_id, job_id, row_no, input, document_id) VALUES (acctA, j1, 9, '{}'::jsonb, dB);
    RAISE EXCEPTION 'FAIL a row was created with another workspace''s document';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- recording a result clears the lease and stamps the time; the result is then final
  UPDATE sign_bulk_rows SET claimed_until = now() + interval '5 minutes' WHERE id = r1;
  UPDATE sign_bulk_rows SET state = 'sent' WHERE id = r1;
  IF (SELECT claimed_until FROM sign_bulk_rows WHERE id = r1) IS NOT NULL OR (SELECT processed_at FROM sign_bulk_rows WHERE id = r1) IS NULL THEN
    RAISE EXCEPTION 'FAIL a finished row kept its lease or has no finish time';
  END IF;
  BEGIN
    UPDATE sign_bulk_rows SET state = 'pending' WHERE id = r1;
    RAISE EXCEPTION 'FAIL a sent row went back to pending';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_bulk_rows SET state = 'failed' WHERE id = r1;
    RAISE EXCEPTION 'FAIL a sent row became failed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_bulk_rows SET state = 'pending' WHERE job_id = j1 AND row_no = 3;
    RAISE EXCEPTION 'FAIL a skipped row went back to pending';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- a draft that is deleted afterwards leaves its row in place, with no document (and the guard lets that happen)
  DELETE FROM sign_documents WHERE id = dA;
  IF (SELECT document_id FROM sign_bulk_rows WHERE id = r1) IS NOT NULL OR (SELECT state FROM sign_bulk_rows WHERE id = r1) <> 'sent' THEN
    RAISE EXCEPTION 'FAIL deleting a draft should clear the row''s document and nothing else';
  END IF;

  -- 7. A job's integrity: it keeps what it started with, and its status only moves forward.
  BEGIN
    UPDATE sign_bulk_jobs SET total_rows = 9 WHERE id = j1;
    RAISE EXCEPTION 'FAIL a batch''s size was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_bulk_jobs SET options = '{}'::jsonb WHERE id = j1;
    RAISE EXCEPTION 'FAIL a batch''s options were changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_bulk_jobs SET account_id = acctB WHERE id = j1;
    RAISE EXCEPTION 'FAIL a batch moved to another workspace';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN NULL;
  END;

  -- 8. Claiming: a fair share of every workspace, under a lease, never the same row twice.
  UPDATE sign_bulk_rows SET claimed_until = NULL WHERE job_id = j1 AND state = 'pending';
  SELECT array_agg(id) INTO v_ids FROM sign_bulk_claim(10, 1, 300, 3);
  IF coalesce(array_length(v_ids, 1), 0) < 2 THEN RAISE EXCEPTION 'FAIL expected a row for each workspace, claimed %', v_ids; END IF;
  IF (SELECT count(DISTINCT account_id) FROM sign_bulk_rows WHERE id = ANY (v_ids)) <> 2 THEN RAISE EXCEPTION 'FAIL the claim was not shared between the two workspaces'; END IF;
  IF (SELECT count(*) FROM sign_bulk_rows WHERE id = ANY (v_ids) AND account_id = acctA) <> 1 THEN RAISE EXCEPTION 'FAIL one workspace took more than its share'; END IF;
  IF EXISTS (SELECT 1 FROM sign_bulk_rows WHERE id = ANY (v_ids) AND (claimed_until IS NULL OR claimed_until < now() + interval '4 minutes' OR attempts <> 1)) THEN
    RAISE EXCEPTION 'FAIL a claimed row has no lease or a wrong count of tries';
  END IF;
  IF (SELECT status FROM sign_bulk_jobs WHERE id = jB) <> 'running' OR (SELECT started_at FROM sign_bulk_jobs WHERE id = jB) IS NULL THEN
    RAISE EXCEPTION 'FAIL a batch with a claimed row should be running';
  END IF;
  SELECT array_agg(id) INTO v_ids2 FROM sign_bulk_claim(50, 50, 300, 3);
  IF v_ids2 && v_ids THEN RAISE EXCEPTION 'FAIL a row held under a lease was handed out again'; END IF;
  IF EXISTS (SELECT 1 FROM sign_bulk_rows WHERE job_id = j1 AND state = 'pending' AND id <> ALL (v_ids || v_ids2)) THEN
    RAISE EXCEPTION 'FAIL a waiting row was neither claimed nor held';
  END IF;
  -- a row whose lease passed comes back, counted as another try
  UPDATE sign_bulk_rows SET claimed_until = now() - interval '1 minute' WHERE id = ANY (v_ids);
  SELECT array_agg(id) INTO v_ids2 FROM sign_bulk_claim(50, 50, 300, 3);
  IF NOT (v_ids2 @> v_ids) THEN RAISE EXCEPTION 'FAIL rows whose lease passed were not claimable again'; END IF;
  IF EXISTS (SELECT 1 FROM sign_bulk_rows WHERE id = ANY (v_ids) AND attempts <> 2) THEN RAISE EXCEPTION 'FAIL a re-claimed row should be on its second try'; END IF;
  -- giving rows back is not a try
  PERFORM public.sign_bulk_release(v_ids);
  IF EXISTS (SELECT 1 FROM sign_bulk_rows WHERE id = ANY (v_ids) AND (claimed_until IS NOT NULL OR attempts <> 1)) THEN RAISE EXCEPTION 'FAIL released rows should have no lease and one try less'; END IF;
  UPDATE sign_bulk_rows SET claimed_until = NULL, attempts = 0 WHERE state = 'pending' AND job_id IN (j1, j2, j3, jB);

  -- a suspended workspace is left alone, and so is a batch that was cancelled
  UPDATE account_platform SET status = 'suspended' WHERE account_id = acctB;
  IF EXISTS (SELECT 1 FROM sign_bulk_claim(50, 50, 300, 3) c WHERE c.account_id = acctB) THEN RAISE EXCEPTION 'FAIL a suspended workspace''s rows were claimed'; END IF;
  UPDATE account_platform SET status = 'active' WHERE account_id = acctB;
  UPDATE sign_bulk_rows SET claimed_until = NULL, attempts = 0 WHERE state = 'pending' AND job_id IN (j1, j2, j3, jB);

  -- 9. Stopping: what nobody is working on is settled; a row being sent right now is left to finish.
  UPDATE sign_bulk_rows SET claimed_until = now() + interval '5 minutes' WHERE job_id = j2 AND row_no = 1;
  v_n := public.sign_bulk_stop(acctA, j2, 'cancelled', 'skipped', 'cancelled', 'Cancelled before it was sent.');
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL cancelling should skip the one row nobody held, skipped %', v_n; END IF;
  IF (SELECT state FROM sign_bulk_rows WHERE job_id = j2 AND row_no = 1) <> 'pending' THEN RAISE EXCEPTION 'FAIL a row being sent was cancelled under its worker'; END IF;
  IF (SELECT status FROM sign_bulk_jobs WHERE id = j2) <> 'cancelled' OR (SELECT finished_at FROM sign_bulk_jobs WHERE id = j2) IS NULL THEN
    RAISE EXCEPTION 'FAIL the batch should be cancelled and stamped';
  END IF;
  -- when the held row finishes, the counters follow
  UPDATE sign_bulk_rows SET state = 'sent' WHERE job_id = j2 AND row_no = 1;
  PERFORM public.sign_bulk_settle(ARRAY[j2]);
  IF (SELECT sent_count FROM sign_bulk_jobs WHERE id = j2) <> 1 OR (SELECT skipped_count FROM sign_bulk_jobs WHERE id = j2) <> 1 THEN
    RAISE EXCEPTION 'FAIL the counters of the cancelled batch are %', (SELECT to_jsonb(j) FROM sign_bulk_jobs j WHERE id = j2);
  END IF;
  -- a finished batch cannot be stopped again into something else
  PERFORM public.sign_bulk_stop(acctA, j2, 'failed', 'failed', 'x', 'x');
  IF (SELECT status FROM sign_bulk_jobs WHERE id = j2) <> 'cancelled' THEN RAISE EXCEPTION 'FAIL a cancelled batch was changed'; END IF;
  BEGIN
    PERFORM public.sign_bulk_stop(acctB, j1, 'cancelled', 'skipped', 'x', 'x');
    RAISE EXCEPTION 'FAIL another workspace stopped a batch';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_bulk_stop(acctA, j1, NULL, 'sent', 'x', 'x');
    RAISE EXCEPTION 'FAIL stop accepted the state sent';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- a limit reached: the waiting rows fail and the batch closes by itself once nothing is left
  v_n := public.sign_bulk_stop(acctA, j3, NULL, 'failed', 'sign_limit_reached', 'The monthly limit was reached.');
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL expected 2 rows failed by the limit, got %', v_n; END IF;
  IF (SELECT status FROM sign_bulk_jobs WHERE id = j3) <> 'done' OR (SELECT failed_count FROM sign_bulk_jobs WHERE id = j3) <> 2 THEN
    RAISE EXCEPTION 'FAIL a batch with every row failed should be done with 2 failed: %', (SELECT to_jsonb(j) FROM sign_bulk_jobs j WHERE id = j3);
  END IF;
  IF (SELECT error_code FROM sign_bulk_rows WHERE job_id = j3 AND row_no = 1) <> 'sign_limit_reached' THEN RAISE EXCEPTION 'FAIL the reason was not kept'; END IF;
  -- a finished batch moves no further
  BEGIN
    UPDATE sign_bulk_jobs SET status = 'running' WHERE id = j3;
    RAISE EXCEPTION 'FAIL a done batch went back to running';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 10. Giving up: a row tried too often without finishing fails; one whose document went out is left for the app to record.
  UPDATE sign_bulk_rows SET claimed_until = now() - interval '1 minute', attempts = 3 WHERE job_id = j1 AND row_no = 2;
  PERFORM 1 FROM sign_bulk_claim(50, 50, 300, 3);
  IF (SELECT state FROM sign_bulk_rows WHERE id = r2) <> 'failed' OR (SELECT error_code FROM sign_bulk_rows WHERE id = r2) <> 'gave_up' THEN
    RAISE EXCEPTION 'FAIL a row tried three times without finishing should give up: %', (SELECT to_jsonb(r) FROM sign_bulk_rows r WHERE id = r2);
  END IF;
  IF (SELECT status FROM sign_bulk_jobs WHERE id = j1) <> 'done' THEN
    RAISE EXCEPTION 'FAIL a batch whose last row gave up should be closed, it is %', (SELECT status FROM sign_bulk_jobs WHERE id = j1);
  END IF;
  -- (j1 is done: 1 sent, 1 failed, 1 skipped)
  IF (SELECT sent_count FROM sign_bulk_jobs WHERE id = j1) <> 1 OR (SELECT failed_count FROM sign_bulk_jobs WHERE id = j1) <> 1
     OR (SELECT skipped_count FROM sign_bulk_jobs WHERE id = j1) <> 1 THEN
    RAISE EXCEPTION 'FAIL the counters of the closed batch are %', (SELECT to_jsonb(j) FROM sign_bulk_jobs j WHERE id = j1);
  END IF;

  -- 11. The workspace export finds both tables by itself, without a secret column.
  v_json := public.workspace_export_manifest();
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json) e WHERE e ->> 'table' = 'sign_bulk_jobs')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json) e WHERE e ->> 'table' = 'sign_bulk_rows') THEN
    RAISE EXCEPTION 'FAIL the workspace export does not list the bulk tables';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('sign_bulk_jobs', 'sign_bulk_rows')
               AND column_name ~* '(token|secret|hash|password|api_key|embedding|client_state|signing|_enc$)') THEN
    RAISE EXCEPTION 'FAIL a bulk table has a column the export would hide';
  END IF;
  v_json := public.workspace_export_rows(acctA, 'sign_bulk_rows', NULL, 100);
  IF jsonb_array_length(v_json -> 'rows') <> (SELECT count(*) FROM sign_bulk_rows WHERE account_id = acctA) THEN
    RAISE EXCEPTION 'FAIL the export read % of the workspace''s bulk rows', jsonb_array_length(v_json -> 'rows');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_json -> 'rows') e WHERE e ->> 'account_id' <> acctA::text) THEN RAISE EXCEPTION 'FAIL the export carried another workspace''s rows'; END IF;

  -- 12. Deleting a workspace removes its batches and rows (through the cascade), with sent documents in the way.
  --     Workspace B has a batch with a row whose document was sent.
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email) VALUES (acctB, dB, 'merchant', 'Bob', 'bob@example.invalid');
  PERFORM public.sign_send_document(dB, 'p', repeat('a', 64), 1, now() + interval '14 days', uB);
  UPDATE sign_bulk_rows SET document_id = dB, state = 'sent' WHERE id = (SELECT id FROM sign_bulk_rows WHERE job_id = jB AND row_no = 1);
  v_res := pg_temp.run(uB, format($q$SELECT public.workspace_deletion_request(%L)::text$q$, acctB));
  IF v_res LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL the owner could not ask for the deletion: %', v_res; END IF;
  UPDATE account_platform SET deletion_due_at = now() - interval '1 minute' WHERE account_id = acctB;
  PERFORM public.workspace_deletion_begin(acctB);
  PERFORM public.delete_workspace_data(acctB);
  IF EXISTS (SELECT 1 FROM sign_bulk_jobs WHERE account_id = acctB) OR EXISTS (SELECT 1 FROM sign_bulk_rows WHERE account_id = acctB) THEN
    RAISE EXCEPTION 'FAIL batches or rows of the deleted workspace remain';
  END IF;
  IF (SELECT count(*) FROM sign_bulk_jobs WHERE account_id = acctA) <> 3 THEN RAISE EXCEPTION 'FAIL the other workspace lost its batches'; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: a batch and its rows are created in one transaction (invalid people recorded as skipped, 1 to 500 rows, own workspace''s template, three active batches), audited without the people''s addresses; members with menu.sign read and a viewer or another workspace reads nothing; nobody signed in or signed out writes the tables or calls the functions; a row''s input is fixed, its result final, its document never swapped nor taken from another workspace, and a deleted draft leaves the row; a batch keeps its options and only moves forward; claims share every workspace''s turn, hold a lease, never hand out a held row, bring back an expired one and give up after three tries; release is not a try; stop and cancel leave a row being sent to finish and close the batch; the workspace export lists both tables and deleting a workspace removes them';
END
$verify$;
