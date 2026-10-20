-- Verify migration 192 (KYC review: the access log's 'amend' action, for a rejected ID check that is amended and approved).
-- Self-contained; run against an empty database or production with 182's, 188's and 192's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: the log takes an 'amend' row with the decision 'approve' and the outcomes 'attempt', 'ok', 'error' and 'not_found'; refuses an amendment that
-- rejects, one with no decision, and a decision on any action that is neither a decision nor an amendment; still takes every row the 188 verify takes; and
-- is still append-only for the service role and closed to every browser role.
DO $verify$
DECLARE
  uA    uuid := gen_random_uuid();
  uAd   uuid := gen_random_uuid();
  acctA uuid;
  v_res text;
  k     text;
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
    (uAd, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ad-' || uAd || '@example.invalid', '{"full_name":"Admin"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  UPDATE profiles SET account_id = acctA, account_role = 'admin' WHERE user_id = uAd;

  -- the two rows an amendment writes, then the result rows of the other outcomes
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, validation_id, outcome, decision) VALUES (%L, %L, 'amend', 'child-1', '42', 'attempt', 'approve')$q$, acctA, uAd), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the service role could not write the attempt row of an amendment: %', v_res; END IF;
  FOREACH k IN ARRAY ARRAY['ok', 'error', 'not_found', 'forbidden'] LOOP
    v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, validation_id, outcome, decision) VALUES (%L, %L, 'amend', 'child-1', '42', %L, 'approve')$q$, acctA, uAd, k), 'service_role');
    IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL an amendment with the outcome % was refused: %', k, v_res; END IF;
  END LOOP;

  -- what it must refuse
  FOREACH k IN ARRAY ARRAY[
    $s$action, outcome, decision) VALUES ('amend', 'ok', 'reject')$s$,
    $s$action, outcome) VALUES ('amend', 'ok')$s$,
    $s$action, outcome, decision) VALUES ('amend', 'ok', 'maybe')$s$,
    $s$action, outcome, decision) VALUES ('lookup', 'ok', 'approve')$s$,
    $s$action, outcome, decision) VALUES ('amended', 'ok', 'approve')$s$
  ] LOOP
    v_res := pg_temp.run(NULL, format('INSERT INTO kyc_access_log (account_id, %s', replace(k, 'VALUES (', format('VALUES (%L, ', acctA))), 'service_role');
    IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL the table accepted a bad row (% -> %)', k, v_res; END IF;
  END LOOP;

  -- everything that went in before still goes in
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, validation_id, outcome, decision) VALUES (%L, %L, 'decision', 'child-1', '42', 'ok', 'reject')$q$, acctA, uAd), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a rejection row was refused after the change: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, outcome) VALUES (%L, %L, 'lookup', 'child-1', 'ok')$q$, acctA, uAd), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a lookup row was refused after the change: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, action, outcome, decision) VALUES (%L, 'decision', 'ok', NULL)$q$, acctA), 'service_role');
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a decision row with no decision was accepted (saw %)', v_res; END IF;

  -- still closed to browsers, still append-only
  v_res := pg_temp.run(uAd, format($q$SELECT count(*)::text FROM kyc_access_log WHERE action = 'amend' AND account_id = %L$q$, acctA));
  IF v_res <> '5' THEN RAISE EXCEPTION 'FAIL the admin should read the 5 amendment rows (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, outcome, decision) VALUES (%L, %L, 'amend', 'ok', 'approve')$q$, acctA, uAd));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an admin could write an amendment row from the browser (saw %)', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$UPDATE kyc_access_log SET outcome = 'error' WHERE account_id = %L AND action = 'amend'$q$, acctA), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%append-only%' THEN RAISE EXCEPTION 'FAIL the service role could change an amendment row (saw %)', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$DELETE FROM kyc_access_log WHERE account_id = %L$q$, acctA), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%append-only%' THEN RAISE EXCEPTION 'FAIL the service role could delete an amendment row (saw %)', v_res; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: the access log takes an amend row that approves (attempt, ok, error, not_found, forbidden), refuses one that rejects or has no decision, still takes every older row, and stays append-only and closed to browsers';
END
$verify$;
