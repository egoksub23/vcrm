-- Verify migration 132. Self-contained (builds its own tenants), so it runs against an
-- empty database as well as production. Concatenate 132's migration text in front when
-- the database does not have it yet, then run it. Ends in a deliberate error so nothing
-- is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();   -- owner of tenant A, an ordinary tenant owner
  uB     uuid := gen_random_uuid();   -- owner of tenant B, an ordinary tenant owner
  uOp    uuid := gen_random_uuid();   -- the platform operator (own workspace)
  acctOp uuid;
  acctA  uuid;
  acctB  uuid;
  cfgA   uuid;
  v_res  text;
  v_txt  text;
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

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now()),
    (uOp, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op-' || uOp || '@example.invalid', '{"full_name":"Operator"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  SELECT account_id INTO acctOp FROM profiles WHERE user_id = uOp;
  INSERT INTO platform_admins (user_id, note) VALUES (uOp, 'verify-132');
  INSERT INTO web_widget_config (account_id, user_id, widget_token) VALUES (acctA, uA, 'verify-132-' || uA) RETURNING id INTO cfgA;

  -- 1. A new tenant starts active, on the standard plan, with Incident Reporting off.
  IF (SELECT status FROM account_platform WHERE account_id = acctA) IS DISTINCT FROM 'active'
     OR (SELECT features ->> 'incidents' FROM account_platform WHERE account_id = acctA) IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'FAIL a new account was not seeded active with incidents off';
  END IF;

  -- 2. Members read their own platform row but cannot read another tenant's or write their own.
  v_res := pg_temp.run(uB, format('SELECT status FROM account_platform WHERE account_id = %L', acctB));
  IF v_res <> 'active' THEN RAISE EXCEPTION 'FAIL a member could not read their own platform row: %', v_res; END IF;
  v_res := pg_temp.run(uB, format('SELECT count(*)::text FROM account_platform WHERE account_id = %L', acctA));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a member could read another tenant''s platform row'; END IF;
  PERFORM pg_temp.run(uB, format('UPDATE account_platform SET plan = %L, status = %L WHERE account_id = %L', 'hacked', 'suspended', acctB));
  IF (SELECT plan FROM account_platform WHERE account_id = acctB) <> 'standard' THEN
    RAISE EXCEPTION 'FAIL a tenant owner changed their own plan';
  END IF;
  v_res := pg_temp.run(uB, format('INSERT INTO account_platform (account_id) VALUES (%L)', gen_random_uuid()));
  IF v_res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL a tenant could insert a platform row: %', v_res; END IF;

  -- 3. Operator RPCs: refused for a tenant owner, work for a platform admin.
  v_res := pg_temp.run(uB, 'SELECT public.platform_list_accounts()::text');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a non-operator listed all tenants: %', left(v_res, 80); END IF;
  v_res := pg_temp.run(uB, format('SELECT public.platform_set_account_status(%L, %L)::text', acctA, 'suspended'));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a non-operator suspended another tenant: %', v_res; END IF;
  v_res := pg_temp.run(uB, format('SELECT public.platform_update_account(%L, %L)::text', acctB, 'enterprise'));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a tenant owner changed their own plan via the RPC: %', v_res; END IF;
  v_txt := pg_temp.run(uOp, 'SELECT public.platform_list_accounts()::text');
  IF v_txt NOT LIKE '%' || acctA::text || '%' OR v_txt NOT LIKE '%' || acctB::text || '%' THEN
    RAISE EXCEPTION 'FAIL the operator list is missing a tenant';
  END IF;
  v_res := pg_temp.run(NULL, 'SELECT public.is_platform_admin()::text', 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL anon can call is_platform_admin: %', v_res;
  END IF;

  -- 4. Plan / limits / features merge and a null removes a key.
  PERFORM pg_temp.run(uOp, format($q$SELECT public.platform_update_account(%L, 'pro', '{"seats": 7}', '{"incidents": true, "x": 1}')::text$q$, acctB));
  IF (SELECT (limits ->> 'seats')::int FROM account_platform WHERE account_id = acctB) <> 7
     OR (SELECT plan FROM account_platform WHERE account_id = acctB) <> 'pro'
     OR (SELECT features ->> 'incidents' FROM account_platform WHERE account_id = acctB) <> 'true' THEN
    RAISE EXCEPTION 'FAIL platform_update_account did not apply plan/limits/features';
  END IF;
  PERFORM pg_temp.run(uOp, format($q$SELECT public.platform_update_account(%L, NULL, '{"seats": null}', '{"x": null}')::text$q$, acctB));
  IF (SELECT limits FROM account_platform WHERE account_id = acctB) ? 'seats'
     OR (SELECT features FROM account_platform WHERE account_id = acctB) ? 'x'
     OR (SELECT features ->> 'incidents' FROM account_platform WHERE account_id = acctB) <> 'true' THEN
    RAISE EXCEPTION 'FAIL a null did not remove just its own key';
  END IF;

  -- 5. Suspend pauses every channel; resume restores exactly what was on.
  PERFORM pg_temp.run(uOp, format($q$SELECT public.platform_set_account_status(%L, 'suspended', 'unpaid')::text$q$, acctA));
  IF (SELECT status FROM account_platform WHERE account_id = acctA) <> 'suspended'
     OR (SELECT enabled FROM web_widget_config WHERE id = cfgA) THEN
    RAISE EXCEPTION 'FAIL suspend did not switch the account and its widget off';
  END IF;
  PERFORM pg_temp.run(uOp, format($q$SELECT public.platform_set_account_status(%L, 'active')::text$q$, acctA));
  IF (SELECT status FROM account_platform WHERE account_id = acctA) <> 'active'
     OR NOT (SELECT enabled FROM web_widget_config WHERE id = cfgA) THEN
    RAISE EXCEPTION 'FAIL resume did not restore the widget';
  END IF;
  -- a channel the tenant had paused themselves stays paused through suspend + resume
  UPDATE web_widget_config SET enabled = false WHERE id = cfgA;
  PERFORM pg_temp.run(uOp, format($q$SELECT public.platform_set_account_status(%L, 'suspended')::text$q$, acctA));
  PERFORM pg_temp.run(uOp, format($q$SELECT public.platform_set_account_status(%L, 'active')::text$q$, acctA));
  IF (SELECT enabled FROM web_widget_config WHERE id = cfgA) THEN
    RAISE EXCEPTION 'FAIL resume re-enabled a channel the tenant had paused themselves';
  END IF;

  -- an operator cannot suspend their own workspace (they would lose the console)
  v_res := pg_temp.run(uOp, format($q$SELECT public.platform_set_account_status(%L, 'suspended')::text$q$, acctOp));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL an operator could suspend their own workspace: %', v_res; END IF;

  -- 6. A tenant admin cannot write the operator-owned columns of accounts, but can still rename.
  v_res := pg_temp.run(uA, format('UPDATE accounts SET ticket_seq = ticket_seq + 5 WHERE id = %L', acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL ticket_seq was writable by a tenant owner: %', v_res; END IF;
  v_res := pg_temp.run(uA, format('UPDATE accounts SET owner_user_id = %L WHERE id = %L', uB, acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL owner_user_id was writable by a tenant owner: %', v_res; END IF;
  v_res := pg_temp.run(uA, format('UPDATE accounts SET name = %L WHERE id = %L', 'Renamed Co', acctA));
  IF v_res <> 'OK' OR (SELECT name FROM accounts WHERE id = acctA) <> 'Renamed Co' THEN
    RAISE EXCEPTION 'FAIL a tenant owner could no longer rename their account: %', v_res;
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: new tenants seed active with incidents off; members read but never write their platform row; operator RPCs refuse non-operators and an operator cannot suspend their own workspace; plan/limits/features merge; suspend pauses channels and resume restores exactly what was on; owner_user_id and the number counters are no longer tenant-writable';
END
$verify$;
