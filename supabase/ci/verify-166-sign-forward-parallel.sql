-- Verify migration 166 (Doc Sign: steps that sign together, and forwarding a turn or a part). Self-contained; run
-- against an empty database or production with 157's to 160's and 166's migration text concatenated in front when
-- they are not applied yet. Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();
  acctA  uuid;
  d_step uuid;  -- ordered: step 1 (A and B together), step 2 (C)
  d_solo uuid;  -- ordered: one person per step
  d_mix  uuid;  -- ordered: 1 (A), 2 (B, C), 3 (D); a decline inside a step
  d_edit uuid;  -- ordered: a person who is not invited yet is edited and moved
  d_free uuid;  -- no signing order
  d_turn uuid;  -- forward a turn (no order)
  d_part uuid;  -- forward parts (ordered, with a form)
  d_back uuid;  -- take a part back (no order)
  sa uuid; sb uuid; sc uuid;
  p1 uuid; p2 uuid;
  q1 uuid; q2 uuid; q3 uuid; q4 uuid;
  z1 uuid; z2 uuid; z3 uuid;
  f1 uuid; f2 uuid;
  m1 uuid; m2 uuid; dg uuid;
  r      jsonb;
  tok    text;
  v_n    int;
  v_txt  text;
  v_json jsonb;
  v_count_before int;
  v_form jsonb := '{"version":1,"parts":[
        {"key":"company","title":{"en":"Company"},"role":"merchant"},
        {"key":"bank","title":{"en":"Bank"},"role":"merchant"},
        {"key":"tax","title":{"en":"Tax"},"role":"merchant"},
        {"key":"owner","title":{"en":"Owner"},"role":"director"}],
      "fields":[
        {"key":"legalName","type":"text","part":"company","label":{"en":"Legal name"},"required":true},
        {"key":"accountNo","type":"text","part":"bank","label":{"en":"Account"},"required":true},
        {"key":"bankName","type":"text","part":"bank","label":{"en":"Bank"},"required":false},
        {"key":"taxId","type":"text","part":"tax","label":{"en":"Tax id"},"required":false},
        {"key":"ownerName","type":"text","part":"owner","label":{"en":"Owner"},"required":true}]}'::jsonb;
  v_fields jsonb := '[{"key":"msig","type":"signature","role":"merchant","page":0,"x":0.1,"y":0.1,"w":0.2,"h":0.05,"required":true},
                      {"key":"mname","type":"text","role":"merchant","page":0,"x":0.1,"y":0.2,"w":0.2,"h":0.05,"required":false}]'::jsonb;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  PERFORM public.sign_ensure_defaults(acctA);

  -- 0. The new functions are the server's alone; the helpers are internal.
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('sign_forward_turn', 'sign_forward_part', 'sign_take_back_part', 'sign_move_signer', 'sign_forward_check', 'sign_mask_email', 'sign_invite_step', 'sign_complete_signer', 'sign_change_recipient')
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL % of the new or changed functions are callable by signed-in or signed-out users', v_n; END IF;
  IF NOT has_function_privilege('service_role', 'public.sign_forward_turn(uuid,text,text,integer,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sign_forward_part(uuid,text,text,text,integer,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sign_take_back_part(uuid,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sign_move_signer(uuid,integer,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sign_complete_signer(uuid,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sign_change_recipient(uuid,text,text,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the server cannot call the forwarding functions';
  END IF;
  IF has_function_privilege('service_role', 'public.sign_forward_check(public.sign_documents,public.sign_signers,text,text,integer,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.sign_invite_step(uuid,integer,boolean,uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.sign_mask_email(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the helpers must be internal';
  END IF;
  -- the old four-argument invitation function is gone (a call with four arguments reaches the new one)
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'sign_invite_step' AND p.pronargs = 4) THEN
    RAISE EXCEPTION 'FAIL the old sign_invite_step is still there';
  END IF;
  -- the notification type was added and the earlier ones were kept
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check'
                   AND pg_get_constraintdef(oid) LIKE '%sign_forwarded%' AND pg_get_constraintdef(oid) LIKE '%sign_completed%'
                   AND pg_get_constraintdef(oid) LIKE '%sign_declined%' AND pg_get_constraintdef(oid) LIKE '%incident_raised%') THEN
    RAISE EXCEPTION 'FAIL the notification types were not widened (or an older one was lost)';
  END IF;
  -- the masked address
  IF public.sign_mask_email('ali@kedai.example') <> 'a***@kedai.example' OR public.sign_mask_email('nonsense') <> '***' THEN RAISE EXCEPTION 'FAIL sign_mask_email'; END IF;
  -- a document does not allow forwarding unless asked to
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Default', uA) RETURNING id INTO d_free;
  IF (SELECT allow_forwarding FROM sign_documents WHERE id = d_free) THEN RAISE EXCEPTION 'FAIL forwarding must be off by default'; END IF;

  -- 1. Parallel steps: A and B share step 1, C is step 2.
  INSERT INTO sign_documents (account_id, title, created_by, sign_in_order) VALUES (acctA, 'Steps', uA, true) RETURNING id INTO d_step;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_step, 'ra', 'Ali', 'ali@example.invalid', 1) RETURNING id INTO sa;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_step, 'rb', 'Bee', 'bee@example.invalid', 1) RETURNING id INTO sb;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_step, 'rc', 'Cik', 'cik@example.invalid', 2) RETURNING id INTO sc;
  r := public.sign_send_document(d_step, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
  IF jsonb_array_length(r -> 'invited') <> 2 THEN RAISE EXCEPTION 'FAIL both people of step 1 should be invited together: %', r; END IF;
  IF (SELECT array_agg(status ORDER BY full_name) FROM sign_signers WHERE document_id = d_step) IS DISTINCT FROM ARRAY['sent', 'sent', 'pending'] THEN
    RAISE EXCEPTION 'FAIL expected A and B invited and C waiting: %', (SELECT array_agg(status ORDER BY full_name) FROM sign_signers WHERE document_id = d_step);
  END IF;
  IF (SELECT count(*) FROM sign_signer_secrets WHERE signer_id IN (sa, sb, sc)) <> 2 THEN RAISE EXCEPTION 'FAIL a person whose step has not begun must have no link'; END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id = d_step AND type = 'invited' AND (detail ->> 'step')::int = 1) <> 2 THEN RAISE EXCEPTION 'FAIL each invitation of step 1 is an event'; END IF;
  PERFORM public.sign_record_consent(sa, 'v1', 'en', NULL, NULL);
  PERFORM public.sign_record_consent(sb, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(sa, NULL, NULL, 'en', 'v1');
  IF jsonb_array_length(r -> 'invited') <> 0 OR (SELECT status FROM sign_signers WHERE id = sc) <> 'pending' THEN
    RAISE EXCEPTION 'FAIL step 2 must wait until everyone of step 1 has finished: %', r;
  END IF;
  r := public.sign_complete_signer(sb, NULL, NULL, 'en', 'v1');
  IF jsonb_array_length(r -> 'invited') <> 1 OR (r -> 'invited' -> 0 ->> 'signer_id')::uuid <> sc OR length(r -> 'invited' -> 0 ->> 'token') <> 64 THEN
    RAISE EXCEPTION 'FAIL C should be invited, once, when the step finished: %', r;
  END IF;
  IF (SELECT detail ->> 'because' FROM sign_events WHERE document_id = d_step AND signer_id = sc AND type = 'invited') <> 'step_finished' THEN
    RAISE EXCEPTION 'FAIL the invitation should say the previous step finished';
  END IF;
  IF jsonb_array_length(public.sign_invite_step(d_step, 2, true, NULL)) <> 0 THEN RAISE EXCEPTION 'FAIL step 2 was invited twice'; END IF;
  PERFORM public.sign_record_consent(sc, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(sc, NULL, NULL, 'en', 'v1');
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL the last signature should start sealing'; END IF;

  -- one person per step still reads "because Ali finished"
  INSERT INTO sign_documents (account_id, title, created_by, sign_in_order) VALUES (acctA, 'Solo steps', uA, true) RETURNING id INTO d_solo;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_solo, 'ra', 'Ali Solo', 'ali2@example.invalid', 1) RETURNING id INTO p1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_solo, 'rb', 'Bee Solo', 'bee2@example.invalid', 2) RETURNING id INTO p2;
  PERFORM public.sign_send_document(d_solo, 'p', repeat('b', 64), 1, NULL, uA);
  PERFORM public.sign_record_consent(p1, 'v1', 'en', NULL, NULL);
  PERFORM public.sign_complete_signer(p1, NULL, NULL, 'en', 'v1');
  SELECT detail INTO v_json FROM sign_events WHERE document_id = d_solo AND signer_id = p2 AND type = 'invited';
  IF v_json ->> 'because' <> 'signer_finished' OR v_json ->> 'finished_name' <> 'Ali Solo' OR (v_json ->> 'step')::int <> 2 THEN
    RAISE EXCEPTION 'FAIL a single-person step should record who finished: %', v_json;
  END IF;

  -- mixed: 1 (A), 2 (B, C), 3 (D); a decline inside step 2 stops the chain
  INSERT INTO sign_documents (account_id, title, created_by, sign_in_order) VALUES (acctA, 'Mixed', uA, true) RETURNING id INTO d_mix;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_mix, 'ra', 'M-A', 'ma@example.invalid', 1) RETURNING id INTO q1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_mix, 'rb', 'M-B', 'mb@example.invalid', 2) RETURNING id INTO q2;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_mix, 'rc', 'M-C', 'mc@example.invalid', 2) RETURNING id INTO q3;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_mix, 'rd', 'M-D', 'md@example.invalid', 3) RETURNING id INTO q4;
  r := public.sign_send_document(d_mix, 'p', repeat('c', 64), 1, NULL, uA);
  IF jsonb_array_length(r -> 'invited') <> 1 THEN RAISE EXCEPTION 'FAIL only step 1 is invited at the send'; END IF;
  PERFORM public.sign_record_consent(q1, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(q1, NULL, NULL, 'en', 'v1');
  IF jsonb_array_length(r -> 'invited') <> 2 THEN RAISE EXCEPTION 'FAIL B and C should be invited together: %', r; END IF;
  IF (SELECT status FROM sign_signers WHERE id = q4) <> 'pending' THEN RAISE EXCEPTION 'FAIL D must wait'; END IF;
  PERFORM public.sign_decline_signer(q2, 'not for me', NULL, NULL);
  IF (SELECT status FROM sign_documents WHERE id = d_mix) <> 'declined' THEN RAISE EXCEPTION 'FAIL a decline by one person of a step stops the document'; END IF;
  BEGIN
    PERFORM public.sign_record_consent(q3, 'v1', 'en', NULL, NULL);
    RAISE EXCEPTION 'FAIL the other person of the step could still act on a declined document';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT status FROM sign_signers WHERE id = q4) <> 'pending' OR EXISTS (SELECT 1 FROM sign_signer_secrets WHERE signer_id = q4) THEN
    RAISE EXCEPTION 'FAIL the next step must never be invited after a decline';
  END IF;

  -- 2. Change of recipient: a person not invited yet keeps no link; an invited one gets a new link and agrees again.
  INSERT INTO sign_documents (account_id, title, created_by, sign_in_order) VALUES (acctA, 'Edits', uA, true) RETURNING id INTO d_edit;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_edit, 'ra', 'E-A', 'ea@example.invalid', 1) RETURNING id INTO z1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_edit, 'rb', 'E-B', 'eb@example.invalid', 2) RETURNING id INTO z2;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_edit, 'rc', 'E-C', 'ec@example.invalid', 3) RETURNING id INTO z3;
  PERFORM public.sign_send_document(d_edit, 'p', repeat('d', 64), 1, NULL, uA);
  v_json := public.sign_change_recipient(z2, 'Eb Renamed', 'eb2@example.invalid', '', 'email', uA);
  IF v_json ->> 'token' IS NOT NULL OR (SELECT email FROM sign_signers WHERE id = z2) <> 'eb2@example.invalid' OR (SELECT status FROM sign_signers WHERE id = z2) <> 'pending'
     OR EXISTS (SELECT 1 FROM sign_signer_secrets WHERE signer_id = z2) THEN
    RAISE EXCEPTION 'FAIL a person who is not invited yet is re-addressed without getting a link: %', v_json;
  END IF;
  PERFORM public.sign_record_consent(z1, 'v1', 'en', NULL, NULL);
  SELECT token_hash INTO v_txt FROM sign_signer_secrets WHERE signer_id = z1;
  v_json := public.sign_change_recipient(z1, 'Ea New', 'ea2@example.invalid', '', 'email', uA);
  IF length(v_json ->> 'token') <> 64 OR (SELECT token_hash FROM sign_signer_secrets WHERE signer_id = z1) = v_txt THEN RAISE EXCEPTION 'FAIL the new person has no new link, or the old one still works'; END IF;
  IF (SELECT consented_at FROM sign_signers WHERE id = z1) IS NOT NULL THEN RAISE EXCEPTION 'FAIL the new person must agree to sign electronically themselves'; END IF;
  BEGIN
    PERFORM public.sign_complete_signer(z1, NULL, NULL, 'en', 'v1');
    RAISE EXCEPTION 'FAIL the new person signed without their own consent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- moving a person whose step has not begun
  BEGIN
    PERFORM public.sign_move_signer(z1, 4, uA);
    RAISE EXCEPTION 'FAIL a person who is invited was moved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_move_signer(z2, 1, uA);
    RAISE EXCEPTION 'FAIL a person was moved into a step that has begun';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_move_signer(z2, 0, uA);
    RAISE EXCEPTION 'FAIL a person was moved to step 0';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM public.sign_move_signer(z2, 5, uA);
  IF (SELECT order_no FROM sign_signers WHERE id = z2) <> 5 THEN RAISE EXCEPTION 'FAIL the person was not moved to the later step'; END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id = d_edit AND type = 'signer_moved') <> 1 THEN RAISE EXCEPTION 'FAIL the move is an audit event'; END IF;
  -- the chain skips the gap: after the first step finishes, the next number is invited (here C at 3, before the moved B at 5)
  PERFORM public.sign_record_consent(z1, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(z1, NULL, NULL, 'en', 'v1');
  IF jsonb_array_length(r -> 'invited') <> 1 OR (r -> 'invited' -> 0 ->> 'signer_id')::uuid <> z3 THEN RAISE EXCEPTION 'FAIL the next step in order should be invited, gaps and all: %', r; END IF;
  -- a document without signing order has no steps to move in
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'No order', uA) RETURNING id INTO d_free;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_free, 'ra', 'N-A', 'na@example.invalid', 1);
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_free, 'rb', 'N-B', 'nb@example.invalid', 2) RETURNING id INTO z1;
  PERFORM public.sign_send_document(d_free, 'p', repeat('e', 64), 1, NULL, uA);
  BEGIN
    PERFORM public.sign_move_signer(z1, 3, uA);
    RAISE EXCEPTION 'FAIL a person on a document without order was moved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3. Forward a whole turn (no signing order, two roles).
  INSERT INTO sign_documents (account_id, title, created_by, allow_forwarding, fields_snapshot) VALUES (acctA, 'Forward a turn', uA, false, v_fields) RETURNING id INTO d_turn;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_turn, 'merchant', 'Ali bin Ahmad', 'ali@kedai.example', 1) RETURNING id INTO f1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_turn, 'director', 'Gokula', 'g@vircle.example', 2) RETURNING id INTO f2;
  PERFORM public.sign_send_document(d_turn, 'p', repeat('f', 64), 1, NULL, uA);
  SELECT (public.account_usage(acctA) ->> 'sign_documents_month')::int INTO v_count_before;
  tok := public.sign_issue_token(f1);
  -- the sender has not switched it on
  BEGIN
    PERFORM public.sign_forward_turn(f1, 'Siti Finance', 'siti@kedai.example', 2, '203.0.113.9', 'Chrome');
    RAISE EXCEPTION 'FAIL a turn was forwarded on a document that does not allow it';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_documents SET allow_forwarding = true WHERE id = d_turn; -- the flag is not frozen: the sender may change it while the document is open
  -- the rules
  BEGIN PERFORM public.sign_forward_turn(f1, ' ', 'x@example.invalid', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a nameless forward was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM public.sign_forward_turn(f1, 'Siti', 'not an email', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a bad address was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM public.sign_forward_turn(f1, 'Me again', 'ALI@kedai.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a forward to the forwarder was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_turn, 'merchant', 'Partner', 'partner@kedai.example', 3);
  BEGIN PERFORM public.sign_forward_turn(f1, 'P', 'Partner@kedai.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a forward to someone already on the document for the role was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  DELETE FROM sign_signers WHERE document_id = d_turn AND email = 'partner@kedai.example';
  -- answers before the forward: a signature, a text answer and an answer from the contact
  PERFORM public.sign_record_consent(f1, 'v1', 'en', '203.0.113.5', 'Chrome');
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value, source) VALUES
    (acctA, d_turn, f1, 'msig', '{"typed":"Ali"}', 'signer'),
    (acctA, d_turn, f1, 'mname', '{"text":"Kedai Ali"}', 'signer'),
    (acctA, d_turn, f1, 'legalName', '{"text":"Kedai Ali Sdn Bhd"}', 'contact');
  v_json := public.sign_forward_turn(f1, 'Siti Finance', 'siti@kedai.example', 2, '203.0.113.9', 'Chrome');
  IF v_json ->> 'signer_id' <> f1::text OR length(v_json ->> 'token') <> 64 OR v_json ->> 'forwarded_by' <> 'Ali bin Ahmad' OR v_json ->> 'name' <> 'Siti Finance' THEN
    RAISE EXCEPTION 'FAIL the forward should return the same position with a new person and a link: %', v_json;
  END IF;
  IF (SELECT full_name || email || status || forward_count::text FROM sign_signers WHERE id = f1) <> 'Siti Financesiti@kedai.examplesent1' THEN
    RAISE EXCEPTION 'FAIL the position should now be Siti: %', (SELECT row_to_json(s)::text FROM sign_signers s WHERE id = f1);
  END IF;
  IF (SELECT consented_at FROM sign_signers WHERE id = f1) IS NOT NULL OR (SELECT viewed_at FROM sign_signers WHERE id = f1) IS NOT NULL THEN RAISE EXCEPTION 'FAIL nothing the forwarder agreed to or viewed may carry over'; END IF;
  IF (SELECT forward_history -> 0 ->> 'name' FROM sign_signers WHERE id = f1) <> 'Ali bin Ahmad' THEN RAISE EXCEPTION 'FAIL the forwarder is kept as history'; END IF;
  IF (SELECT token_hash FROM sign_signer_secrets WHERE signer_id = f1) = encode(sha256(convert_to(tok, 'UTF8')), 'hex') THEN RAISE EXCEPTION 'FAIL the old link still works'; END IF;
  IF (SELECT token_hash FROM sign_signer_secrets WHERE signer_id = f1) <> encode(sha256(convert_to(v_json ->> 'token', 'UTF8')), 'hex') THEN RAISE EXCEPTION 'FAIL the new link is not the stored one'; END IF;
  IF EXISTS (SELECT 1 FROM sign_answers WHERE signer_id = f1 AND field_key = 'msig') THEN RAISE EXCEPTION 'FAIL the forwarder''s signature must not carry over'; END IF;
  IF (SELECT source FROM sign_answers WHERE signer_id = f1 AND field_key = 'mname') <> 'forwarded' THEN RAISE EXCEPTION 'FAIL a kept answer should be marked as forwarded'; END IF;
  IF (SELECT source FROM sign_answers WHERE signer_id = f1 AND field_key = 'legalName') <> 'contact' THEN RAISE EXCEPTION 'FAIL an answer from the contact stays unconfirmed'; END IF;
  -- the audit trail: names and a masked address, never a token
  SELECT detail INTO v_json FROM sign_events WHERE document_id = d_turn AND type = 'forwarded';
  IF v_json ->> 'from_name' <> 'Ali bin Ahmad' OR v_json ->> 'to_name' <> 'Siti Finance' OR v_json ->> 'to_email' <> 's***@kedai.example' OR (v_json ->> 'count')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL the forwarded event is wrong: %', v_json;
  END IF;
  IF (SELECT string_agg(detail::text, ' ') FROM sign_events WHERE document_id = d_turn) LIKE '%siti@kedai.example%'
     OR (SELECT string_agg(detail::text, ' ') FROM sign_events WHERE document_id = d_turn) LIKE '%' || tok || '%' THEN
    RAISE EXCEPTION 'FAIL a full address or a token is in the audit trail';
  END IF;
  -- the sender is told, once
  IF (SELECT count(*) FROM notifications WHERE sign_document_id = d_turn AND user_id = uA AND type = 'sign_forwarded') <> 1 THEN RAISE EXCEPTION 'FAIL the sender should be notified once'; END IF;
  -- a forward is not a new document
  IF (public.account_usage(acctA) ->> 'sign_documents_month')::int <> v_count_before THEN RAISE EXCEPTION 'FAIL a forward counted as a new document'; END IF;
  -- the new person signs for themselves; a second forward uses the second of two; a third is refused
  PERFORM public.sign_record_consent(f1, 'v1', 'en', NULL, NULL);
  PERFORM public.sign_forward_turn(f1, 'Lim Next', 'lim@kedai.example', 2, NULL, NULL);
  IF (SELECT forward_count FROM sign_signers WHERE id = f1) <> 2 OR jsonb_array_length((SELECT forward_history FROM sign_signers WHERE id = f1)) <> 2 THEN RAISE EXCEPTION 'FAIL two forwards should be counted and remembered'; END IF;
  BEGIN PERFORM public.sign_forward_turn(f1, 'Wong Third', 'wong@kedai.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a third forward of the same position was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- the director: not to their own address; to a person of another role only because this document needs no order
  PERFORM public.sign_record_consent(f2, 'v1', 'en', NULL, NULL);
  BEGIN PERFORM public.sign_forward_turn(f2, 'Director Friend', 'G@vircle.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a forward to the forwarder''s own address was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM public.sign_forward_turn(f2, 'Same Lim', 'lim@kedai.example', 2, NULL, NULL);
  -- a signer who has signed cannot forward
  PERFORM public.sign_record_consent(f1, 'v1', 'en', NULL, NULL);
  PERFORM public.sign_complete_signer(f1, NULL, NULL, 'en', 'v1');
  BEGIN PERFORM public.sign_forward_turn(f1, 'Late', 'late@kedai.example', 3, NULL, NULL); RAISE EXCEPTION 'FAIL a signer forwarded after signing';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- 4. Forward parts: an ordered document, the merchant (step 1) holds company, bank and tax; the director is step 2.
  INSERT INTO sign_documents (account_id, title, created_by, sign_in_order, allow_forwarding, form_snapshot)
  VALUES (acctA, 'Forward parts', uA, true, true, v_form) RETURNING id INTO d_part;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_part, 'merchant', 'Ali bin Ahmad', 'ali@kedai.example', 1) RETURNING id INTO m1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_part, 'director', 'Gokula', 'g@vircle.example', 2) RETURNING id INTO m2;
  PERFORM public.sign_send_document(d_part, 'p', repeat('1', 64), 1, NULL, uA);
  PERFORM public.sign_record_consent(m1, 'v1', 'en', NULL, NULL);

  BEGIN PERFORM public.sign_forward_part(m1, 'owner', 'Siti', 'siti@kedai.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a part of another role was forwarded';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM public.sign_forward_part(m1, 'nope', 'Siti', 'siti@kedai.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a part that does not exist was forwarded';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM public.sign_forward_part(m1, 'bank', 'Me', 'ali@kedai.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a part was forwarded to the forwarder';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM public.sign_forward_part(m1, 'bank', 'Dir', 'g@vircle.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL (signing order) a part was forwarded to someone already on the document';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- forward the bank part
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value, source) VALUES
    (acctA, d_part, m1, 'accountNo', '{"text":"OLD"}', 'signer'),
    (acctA, d_part, m1, 'bankName', '{"text":"Maybank"}', 'signer'),
    (acctA, d_part, m1, 'legalName', '{"text":"Kedai Ali"}', 'signer');
  v_json := public.sign_forward_part(m1, 'bank', 'Siti Finance', 'siti@kedai.example', 2, '203.0.113.9', 'Chrome');
  dg := (v_json ->> 'signer_id')::uuid;
  IF dg IS NULL OR dg = m1 OR length(v_json ->> 'token') <> 64 OR v_json ->> 'part' <> 'bank' OR v_json ->> 'kind' <> 'filler' THEN RAISE EXCEPTION 'FAIL the delegate and their link: %', v_json; END IF;
  IF (SELECT role_key || kind || order_no::text || status || delegated_by::text || array_to_string(part_keys, ',') FROM sign_signers WHERE id = dg) <> 'merchantfiller1sent' || m1::text || 'bank' THEN
    RAISE EXCEPTION 'FAIL the delegate should be a filler of the role, in the signer''s step, restricted to the part: %', (SELECT row_to_json(s)::text FROM sign_signers s WHERE id = dg);
  END IF;
  IF (SELECT forward_count FROM sign_signers WHERE id = m1) <> 1 THEN RAISE EXCEPTION 'FAIL the forward is counted against the signer'; END IF;
  IF (SELECT count(*) FROM sign_signer_secrets WHERE signer_id = dg) <> 1 THEN RAISE EXCEPTION 'FAIL the delegate has a link of their own'; END IF;
  SELECT detail INTO v_json FROM sign_events WHERE document_id = d_part AND type = 'part_forwarded';
  IF v_json ->> 'part' <> 'bank' OR v_json ->> 'to_name' <> 'Siti Finance' OR v_json ->> 'to_email' <> 's***@kedai.example' OR v_json ->> 'delegate' <> dg::text THEN RAISE EXCEPTION 'FAIL the part_forwarded event: %', v_json; END IF;
  BEGIN PERFORM public.sign_forward_part(m1, 'bank', 'Other', 'other@kedai.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a part that is already out was forwarded again';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- a second part for the same person goes to the same row, with a new link
  SELECT token_hash INTO v_txt FROM sign_signer_secrets WHERE signer_id = dg;
  PERFORM public.sign_forward_part(m1, 'tax', 'Siti Finance', 'SITI@kedai.example', 2, NULL, NULL);
  IF (SELECT count(*) FROM sign_signers WHERE delegated_by = m1) <> 1 OR (SELECT array_to_string(part_keys, ',') FROM sign_signers WHERE id = dg) <> 'bank,tax' THEN RAISE EXCEPTION 'FAIL the second part should join the delegate''s row'; END IF;
  IF (SELECT token_hash FROM sign_signer_secrets WHERE signer_id = dg) = v_txt THEN RAISE EXCEPTION 'FAIL the delegate''s link was not renewed'; END IF;
  IF (SELECT forward_count FROM sign_signers WHERE id = m1) <> 2 THEN RAISE EXCEPTION 'FAIL both part forwards count'; END IF;
  -- the limit counts parts and turns together
  BEGIN PERFORM public.sign_forward_part(m1, 'company', 'Wong', 'wong@kedai.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a third forward of the position was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM public.sign_forward_turn(m1, 'Wong', 'wong@kedai.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a turn was forwarded after the limit';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- a delegate cannot pass it on
  PERFORM public.sign_record_consent(dg, 'v1', 'en', NULL, NULL);
  BEGIN PERFORM public.sign_forward_part(dg, 'bank', 'Third', 'third@kedai.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a delegate passed a part on';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM public.sign_forward_turn(dg, 'Third', 'third@kedai.example', 2, NULL, NULL); RAISE EXCEPTION 'FAIL a delegate forwarded a turn';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- the table itself refuses a delegate that is not a filler, or a restriction without a giver
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, kind, full_name, email, part_keys, delegated_by) VALUES (acctA, d_part, 'merchant', 'signer', 'X', 'x@example.invalid', ARRAY['bank'], m1);
    RAISE EXCEPTION 'FAIL a delegate that signs was stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO sign_signers (account_id, document_id, role_key, kind, full_name, email, part_keys) VALUES (acctA, d_part, 'merchant', 'filler', 'X', 'x@example.invalid', ARRAY['bank']);
    RAISE EXCEPTION 'FAIL a part restriction without a giver was stored';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- the signer cannot finish while a part is out, nor can the next step begin
  BEGIN PERFORM public.sign_complete_signer(m1, NULL, NULL, 'en', 'v1'); RAISE EXCEPTION 'FAIL the signer finished while a part was out';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- the delegate submits (a filler's act); the step still waits for the signer; then the signer finishes and the director is invited
  r := public.sign_complete_signer(dg, '203.0.113.9', 'Chrome', 'en', 'v1');
  IF jsonb_array_length(r -> 'invited') <> 0 OR (SELECT status FROM sign_signers WHERE id = m2) <> 'pending' THEN RAISE EXCEPTION 'FAIL the next step began before the signer of the step finished: %', r; END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id = d_part AND type = 'submitted' AND signer_id = dg) <> 1 THEN RAISE EXCEPTION 'FAIL a delegate submits, it does not sign'; END IF;
  BEGIN PERFORM public.sign_take_back_part(m1, 'bank', NULL, NULL); RAISE EXCEPTION 'FAIL a completed part was taken back';
  EXCEPTION WHEN check_violation THEN NULL; END;
  r := public.sign_complete_signer(m1, NULL, NULL, 'en', 'v1');
  IF jsonb_array_length(r -> 'invited') <> 1 OR (r -> 'invited' -> 0 ->> 'signer_id')::uuid <> m2 THEN RAISE EXCEPTION 'FAIL the director should be invited when the merchant finished: %', r; END IF;
  SELECT detail INTO v_json FROM sign_events WHERE document_id = d_part AND signer_id = m2 AND type = 'invited';
  IF v_json ->> 'because' <> 'signer_finished' OR v_json ->> 'finished_name' <> 'Ali bin Ahmad' THEN
    RAISE EXCEPTION 'FAIL a delegate is part of the signer''s step, not a person of it: %', v_json;
  END IF;
  PERFORM public.sign_record_consent(m2, 'v1', 'en', NULL, NULL);
  r := public.sign_complete_signer(m2, NULL, NULL, 'en', 'v1');
  IF NOT (r ->> 'sealing')::boolean THEN RAISE EXCEPTION 'FAIL everyone, the delegate included, finished: sealing should start'; END IF;

  -- 5. Take a part back (a document without order).
  INSERT INTO sign_documents (account_id, title, created_by, allow_forwarding, form_snapshot) VALUES (acctA, 'Take back', uA, true, v_form) RETURNING id INTO d_back;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_back, 'merchant', 'Ali T', 'alit@kedai.example', 1) RETURNING id INTO m1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d_back, 'director', 'Dir T', 'dirt@vircle.example', 2) RETURNING id INTO m2;
  PERFORM public.sign_send_document(d_back, 'p', repeat('2', 64), 1, NULL, uA);
  PERFORM public.sign_record_consent(m1, 'v1', 'en', NULL, NULL);
  BEGIN PERFORM public.sign_take_back_part(m1, 'bank', NULL, NULL); RAISE EXCEPTION 'FAIL a part that is not out was taken back';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value, source) VALUES
    (acctA, d_back, m1, 'accountNo', '{"text":"OLD"}', 'signer'),
    (acctA, d_back, m1, 'bankName', '{"text":"Maybank"}', 'signer');
  v_json := public.sign_forward_part(m1, 'bank', 'Siti Finance', 'siti2@kedai.example', 2, NULL, NULL);
  dg := (v_json ->> 'signer_id')::uuid;
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value, source) VALUES (acctA, d_back, dg, 'accountNo', '{"text":"1234567890"}', 'forwarded');
  PERFORM public.sign_take_back_part(m1, 'bank', '203.0.113.9', 'Chrome');
  IF EXISTS (SELECT 1 FROM sign_signers WHERE id = dg) OR EXISTS (SELECT 1 FROM sign_signer_secrets WHERE signer_id = dg) THEN RAISE EXCEPTION 'FAIL the delegate and their link should be gone'; END IF;
  IF (SELECT value ->> 'text' FROM sign_answers WHERE signer_id = m1 AND field_key = 'accountNo') <> '1234567890' THEN RAISE EXCEPTION 'FAIL what the delegate typed should be the signer''s now'; END IF;
  IF (SELECT source FROM sign_answers WHERE signer_id = m1 AND field_key = 'accountNo') <> 'forwarded' THEN RAISE EXCEPTION 'FAIL the moved answer keeps its origin'; END IF;
  IF (SELECT value ->> 'text' FROM sign_answers WHERE signer_id = m1 AND field_key = 'bankName') <> 'Maybank' THEN RAISE EXCEPTION 'FAIL the signer''s own answer the delegate did not touch must stay'; END IF;
  SELECT count(*) INTO v_n FROM sign_answers WHERE document_id = d_back AND signer_id = m1 AND field_key = 'accountNo';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL exactly one answer to the field should remain'; END IF;
  IF (SELECT count(*) FROM sign_events WHERE document_id = d_back AND type = 'part_taken_back') <> 1 THEN RAISE EXCEPTION 'FAIL taking a part back is an audit event'; END IF;
  -- the signer can finish now
  PERFORM public.sign_complete_signer(m1, NULL, NULL, 'en', 'v1');
  IF (SELECT status FROM sign_signers WHERE id = m1) <> 'signed' THEN RAISE EXCEPTION 'FAIL the signer should be able to finish once the part is back'; END IF;

  -- 6. Every chain is intact.
  FOR v_json IN SELECT public.sign_verify_chain(x.id) FROM sign_documents x WHERE x.account_id = acctA LOOP
    IF NOT (v_json ->> 'ok')::boolean THEN RAISE EXCEPTION 'FAIL a chain is broken: %', v_json; END IF;
  END LOOP;

  RAISE EXCEPTION 'ROLLBACK-OK: people who share an order number are invited together, the next step waits for all of them and says why it began, a decline inside a step stops the chain; a person not invited yet is re-addressed or moved without a link; a turn forwarded keeps the position, kills the old link, drops the signature, leaves history and a masked audit event, notifies the sender and is not a new document, at most twice; a part goes to a delegate who sees only that part, cannot pass it on, holds the step open with the signer, and can be taken back with the work done so far';
END
$verify$;
