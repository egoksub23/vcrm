-- Verify migration 194 (Compliance requests: the Transaction fraud review type).
-- Self-contained; run against an empty database or production with the text of 183 to 186 and 194 in front when they are not applied yet (182 before 183).
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Written against the REAL schema: it creates its workspaces through the signup path (auth.users), so the seed trigger is what puts the type there.
--
-- Proves: (1) a workspace made after the migration has the type fraud_review: an ordinary (not system) type, active, position 4, clocks 7 and 30 days, an
-- identity check, no dues check, no pause; (2) its fields, in order, with their kinds: exactly five required (the kind of fraud, the transaction reference,
-- the date, the amount, what happened), exactly one sensitive (the recipient's account), two file fields (the customer's screenshots and the investigation's
-- evidence), two choices with options, every label and option in four languages, the investigation fields all optional; (3) its checklist of five steps;
-- (4) a case of the type takes the clocks and the checklist from it and has its creation event; (5) running the function again changes nothing, and an
-- administrator's edit, and a type switched off, survive; (6) a workspace that lost the type gets it back and its other types are untouched; (7) the
-- function is not callable by a browser role and pins its search_path; the seed trigger still seeds every earlier part and now this type; (8) a type of
-- another workspace is not touched.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();
  uB      uuid := gen_random_uuid();
  acctA   uuid;
  acctB   uuid;
  r1      uuid := gen_random_uuid();
  v_res   text;
  v_n     int;
  v_t     compliance_request_types%ROWTYPE;
  k       text;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(q TEXT, r TEXT DEFAULT 'service_role') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      PERFORM set_config('request.jwt.claims', '', true);
      EXECUTE format('SET LOCAL ROLE %I', r);
      BEGIN
        IF q ~* '^\s*(select|with)' THEN EXECUTE q INTO res; ELSE EXECUTE q; END IF;
        res := COALESCE(res, 'OK');
      EXCEPTION WHEN OTHERS THEN
        res := 'ERR ' || SQLSTATE || ': ' || SQLERRM;
      END;
      EXECUTE 'RESET ROLE';
      RETURN res;
    END $b$;
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
  -- 1. The type on a workspace made after the migration (through the seed trigger)
  -- ------------------------------------------------------------
  SELECT count(*) INTO v_n FROM compliance_request_types WHERE account_id = acctA AND key = 'fraud_review';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL a new workspace has % fraud_review types, not 1', v_n; END IF;
  SELECT * INTO v_t FROM compliance_request_types WHERE account_id = acctA AND key = 'fraud_review';
  IF v_t.is_system OR NOT v_t.active OR v_t.position <> 4 OR v_t.target_days <> 7 OR v_t.hard_stop_days <> 30
     OR NOT v_t.requires_identity_check OR v_t.check_dues OR v_t.allow_pause OR v_t.label <> 'Transaction fraud review'
     OR NOT (v_t.label_l10n ? 'ms' AND v_t.label_l10n ? 'zh' AND v_t.label_l10n ? 'ko') THEN
    RAISE EXCEPTION 'FAIL the type is not as designed: %', to_jsonb(v_t);
  END IF;
  SELECT count(*) INTO v_n FROM compliance_request_types WHERE account_id = acctA AND is_system;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL the workspace should still have exactly its three system types (has %)', v_n; END IF;

  -- ------------------------------------------------------------
  -- 2. The fields
  -- ------------------------------------------------------------
  IF (SELECT array_agg(f ->> 'key' ORDER BY ord) FROM compliance_request_types t, jsonb_array_elements(t.fields) WITH ORDINALITY e(f, ord)
       WHERE t.account_id = acctA AND t.key = 'fraud_review')
     <> ARRAY['fraud_kind', 'transaction_ref', 'transaction_date', 'amount', 'customer_wallet_id', 'recipient_name', 'recipient_account', 'description',
              'police_report', 'screenshots', 'investigation_findings', 'investigation_outcome', 'amount_recovered', 'action_taken', 'investigation_files'] THEN
    RAISE EXCEPTION 'FAIL the fields are not the designed ones, in order';
  END IF;
  IF (SELECT array_agg(f ->> 'key' ORDER BY f ->> 'key') FROM compliance_request_types t, jsonb_array_elements(t.fields) f
       WHERE t.account_id = acctA AND t.key = 'fraud_review' AND (f ->> 'required') = 'true')
     <> ARRAY['amount', 'description', 'fraud_kind', 'transaction_date', 'transaction_ref'] THEN
    RAISE EXCEPTION 'FAIL the required fields are not exactly kind, reference, date, amount and what happened';
  END IF;
  IF (SELECT array_agg(f ->> 'key') FROM compliance_request_types t, jsonb_array_elements(t.fields) f
       WHERE t.account_id = acctA AND t.key = 'fraud_review' AND (f ->> 'sensitive') = 'true') <> ARRAY['recipient_account'] THEN
    RAISE EXCEPTION 'FAIL exactly the recipient account should be sensitive';
  END IF;
  IF (SELECT array_agg(f ->> 'key' ORDER BY f ->> 'key') FROM compliance_request_types t, jsonb_array_elements(t.fields) f
       WHERE t.account_id = acctA AND t.key = 'fraud_review' AND f ->> 'type' = 'file') <> ARRAY['investigation_files', 'screenshots'] THEN
    RAISE EXCEPTION 'FAIL the two file fields are not the screenshots and the investigation evidence';
  END IF;
  IF (SELECT array_agg(f ->> 'key' ORDER BY f ->> 'key') FROM compliance_request_types t, jsonb_array_elements(t.fields) f
       WHERE t.account_id = acctA AND t.key = 'fraud_review' AND f ->> 'type' = 'choice' AND jsonb_array_length(f -> 'options') >= 3) <> ARRAY['fraud_kind', 'investigation_outcome'] THEN
    RAISE EXCEPTION 'FAIL the two choices do not have their options';
  END IF;
  -- every label, help and option in four languages
  FOR k IN
    SELECT COALESCE(f ->> 'key', '?') FROM compliance_request_types t, jsonb_array_elements(t.fields) f
     WHERE t.account_id = acctA AND t.key = 'fraud_review'
       AND NOT (f -> 'label' ? 'en' AND f -> 'label' ? 'ms' AND f -> 'label' ? 'zh' AND f -> 'label' ? 'ko')
  LOOP RAISE EXCEPTION 'FAIL the label of % is not in four languages', k; END LOOP;
  FOR k IN
    SELECT COALESCE(f ->> 'key', '?') FROM compliance_request_types t, jsonb_array_elements(t.fields) f
     WHERE t.account_id = acctA AND t.key = 'fraud_review' AND f ? 'help'
       AND NOT (f -> 'help' ? 'en' AND f -> 'help' ? 'ms' AND f -> 'help' ? 'zh' AND f -> 'help' ? 'ko')
  LOOP RAISE EXCEPTION 'FAIL the help of % is not in four languages', k; END LOOP;
  IF EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f, jsonb_array_elements(f -> 'options') o
              WHERE t.account_id = acctA AND t.key = 'fraud_review'
                AND NOT (o -> 'label' ? 'en' AND o -> 'label' ? 'ms' AND o -> 'label' ? 'zh' AND o -> 'label' ? 'ko')) THEN
    RAISE EXCEPTION 'FAIL an option is not in four languages';
  END IF;
  -- no field of this type is conditional or asks for a secret type it cannot hold
  IF EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f
              WHERE t.account_id = acctA AND t.key = 'fraud_review' AND f ? 'showIf') THEN
    RAISE EXCEPTION 'FAIL a field is conditional';
  END IF;

  -- ------------------------------------------------------------
  -- 3. The checklist
  -- ------------------------------------------------------------
  IF (SELECT array_agg(c ->> 'key' ORDER BY ord) FROM compliance_request_types t, jsonb_array_elements(t.checklist) WITH ORDINALITY e(c, ord)
       WHERE t.account_id = acctA AND t.key = 'fraud_review')
     <> ARRAY['preserve_evidence', 'restrict_account', 'recall_funds', 'report_authorities', 'confirm_customer'] THEN
    RAISE EXCEPTION 'FAIL the checklist is not the five designed steps';
  END IF;

  -- ------------------------------------------------------------
  -- 4. A case of the type
  -- ------------------------------------------------------------
  v_res := pg_temp.run(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name, customer_phone, data)
                                   VALUES (%L, %L, 'fraud_review', 'staff', 'Reporter One', '+60123456789', '{"fraud_kind":"scam","transaction_ref":"TX-1","amount":250}')$q$, r1, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not create a case of the type: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r1 AND status = 'received' AND target_days = 7 AND hard_stop_days = 30
                   AND target_due_at = received_at + interval '7 days' AND hard_stop_at = received_at + interval '30 days'
                   AND retention_until >= received_at + interval '7 years' - interval '1 minute') THEN
    RAISE EXCEPTION 'FAIL the case has wrong clocks or retention';
  END IF;
  IF (SELECT count(*) FROM compliance_request_checklist WHERE request_id = r1) <> 5
     OR NOT EXISTS (SELECT 1 FROM compliance_request_checklist WHERE request_id = r1 AND step_key = 'recall_funds' AND label LIKE 'Ask the bank%' AND label_l10n ? 'ms') THEN
    RAISE EXCEPTION 'FAIL the checklist was not copied onto the case';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'created') THEN
    RAISE EXCEPTION 'FAIL the case has no creation event';
  END IF;

  -- ------------------------------------------------------------
  -- 5. Idempotent; an administrator's edit and a deactivation survive
  -- ------------------------------------------------------------
  v_res := pg_temp.run(format($q$UPDATE compliance_request_types SET label = 'Fraud report', active = FALSE, target_days = 3 WHERE account_id = %L AND key = 'fraud_review'$q$, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL an administrator could not edit the type: %', v_res; END IF;
  v_res := pg_temp.run(format($q$SELECT public.compliance_fraud_review_type(%L)::text$q$, acctA));
  IF v_res NOT IN ('OK', '') THEN RAISE EXCEPTION 'FAIL the function failed when run again: %', v_res; END IF;
  SELECT * INTO v_t FROM compliance_request_types WHERE account_id = acctA AND key = 'fraud_review';
  IF v_t.label <> 'Fraud report' OR v_t.active OR v_t.target_days <> 3 THEN
    RAISE EXCEPTION 'FAIL running the function again overwrote an administrator''s edit: %', to_jsonb(v_t);
  END IF;
  SELECT count(*) INTO v_n FROM compliance_request_types WHERE account_id = acctA AND key = 'fraud_review';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL running the function again made % copies', v_n; END IF;

  -- ------------------------------------------------------------
  -- 6. A workspace that lost the type gets it back; its other types stay as they are
  -- ------------------------------------------------------------
  v_res := pg_temp.run(format($q$DELETE FROM compliance_request_types WHERE account_id = %L AND key = 'fraud_review'$q$, acctB));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not remove the type from workspace B: %', v_res; END IF;
  IF EXISTS (SELECT 1 FROM compliance_request_types WHERE account_id = acctB AND key = 'fraud_review') THEN RAISE EXCEPTION 'FAIL the type was not removed from B'; END IF;
  PERFORM public.compliance_fraud_review_type(acctB);
  IF (SELECT count(*) FROM compliance_request_types WHERE account_id = acctB AND key = 'fraud_review' AND NOT is_system AND active AND target_days = 7) <> 1 THEN
    RAISE EXCEPTION 'FAIL workspace B did not get the type back';
  END IF;
  IF (SELECT count(*) FROM compliance_request_types WHERE account_id = acctB AND is_system) <> 3 THEN RAISE EXCEPTION 'FAIL the system types of B changed'; END IF;
  -- (8) workspace A's edit is not in B
  IF EXISTS (SELECT 1 FROM compliance_request_types WHERE account_id = acctB AND label = 'Fraud report') THEN RAISE EXCEPTION 'FAIL an edit of A reached B'; END IF;

  -- ------------------------------------------------------------
  -- 7. Who may call it; the seed trigger
  -- ------------------------------------------------------------
  FOREACH k IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    v_res := pg_temp.run(format($q$SELECT public.compliance_fraud_review_type(%L)::text$q$, acctA), k);
    IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the role % can call the function (saw %)', k, v_res; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'compliance_fraud_review_type' AND p.prosecdef AND 'search_path=public' = ANY (p.proconfig)) THEN
    RAISE EXCEPTION 'FAIL the function is not SECURITY DEFINER with a pinned search_path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'compliance_accounts_seed'
                   AND p.prosrc LIKE '%compliance_seed_types%' AND p.prosrc LIKE '%compliance_intake_fields%' AND p.prosrc LIKE '%compliance_account_change_fields%'
                   AND p.prosrc LIKE '%compliance_bank_own_fields%' AND p.prosrc LIKE '%compliance_fraud_review_type%') THEN
    RAISE EXCEPTION 'FAIL the seed trigger does not seed every part, including the new type';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: the Transaction fraud review type is seeded as an editable type (fifteen fields in order, five required, one sensitive, two file fields, four languages everywhere, five steps, 7 and 30 days), a case takes its clocks and checklist, running it again overwrites nothing, a lost type comes back, browsers cannot call it, and the seed trigger includes it';
END
$verify$;
