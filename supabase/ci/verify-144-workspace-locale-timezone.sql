-- Verify migration 144. Self-contained (builds its own workspace), so it runs against an
-- empty database as well as production. Concatenate 144's migration text in front when the
-- database does not have it yet, then run it. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
--
-- People are simulated the way PostgREST does it (JWT claims + SET LOCAL ROLE), so the access
-- rules are exercised, not skipped the way they would be running as the owner.
DO $verify$
DECLARE
  uA    uuid := gen_random_uuid();
  uB    uuid := gen_random_uuid();
  acctA uuid;
  acctB uuid;
  v_res text;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
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
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;

  -- 1. New workspaces start at UTC with no language chosen; people start with no choice.
  IF (SELECT timezone FROM accounts WHERE id = acctA) <> 'UTC' OR (SELECT locale FROM accounts WHERE id = acctA) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a new workspace should start at UTC with no locale';
  END IF;
  IF (SELECT timezone FROM profiles WHERE user_id = uA) IS NOT NULL OR (SELECT locale FROM profiles WHERE user_id = uA) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a new profile should have no locale or timezone';
  END IF;

  -- 2. The owner sets the workspace's language and timezone.
  v_res := pg_temp.run(uA, format($q$UPDATE accounts SET locale = 'ms', timezone = 'Asia/Kuala_Lumpur' WHERE id = %L$q$, acctA));
  IF v_res <> 'OK' OR (SELECT locale FROM accounts WHERE id = acctA) <> 'ms' THEN
    RAISE EXCEPTION 'FAIL the owner could not set the workspace language/timezone: %', v_res;
  END IF;

  -- 3. Another workspace's owner cannot change it.
  v_res := pg_temp.run(uB, format($q$UPDATE accounts SET locale = 'ko' WHERE id = %L$q$, acctA));
  IF (SELECT locale FROM accounts WHERE id = acctA) <> 'ms' THEN
    RAISE EXCEPTION 'FAIL another workspace changed this workspace''s language (%)', v_res;
  END IF;

  -- 4. People set their own.
  v_res := pg_temp.run(uA, format($q$UPDATE profiles SET locale = 'zh-CN', timezone = 'Asia/Seoul' WHERE user_id = %L$q$, uA));
  IF v_res <> 'OK' OR (SELECT timezone FROM profiles WHERE user_id = uA) <> 'Asia/Seoul' THEN
    RAISE EXCEPTION 'FAIL a person could not set their own language/timezone: %', v_res;
  END IF;
  v_res := pg_temp.run(uA, format($q$UPDATE profiles SET locale = 'ko' WHERE user_id = %L$q$, uB));
  IF (SELECT locale FROM profiles WHERE user_id = uB) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a person changed someone else''s language (%)', v_res;
  END IF;

  -- 5. Bad values are refused: shapes that are not a locale, zones that do not exist.
  FOREACH v_res IN ARRAY ARRAY['EN', 'english', 'e', 'en_US', 'en-', 'ms; drop table x'] LOOP
    BEGIN
      UPDATE accounts SET locale = v_res WHERE id = acctA;
      RAISE EXCEPTION 'FAIL locale accepted: %', v_res;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    UPDATE accounts SET timezone = 'Mars/Olympus_Mons' WHERE id = acctA;
    RAISE EXCEPTION 'FAIL an invalid timezone was accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    UPDATE profiles SET timezone = 'Not/AZone' WHERE user_id = uA;
    RAISE EXCEPTION 'FAIL an invalid profile timezone was accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    UPDATE accounts SET timezone = NULL WHERE id = acctA;
    RAISE EXCEPTION 'FAIL a workspace timezone was cleared';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;

  -- 6. A person can clear their own choice.
  UPDATE profiles SET locale = NULL, timezone = NULL WHERE user_id = uA;

  RAISE EXCEPTION 'ROLLBACK-OK: workspace and person language/timezone default to unset/UTC, are settable by their owner only, and reject malformed locales and unknown timezones';
END
$verify$;
