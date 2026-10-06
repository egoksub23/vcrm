-- Verify migration 168 (Doc Sign sensitive answers). Self-contained; run against an empty database or production with
-- 157's to 168's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();
  acctA  uuid;
  d1     uuid;
  s1     uuid;
  s2     uuid;
  v_n    int;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  PERFORM public.sign_ensure_defaults(acctA);

  -- 1. the column exists, and is plain text
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sign_answers' AND column_name = 'value_enc' AND data_type = 'text') THEN
    RAISE EXCEPTION 'FAIL sign_answers.value_enc is missing';
  END IF;

  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Sensitive doc', uA) RETURNING id INTO d1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d1, 'merchant', 'Ali', 'ali@example.invalid', 1) RETURNING id INTO s1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d1, 'director', 'Gokula', 'g@example.invalid', 2) RETURNING id INTO s2;

  -- 2. a sensitive row cannot hold the plain value, an ordinary row cannot hold ciphertext, and each needs what it is
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value, value_enc, sensitive)
    VALUES (acctA, d1, s1, 'icNumber', '{"text":"900101-01-1234"}'::jsonb, 'v2:k:aa:bb:cc', true);
    RAISE EXCEPTION 'FAIL a sensitive answer was stored with its plain value beside the ciphertext';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value, sensitive)
    VALUES (acctA, d1, s1, 'icNumber', '{"text":"900101-01-1234"}'::jsonb, true);
    RAISE EXCEPTION 'FAIL a sensitive answer was stored as plain text';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value, sensitive)
    VALUES (acctA, d1, s1, 'icNumber', NULL, true);
    RAISE EXCEPTION 'FAIL a sensitive answer with no ciphertext was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value, value_enc, sensitive)
    VALUES (acctA, d1, s1, 'icNumber', NULL, 'v2:k:aa:bb:cc', false);
    RAISE EXCEPTION 'FAIL an ordinary answer was given ciphertext';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value, value_enc, sensitive)
    VALUES (acctA, d1, s1, 'icNumber', NULL, '', true);
    RAISE EXCEPTION 'FAIL an empty ciphertext was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- the two good shapes
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value, value_enc, sensitive)
  VALUES (acctA, d1, s1, 'icNumber', NULL, 'v2:k:aa:bb:cc', true);
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value)
  VALUES (acctA, d1, s1, 'tradeName', '{"text":"Kedai Ali"}'::jsonb);
  IF (SELECT count(*) FROM sign_answers WHERE document_id = d1 AND signer_id = s1) <> 2 THEN RAISE EXCEPTION 'FAIL the two good answers should be stored'; END IF;
  IF EXISTS (SELECT 1 FROM sign_answers WHERE sensitive AND value IS NOT NULL) THEN RAISE EXCEPTION 'FAIL a sensitive row holds a plain value'; END IF;

  -- a row cannot be turned sensitive while keeping its plain value, nor back
  BEGIN
    UPDATE sign_answers SET sensitive = true WHERE signer_id = s1 AND field_key = 'tradeName';
    RAISE EXCEPTION 'FAIL an ordinary answer was marked sensitive without being encrypted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_answers SET value = '{"text":"x"}'::jsonb WHERE signer_id = s1 AND field_key = 'icNumber';
    RAISE EXCEPTION 'FAIL plain text was written over a sensitive answer';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3. until the signer signs, an answer can be rewritten (autosave)
  UPDATE sign_answers SET value_enc = 'v2:k:dd:ee:ff' WHERE signer_id = s1 AND field_key = 'icNumber';
  UPDATE sign_answers SET value = '{"text":"Kedai Ali Sdn Bhd"}'::jsonb WHERE signer_id = s1 AND field_key = 'tradeName';

  -- 4. once the signer has signed, the answers are frozen
  PERFORM public.sign_send_document(d1, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
  PERFORM public.sign_record_consent(s1, 'consent-v1', 'en', '203.0.113.9', 'Chrome');
  PERFORM public.sign_complete_signer(s1, '203.0.113.9', 'Chrome', 'en', 'consent-v1');
  IF (SELECT status FROM sign_signers WHERE id = s1) <> 'signed' THEN RAISE EXCEPTION 'FAIL the signer should have signed'; END IF;

  BEGIN
    UPDATE sign_answers SET value = '{"text":"Changed"}'::jsonb WHERE signer_id = s1 AND field_key = 'tradeName';
    RAISE EXCEPTION 'FAIL the answer of a signed person was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_answers SET value_enc = NULL, sensitive = false, value = '{"text":"900101-01-1234"}'::jsonb WHERE signer_id = s1 AND field_key = 'icNumber';
    RAISE EXCEPTION 'FAIL a sensitive answer of a signed person was turned into plain text';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d1, s1, 'late', '{"text":"x"}'::jsonb);
    RAISE EXCEPTION 'FAIL an answer was added for a signed person';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- ...but the same answer under a newer key (rotation), and moving the row (forwarding), are not changes of the answer
  UPDATE sign_answers SET value_enc = 'v2:k2:11:22:33' WHERE signer_id = s1 AND field_key = 'icNumber';
  UPDATE sign_answers SET source = 'forwarded' WHERE signer_id = s1 AND field_key = 'icNumber';
  IF (SELECT value_enc FROM sign_answers WHERE signer_id = s1 AND field_key = 'icNumber') <> 'v2:k2:11:22:33' THEN RAISE EXCEPTION 'FAIL the re-encrypted answer was not kept'; END IF;
  -- a person who has not signed is not frozen by someone else's signature
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value, value_enc, sensitive)
  VALUES (acctA, d1, s2, 'bankAccount', NULL, 'v2:k:aa:bb:cc', true);
  UPDATE sign_answers SET value_enc = 'v2:k:99:99:99' WHERE signer_id = s2 AND field_key = 'bankAccount';
  -- deleting stays possible (forwarding a part, retention, the purge of a workspace)
  DELETE FROM sign_answers WHERE signer_id = s1 AND field_key = 'tradeName';
  SELECT count(*) INTO v_n FROM sign_answers WHERE signer_id = s1;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL expected one answer left for the signed person, found %', v_n; END IF;

  -- 5. the guard is not callable by the API roles
  IF has_function_privilege('authenticated', 'public.sign_answers_guard()', 'EXECUTE') OR has_function_privilege('anon', 'public.sign_answers_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL sign_answers_guard must not be callable by signed-in or signed-out users';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'sign_answers_guard' AND p.prosecdef AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'FAIL sign_answers_guard must pin its search_path';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: sign_answers.value_enc exists; a sensitive row holds only ciphertext and an ordinary row never does; answers can change until the signer signs and are frozen after (a new ciphertext for the same answer and moving the row are still allowed); the guard is internal';
END
$verify$;
