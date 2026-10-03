-- Verify migration 155. Self-contained (builds its own tenants), so it runs against an
-- empty database as well as production. Concatenate 155's migration text in front when
-- the database does not have it yet, then run it. Ends in a deliberate error so nothing
-- is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();   -- owner of tenant A, brand new
  uM     uuid := gen_random_uuid();   -- an agent who joins A later
  uV     uuid := gen_random_uuid();   -- a viewer in A
  uB     uuid := gen_random_uuid();   -- owner of tenant B
  a      uuid;
  b      uuid;
  mAcct  uuid;
  v_res  text;
  j      jsonb;
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
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Owner A"}', now()),
    (uM, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm-' || uM || '@example.invalid', '{"full_name":"Agent A"}', now()),
    (uV, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'v-' || uV || '@example.invalid', '{"full_name":"Viewer A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Owner B"}', now());
  SELECT account_id INTO a FROM profiles WHERE user_id = uA;
  SELECT account_id INTO b FROM profiles WHERE user_id = uB;

  -- ------------------------------------------------------------
  -- 1. A brand new workspace has done none of it
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uA, format($q$SELECT public.onboarding_status(%L)::text$q$, a));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the owner could not read the status: %', v_res; END IF;
  j := v_res::jsonb;
  IF j <> '{"has_team": false, "dismissed": false, "has_hours": false, "has_channel": false, "has_replies": false, "has_contacts": false, "has_knowledge": false}'::jsonb THEN
    RAISE EXCEPTION 'FAIL a new workspace should have done nothing: %', j;
  END IF;

  -- ------------------------------------------------------------
  -- 2. Each step turns true when it really happens, and only then
  -- ------------------------------------------------------------
  -- a channel: WhatsApp only once connected; the widget only once on
  INSERT INTO whatsapp_config (account_id, user_id, phone_number_id, waba_id, access_token, verify_token, status, enabled)
    VALUES (a, uA, 'PH-155', 'WABA-155', 'tok', 'vt', 'disconnected', false);
  IF (pg_temp.run(uA, format($q$SELECT public.onboarding_status(%L)::text$q$, a))::jsonb ->> 'has_channel') <> 'false' THEN
    RAISE EXCEPTION 'FAIL a disconnected WhatsApp counted as a channel';
  END IF;
  UPDATE whatsapp_config SET status = 'connected', enabled = true WHERE account_id = a;
  IF (pg_temp.run(uA, format($q$SELECT public.onboarding_status(%L)::text$q$, a))::jsonb ->> 'has_channel') <> 'true' THEN
    RAISE EXCEPTION 'FAIL a connected WhatsApp did not count as a channel';
  END IF;
  DELETE FROM whatsapp_config WHERE account_id = a;
  INSERT INTO web_widget_config (account_id, user_id, widget_token, enabled) VALUES (a, uA, 'verify-155-' || uA, false);
  IF (pg_temp.run(uA, format($q$SELECT public.onboarding_status(%L)::text$q$, a))::jsonb ->> 'has_channel') <> 'false' THEN
    RAISE EXCEPTION 'FAIL a switched-off widget counted as a channel';
  END IF;
  UPDATE web_widget_config SET enabled = true WHERE account_id = a;
  IF (pg_temp.run(uA, format($q$SELECT public.onboarding_status(%L)::text$q$, a))::jsonb ->> 'has_channel') <> 'true' THEN
    RAISE EXCEPTION 'FAIL a switched-on widget did not count as a channel';
  END IF;

  -- the team: a second member, or an invitation sent
  INSERT INTO account_invitations (account_id, created_by_user_id, email, role, token_hash, expires_at)
    VALUES (a, uA, 'new-agent@example.invalid', 'agent', md5(random()::text), now() + interval '7 days');
  IF (pg_temp.run(uA, format($q$SELECT public.onboarding_status(%L)::text$q$, a))::jsonb ->> 'has_team') <> 'true' THEN
    RAISE EXCEPTION 'FAIL an invitation did not count as inviting the team';
  END IF;
  DELETE FROM account_invitations WHERE account_id = a;
  IF (pg_temp.run(uA, format($q$SELECT public.onboarding_status(%L)::text$q$, a))::jsonb ->> 'has_team') <> 'false' THEN
    RAISE EXCEPTION 'FAIL no invitation and no second member should read as not done';
  END IF;
  SELECT account_id INTO mAcct FROM profiles WHERE user_id = uM;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id = uM;
  DELETE FROM accounts WHERE id = mAcct;
  SELECT account_id INTO mAcct FROM profiles WHERE user_id = uV;
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = uV;
  DELETE FROM accounts WHERE id = mAcct;
  IF (pg_temp.run(uA, format($q$SELECT public.onboarding_status(%L)::text$q$, a))::jsonb ->> 'has_team') <> 'true' THEN
    RAISE EXCEPTION 'FAIL a second member did not count as the team';
  END IF;

  -- contacts: a soft-deleted one does not count
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, uA, '+60100001551', 'Casey');
  IF (pg_temp.run(uA, format($q$SELECT public.onboarding_status(%L)::text$q$, a))::jsonb ->> 'has_contacts') <> 'true' THEN
    RAISE EXCEPTION 'FAIL a contact did not count';
  END IF;
  UPDATE contacts SET deleted_at = now() WHERE account_id = a;
  IF (pg_temp.run(uA, format($q$SELECT public.onboarding_status(%L)::text$q$, a))::jsonb ->> 'has_contacts') <> 'false' THEN
    RAISE EXCEPTION 'FAIL a deleted contact counted';
  END IF;

  -- the optional ones
  INSERT INTO quick_replies (account_id, user_id, title, kind, content_text)
    VALUES (a, uA, 'Hello', 'text', 'Hello there');
  INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
    VALUES (a, 'Office', 'UTC', '{"1":[{"start":"09:00","end":"17:00"}],"2":[],"3":[],"4":[],"5":[],"6":[],"7":[]}'::jsonb);
  j := pg_temp.run(uA, format($q$SELECT public.onboarding_status(%L)::text$q$, a))::jsonb;
  IF j ->> 'has_replies' <> 'true' OR j ->> 'has_hours' <> 'true' OR j ->> 'has_knowledge' <> 'false' THEN
    RAISE EXCEPTION 'FAIL the optional steps read wrong: %', j;
  END IF;

  -- ------------------------------------------------------------
  -- 3. Who can read it, and who can dismiss it
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uV, format($q$SELECT public.onboarding_status(%L)::text$q$, a));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL a viewer (a member) could not read the status: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT public.onboarding_status(%L)::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL another workspace read this status: %', left(v_res, 80); END IF;
  v_res := pg_temp.run(NULL, format($q$SELECT public.onboarding_status(%L)::text$q$, a), 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL anon read the status: %', left(v_res, 80); END IF;

  v_res := pg_temp.run(uM, format($q$SELECT public.onboarding_dismiss(%L)::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent dismissed the workspace''s checklist: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT public.onboarding_dismiss(%L)::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL another workspace dismissed this checklist: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO account_onboarding (account_id, dismissed_at) VALUES (%L, now())$q$, a));
  IF v_res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the table was written without the function: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$SELECT public.onboarding_dismiss(%L)::text$q$, a));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the owner could not dismiss: %', v_res; END IF;
  -- dismissal belongs to the workspace: every member sees it, another workspace does not
  IF (pg_temp.run(uV, format($q$SELECT public.onboarding_status(%L)::text$q$, a))::jsonb ->> 'dismissed') <> 'true' THEN
    RAISE EXCEPTION 'FAIL the dismissal is not shared by the workspace';
  END IF;
  IF (pg_temp.run(uB, format($q$SELECT public.onboarding_status(%L)::text$q$, b))::jsonb ->> 'dismissed') <> 'false' THEN
    RAISE EXCEPTION 'FAIL dismissing one workspace''s checklist hid another''s';
  END IF;
  v_res := pg_temp.run(uV, format($q$SELECT count(*)::text FROM account_onboarding WHERE account_id = %L$q$, a));
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL a member cannot read their workspace''s dismissal row: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT count(*)::text FROM account_onboarding WHERE account_id = %L$q$, a));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace read this dismissal row'; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: a new workspace has done nothing; channel (connected WhatsApp, switched-on widget, any other connection), team (invitation or second member), contacts (not deleted ones) and the three optional steps turn true only when they really happen; any member reads the status, other workspaces and signed-out callers cannot; only holders of settings.workspace dismiss it, for the whole workspace, through the function only';
END
$verify$;
