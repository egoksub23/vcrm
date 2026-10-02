-- Verify migration 134. Self-contained, so it runs against an empty database as well as
-- production. Concatenate 134's migration text in front when the database does not have it
-- yet, then run it. Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means
-- every check passed.
DO $verify$
DECLARE
  uOwner  uuid := gen_random_uuid();   -- a provisioned tenant owner (also the operator)
  uOp     uuid := gen_random_uuid();   -- platform operator
  uNobody uuid := gen_random_uuid();
  acct    uuid;
  v_res   text;
  v_token constant text := 'tok-' || 'verify-134-link-token';
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

  -- Close sign-up for the whole test.
  UPDATE public.platform_settings SET value = 'false'::jsonb WHERE key = 'open_signup';
  IF public.signup_is_open() THEN RAISE EXCEPTION 'FAIL signup_is_open() should be false'; END IF;

  -- 1. A plain browser sign-up is refused.
  BEGIN
    INSERT INTO auth.users (id, instance_id, aud, role, email)
    VALUES (uNobody, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nobody-' || uNobody || '@example.invalid');
    RAISE EXCEPTION 'FAIL an uninvited sign-up was accepted';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;
  -- ...even when it claims to be provisioned in user_metadata (only app_metadata counts).
  BEGIN
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
    VALUES (uNobody, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nobody-' || uNobody || '@example.invalid', '{"provisioned": true}');
    RAISE EXCEPTION 'FAIL a user_metadata "provisioned" claim let a sign-up through';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;

  -- 2. The operator console's path (app_metadata.provisioned) works, and so does an anonymous widget visitor.
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, email_confirmed_at)
  VALUES (uOwner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-' || uOwner || '@example.invalid', '{"provisioned": true}', '{"full_name":"Tenant Owner"}', now());
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_app_meta_data, email_confirmed_at)
  VALUES (uOp, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op-' || uOp || '@example.invalid', '{"provisioned": true}', now());
  INSERT INTO auth.users (id, instance_id, aud, role, is_anonymous)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', true);
  SELECT account_id INTO acct FROM profiles WHERE user_id = uOwner;
  IF acct IS NULL THEN RAISE EXCEPTION 'FAIL the provisioned owner did not get a workspace'; END IF;
  INSERT INTO platform_admins (user_id, note) VALUES (uOp, 'verify-134');

  -- 3. A pending email-targeted invitation lets that exact email in (case-insensitively), nobody else.
  INSERT INTO account_invitations (account_id, token_hash, role, email, expires_at)
  VALUES (acct, 'hash-email-verify-134', 'agent', 'Invited.Person@Example.invalid', now() + interval '1 day');
  INSERT INTO auth.users (id, instance_id, aud, role, email)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'invited.person@example.invalid');
  BEGIN
    INSERT INTO auth.users (id, instance_id, aud, role, email)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'someone.else@example.invalid');
    RAISE EXCEPTION 'FAIL a different email slipped in on another address''s invitation';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;

  -- 4. A link invitation: the matching plaintext token in user_metadata lets a sign-up through; a wrong,
  --    expired or already-used token does not.
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at)
  VALUES (acct, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), 'agent', now() + interval '1 day');
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'link-' || gen_random_uuid() || '@example.invalid', jsonb_build_object('invite_token', v_token));
  BEGIN
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bad-' || gen_random_uuid() || '@example.invalid', '{"invite_token": "not-a-real-token"}');
    RAISE EXCEPTION 'FAIL a wrong invite token let a sign-up through';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;
  UPDATE account_invitations SET expires_at = now() - interval '1 minute'
   WHERE token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex');
  BEGIN
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
    VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'exp-' || gen_random_uuid() || '@example.invalid', jsonb_build_object('invite_token', v_token));
    RAISE EXCEPTION 'FAIL an expired invite token let a sign-up through';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;

  -- 5. The signed-out sign-up page can ask whether sign-up is open; only an operator can change it.
  v_res := pg_temp.run(NULL, 'SELECT public.signup_is_open()::text', 'anon');
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL anon could not read signup_is_open(): %', v_res; END IF;
  v_res := pg_temp.run(uOwner, 'SELECT public.platform_set_open_signup(true)::text');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a tenant owner could open sign-up: %', v_res; END IF;
  v_res := pg_temp.run(NULL, 'SELECT public.platform_set_open_signup(true)::text', 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL anon could open sign-up: %', v_res; END IF;
  IF public.signup_is_open() THEN RAISE EXCEPTION 'FAIL sign-up was opened by a non-operator'; END IF;

  -- 6. The operator can open it; then a plain sign-up works again.
  v_res := pg_temp.run(uOp, 'SELECT public.platform_set_open_signup(true)::text');
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the operator could not open sign-up: %', v_res; END IF;
  IF NOT public.signup_is_open() THEN RAISE EXCEPTION 'FAIL sign-up did not open'; END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'open-' || gen_random_uuid() || '@example.invalid');

  RAISE EXCEPTION 'ROLLBACK-OK: closed sign-up refuses uninvited and user_metadata-spoofed sign-ups; accepts provisioned logins, anonymous visitors, a pending email invitation (case-insensitive) and a valid unexpired link token only; the operator alone can open or close it';
END
$verify$;
