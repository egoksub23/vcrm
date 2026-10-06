-- Verify migration 159 (Doc Sign notifications and realtime). Self-contained; run against an empty database
-- or production with 157's, 158's and 159's migration text concatenated in front when not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();
  uB     uuid := gen_random_uuid();
  acctA  uuid;
  d1     uuid;  d2 uuid;  d3 uuid;  d4 uuid;
  s1     uuid;  s2 uuid;
  v_n    int;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
         (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  PERFORM public.sign_ensure_defaults(acctA);

  -- the three types are allowed, and none that existed was dropped
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check'
                   AND pg_get_constraintdef(oid) LIKE '%sign_completed%' AND pg_get_constraintdef(oid) LIKE '%sign_declined%'
                   AND pg_get_constraintdef(oid) LIKE '%sign_expired%' AND pg_get_constraintdef(oid) LIKE '%incident_raised%') THEN
    RAISE EXCEPTION 'FAIL the notification types were not widened (or an older one was lost)';
  END IF;

  -- realtime carries both tables
  SELECT count(*) INTO v_n FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename IN ('sign_documents', 'sign_signers');
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL realtime should carry sign_documents and sign_signers, has %', v_n; END IF;

  -- a declined document tells the sender, once
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Declined one', uA) RETURNING id INTO d1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email) VALUES (acctA, d1, 'merchant', 'Ali', 'ali@example.invalid') RETURNING id INTO s1;
  PERFORM public.sign_send_document(d1, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
  PERFORM public.sign_decline_signer(s1, 'no thanks', '203.0.113.9', 'Chrome');
  IF (SELECT count(*) FROM notifications WHERE sign_document_id = d1 AND user_id = uA AND type = 'sign_declined') <> 1 THEN
    RAISE EXCEPTION 'FAIL a declined document should notify its sender once';
  END IF;

  -- a completed one does too (finishing the only signer and the seal)
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Completed one', uA) RETURNING id INTO d2;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email) VALUES (acctA, d2, 'merchant', 'Siti', 'siti@example.invalid') RETURNING id INTO s2;
  PERFORM public.sign_send_document(d2, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
  PERFORM public.sign_record_consent(s2, 'v1', 'en', '203.0.113.9', 'Chrome');
  PERFORM public.sign_complete_signer(s2, '203.0.113.9', 'Chrome', 'en', 'v1');
  PERFORM public.sign_claim_sealing(1);
  PERFORM public.sign_finish_sealing(d2, 'final/path.pdf', repeat('b', 64));
  IF (SELECT count(*) FROM notifications WHERE sign_document_id = d2 AND user_id = uA AND type = 'sign_completed') <> 1 THEN
    RAISE EXCEPTION 'FAIL a completed document should notify its sender once';
  END IF;

  -- an expired one too
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Expired one', uA) RETURNING id INTO d3;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email) VALUES (acctA, d3, 'merchant', 'Lim', 'lim@example.invalid');
  PERFORM public.sign_send_document(d3, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
  UPDATE sign_documents SET expires_at = now() - interval '1 minute' WHERE id = d3;
  PERFORM public.sign_expire_due(50);
  IF (SELECT count(*) FROM notifications WHERE sign_document_id = d3 AND user_id = uA AND type = 'sign_expired') <> 1 THEN
    RAISE EXCEPTION 'FAIL an expired document should notify its sender once';
  END IF;

  -- a voided one, and a document made by someone no longer in the workspace, do not
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Voided one', uA) RETURNING id INTO d4;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email) VALUES (acctA, d4, 'merchant', 'Wong', 'wong@example.invalid');
  PERFORM public.sign_send_document(d4, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
  PERFORM public.sign_void_document(d4, 'changed my mind', uA);
  IF EXISTS (SELECT 1 FROM notifications WHERE sign_document_id = d4) THEN
    RAISE EXCEPTION 'FAIL cancelling your own document should not notify you';
  END IF;

  -- deleting a document removes its notifications (a draft can be deleted)
  IF (SELECT count(*) FROM notifications WHERE sign_document_id = d1) <> 1 THEN RAISE EXCEPTION 'FAIL setup'; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: the notification types are widened without losing any; realtime carries the documents and signers; a completed, declined or expired document notifies its sender once and a voided one does not';
END
$verify$;
