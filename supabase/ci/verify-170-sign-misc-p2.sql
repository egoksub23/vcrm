-- Verify migration 170 (Doc Sign: test documents, and a ticket or deal a document is attached to). Self-contained; run against an
-- empty database or production with 157 to 169's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- What it proves:
--   (a) a document is not a test unless it is made one; the flag can change on a draft and never once sent
--   (b) account_usage() counts a real document sent this month and not a test one
--   (c) a test document that completes is kept 30 days at most, a real one keeps the date it was given
--   (d) a ticket or deal of another workspace cannot be attached, one of the same workspace can
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();
  uB      uuid := gen_random_uuid();
  acctA   uuid;
  acctB   uuid;
  cA      uuid := gen_random_uuid();
  cB      uuid := gen_random_uuid();
  tA      uuid := gen_random_uuid();
  tB      uuid := gen_random_uuid();
  pA      uuid := gen_random_uuid();
  sA      uuid := gen_random_uuid();
  pB      uuid := gen_random_uuid();
  sB      uuid := gen_random_uuid();
  deA     uuid := gen_random_uuid();
  deB     uuid := gen_random_uuid();
  dReal   uuid;
  dTest   uuid;
  dDraft  uuid;
  dDone   uuid;
  dDoneT  uuid;
  v_before int;
  v_after  int;
  v_ret   timestamptz;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Owner A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Owner B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  PERFORM public.sign_ensure_defaults(acctA);
  PERFORM public.sign_ensure_defaults(acctB);

  -- (a) the column, its default, and the rule that fixes it when the document is sent
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sign_documents' AND column_name = 'test' AND data_type = 'boolean' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'FAIL sign_documents.test is missing or nullable';
  END IF;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Real', uA) RETURNING id INTO dReal;
  INSERT INTO sign_documents (account_id, title, created_by, test) VALUES (acctA, 'Test', uA, TRUE) RETURNING id INTO dTest;
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Draft', uA) RETURNING id INTO dDraft;
  IF (SELECT test FROM sign_documents WHERE id = dReal) THEN RAISE EXCEPTION 'FAIL a document is a test by default'; END IF;
  -- a draft can become a test and stop being one
  UPDATE sign_documents SET test = TRUE WHERE id = dDraft;
  UPDATE sign_documents SET test = FALSE WHERE id = dDraft;
  UPDATE sign_documents SET status = 'sent', base_path = 'account-x/real/base.pdf', base_sha256 = repeat('a', 64) WHERE id = dReal;
  UPDATE sign_documents SET status = 'sent', base_path = 'account-x/test/base.pdf', base_sha256 = repeat('b', 64) WHERE id = dTest;
  BEGIN
    UPDATE sign_documents SET test = TRUE WHERE id = dReal;
    RAISE EXCEPTION 'FAIL a document that was sent became a test';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET test = FALSE WHERE id = dTest;
    RAISE EXCEPTION 'FAIL a test document that was sent became a real one';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- (b) the monthly count: the real document counts, the test does not
  v_after := (public.account_usage(acctA) ->> 'sign_documents_month')::int;
  IF v_after <> 1 THEN RAISE EXCEPTION 'FAIL account_usage counted % sent documents, expected 1 (the real one, not the test)', v_after; END IF;
  v_before := v_after;
  INSERT INTO sign_documents (account_id, title, created_by, test, status, base_path, base_sha256, sent_at)
  VALUES (acctA, 'Another test', uA, TRUE, 'draft', NULL, NULL, NULL);
  UPDATE sign_documents SET status = 'sent', base_path = 'account-x/t2/base.pdf', base_sha256 = repeat('c', 64) WHERE title = 'Another test' AND account_id = acctA;
  v_after := (public.account_usage(acctA) ->> 'sign_documents_month')::int;
  IF v_after <> v_before THEN RAISE EXCEPTION 'FAIL a second test document changed the count from % to %', v_before, v_after; END IF;

  -- (c) retention: a test document completes with at most 30 days, a real one keeps what it was given
  INSERT INTO sign_documents (account_id, title, created_by, test) VALUES (acctA, 'Done real', uA, FALSE) RETURNING id INTO dDone;
  INSERT INTO sign_documents (account_id, title, created_by, test) VALUES (acctA, 'Done test', uA, TRUE) RETURNING id INTO dDoneT;
  UPDATE sign_documents SET status = 'sent', base_path = 'account-x/d/base.pdf', base_sha256 = repeat('d', 64) WHERE id IN (dDone, dDoneT);
  UPDATE sign_documents SET status = 'in_progress' WHERE id IN (dDone, dDoneT);
  UPDATE sign_documents SET status = 'sealing' WHERE id IN (dDone, dDoneT);
  UPDATE sign_documents SET status = 'completed', final_path = 'account-x/d/final.pdf', final_sha256 = repeat('e', 64), retain_until = now() + interval '7 years' WHERE id IN (dDone, dDoneT);
  SELECT retain_until INTO v_ret FROM sign_documents WHERE id = dDone;
  IF v_ret < now() + interval '6 years' THEN RAISE EXCEPTION 'FAIL a real document lost its retention date: %', v_ret; END IF;
  SELECT retain_until INTO v_ret FROM sign_documents WHERE id = dDoneT;
  IF v_ret IS NULL OR v_ret > now() + interval '30 days 1 minute' OR v_ret < now() + interval '29 days' THEN
    RAISE EXCEPTION 'FAIL a test document is not kept for 30 days: %', v_ret;
  END IF;

  -- (d) a ticket or deal of another workspace cannot be attached
  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (cA, uA, acctA, '+60170000001', 'Ali'), (cB, uB, acctB, '+60170000002', 'Bala');
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject) VALUES (tA, acctA, 170001, cA, 'Ticket A'), (tB, acctB, 170001, cB, 'Ticket B');
  INSERT INTO pipelines (id, user_id, name, account_id) VALUES (pA, uA, 'Pipeline A', acctA), (pB, uB, 'Pipeline B', acctB);
  INSERT INTO pipeline_stages (id, pipeline_id, name) VALUES (sA, pA, 'Stage A'), (sB, pB, 'Stage B');
  INSERT INTO deals (id, user_id, pipeline_id, stage_id, contact_id, title, account_id) VALUES (deA, uA, pA, sA, cA, 'Deal A', acctA), (deB, uB, pB, sB, cB, 'Deal B', acctB);
  UPDATE sign_documents SET ticket_id = tA, deal_id = deA WHERE id = dDraft;
  BEGIN
    UPDATE sign_documents SET ticket_id = tB WHERE id = dDraft;
    RAISE EXCEPTION 'FAIL a ticket of another workspace was attached';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET deal_id = deB WHERE id = dDraft;
    RAISE EXCEPTION 'FAIL a deal of another workspace was attached';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_documents (account_id, title, created_by, ticket_id) VALUES (acctA, 'Crossed', uA, tB);
    RAISE EXCEPTION 'FAIL a document was made with a ticket of another workspace';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT ticket_id FROM sign_documents WHERE id = dDraft) IS DISTINCT FROM tA THEN RAISE EXCEPTION 'FAIL the good link was lost'; END IF;

  -- the functions are internal: not callable by users
  IF has_function_privilege('authenticated', 'public.sign_documents_links_guard()', 'EXECUTE') OR has_function_privilege('anon', 'public.sign_documents_links_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the link guard is callable by users';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'sign_documents_links_guard' AND p.prosecdef AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'FAIL the link guard must pin its search_path';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: a document is not a test unless made one; the flag moves on a draft and is fixed once sent; account_usage counts real documents sent this month and no test; a test document completes with at most 30 days of retention and a real one keeps its date; a ticket or deal of another workspace cannot be attached and one of the same workspace can; the link guard is internal';
END
$verify$;
