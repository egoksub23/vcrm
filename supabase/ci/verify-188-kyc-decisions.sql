-- Verify migration 188 (KYC decisions: the kyc.decide capability and the access log's decision action, attempt outcome and decision column).
-- Self-contained; run against an empty database or production with 182's AND 188's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: (1) kyc.decide is in the catalogue (app tier, grantable down to agent), the owner and the admin hold it by default and an agent and a viewer do not,
-- an admin can grant it to an agent without granting kyc.view or kyc.reveal with it, and the database refuses to grant it to a viewer; (2) the access log takes
-- a 'decision' row with the decision 'approve' or 'reject' and the outcomes 'attempt', 'ok', 'error', 'not_found' and 'forbidden'; refuses a decision row with no
-- decision, a decision on any other action, a decision other than approve or reject, and still refuses an unknown action or outcome; (3) the log is still
-- append-only for the service role and still closed to every browser role, and an admin of the workspace still reads the new rows while an agent does not.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();  -- owner of workspace A
  uAd     uuid := gen_random_uuid();  -- admin of A
  uG      uuid := gen_random_uuid();  -- an agent of A
  uV      uuid := gen_random_uuid();  -- a viewer of A
  acctA   uuid;
  v_res   text;
  k       text;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      PERFORM set_config('request.jwt.claims', CASE WHEN u IS NULL THEN '' ELSE json_build_object('sub', u, 'role', r)::text END, true);
      PERFORM set_config('request.jwt.claim.sub', COALESCE(u::text, ''), true);
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

  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'  || uA  || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uAd, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ad-' || uAd || '@example.invalid', '{"full_name":"Admin"}', now()),
    (uG,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g-'  || uG  || '@example.invalid', '{"full_name":"Agent"}', now()),
    (uV,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'v-'  || uV  || '@example.invalid', '{"full_name":"Viewer"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  UPDATE profiles SET account_id = acctA, account_role = 'admin'  WHERE user_id = uAd;
  UPDATE profiles SET account_id = acctA, account_role = 'agent'  WHERE user_id = uG;
  UPDATE profiles SET account_id = acctA, account_role = 'viewer' WHERE user_id = uV;

  -- ------------------------------------------------------------
  -- 1. The capability
  -- ------------------------------------------------------------
  k := 'kyc.decide';
  IF NOT EXISTS (SELECT 1 FROM capability_catalogue WHERE capability = k AND min_grant_role = 'agent' AND enforced_by = 'app') THEN
    RAISE EXCEPTION 'FAIL % is not in the catalogue as an agent-grantable app capability', k;
  END IF;
  IF (SELECT count(*) FROM role_capability_defaults WHERE capability = k) <> 2
     OR NOT EXISTS (SELECT 1 FROM role_capability_defaults WHERE capability = k AND role = 'owner')
     OR NOT EXISTS (SELECT 1 FROM role_capability_defaults WHERE capability = k AND role = 'admin') THEN
    RAISE EXCEPTION 'FAIL % should default to the owner and the admin only', k;
  END IF;
  v_res := pg_temp.run(uA,  format($q$SELECT has_capability(%L, %L)::text$q$, acctA, k));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the owner should hold % (saw %)', k, v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT has_capability(%L, %L)::text$q$, acctA, k));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the admin should hold % (saw %)', k, v_res; END IF;
  v_res := pg_temp.run(uG,  format($q$SELECT has_capability(%L, %L)::text$q$, acctA, k));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL an agent should not hold % by default (saw %)', k, v_res; END IF;
  v_res := pg_temp.run(uV,  format($q$SELECT has_capability(%L, %L)::text$q$, acctA, k));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL a viewer should not hold % (saw %)', k, v_res; END IF;

  IF to_regproc('public.set_role_capabilities') IS NOT NULL THEN
    v_res := pg_temp.run(uA, format($q$SELECT public.set_role_capabilities(%L, 'agent'::account_role_enum, '{"kyc.decide": true}'::jsonb)::text$q$, acctA));
    IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the owner could not grant kyc.decide to the agent role: %', v_res; END IF;
    v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'kyc.decide')::text$q$, acctA));
    IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the agent did not receive the granted kyc.decide (saw %)', v_res; END IF;
    v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'kyc.view')::text$q$, acctA));
    IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL granting kyc.decide also granted kyc.view (saw %)', v_res; END IF;
    v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'kyc.reveal')::text$q$, acctA));
    IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL granting kyc.decide also granted kyc.reveal (saw %)', v_res; END IF;
    v_res := pg_temp.run(uA, format($q$SELECT public.set_role_capabilities(%L, 'viewer'::account_role_enum, '{"kyc.decide": true}'::jsonb)::text$q$, acctA));
    IF v_res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL kyc.decide could be granted to the viewer role: %', v_res; END IF;
  END IF;

  -- ------------------------------------------------------------
  -- 2. The access log takes decisions, and only well-formed ones
  -- ------------------------------------------------------------
  -- the two rows a decision writes, then the result rows of the other outcomes
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, validation_id, outcome, decision) VALUES (%L, %L, 'decision', 'child-1', '42', 'attempt', 'approve')$q$, acctA, uAd), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the service role could not write the attempt row of a decision: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, validation_id, outcome, decision) VALUES (%L, %L, 'decision', 'child-1', '42', 'ok', 'approve')$q$, acctA, uAd), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the service role could not write the result row of a decision: %', v_res; END IF;
  FOREACH k IN ARRAY ARRAY['error', 'not_found', 'forbidden'] LOOP
    v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, validation_id, outcome, decision) VALUES (%L, %L, 'decision', 'child-2', '43', %L, 'reject')$q$, acctA, uAd, k), 'service_role');
    IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a rejection with the outcome % was refused: %', k, v_res; END IF;
  END LOOP;
  -- a row of an older kind still goes in with no decision
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, outcome) VALUES (%L, %L, 'lookup', 'child-1', 'ok')$q$, acctA, uAd), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a lookup row was refused after the change: %', v_res; END IF;

  FOREACH k IN ARRAY ARRAY[
    $s$action, outcome) VALUES ('decision', 'ok')$s$,
    $s$action, outcome, decision) VALUES ('lookup', 'ok', 'approve')$s$,
    $s$action, outcome, decision) VALUES ('decision', 'ok', 'maybe')$s$,
    $s$action, outcome, decision) VALUES ('decision', 'ok', '')$s$,
    $s$action, outcome, decision) VALUES ('delete', 'ok', 'approve')$s$,
    $s$action, outcome, decision) VALUES ('decision', 'sent', 'approve')$s$,
    $s$action, outcome) VALUES ('lookup', 'attempt-ish')$s$
  ] LOOP
    v_res := pg_temp.run(NULL, format('INSERT INTO kyc_access_log (account_id, %s', replace(k, 'VALUES (', format('VALUES (%L, ', acctA))), 'service_role');
    IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL the table accepted a bad row (% -> %)', k, v_res; END IF;
  END LOOP;
  -- 'attempt' is an outcome of any action (the check is on the column), but the wording of the others is unchanged
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, action, outcome) VALUES (%L, 'config_error', 'error')$q$, acctA), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a config_error row was refused after the change: %', v_res; END IF;

  -- ------------------------------------------------------------
  -- 3. Still closed to browsers, still append-only
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uA, format($q$SELECT count(*)::text FROM kyc_access_log WHERE action = 'decision' AND account_id = %L$q$, acctA));
  IF v_res <> '5' THEN RAISE EXCEPTION 'FAIL the owner should read the 5 decision rows of workspace A (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, $q$SELECT count(*)::text FROM kyc_access_log WHERE decision = 'reject'$q$);
  IF v_res <> '3' THEN RAISE EXCEPTION 'FAIL the admin should read the 3 rejections (saw %)', v_res; END IF;
  v_res := pg_temp.run(uG, 'SELECT count(*)::text FROM kyc_access_log');
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL an agent read the access log (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, 'SELECT count(*)::text FROM kyc_access_log');
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer read the access log (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, outcome, decision) VALUES (%L, %L, 'decision', 'ok', 'approve')$q$, acctA, uAd));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an admin could write a decision row from the browser (saw %)', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$UPDATE kyc_access_log SET decision = 'reject' WHERE account_id = %L$q$, acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner could change a decision from the browser (saw %)', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$UPDATE kyc_access_log SET decision = 'reject' WHERE account_id = %L$q$, acctA), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%append-only%' THEN RAISE EXCEPTION 'FAIL the service role could change a decision row (saw %)', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$DELETE FROM kyc_access_log WHERE account_id = %L$q$, acctA), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%append-only%' THEN RAISE EXCEPTION 'FAIL the service role could delete a decision row (saw %)', v_res; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: kyc.decide, decision rows and the append-only log all check out';
END
$verify$;
