-- Verify migration 186 (Compliance requests: "does this bank account belong to you?" on the closure and withdrawal types).
-- Self-contained; run against an empty database or production with the text of 183, 184, 185 and 186 in front when they are not applied yet (182 before 183).
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Written against the REAL schema: it creates its workspaces through the signup path (auth.users), so the seed trigger is what puts the types and fields
-- there, and the one case it makes is inserted with the columns every case has. Nothing here deletes a contact or a conversation.
--
-- Proves: (1) a workspace made after the migration has the question bank_account_is_own on the closure and withdrawal types: one field, a yes/no, required,
-- not sensitive, in four languages, right before the bank name; the other types do not get it; (2) the authorization letter is conditional (asked while
-- the answer is false: showIf bank_account_is_own in ["false"]) and required, with the new words; (3) running the function again changes nothing; (4) an
-- administrator's edit survives (the question's words; a letter that already has its own condition and its own words); a field that was lost comes back in
-- the right place (before the bank name, or at the end when there is no bank name); (5) a workspace as 183 and 184 left it (no question, an unconditional
-- optional letter with 183's words) is brought up to date, and a letter with the administrator's own words keeps them while becoming conditional; (6) a case
-- that already exists is not rewritten; (7) the function is not callable by a browser role and pins its search_path; the seed function still seeds the three
-- types, the intake fields, the account change fields and the question.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();  -- owner of workspace A (made after the migration: the seed trigger gives it the question)
  uB      uuid := gen_random_uuid();  -- owner of workspace B (turned back into a workspace as 183 and 184 left it)
  acctA   uuid;
  acctB   uuid;
  r1      uuid := gen_random_uuid();
  v_before jsonb;
  v_after  jsonb;
  v_data   jsonb;
  v_n      int;
  v_pos    int;
  v_bank   int;
  k        text;
  t        text;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.pos(p_acct uuid, p_type text, p_key text) RETURNS int LANGUAGE sql AS $b$
      SELECT e.ord::int FROM compliance_request_types t, jsonb_array_elements(t.fields) WITH ORDINALITY AS e(f, ord)
       WHERE t.account_id = p_acct AND t.key = p_type AND e.f ->> 'key' = p_key
    $b$;
  $f$;
  EXECUTE $f$
    CREATE FUNCTION pg_temp.fld(p_acct uuid, p_type text, p_key text) RETURNS jsonb LANGUAGE sql AS $b$
      SELECT e.f FROM compliance_request_types t, jsonb_array_elements(t.fields) AS e(f)
       WHERE t.account_id = p_acct AND t.key = p_type AND e.f ->> 'key' = p_key
    $b$;
  $f$;
  EXECUTE $f$
    CREATE FUNCTION pg_temp.cnt(p_acct uuid, p_type text, p_key text) RETURNS int LANGUAGE sql AS $b$
      SELECT count(*)::int FROM compliance_request_types t, jsonb_array_elements(t.fields) AS e(f)
       WHERE t.account_id = p_acct AND t.key = p_type AND e.f ->> 'key' = p_key
    $b$;
  $f$;

  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;

  -- ------------------------------------------------------------
  -- 1. The question on a workspace made after the migration (through the seed trigger)
  -- ------------------------------------------------------------
  FOREACH t IN ARRAY ARRAY['closure', 'withdrawal'] LOOP
    IF pg_temp.cnt(acctA, t, 'bank_account_is_own') <> 1 THEN RAISE EXCEPTION 'FAIL the % type of a new workspace does not have exactly one bank_account_is_own', t; END IF;
    IF NOT EXISTS (SELECT 1 FROM compliance_request_types ty, jsonb_array_elements(ty.fields) f
                    WHERE ty.account_id = acctA AND ty.key = t AND f ->> 'key' = 'bank_account_is_own' AND f ->> 'type' = 'yesno'
                      AND (f ->> 'required') = 'true' AND (f ->> 'sensitive') = 'false' AND NOT (f ? 'showIf')
                      AND f -> 'label' ? 'en' AND f -> 'label' ? 'ms' AND f -> 'label' ? 'zh' AND f -> 'label' ? 'ko'
                      AND f #>> '{label,en}' = 'Does this bank account belong to you, the Vircle account holder?') THEN
      RAISE EXCEPTION 'FAIL the question on % is not a required, non-sensitive yes/no with four languages: %', t, pg_temp.fld(acctA, t, 'bank_account_is_own');
    END IF;
    v_pos := pg_temp.pos(acctA, t, 'bank_account_is_own');
    v_bank := pg_temp.pos(acctA, t, 'bank_name');
    IF v_pos IS NULL OR v_bank IS NULL OR v_pos <> v_bank - 1 THEN RAISE EXCEPTION 'FAIL the question is not right before the bank name on % (at % / bank name at %)', t, v_pos, v_bank; END IF;
  END LOOP;
  IF pg_temp.cnt(acctA, 'phone_change', 'bank_account_is_own') <> 0 THEN RAISE EXCEPTION 'FAIL the account change type got the bank question'; END IF;
  -- nothing else on the two types was added or lost: 183 and 184 left closure with 9 fields and withdrawal with 10
  SELECT jsonb_array_length(fields) INTO v_n FROM compliance_request_types WHERE account_id = acctA AND key = 'closure';
  IF v_n <> 10 THEN RAISE EXCEPTION 'FAIL the closure type has % fields (expected 9 plus the question)', v_n; END IF;
  SELECT jsonb_array_length(fields) INTO v_n FROM compliance_request_types WHERE account_id = acctA AND key = 'withdrawal';
  IF v_n <> 11 THEN RAISE EXCEPTION 'FAIL the withdrawal type has % fields (expected 10 plus the question)', v_n; END IF;
  IF (SELECT count(*) FROM compliance_request_types WHERE account_id = acctA AND is_system) <> 3 THEN RAISE EXCEPTION 'FAIL a new workspace does not have exactly the three system types'; END IF;

  -- ------------------------------------------------------------
  -- 2. The letter is conditional and required, with the new words, on both types
  -- ------------------------------------------------------------
  FOREACH t IN ARRAY ARRAY['closure', 'withdrawal'] LOOP
    IF NOT EXISTS (SELECT 1 FROM compliance_request_types ty, jsonb_array_elements(ty.fields) f
                    WHERE ty.account_id = acctA AND ty.key = t AND f ->> 'key' = 'authorization_letter' AND f ->> 'type' = 'file'
                      AND (f ->> 'required') = 'true' AND f #>> '{showIf,field}' = 'bank_account_is_own'
                      AND f #> '{showIf,in}' = '["false"]'::jsonb
                      AND f #>> '{label,en}' = 'Authorization letter (signed by the bank account holder; needed when the bank account is not yours)'
                      AND f -> 'label' ? 'ms' AND f -> 'label' ? 'zh' AND f -> 'label' ? 'ko') THEN
      RAISE EXCEPTION 'FAIL the authorization letter on % is not conditional and required with the new words: %', t, pg_temp.fld(acctA, t, 'authorization_letter');
    END IF;
  END LOOP;
  -- the bank holder name stays required and protected
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types ty, jsonb_array_elements(ty.fields) f
                  WHERE ty.account_id = acctA AND ty.key = 'closure' AND f ->> 'key' = 'bank_account_holder' AND (f ->> 'required') = 'true' AND (f ->> 'sensitive') = 'true') THEN
    RAISE EXCEPTION 'FAIL the bank account holder name is no longer required and protected';
  END IF;

  -- ------------------------------------------------------------
  -- 3. Idempotent
  -- ------------------------------------------------------------
  SELECT jsonb_agg(fields ORDER BY key) INTO v_before FROM compliance_request_types WHERE account_id = acctA;
  PERFORM public.compliance_bank_own_fields(acctA);
  PERFORM public.compliance_bank_own_fields(acctA);
  SELECT jsonb_agg(fields ORDER BY key) INTO v_after FROM compliance_request_types WHERE account_id = acctA;
  IF v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'FAIL running the function again changed the fields'; END IF;

  -- ------------------------------------------------------------
  -- 4. An administrator's edit survives; a lost field comes back in the right place
  -- ------------------------------------------------------------
  UPDATE compliance_request_types
     SET fields = (SELECT jsonb_agg(CASE WHEN f ->> 'key' = 'bank_account_is_own' THEN jsonb_set(f, '{label,en}', '"Admin words for the question"')
                                         WHEN f ->> 'key' = 'authorization_letter' THEN jsonb_set(jsonb_set(f, '{label,en}', '"Admin words for the letter"'), '{showIf}', '{"field":"reason","in":["x"]}')
                                         ELSE f END ORDER BY ord)
                     FROM jsonb_array_elements(fields) WITH ORDINALITY AS e(f, ord))
   WHERE account_id = acctA AND key = 'closure';
  UPDATE compliance_request_types
     SET fields = (SELECT jsonb_agg(CASE WHEN f ->> 'key' = 'authorization_letter' THEN f || '{"required": false}'::jsonb ELSE f END ORDER BY ord) FROM jsonb_array_elements(fields) WITH ORDINALITY AS e(f, ord))
   WHERE account_id = acctA AND key = 'closure';
  PERFORM public.compliance_bank_own_fields(acctA);
  IF pg_temp.cnt(acctA, 'closure', 'bank_account_is_own') <> 1 OR pg_temp.fld(acctA, 'closure', 'bank_account_is_own') #>> '{label,en}' <> 'Admin words for the question' THEN
    RAISE EXCEPTION 'FAIL running the function again overwrote or duplicated an administrator''s question';
  END IF;
  IF pg_temp.fld(acctA, 'closure', 'authorization_letter') #>> '{label,en}' <> 'Admin words for the letter'
     OR pg_temp.fld(acctA, 'closure', 'authorization_letter') #>> '{showIf,field}' <> 'reason'
     OR (pg_temp.fld(acctA, 'closure', 'authorization_letter') ->> 'required') <> 'false' THEN
    RAISE EXCEPTION 'FAIL running the function again overwrote an administrator''s letter condition or words: %', pg_temp.fld(acctA, 'closure', 'authorization_letter');
  END IF;
  -- a lost question comes back right before the bank name
  UPDATE compliance_request_types
     SET fields = (SELECT jsonb_agg(f ORDER BY ord) FROM jsonb_array_elements(fields) WITH ORDINALITY AS e(f, ord) WHERE f ->> 'key' <> 'bank_account_is_own')
   WHERE account_id = acctA AND key = 'withdrawal';
  PERFORM public.compliance_bank_own_fields(acctA);
  IF pg_temp.cnt(acctA, 'withdrawal', 'bank_account_is_own') <> 1 OR pg_temp.pos(acctA, 'withdrawal', 'bank_account_is_own') <> pg_temp.pos(acctA, 'withdrawal', 'bank_name') - 1 THEN
    RAISE EXCEPTION 'FAIL a type that lost the question did not get it back right before the bank name';
  END IF;
  -- a type without a bank name field gets it at the end
  UPDATE compliance_request_types
     SET fields = (SELECT jsonb_agg(f ORDER BY ord) FROM jsonb_array_elements(fields) WITH ORDINALITY AS e(f, ord) WHERE f ->> 'key' NOT IN ('bank_account_is_own', 'bank_name'))
   WHERE account_id = acctA AND key = 'withdrawal';
  PERFORM public.compliance_bank_own_fields(acctA);
  SELECT jsonb_array_length(fields) INTO v_n FROM compliance_request_types WHERE account_id = acctA AND key = 'withdrawal';
  IF pg_temp.pos(acctA, 'withdrawal', 'bank_account_is_own') <> v_n THEN RAISE EXCEPTION 'FAIL the question was not added at the end of a type with no bank name field'; END IF;

  -- ------------------------------------------------------------
  -- 5. A workspace as 183 and 184 left it is brought up to date
  -- ------------------------------------------------------------
  UPDATE compliance_request_types
     SET fields = (SELECT jsonb_agg(CASE WHEN f ->> 'key' = 'authorization_letter'
                                         THEN (f - 'showIf') || jsonb_build_object('required', false, 'label', public.compliance_label(
                                                'Authorization letter (needed when the bank account holder name differs)',
                                                'Surat kebenaran (diperlukan jika nama pemegang akaun bank berbeza)',
                                                '授权书（银行账户持有人姓名不同时需要）',
                                                '위임장(은행 계좌 예금주 이름이 다를 때 필요)'))
                                         ELSE f END ORDER BY ord)
                     FROM jsonb_array_elements(fields) WITH ORDINALITY AS e(f, ord) WHERE f ->> 'key' <> 'bank_account_is_own')
   WHERE account_id = acctB AND key = 'closure';
  -- (withdrawal: the letter was edited by an administrator and has no condition)
  UPDATE compliance_request_types
     SET fields = (SELECT jsonb_agg(CASE WHEN f ->> 'key' = 'authorization_letter'
                                         THEN (f - 'showIf') || jsonb_build_object('required', false, 'label', jsonb_build_object('en', 'Our own letter words'))
                                         ELSE f END ORDER BY ord)
                     FROM jsonb_array_elements(fields) WITH ORDINALITY AS e(f, ord) WHERE f ->> 'key' <> 'bank_account_is_own')
   WHERE account_id = acctB AND key = 'withdrawal';
  IF pg_temp.cnt(acctB, 'closure', 'bank_account_is_own') <> 0 OR pg_temp.cnt(acctB, 'withdrawal', 'bank_account_is_own') <> 0 THEN RAISE EXCEPTION 'FAIL the test could not put workspace B back as it was before the migration'; END IF;
  -- a case that already exists, made under the old definitions
  INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name, customer_email, data) VALUES (r1, acctB, 'closure', 'staff', 'Before 186', 'before186@example.invalid', '{"reason":"Moving abroad"}');

  PERFORM public.compliance_bank_own_fields(acctB);
  PERFORM public.compliance_bank_own_fields(acctB);
  FOREACH t IN ARRAY ARRAY['closure', 'withdrawal'] LOOP
    IF pg_temp.cnt(acctB, t, 'bank_account_is_own') <> 1 OR pg_temp.pos(acctB, t, 'bank_account_is_own') <> pg_temp.pos(acctB, t, 'bank_name') - 1 THEN
      RAISE EXCEPTION 'FAIL workspace B did not get the question right before the bank name on %', t;
    END IF;
    IF NOT ((pg_temp.fld(acctB, t, 'authorization_letter') ->> 'required') = 'true' AND pg_temp.fld(acctB, t, 'authorization_letter') #> '{showIf,in}' = '["false"]'::jsonb
            AND pg_temp.fld(acctB, t, 'authorization_letter') #>> '{showIf,field}' = 'bank_account_is_own') THEN
      RAISE EXCEPTION 'FAIL workspace B''s letter on % did not become conditional and required: %', t, pg_temp.fld(acctB, t, 'authorization_letter');
    END IF;
  END LOOP;
  IF pg_temp.fld(acctB, 'closure', 'authorization_letter') #>> '{label,en}' <> 'Authorization letter (signed by the bank account holder; needed when the bank account is not yours)' THEN
    RAISE EXCEPTION 'FAIL the letter that still had 183''s words did not get the new words';
  END IF;
  IF pg_temp.fld(acctB, 'withdrawal', 'authorization_letter') #>> '{label,en}' <> 'Our own letter words' THEN
    RAISE EXCEPTION 'FAIL a letter with the administrator''s own words lost them';
  END IF;

  -- ------------------------------------------------------------
  -- 6. A case that already exists is not rewritten
  -- ------------------------------------------------------------
  SELECT data INTO v_data FROM compliance_requests WHERE id = r1;
  IF v_data IS DISTINCT FROM '{"reason":"Moving abroad"}'::jsonb THEN RAISE EXCEPTION 'FAIL an existing case was rewritten: %', v_data; END IF;

  -- ------------------------------------------------------------
  -- 7. Privileges, search_path, the seed
  -- ------------------------------------------------------------
  FOREACH k IN ARRAY ARRAY['compliance_bank_own_fields(uuid)', 'compliance_accounts_seed()'] LOOP
    IF has_function_privilege('anon', k, 'EXECUTE') OR has_function_privilege('authenticated', k, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL a browser role can call %', k; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = k::regprocedure AND (NOT p.prosecdef OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%'))) THEN
      RAISE EXCEPTION 'FAIL % is not a security definer function with a pinned search_path', k;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'compliance_bank_own_fields(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL the service role cannot call compliance_bank_own_fields'; END IF;
  IF pg_get_functiondef('public.compliance_accounts_seed()'::regprocedure) NOT LIKE '%compliance_seed_types%'
     OR pg_get_functiondef('public.compliance_accounts_seed()'::regprocedure) NOT LIKE '%compliance_intake_fields%'
     OR pg_get_functiondef('public.compliance_accounts_seed()'::regprocedure) NOT LIKE '%compliance_account_change_fields%'
     OR pg_get_functiondef('public.compliance_accounts_seed()'::regprocedure) NOT LIKE '%compliance_bank_own_fields%' THEN
    RAISE EXCEPTION 'FAIL the seed function no longer seeds the types, the intake fields, the account change fields and the bank question';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: a workspace made after the migration has the bank_account_is_own yes/no (required, not protected, four languages, right before the bank name, on closure and withdrawal only) and a conditional required authorization letter with the new words; running the function again changes nothing; an administrator''s question words and a letter with its own condition or words survive; a lost question comes back before the bank name (at the end when there is no bank name); a workspace as 183 and 184 left it is brought up to date while a letter with the administrator''s own words keeps them; an existing case is not rewritten; no browser role reaches the function and it pins its search_path; the seed function still seeds all four things';
END
$verify$;
