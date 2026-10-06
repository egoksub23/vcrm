-- Verify migration 173 (Doc Sign: the person who started a bulk batch is told when it finishes). Self-contained; run against
-- an empty database or production with 157's, 159's, 162's and 173's migration text concatenated in front when not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();   -- starts the batches, owner of workspace A
  uGone  uuid := gen_random_uuid();   -- started a batch and then left the workspace
  uB     uuid := gen_random_uuid();   -- a user of workspace B
  acctA  uuid;
  acctB  uuid;
  tplA   uuid;
  j1     uuid;  j2 uuid;  j3 uuid;  j4 uuid;
  v_n    int;
  v_row  record;
  v_opts jsonb := '{"personRole": "merchant", "channel": "email"}'::jsonb;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'    || uA    || '@example.invalid', '{"full_name":"Tenant A"}', now()),
         (uGone, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gone-' || uGone || '@example.invalid', '{"full_name":"Gone"}', now()),
         (uB,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'    || uB    || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  UPDATE profiles SET account_id = acctA, account_role = 'agent' WHERE user_id = uGone;
  PERFORM public.sign_ensure_defaults(acctA);
  INSERT INTO sign_templates (account_id, name, status, created_by) VALUES (acctA, 'Merchant Agreement', 'active', uA) RETURNING id INTO tplA;

  -- 1. the type is allowed and no type that existed was dropped
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check'
                   AND pg_get_constraintdef(oid) LIKE '%sign_bulk_done%' AND pg_get_constraintdef(oid) LIKE '%sign_completed%'
                   AND pg_get_constraintdef(oid) LIKE '%incident_raised%') THEN
    RAISE EXCEPTION 'FAIL the notification types were not widened (or an older one was lost)';
  END IF;

  -- 2. the function is internal and the trigger is in place
  IF has_function_privilege('authenticated', 'public.notify_sign_bulk_done()', 'EXECUTE') OR has_function_privilege('anon', 'public.notify_sign_bulk_done()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL notify_sign_bulk_done must not be callable by signed-in or signed-out users';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.sign_bulk_jobs'::regclass AND tgname = 'trg_sign_bulk_done_notify' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FAIL the trigger is missing';
  END IF;

  -- 3. a batch that settles to done: one notification for its starter, with the counts, no document, own workspace
  j1 := public.sign_bulk_create(acctA, tplA, 'Merchant Agreement', uA, 'csv', 'list.csv', v_opts,
    (SELECT jsonb_agg(e) FROM (
       SELECT jsonb_build_object('row_no', 1, 'input', jsonb_build_object('name', 'Ali', 'email', 'ali@example.invalid', 'merge', '{}'::jsonb)) AS e
       UNION ALL SELECT jsonb_build_object('row_no', 2, 'input', jsonb_build_object('name', 'Siti', 'email', 'siti@example.invalid', 'merge', '{}'::jsonb))
       UNION ALL SELECT jsonb_build_object('row_no', 3, 'input', jsonb_build_object('name', 'Bad', 'email', 'nope', 'merge', '{}'::jsonb),
                                           'state', 'skipped', 'error_code', 'email_invalid', 'error_message', 'The email address is not valid.')
    ) x));
  IF EXISTS (SELECT 1 FROM notifications WHERE type = 'sign_bulk_done' AND account_id = acctA) THEN
    RAISE EXCEPTION 'FAIL a batch that has only been created must not be announced';
  END IF;
  UPDATE sign_bulk_jobs SET status = 'running' WHERE id = j1;
  IF EXISTS (SELECT 1 FROM notifications WHERE type = 'sign_bulk_done' AND account_id = acctA) THEN
    RAISE EXCEPTION 'FAIL a batch that has started must not be announced';
  END IF;
  UPDATE sign_bulk_rows SET state = 'sent' WHERE job_id = j1 AND row_no = 1;
  UPDATE sign_bulk_rows SET state = 'failed', error_code = 'x', error_message = 'x' WHERE job_id = j1 AND row_no = 2;
  PERFORM public.sign_bulk_settle(ARRAY[j1]);
  IF (SELECT status FROM sign_bulk_jobs WHERE id = j1) <> 'done' THEN RAISE EXCEPTION 'FAIL the batch should have settled to done'; END IF;
  SELECT * INTO v_row FROM notifications WHERE type = 'sign_bulk_done' AND account_id = acctA;
  IF NOT FOUND OR v_row.user_id <> uA OR v_row.sign_document_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL the starter should be told, in their own workspace, with no document attached';
  END IF;
  IF v_row.title <> 'Batch finished: Merchant Agreement' OR v_row.body <> '1 sent, 1 failed, 1 skipped' THEN
    RAISE EXCEPTION 'FAIL the notification words are wrong: % / %', v_row.title, v_row.body;
  END IF;

  -- 4. settling again, or any later update, does not announce a second time
  PERFORM public.sign_bulk_settle(ARRAY[j1]);
  UPDATE sign_bulk_jobs SET error_code = 'later' WHERE id = j1;
  SELECT count(*) INTO v_n FROM notifications WHERE type = 'sign_bulk_done' AND account_id = acctA;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL the batch was announced % times', v_n; END IF;

  -- 5. a batch stopped by the system (the monthly limit) is announced as stopped, with the rows counted at that moment
  j2 := public.sign_bulk_create(acctA, tplA, 'Limit hit', uA, 'csv', NULL, v_opts,
    (SELECT jsonb_agg(jsonb_build_object('row_no', g, 'input', jsonb_build_object('name', 'P' || g, 'email', 'p' || g || '@example.invalid', 'merge', '{}'::jsonb)) ORDER BY g) FROM generate_series(1, 2) g));
  PERFORM public.sign_bulk_stop(acctA, j2, 'failed', 'failed', 'sign_limit_reached', 'The monthly limit was reached.');
  SELECT * INTO v_row FROM notifications WHERE type = 'sign_bulk_done' AND title = 'Batch stopped: Limit hit';
  IF NOT FOUND OR v_row.body <> '0 sent, 2 failed, 0 skipped' THEN
    RAISE EXCEPTION 'FAIL a stopped batch should be announced with its real counts: %', (SELECT body FROM notifications WHERE title = 'Batch stopped: Limit hit');
  END IF;

  -- 6. a batch the person cancelled themselves is not announced to them
  j3 := public.sign_bulk_create(acctA, tplA, 'Cancelled by me', uA, 'csv', NULL, v_opts,
    (SELECT jsonb_agg(jsonb_build_object('row_no', g, 'input', jsonb_build_object('name', 'P' || g, 'email', 'p' || g || '@example.invalid', 'merge', '{}'::jsonb)) ORDER BY g) FROM generate_series(1, 2) g));
  PERFORM public.sign_bulk_stop(acctA, j3, 'cancelled', 'skipped', 'cancelled', 'Cancelled before it was sent.');
  IF (SELECT status FROM sign_bulk_jobs WHERE id = j3) <> 'cancelled' THEN RAISE EXCEPTION 'FAIL the batch should be cancelled'; END IF;
  IF EXISTS (SELECT 1 FROM notifications WHERE title LIKE '%Cancelled by me%') THEN
    RAISE EXCEPTION 'FAIL a cancelled batch must not be announced';
  END IF;

  -- 7. someone who has left the workspace is not told, and the batch still closes
  j4 := public.sign_bulk_create(acctA, tplA, 'Left behind', uGone, 'csv', NULL, v_opts,
    (SELECT jsonb_agg(jsonb_build_object('row_no', g, 'input', jsonb_build_object('name', 'P' || g, 'email', 'p' || g || '@example.invalid', 'merge', '{}'::jsonb)) ORDER BY g) FROM generate_series(1, 1) g));
  UPDATE profiles SET account_id = acctB WHERE user_id = uGone;
  PERFORM public.sign_bulk_stop(acctA, j4, 'failed', 'failed', 'x', 'x');
  IF (SELECT status FROM sign_bulk_jobs WHERE id = j4) <> 'failed' THEN RAISE EXCEPTION 'FAIL the batch must still close'; END IF;
  IF EXISTS (SELECT 1 FROM notifications WHERE user_id = uGone AND type = 'sign_bulk_done') THEN
    RAISE EXCEPTION 'FAIL a person who left the workspace must not be told about its batch';
  END IF;

  -- 8. nobody of workspace B was told anything
  IF EXISTS (SELECT 1 FROM notifications WHERE account_id = acctB AND type = 'sign_bulk_done') THEN
    RAISE EXCEPTION 'FAIL another workspace was notified';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: the notification type is added without losing any; the starter of a batch is told once when it is done or stopped (with counts, no document, own workspace), not when it is created, started or cancelled by them, and never after they left the workspace';
END
$verify$;
