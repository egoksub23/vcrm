-- Verify migration 154. Self-contained (builds its own tenants), so it runs against an
-- empty database as well as production. Concatenate 154's migration text in front when
-- the database does not have it yet, then run it. Ends in a deliberate error so nothing
-- is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();   -- owner of tenant A
  uM     uuid := gen_random_uuid();   -- an agent in A
  uB     uuid := gen_random_uuid();   -- owner of tenant B
  uOp    uuid := gen_random_uuid();   -- platform operator 1
  uOp2   uuid := gen_random_uuid();   -- platform operator 2
  a      uuid;
  b      uuid;
  mAcct  uuid;
  ctA    uuid;
  convA  uuid;
  g1     uuid;
  g2     uuid;
  v_res  text;
  v_all  text := '';
  v_n    bigint;
  s      text;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      IF u IS NULL THEN
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
      ELSE
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', u, 'role', r)::text, true);
        PERFORM set_config('request.jwt.claim.sub', u::text, true);
      END IF;
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
    (uA,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'   || uA   || '@example.invalid', '{"full_name":"Owner A"}', now()),
    (uM,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm-'   || uM   || '@example.invalid', '{"full_name":"Agent A"}', now()),
    (uB,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'   || uB   || '@example.invalid', '{"full_name":"Owner B"}', now()),
    (uOp,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op-'  || uOp  || '@example.invalid', '{"full_name":"Operator One"}', now()),
    (uOp2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op2-' || uOp2 || '@example.invalid', '{"full_name":"Operator Two"}', now());
  SELECT account_id INTO a FROM profiles WHERE user_id = uA;
  SELECT account_id INTO b FROM profiles WHERE user_id = uB;
  INSERT INTO platform_admins (user_id, note) VALUES (uOp, 'verify-154'), (uOp2, 'verify-154');
  SELECT account_id INTO mAcct FROM profiles WHERE user_id = uM;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id = uM;
  DELETE FROM accounts WHERE id = mAcct;

  -- the customer's private things, which no support view may ever show
  INSERT INTO contacts (account_id, user_id, phone, name, email) VALUES (a, uA, '+60100001541', 'CUSTOMER-NAME-ABC', 'customer-abc@example.invalid') RETURNING id INTO ctA;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a, uA, ctA) RETURNING id INTO convA;
  INSERT INTO messages (conversation_id, account_id, sender_type, content_type, content_text, channel_type, status, error_code, error_title)
    VALUES (convA, a, 'customer', 'text', 'MESSAGE-TEXT-ABC', 'whatsapp', 'delivered', NULL, NULL),
           (convA, a, 'agent', 'text', 'FAILED-TEXT-ABC', 'whatsapp', 'failed', 131047, 'Re-engagement message'),
           (convA, a, 'agent', 'text', 'FAILED-TEXT-DEF', 'whatsapp', 'failed', 131047, 'Re-engagement message');
  INSERT INTO whatsapp_config (account_id, user_id, phone_number_id, waba_id, access_token, verify_token, status, enabled)
    VALUES (a, uA, 'PHONE-ID-1', 'WABA-ID-1', 'ACCESS-TOKEN-SECRET-ABC', 'VERIFY-TOKEN-SECRET-ABC', 'connected', true);

  -- ------------------------------------------------------------
  -- 1. Only the owner can allow it, with a limit on how long
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uM, format($q$SELECT public.support_grant_access(%L, 24)::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent allowed support access: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT public.support_grant_access(%L, 24)::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL another workspace''s owner allowed support access here: %', v_res; END IF;
  v_res := pg_temp.run(uOp, format($q$SELECT public.support_grant_access(%L, 24)::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an operator granted themselves access: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$SELECT public.support_grant_access(%L, 24)::text$q$, a), 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL anon allowed support access: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$SELECT public.support_grant_access(%L, 0)::text$q$, a));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL a zero-hour grant was accepted: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$SELECT public.support_grant_access(%L, 169)::text$q$, a));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL a grant of more than 7 days was accepted: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$SELECT public.support_grant_access(%L, 24, 'x', %L)::text$q$, a, uM));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL a grant to someone who is not an operator was accepted: %', v_res; END IF;

  -- ------------------------------------------------------------
  -- 2. Without a grant the operator sees nothing (and cannot tell if the workspace exists)
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uOp, format($q$SELECT public.platform_support_view(%L, 'overview')::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an operator without a grant read the workspace: %', left(v_res, 80); END IF;
  v_res := pg_temp.run(uOp, format($q$SELECT public.platform_support_view(%L, 'overview')::text$q$, gen_random_uuid()));
  IF v_res NOT LIKE 'ERR 42501%No active support access%' THEN RAISE EXCEPTION 'FAIL an unknown workspace answered differently: %', left(v_res, 80); END IF;
  v_res := pg_temp.run(uA, format($q$SELECT public.platform_support_view(%L, 'overview')::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a workspace owner called the operator function: %', left(v_res, 80); END IF;
  v_res := pg_temp.run(NULL, format($q$SELECT public.platform_support_view(%L, 'overview')::text$q$, a), 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL anon called the operator function: %', left(v_res, 80); END IF;
  SELECT count(*) INTO v_n FROM support_access_log WHERE account_id = a;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL a refused view was logged as a view (%)', v_n; END IF;

  -- ------------------------------------------------------------
  -- 3. A grant for one named operator
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uA, format($q$SELECT public.support_grant_access(%L, 24, 'login problem', %L)::text$q$, a, uOp));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the owner could not allow access: %', v_res; END IF;
  g1 := v_res::uuid;
  v_res := pg_temp.run(uOp2, format($q$SELECT public.platform_support_view(%L, 'overview')::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a different operator used a grant named for someone else: %', left(v_res, 80); END IF;
  v_res := pg_temp.run(uOp2, 'SELECT public.platform_support_grants()::text');
  IF v_res LIKE '%' || g1::text || '%' THEN RAISE EXCEPTION 'FAIL the other operator was shown the grant'; END IF;
  v_res := pg_temp.run(uOp, 'SELECT public.platform_support_grants()::text');
  IF v_res NOT LIKE '%' || g1::text || '%' OR v_res NOT LIKE '%login problem%' THEN RAISE EXCEPTION 'FAIL the named operator was not shown the grant: %', left(v_res, 120); END IF;

  -- every section answers, and every look is logged once, with who and which part
  FOREACH s IN ARRAY ARRAY['overview', 'channels', 'failures', 'members', 'jobs', 'usage'] LOOP
    v_res := pg_temp.run(uOp, format($q$SELECT public.platform_support_view(%L, %L)::text$q$, a, s));
    IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL section % failed: %', s, v_res; END IF;
    v_all := v_all || ' ' || v_res;
  END LOOP;
  SELECT count(*) INTO v_n FROM support_access_log WHERE account_id = a AND grant_id = g1 AND operator_user_id = uOp AND operator_label = 'Operator One';
  IF v_n <> 6 THEN RAISE EXCEPTION 'FAIL expected 6 logged views, found %', v_n; END IF;
  v_res := pg_temp.run(uOp, format($q$SELECT public.platform_support_view(%L, 'messages')::text$q$, a));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL an unknown section was answered: %', left(v_res, 80); END IF;

  -- what it shows, and what it must never show
  IF v_all NOT LIKE '%"plan"%' OR v_all NOT LIKE '%connected%' OR v_all NOT LIKE '%131047%' OR v_all NOT LIKE '%Re-engagement message%' THEN
    RAISE EXCEPTION 'FAIL the diagnostics lack plan, channel status or the failure summary: %', left(v_all, 400);
  END IF;
  IF v_all NOT LIKE '%"count": 2%' THEN
    RAISE EXCEPTION 'FAIL the failure summary should group the two failed sends into one row: %', left(v_all, 400);
  END IF;
  FOREACH s IN ARRAY ARRAY['CUSTOMER-NAME-ABC', 'customer-abc@example.invalid', '+60100001541', 'MESSAGE-TEXT-ABC', 'FAILED-TEXT-ABC',
                           'FAILED-TEXT-DEF', 'ACCESS-TOKEN-SECRET-ABC', 'VERIFY-TOKEN-SECRET-ABC', 'PHONE-ID-1', 'WABA-ID-1',
                           'a-' || uA, 'm-' || uM, 'Owner A', 'Agent A'] LOOP
    IF v_all LIKE '%' || s || '%' THEN RAISE EXCEPTION 'FAIL the support view exposed private data: %', s; END IF;
  END LOOP;

  -- ------------------------------------------------------------
  -- 4. The log: the workspace's admins read it, others do not, nobody edits it
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uA, format($q$SELECT count(*)::text FROM support_access_log WHERE account_id = %L$q$, a));
  IF v_res <> '6' THEN RAISE EXCEPTION 'FAIL the owner sees % log rows, expected 6', v_res; END IF;
  v_res := pg_temp.run(uM, format($q$SELECT count(*)::text FROM support_access_log WHERE account_id = %L$q$, a));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL an agent could read the support access log'; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT count(*)::text FROM support_access_log WHERE account_id = %L$q$, a));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace could read this log'; END IF;
  v_res := pg_temp.run(uA, format($q$SELECT count(*)::text FROM support_access_grants WHERE account_id = %L$q$, a));
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL the owner does not see the grant: %', v_res; END IF;
  v_res := pg_temp.run(uOp, format($q$SELECT count(*)::text FROM support_access_grants WHERE account_id = %L$q$, a));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL an operator could read the grants table directly'; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO support_access_log (account_id, grant_id, operator_user_id, operator_label, section) VALUES (%L, %L, %L, 'x', 'overview')$q$, a, g1, uA));
  IF v_res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the owner wrote a log row: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO support_access_grants (account_id, granted_by, expires_at) VALUES (%L, %L, now() + interval '1 day')$q$, a, uA));
  IF v_res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL a grant was written without the function: %', v_res; END IF;
  BEGIN
    DELETE FROM support_access_log WHERE account_id = a;
    RAISE EXCEPTION 'FAIL log rows were deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE support_access_log SET section = 'x' WHERE account_id = a;
    RAISE EXCEPTION 'FAIL a log row was edited';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- ------------------------------------------------------------
  -- 5. It ends: revoked, or expired
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uM, format($q$SELECT public.support_revoke_access(%L)::text$q$, g1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent ended support access: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT public.support_revoke_access(%L)::text$q$, g1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL another owner ended this support access: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$SELECT public.support_revoke_access(%L)::text$q$, g1));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the owner could not end support access: %', v_res; END IF;
  v_res := pg_temp.run(uOp, format($q$SELECT public.platform_support_view(%L, 'overview')::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a revoked grant still worked: %', left(v_res, 80); END IF;

  -- an open grant (any operator) works until it expires, then stops by itself
  v_res := pg_temp.run(uA, format($q$SELECT public.support_grant_access(%L, 1)::text$q$, a));
  g2 := v_res::uuid;
  v_res := pg_temp.run(uOp2, format($q$SELECT public.platform_support_view(%L, 'jobs')::text$q$, a));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL an open grant did not work for any operator: %', v_res; END IF;
  UPDATE support_access_grants SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = g2;
  v_res := pg_temp.run(uOp2, format($q$SELECT public.platform_support_view(%L, 'jobs')::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an expired grant still worked: %', left(v_res, 80); END IF;
  v_res := pg_temp.run(uOp2, 'SELECT public.platform_support_grants()::text');
  IF v_res LIKE '%' || g2::text || '%' THEN RAISE EXCEPTION 'FAIL an expired grant is still listed'; END IF;

  -- ------------------------------------------------------------
  -- 6. A workspace can still be deleted with its grants and log
  -- ------------------------------------------------------------
  DELETE FROM accounts WHERE id = a;
  IF EXISTS (SELECT 1 FROM support_access_grants WHERE account_id = a) OR EXISTS (SELECT 1 FROM support_access_log WHERE account_id = a) THEN
    RAISE EXCEPTION 'FAIL the grants or the log outlived the workspace';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: only the owner can allow support access (1 hour to 7 days, optionally for one operator) and end it; without a grant, with someone else''s, revoked or expired an operator gets the same refusal; six sections answer from fixed fields and a planted contact, message text, token and email never appear; every look is logged once with who and which part and only the workspace''s admins can read the log; grants and log cannot be written or changed directly; a workspace deletes with its grants and log';
END
$verify$;
