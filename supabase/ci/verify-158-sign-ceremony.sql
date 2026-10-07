-- Verify migration 158 (Doc Sign ceremony functions). Self-contained; run against an empty database or
-- production with 157's and 158's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();
  acctA  uuid;
  d1     uuid;  -- ordered, three signers
  d2     uuid;  -- unordered, two signers
  d3     uuid;  -- declined
  d4     uuid;  -- voided
  d5     uuid;  -- expired
  s1     uuid;  s2 uuid;  s3 uuid;
  u1     uuid;  u2 uuid;
  e1     uuid;  e2 uuid;
  r      jsonb;
  tok    text;
  tok2   text;
  v_n    int;
  v_txt  text;
  v_json jsonb;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  PERFORM public.sign_ensure_defaults(acctA);

  -- 0. Nothing here is callable by a signed-in user or a signed-out one.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname LIKE 'sign\_%' AND p.prokind = 'f'
     -- (sign_verify_chain checks the caller; migration 176's helpers answer for auth.uid() and are called by the row level security policies, and
     --  its list check is a pure function a CHECK constraint calls: those are meant to be callable)
     AND p.proname NOT IN ('sign_verify_chain', 'sign_is_named_signer', 'sign_is_named_on_envelope', 'sign_document_visible', 'sign_envelope_visible', 'sign_copy_list_valid') AND p.prorettype <> 'trigger'::regtype
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL % sign_ function(s) are callable by signed-in or signed-out users', v_n; END IF;
  IF NOT has_function_privilege('service_role', 'public.sign_send_document(uuid,text,text,integer,timestamptz,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the server cannot call sign_send_document';
  END IF;
  IF has_function_privilege('service_role', 'public.sign_issue_token(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL sign_issue_token must be internal';
  END IF;

  -- 1. An ordered document with three signers: only the first is invited, with a token.
  INSERT INTO sign_documents (account_id, title, created_by, sign_in_order) VALUES (acctA, 'Ordered', uA, true) RETURNING id INTO d1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d1, 'merchant', 'Ali', 'ali@example.invalid', 1) RETURNING id INTO s1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d1, 'director', 'Gokula', 'g@example.invalid', 2) RETURNING id INTO s2;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, channel, phone) VALUES (acctA, d1, 'witness', 'Siti', 's@example.invalid', 3, 'whatsapp', '+60123456789') RETURNING id INTO s3;

  BEGIN
    PERFORM public.sign_send_document(d1, 'p', repeat('a', 64), 2, now() + interval '14 days', uA);
    -- (runs as the owner of this block, which may call it; the point of the next check is the privilege test above)
  END;
  -- sent once; a second attempt is refused
  BEGIN
    PERFORM public.sign_send_document(d1, 'p', repeat('a', 64), 2, now() + interval '14 days', uA);
    RAISE EXCEPTION 'FAIL a sent document was sent again';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT status FROM sign_documents WHERE id = d1) <> 'sent' THEN RAISE EXCEPTION 'FAIL the document should be sent'; END IF;
  IF (SELECT sent_at FROM sign_documents WHERE id = d1) IS NULL THEN RAISE EXCEPTION 'FAIL sent_at missing'; END IF;
  IF (SELECT array_agg(status ORDER BY order_no) FROM sign_signers WHERE document_id = d1) IS DISTINCT FROM ARRAY['sent', 'pending', 'pending'] THEN
    RAISE EXCEPTION 'FAIL only the first signer should be invited: %', (SELECT array_agg(status ORDER BY order_no) FROM sign_signers WHERE document_id = d1);
  END IF;
  IF (SELECT count(*) FROM sign_signer_secrets WHERE signer_id IN (s1, s2, s3)) <> 1 THEN RAISE EXCEPTION 'FAIL only the invited signer should have a link'; END IF;
  IF (SELECT array_agg(step) FROM sign_step_invites WHERE document_id = d1) IS DISTINCT FROM ARRAY[1] THEN RAISE EXCEPTION 'FAIL step 1 should be recorded'; END IF;

  -- a send for a document without a signer, and with an expiry in the past, is refused
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Empty', uA) RETURNING id INTO d3;
  BEGIN
    PERFORM public.sign_send_document(d3, 'p', repeat('a', 64), 1, now() + interval '1 day', uA);
    RAISE EXCEPTION 'FAIL a document without a signer was sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email) VALUES (acctA, d3, 'm', 'M', 'm@example.invalid');
  BEGIN
    PERFORM public.sign_send_document(d3, 'p', repeat('a', 64), 1, now() - interval '1 day', uA);
    RAISE EXCEPTION 'FAIL an expiry in the past was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  DELETE FROM sign_documents WHERE id = d3;

  -- 2. The token is only stored as a hash, and a later signer cannot finish before their turn.
  tok := public.sign_issue_token(s1);
  IF (SELECT token_hash FROM sign_signer_secrets WHERE signer_id = s1) <> encode(sha256(convert_to(tok, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'FAIL the stored token hash is not the SHA-256 of the token';
  END IF;
  IF length(tok) <> 64 THEN RAISE EXCEPTION 'FAIL a token should be 64 characters, was %', length(tok); END IF;
  BEGIN
    PERFORM public.sign_complete_signer(s2, '203.0.113.9', 'Chrome', 'en', 'v1');
    RAISE EXCEPTION 'FAIL a signer who has not been invited signed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3. Viewing is recorded once.
  IF NOT public.sign_mark_viewed(s1, '203.0.113.9', 'Chrome') THEN RAISE EXCEPTION 'FAIL first view not recorded'; END IF;
  IF public.sign_mark_viewed(s1, '203.0.113.9', 'Chrome') THEN RAISE EXCEPTION 'FAIL second view recorded again'; END IF;

  -- 4. The first signer finishes: the second is invited (once), the third is not.
  BEGIN
    PERFORM public.sign_complete_signer(s1, '203.0.113.9', 'Chrome', 'en', 'v1');
    RAISE EXCEPTION 'FAIL a signer signed without agreeing to sign electronically';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT public.sign_record_consent(s1, 'consent-v1', 'ms', '203.0.113.9', 'Chrome on Android') THEN RAISE EXCEPTION 'FAIL consent not recorded'; END IF;
  IF public.sign_record_consent(s1, 'consent-v2', 'en', NULL, NULL) THEN RAISE EXCEPTION 'FAIL consent recorded twice'; END IF;
  r := public.sign_complete_signer(s1, '203.0.113.9', 'Chrome on Android', 'ms', 'consent-v1');
  IF (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL sealing started too early'; END IF;
  IF jsonb_array_length(r -> 'invited') <> 1 OR (r -> 'invited' -> 0 ->> 'signer_id')::uuid <> s2 THEN RAISE EXCEPTION 'FAIL the director should be invited next: %', r; END IF;
  IF length(r -> 'invited' -> 0 ->> 'token') <> 64 THEN RAISE EXCEPTION 'FAIL the next invitation carries no token'; END IF;
  IF (SELECT status FROM sign_documents WHERE id = d1) <> 'in_progress' THEN RAISE EXCEPTION 'FAIL the document should be in progress'; END IF;
  IF (SELECT status FROM sign_signers WHERE id = s3) <> 'pending' THEN RAISE EXCEPTION 'FAIL the third signer was invited too early'; END IF;
  IF (SELECT locale || consent_version || ip FROM sign_signers WHERE id = s1) <> 'msconsent-v1203.0.113.9' THEN RAISE EXCEPTION 'FAIL the signer''s locale, consent and address were not recorded'; END IF;
  BEGIN
    PERFORM public.sign_complete_signer(s1, '203.0.113.9', 'Chrome', 'ms', 'consent-v1');
    RAISE EXCEPTION 'FAIL a signer signed twice';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- two signers finishing together invite a step once
  IF jsonb_array_length(public.sign_invite_step(d1, 2, true, NULL)) <> 0 THEN RAISE EXCEPTION 'FAIL step 2 was invited twice'; END IF;

  -- 5. Resend and change of recipient: a new link, the old one dies; a signed signer cannot be changed.
  tok := public.sign_issue_token(s1); -- (s1 is signed; just to have a hash to compare)
  DELETE FROM sign_signer_secrets WHERE signer_id = s1;
  SELECT token_hash INTO v_txt FROM sign_signer_secrets WHERE signer_id = s2;
  v_json := public.sign_rotate_token(s2, uA);
  IF v_json ->> 'token' IS NULL OR (SELECT token_hash FROM sign_signer_secrets WHERE signer_id = s2) = v_txt THEN
    RAISE EXCEPTION 'FAIL resend did not replace the link';
  END IF;
  BEGIN
    PERFORM public.sign_rotate_token(s1, uA);
    RAISE EXCEPTION 'FAIL a signer who signed got a new link';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  v_json := public.sign_change_recipient(s2, 'Gokula K', 'gk@example.invalid', '', 'email', uA);
  IF (SELECT email FROM sign_signers WHERE id = s2) <> 'gk@example.invalid' OR v_json ->> 'token' IS NULL THEN RAISE EXCEPTION 'FAIL recipient not changed'; END IF;

  -- 6. The second, then the third finish: sealing starts when the last does.
  PERFORM public.sign_record_consent(s2, 'consent-v1', 'en', NULL, NULL);
  PERFORM public.sign_complete_signer(s2, '198.51.100.4', 'Safari', 'en', 'consent-v1');
  PERFORM public.sign_record_consent(s3, 'consent-v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(s3, '198.51.100.5', 'Firefox', 'en', 'consent-v1');
  -- (s3 was invited when s2 finished)
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL sealing should start when the last signer finishes: %', r; END IF;
  IF (SELECT status FROM sign_documents WHERE id = d1) <> 'sealing' THEN RAISE EXCEPTION 'FAIL the document should be sealing'; END IF;

  -- 7. The sealing job takes it with a lease; it cannot be taken twice; a failed attempt is retried after the lease.
  v_json := public.sign_claim_sealing(2, 300, 5);
  IF jsonb_array_length(v_json) <> 1 OR (v_json -> 0 ->> 'document_id')::uuid <> d1 THEN RAISE EXCEPTION 'FAIL the sealing job did not claim the document: %', v_json; END IF;
  IF jsonb_array_length(public.sign_claim_sealing(2, 300, 5)) <> 0 THEN RAISE EXCEPTION 'FAIL a document under lease was claimed twice'; END IF;
  PERFORM public.sign_fail_sealing(d1, 'storage unavailable');
  IF (SELECT seal_error FROM sign_documents WHERE id = d1) <> 'storage unavailable' THEN RAISE EXCEPTION 'FAIL the error was not recorded'; END IF;
  UPDATE sign_documents SET sealing_started_at = now() - interval '10 minutes' WHERE id = d1;
  IF jsonb_array_length(public.sign_claim_sealing(2, 300, 5)) <> 1 THEN RAISE EXCEPTION 'FAIL an expired lease was not reclaimed'; END IF;
  IF (SELECT sealing_attempts FROM sign_documents WHERE id = d1) <> 2 THEN RAISE EXCEPTION 'FAIL attempts should be 2'; END IF;
  PERFORM public.sign_finish_sealing(d1, 'account-x/d1/final.pdf', repeat('f', 64));
  IF (SELECT status FROM sign_documents WHERE id = d1) <> 'completed' OR (SELECT completed_at FROM sign_documents WHERE id = d1) IS NULL THEN RAISE EXCEPTION 'FAIL the document should be completed'; END IF;
  IF (SELECT retain_until FROM sign_documents WHERE id = d1) < now() + interval '6 years 360 days' THEN RAISE EXCEPTION 'FAIL retention should default to 7 years'; END IF;
  BEGIN
    PERFORM public.sign_finish_sealing(d1, 'x', repeat('e', 64));
    RAISE EXCEPTION 'FAIL a completed document was sealed again';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- the audit chain tells the whole story, in order, and is intact
  v_json := public.sign_verify_chain(d1);
  IF NOT (v_json ->> 'ok')::boolean THEN RAISE EXCEPTION 'FAIL the chain is not intact: %', v_json; END IF;
  IF (SELECT string_agg(type, ',' ORDER BY doc_seq) FROM sign_events WHERE document_id = d1)
     <> 'sent,invited,viewed,consented,signed,invited,resent,recipient_changed,consented,signed,invited,consented,signed,all_signed,seal_attempt_failed,sealed,completed' THEN
    RAISE EXCEPTION 'FAIL unexpected event sequence: %', (SELECT string_agg(type, ',' ORDER BY doc_seq) FROM sign_events WHERE document_id = d1);
  END IF;

  -- 8. An unordered document invites everyone at once; a failed seal run is bounded.
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Unordered', uA) RETURNING id INTO d2;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d2, 'a', 'A', 'a@example.invalid', 1) RETURNING id INTO u1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no, kind) VALUES (acctA, d2, 'b', 'B', 'b@example.invalid', 2, 'filler') RETURNING id INTO u2;
  r := public.sign_send_document(d2, 'p', repeat('b', 64), 1, now() + interval '3 days', uA);
  IF jsonb_array_length(r -> 'invited') <> 2 THEN RAISE EXCEPTION 'FAIL everyone should be invited when there is no signing order: %', r; END IF;
  PERFORM public.sign_record_consent(u1, 'v1', 'en', NULL, NULL);
  PERFORM public.sign_record_consent(u2, 'v1', 'en', NULL, NULL);
  PERFORM public.sign_complete_signer(u2, NULL, NULL, 'en', 'v1');
  IF (SELECT status FROM sign_documents WHERE id = d2) <> 'in_progress' THEN RAISE EXCEPTION 'FAIL one of two done is in progress'; END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id = d2 AND type = 'submitted') <> 1 THEN RAISE EXCEPTION 'FAIL a filler submits, it does not sign'; END IF;
  r := public.sign_complete_signer(u1, NULL, NULL, 'en', 'v1');
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL sealing expected'; END IF;
  UPDATE sign_documents SET sealing_attempts = 5 WHERE id = d2;
  PERFORM public.sign_claim_sealing(2, 300, 5);
  IF (SELECT status FROM sign_documents WHERE id = d2) <> 'failed' THEN RAISE EXCEPTION 'FAIL a document that failed 5 times should be failed'; END IF;

  -- 9. Decline stops the chain; links stay (they show how it ended) but nothing can be signed.
  INSERT INTO sign_documents (account_id, title, created_by, sign_in_order) VALUES (acctA, 'Declined', uA, true) RETURNING id INTO d3;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d3, 'a', 'A', 'a3@example.invalid', 1) RETURNING id INTO e1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d3, 'b', 'B', 'b3@example.invalid', 2) RETURNING id INTO e2;
  PERFORM public.sign_send_document(d3, 'p', repeat('c', 64), 1, NULL, uA);
  PERFORM public.sign_decline_signer(e1, 'I do not agree with clause 4', '203.0.113.1', 'Safari');
  IF (SELECT status FROM sign_documents WHERE id = d3) <> 'declined' THEN RAISE EXCEPTION 'FAIL the document should be declined'; END IF;
  IF (SELECT decline_reason FROM sign_signers WHERE id = e1) <> 'I do not agree with clause 4' THEN RAISE EXCEPTION 'FAIL the reason was not kept'; END IF;
  IF (SELECT count(*) FROM sign_signer_secrets WHERE signer_id IN (e1, e2)) <> 1 THEN RAISE EXCEPTION 'FAIL the link of the signer who was invited should survive a decline (it shows how the document ended); the one never invited has none'; END IF;
  IF (SELECT status FROM sign_signers WHERE id = e2) <> 'pending' THEN RAISE EXCEPTION 'FAIL the next signer must not be invited after a decline'; END IF;
  BEGIN
    PERFORM public.sign_complete_signer(e2, NULL, NULL, 'en', 'v1');
    RAISE EXCEPTION 'FAIL someone signed a declined document';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 10. Void: cancels, revokes links, cannot be repeated or applied to a finished document.
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Voided', uA) RETURNING id INTO d4;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email) VALUES (acctA, d4, 'a', 'A', 'a4@example.invalid');
  PERFORM public.sign_send_document(d4, 'p', repeat('d', 64), 1, NULL, uA);
  r := public.sign_void_document(d4, 'Sent to the wrong merchant', uA);
  IF (SELECT status FROM sign_documents WHERE id = d4) <> 'voided' OR (SELECT void_reason FROM sign_documents WHERE id = d4) <> 'Sent to the wrong merchant' THEN RAISE EXCEPTION 'FAIL void'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sign_signer_secrets k JOIN sign_signers x ON x.id = k.signer_id WHERE x.document_id = d4) THEN RAISE EXCEPTION 'FAIL the link should stay and show the document was voided'; END IF;
  BEGIN
    PERFORM public.sign_void_document(d4, 'again', uA);
    RAISE EXCEPTION 'FAIL a voided document was voided again';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_void_document(d1, 'too late', uA);
    RAISE EXCEPTION 'FAIL a completed document was voided';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 11. Expiry.
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Expiring', uA) RETURNING id INTO d5;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email) VALUES (acctA, d5, 'a', 'A', 'a5@example.invalid');
  PERFORM public.sign_send_document(d5, 'p', repeat('e', 64), 1, now() + interval '1 hour', uA);
  IF jsonb_array_length(public.sign_expire_due(10)) <> 0 THEN RAISE EXCEPTION 'FAIL a document not yet due expired'; END IF;
  UPDATE sign_documents SET expires_at = now() - interval '1 minute' WHERE id = d5;
  v_json := public.sign_expire_due(10);
  IF jsonb_array_length(v_json) <> 1 OR (v_json -> 0 ->> 'document_id')::uuid <> d5 THEN RAISE EXCEPTION 'FAIL expiry: %', v_json; END IF;
  IF (SELECT status FROM sign_documents WHERE id = d5) <> 'expired' THEN RAISE EXCEPTION 'FAIL the document should be expired'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sign_signer_secrets k JOIN sign_signers x ON x.id = k.signer_id WHERE x.document_id = d5) THEN RAISE EXCEPTION 'FAIL the link should stay and show the document expired'; END IF;

  -- 12. Every document's chain is intact, and the monthly count includes what was sent.
  FOR v_json IN SELECT public.sign_verify_chain(x) FROM unnest(ARRAY[d1, d2, d3, d4, d5]) x LOOP
    IF NOT (v_json ->> 'ok')::boolean THEN RAISE EXCEPTION 'FAIL a chain is broken: %', v_json; END IF;
  END LOOP;
  IF (public.account_usage(acctA) ->> 'sign_documents_month')::int <> 5 THEN RAISE EXCEPTION 'FAIL expected 5 documents sent this month'; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: sending invites the first step with hashed tokens; signing order invites each next step once; resend and change of recipient replace links; decline, void and expiry end the chain and nothing more can be signed; sealing is leased, bounded and finishes once; the audit chain stays intact and tells the story in order; nothing is callable by a signed-in or signed-out user';
END
$verify$;
