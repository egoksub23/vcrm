-- Verify migration 167 (Doc Sign: a Halo user is told when it is their turn). Self-contained; run against an empty
-- database or production with 157's to 159's and 167's migration text concatenated in front when not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();   -- the sender and owner of workspace A
  uDir   uuid := gen_random_uuid();   -- a Halo user of workspace A who countersigns
  uB     uuid := gen_random_uuid();   -- a user of workspace B
  acctA  uuid;
  d1     uuid;  d2 uuid;  d3 uuid;
  s1     uuid;  s2 uuid;  s3 uuid;
  v_n    int;
  v_row  record;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'   || uA   || '@example.invalid', '{"full_name":"Tenant A"}', now()),
         (uDir, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dir-' || uDir || '@example.invalid', '{"full_name":"Director"}', now()),
         (uB,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'   || uB   || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  UPDATE profiles SET account_id = acctA, account_role = 'admin' WHERE user_id = uDir;
  PERFORM public.sign_ensure_defaults(acctA);

  -- 1. the type is allowed and no type that existed was dropped
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check'
                   AND pg_get_constraintdef(oid) LIKE '%sign_your_turn%' AND pg_get_constraintdef(oid) LIKE '%sign_completed%'
                   AND pg_get_constraintdef(oid) LIKE '%sign_declined%' AND pg_get_constraintdef(oid) LIKE '%incident_raised%') THEN
    RAISE EXCEPTION 'FAIL the notification types were not widened (or an older one was lost)';
  END IF;

  -- 2. the function is internal and the trigger is in place
  IF has_function_privilege('authenticated', 'public.notify_sign_your_turn()', 'EXECUTE') OR has_function_privilege('anon', 'public.notify_sign_your_turn()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL notify_sign_your_turn must not be callable by signed-in or signed-out users';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.sign_signers'::regclass AND tgname = 'trg_sign_your_turn_notify' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FAIL the trigger is missing';
  END IF;

  -- 3. an unordered document: the Halo user is notified once when the document is sent; the outside signer is not a Halo user and gets nothing
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Unordered', uA) RETURNING id INTO d1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d1, 'merchant', 'Ali', 'ali@example.invalid', 1) RETURNING id INTO s1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, internal_user_id) VALUES (acctA, d1, 'director', 'Director', 'dir@example.invalid', 2, uDir) RETURNING id INTO s2;
  PERFORM public.sign_send_document(d1, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
  SELECT * INTO v_row FROM notifications WHERE sign_document_id = d1 AND type = 'sign_your_turn';
  IF NOT FOUND OR v_row.user_id <> uDir OR v_row.account_id <> acctA THEN
    RAISE EXCEPTION 'FAIL the Halo user should be told, in their own workspace, when an unordered document is sent';
  END IF;
  SELECT count(*) INTO v_n FROM notifications WHERE sign_document_id = d1;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL exactly one notification was expected for the unordered document, got %', v_n; END IF;

  -- 4. a second update of the same signer (a reminder, a view) does not notify again
  PERFORM public.sign_mark_viewed(s2, '203.0.113.9', 'Chrome');
  UPDATE sign_signers SET reminder_count = reminder_count + 1 WHERE id = s2;
  SELECT count(*) INTO v_n FROM notifications WHERE sign_document_id = d1 AND type = 'sign_your_turn';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL viewing or reminding must not notify again, got %', v_n; END IF;

  -- 5. an ordered document: nothing at the send (the Halo user is in step 2), the notification arrives when step 1 finishes
  INSERT INTO sign_documents (account_id, title, created_by, sign_in_order) VALUES (acctA, 'Ordered', uA, true) RETURNING id INTO d2;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d2, 'merchant', 'Siti', 'siti@example.invalid', 1) RETURNING id INTO s1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, internal_user_id) VALUES (acctA, d2, 'director', 'Director', 'dir@example.invalid', 2, uDir) RETURNING id INTO s2;
  PERFORM public.sign_send_document(d2, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
  IF EXISTS (SELECT 1 FROM notifications WHERE sign_document_id = d2) THEN
    RAISE EXCEPTION 'FAIL the Halo user is in step 2 and must not be told when step 1 is invited';
  END IF;
  PERFORM public.sign_record_consent(s1, 'v1', 'en', '203.0.113.9', 'Chrome');
  PERFORM public.sign_complete_signer(s1, '203.0.113.9', 'Chrome', 'en', 'v1');
  SELECT count(*) INTO v_n FROM notifications WHERE sign_document_id = d2 AND user_id = uDir AND type = 'sign_your_turn';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL the Halo user should be told once when step 1 finished, got %', v_n; END IF;
  IF (SELECT title FROM notifications WHERE sign_document_id = d2 AND type = 'sign_your_turn') NOT LIKE 'Your signature is needed:%' THEN
    RAISE EXCEPTION 'FAIL the notification title is wrong';
  END IF;

  -- 6. a user id from another workspace is never notified (the sender typed an id that is not a member of this workspace), and the document is still sent
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Foreign', uA) RETURNING id INTO d3;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, internal_user_id) VALUES (acctA, d3, 'director', 'Stranger', 'x@example.invalid', 1, uB) RETURNING id INTO s3;
  PERFORM public.sign_send_document(d3, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
  IF EXISTS (SELECT 1 FROM notifications WHERE sign_document_id = d3) OR EXISTS (SELECT 1 FROM notifications WHERE user_id = uB) THEN
    RAISE EXCEPTION 'FAIL a user of another workspace must not be notified';
  END IF;
  IF (SELECT status FROM sign_signers WHERE id = s3) <> 'sent' THEN RAISE EXCEPTION 'FAIL the invitation itself must go through'; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: the notification type is added without losing any; a Halo user is told exactly once when their step is invited (at the send for an unordered document, when the earlier step finishes for an ordered one), a viewing or reminder does not repeat it, and a user of another workspace is never told';
END
$verify$;
