-- Verify migration 133. Self-contained (builds its own tenants), so it runs against an
-- empty database as well as production. Concatenate 133's migration text in front when
-- the database does not have it yet, then run it. Ends in a deliberate error so nothing
-- is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();   -- owner of a new tenant
  uOp    uuid := gen_random_uuid();   -- the platform operator
  acctA  uuid;
  v_res  text;
  v_txt  text;
  v_ok   text;
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
    (uA,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'  || uA  || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uOp, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op-' || uOp || '@example.invalid', '{"full_name":"Operator"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  INSERT INTO platform_admins (user_id, note) VALUES (uOp, 'verify-133');

  -- 1. A new tenant gets the neutral defaults, not Vircle's.
  IF (SELECT brand_name FROM accounts WHERE id = acctA) IS NOT NULL
     OR (SELECT brand_logo_url FROM accounts WHERE id = acctA) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a new account did not start with neutral branding';
  END IF;
  IF (SELECT ticket_key_prefix FROM accounts WHERE id = acctA) <> 'TKT' THEN
    RAISE EXCEPTION 'FAIL a new account did not get the neutral ticket prefix, got %', (SELECT ticket_key_prefix FROM accounts WHERE id = acctA);
  END IF;

  -- 2. The tenant owner sets their own name and logo; a bad logo URL and an oversized name are refused.
  v_res := pg_temp.run(uA, format('UPDATE accounts SET brand_name = %L, brand_logo_url = %L WHERE id = %L', 'Acme Desk', 'https://cdn.example.com/logo.png', acctA));
  IF v_res <> 'OK' OR (SELECT brand_name FROM accounts WHERE id = acctA) <> 'Acme Desk' THEN
    RAISE EXCEPTION 'FAIL the owner could not set their own branding: %', v_res;
  END IF;
  v_res := pg_temp.run(uA, format('UPDATE accounts SET brand_logo_url = %L WHERE id = %L', 'javascript:alert(1)', acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a non-https logo URL was accepted: %', v_res; END IF;
  v_res := pg_temp.run(uA, format('UPDATE accounts SET brand_name = %L WHERE id = %L', repeat('x', 61), acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an oversized brand name was accepted: %', v_res; END IF;

  -- 3. Widget brand_name has the same bounds.
  INSERT INTO web_widget_config (account_id, user_id, widget_token) VALUES (acctA, uA, 'verify-133-' || uA);
  BEGIN
    UPDATE web_widget_config SET brand_name = repeat('y', 61) WHERE account_id = acctA;
    RAISE EXCEPTION 'FAIL an oversized widget brand name was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE web_widget_config SET brand_name = 'Acme' WHERE account_id = acctA;

  -- 4. Seed health shows in the operator list, and a missing seed is repairable.
  v_txt := pg_temp.run(uOp, format($q$SELECT (SELECT e ->> 'seed_ok' FROM jsonb_array_elements(public.platform_list_accounts()) e WHERE e ->> 'id' = %L)$q$, acctA));
  IF v_txt <> 'true' THEN RAISE EXCEPTION 'FAIL a freshly seeded account should report seed_ok=true, got %', v_txt; END IF;

  DELETE FROM ticket_types WHERE account_id = acctA;
  v_txt := pg_temp.run(uOp, format($q$SELECT (SELECT e ->> 'seed_ok' FROM jsonb_array_elements(public.platform_list_accounts()) e WHERE e ->> 'id' = %L)$q$, acctA));
  IF v_txt <> 'false' THEN RAISE EXCEPTION 'FAIL missing ticket types were not reported, got %', v_txt; END IF;

  v_res := pg_temp.run(uA, format('SELECT public.platform_reseed_account(%L)::text', acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a tenant owner could re-seed via the operator RPC: %', v_res; END IF;
  v_res := pg_temp.run(uOp, format('SELECT public.platform_reseed_account(%L)::text', acctA));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the operator could not re-seed: %', v_res; END IF;
  SELECT count(*)::text INTO v_ok FROM ticket_types WHERE account_id = acctA AND is_system;
  IF v_ok <> '7' THEN RAISE EXCEPTION 'FAIL re-seed did not restore the 7 system ticket types, got %', v_ok; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: new tenants start with neutral branding and the TKT prefix; owners set their own brand name/logo within bounds; widget brand name bounded; seed health is reported and the operator can repair it (tenants cannot)';
END
$verify$;
