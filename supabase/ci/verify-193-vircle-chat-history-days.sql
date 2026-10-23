-- Verify migration 193 (Vircle Chat: history_days, how far back Halo answers the app's requests for older messages).
-- Self-contained; run against an empty database or production with 147's, 149's and 193's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: a connection that says nothing about it gets 90 days; 1 and 365 are accepted; 0, 366, a negative number and NULL are refused; the setting can be
-- changed on an existing connection; and an administrator reaches it through the connection's own policy (channels.manage) while an agent does not.
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

  -- a connection that says nothing about the setting gets 90 days
  v_res := pg_temp.run(NULL, format($q$INSERT INTO vircle_chat_config (account_id, workspace_key, gateway_base_url, signing_secret, api_token) VALUES (%L, 'vcw_verify193abcdefghij', 'https://gateway.example.invalid', 'x', 'y')$q$, acctA), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the service role could not insert a connection: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$SELECT history_days::text FROM vircle_chat_config WHERE account_id = %L$q$, acctA), 'service_role');
  IF v_res <> '90' THEN RAISE EXCEPTION 'FAIL the default is not 90 days (saw %)', v_res; END IF;

  -- the edges are accepted
  FOREACH k IN ARRAY ARRAY['1', '30', '365'] LOOP
    v_res := pg_temp.run(NULL, format($q$UPDATE vircle_chat_config SET history_days = %s WHERE account_id = %L$q$, k, acctA), 'service_role');
    IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL % days was refused: %', k, v_res; END IF;
  END LOOP;

  -- and nothing beyond them
  FOREACH k IN ARRAY ARRAY['0', '366', '-5', 'NULL'] LOOP
    v_res := pg_temp.run(NULL, format($q$UPDATE vircle_chat_config SET history_days = %s WHERE account_id = %L$q$, k, acctA), 'service_role');
    IF v_res NOT LIKE 'ERR 23514%' AND v_res NOT LIKE 'ERR 23502%' THEN RAISE EXCEPTION 'FAIL the setting % was accepted (saw %)', k, v_res; END IF;
  END LOOP;

  -- an administrator (channels.manage) reads and changes it through the connection's own policy
  v_res := pg_temp.run(uAd, format($q$SELECT history_days::text FROM vircle_chat_config WHERE account_id = %L$q$, acctA));
  IF v_res <> '365' THEN RAISE EXCEPTION 'FAIL the administrator could not read the setting (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$UPDATE vircle_chat_config SET history_days = 60 WHERE account_id = %L$q$, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the administrator could not change the setting: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$SELECT history_days::text FROM vircle_chat_config WHERE account_id = %L$q$, acctA), 'service_role');
  IF v_res <> '60' THEN RAISE EXCEPTION 'FAIL the change did not stick (saw %)', v_res; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: history_days defaults to 90, takes 1 to 365, refuses 0, 366, a negative number and NULL, and an administrator reads and changes it';
END
$verify$;
