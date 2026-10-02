-- Verify migration 130. Self-contained: it builds its own two tenants, so it also
-- runs against an empty database (CI) as well as production. Concatenate 130's
-- migration text in front of this file when the database does not have it yet,
-- then run it. It ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
--
-- People are simulated the way PostgREST does it (same helper as verify-096/128):
-- set the JWT claims and SET LOCAL ROLE, so the guards' `current_user` branches are
-- actually exercised, not skipped the way they would be running as the owner.
DO $verify$
DECLARE
  uA        uuid := gen_random_uuid();   -- owner of tenant A
  uB        uuid := gen_random_uuid();   -- owner of tenant B
  uAnon     uuid := gen_random_uuid();   -- anonymous widget visitor, no profile
  acctA     uuid;
  acctB     uuid;
  roleA     uuid;
  roleB     uuid;
  contactA  uuid;
  contactB  uuid;
  cfgA      uuid;
  v_res     text;
  v_n       int;
  r         record;
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

  -- Fixtures: two real signups (handle_new_user builds an account + owner each)
  -- and one anonymous visitor (no email, so no profile is ever built for it).
  -- Fixture logins are inserted directly; keep self-service sign-up open for this transaction
  -- (migration 134 closes it by default on a fresh database).
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now());
  INSERT INTO auth.users (id, instance_id, aud, role, is_anonymous)
  VALUES (uAnon, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', true);

  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  IF acctA IS NULL OR acctB IS NULL OR acctA = acctB THEN
    RAISE EXCEPTION 'FAIL fixture: expected two separate tenants, got % / %', acctA, acctB;
  END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE user_id = uAnon) THEN
    RAISE EXCEPTION 'FAIL fixture: the anonymous user unexpectedly has a profile';
  END IF;

  INSERT INTO account_roles (account_id, name, base_role) VALUES (acctA, 'verify-role-a', 'agent') RETURNING id INTO roleA;
  INSERT INTO account_roles (account_id, name, base_role) VALUES (acctB, 'verify-role-b', 'agent') RETURNING id INTO roleB;

  -- 1. An anonymous visitor cannot create a profile in someone else's account,
  --    as owner or as anything else.
  v_res := pg_temp.run(uAnon, format(
    'INSERT INTO profiles (user_id, full_name, email, account_id, account_role) VALUES (%L, ''x'', ''x@example.invalid'', %L, ''owner'')',
    uAnon, acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL anonymous profile self-insert was allowed: %', v_res;
  END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE user_id = uAnon) THEN
    RAISE EXCEPTION 'FAIL the anonymous profile row exists';
  END IF;

  -- 2. A member cannot point their own custom_role_id at any role, own or foreign.
  v_res := pg_temp.run(uB, format('UPDATE profiles SET custom_role_id = %L WHERE user_id = %L', roleA, uB));
  IF v_res NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL foreign custom_role_id self-assignment was allowed: %', v_res;
  END IF;
  v_res := pg_temp.run(uB, format('UPDATE profiles SET custom_role_id = %L WHERE user_id = %L', roleB, uB));
  IF v_res NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL own-account custom_role_id self-assignment was allowed: %', v_res;
  END IF;
  -- ...and an ordinary self-service edit still works.
  v_res := pg_temp.run(uB, format('UPDATE profiles SET full_name = %L WHERE user_id = %L', 'Renamed', uB));
  IF v_res <> 'OK' THEN
    RAISE EXCEPTION 'FAIL a plain self-service profile edit broke: %', v_res;
  END IF;

  -- 3. Whoever writes it, a custom role from another account is refused.
  BEGIN
    UPDATE profiles SET custom_role_id = roleA WHERE user_id = uB;
    RAISE EXCEPTION 'FAIL a foreign custom role was accepted for another account''s profile';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;

  -- 4. Leaving the account drops the old account's role; so does becoming owner.
  UPDATE profiles SET account_role = 'agent', custom_role_id = roleB WHERE user_id = uB;
  UPDATE profiles SET account_id = acctA WHERE user_id = uB;
  IF (SELECT custom_role_id FROM profiles WHERE user_id = uB) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL moving to another account kept the previous account''s custom role';
  END IF;
  UPDATE profiles SET custom_role_id = roleA WHERE user_id = uB;
  UPDATE profiles SET account_role = 'owner' WHERE user_id = uB;
  IF (SELECT custom_role_id FROM profiles WHERE user_id = uB) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL promotion to owner kept a custom role';
  END IF;
  -- put B back so later steps have two tenants again
  UPDATE profiles SET account_id = acctB, account_role = 'owner' WHERE user_id = uB;

  -- 5. The cross-tenant DEFINER functions are service_role only.
  FOR r IN
    SELECT p.oid, p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('pick_round_robin_agent','pick_team_round_robin_member','pick_least_loaded_agent',
                         'pick_least_loaded_team_member','merge_duplicate_contacts','merge_duplicate_conversations',
                         'incident_recompute_open_escalations')
  LOOP
    v_n := coalesce(v_n, 0) + 1;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL % is still executable by anon/authenticated', r.sig;
    END IF;
    IF NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL % lost service_role EXECUTE (the automation engine needs it)', r.sig;
    END IF;
  END LOOP;
  IF v_n IS NULL OR v_n < 9 THEN
    RAISE EXCEPTION 'FAIL expected 9 function signatures, found %', v_n;
  END IF;

  -- 6. Storage: no anonymous listing, and a signed-in user sees only their own folder.
  INSERT INTO storage.objects (bucket_id, name) VALUES
    ('chat-media', 'account-' || acctA || '/verify-a.png'),
    ('chat-media', 'account-' || acctB || '/verify-b.png'),
    ('avatars',    uA || '/avatar-a.png'),
    ('avatars',    uB || '/avatar-b.png');

  v_res := pg_temp.run(NULL, $q$SELECT count(*)::text FROM storage.objects WHERE bucket_id IN ('chat-media','flow-media','avatars')$q$, 'anon');
  IF v_res <> '0' THEN
    RAISE EXCEPTION 'FAIL anon can list tenant storage objects, saw %', v_res;
  END IF;
  v_res := pg_temp.run(uA, format($q$SELECT count(*)::text FROM storage.objects WHERE bucket_id = 'chat-media' AND name LIKE 'account-%%/verify-%%'$q$));
  IF v_res <> '1' THEN
    RAISE EXCEPTION 'FAIL tenant A should see exactly its own chat-media object, saw %', v_res;
  END IF;
  v_res := pg_temp.run(uA, format($q$SELECT count(*)::text FROM storage.objects WHERE bucket_id = 'chat-media' AND name = %L$q$, 'account-' || acctB || '/verify-b.png'));
  IF v_res <> '0' THEN
    RAISE EXCEPTION 'FAIL tenant A can see tenant B''s chat-media object';
  END IF;
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM storage.objects WHERE bucket_id = 'avatars'$q$);
  IF v_res <> '1' THEN
    RAISE EXCEPTION 'FAIL a user should see only their own avatar file, saw %', v_res;
  END IF;

  -- 7. A widget visitor / conversation can never point at another tenant's contact or config.
  INSERT INTO contacts (account_id, user_id, phone) VALUES (acctA, uA, '+60100000001') RETURNING id INTO contactA;
  INSERT INTO contacts (account_id, user_id, phone) VALUES (acctB, uB, '+60100000002') RETURNING id INTO contactB;
  INSERT INTO web_widget_config (account_id, user_id, widget_token) VALUES (acctA, uA, 'verify-130-' || uA) RETURNING id INTO cfgA;

  BEGIN
    INSERT INTO widget_visitors (id, account_id, contact_id, widget_config_id) VALUES (uAnon, acctA, contactB, cfgA);
    RAISE EXCEPTION 'FAIL a visitor was bound to another account''s contact';
  EXCEPTION WHEN sqlstate '23514' THEN NULL;
  END;
  BEGIN
    INSERT INTO widget_visitors (id, account_id, contact_id, widget_config_id) VALUES (uAnon, acctB, contactB, cfgA);
    RAISE EXCEPTION 'FAIL a visitor was bound to another account''s widget config';
  EXCEPTION WHEN sqlstate '23514' THEN NULL;
  END;
  INSERT INTO widget_visitors (id, account_id, contact_id, widget_config_id) VALUES (uAnon, acctA, contactA, cfgA);

  BEGIN
    INSERT INTO conversations (account_id, user_id, contact_id) VALUES (acctB, uB, contactA);
    RAISE EXCEPTION 'FAIL a conversation was created against another account''s contact';
  EXCEPTION WHEN sqlstate '23514' THEN NULL;
  END;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (acctA, uA, contactA);

  RAISE EXCEPTION 'ROLLBACK-OK: anonymous profile insert blocked; custom_role_id guarded + same-account + cleared on leave/promote; cross-tenant RPCs service_role only; storage not listable by anon and scoped per tenant; widget visitor/conversation same-account triggers hold';
END
$verify$;
