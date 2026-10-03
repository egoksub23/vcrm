-- Verify migration 152. Self-contained (builds its own tenants), so it runs against an
-- empty database as well as production. Concatenate 152's migration text in front when
-- the database does not have it yet, then run it. Ends in a deliberate error so nothing
-- is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();   -- owner of tenant A
  uB     uuid := gen_random_uuid();   -- owner of tenant B
  uOp    uuid := gen_random_uuid();   -- the platform operator
  acctA  uuid;
  acctB  uuid;
  ctA    uuid;
  convA  uuid;
  v_res  text;
  v_n    int;
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
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now()),
    (uOp, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op-' || uOp || '@example.invalid', '{"full_name":"Operator"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  INSERT INTO platform_admins (user_id, note) VALUES (uOp, 'verify-152');

  -- 1. Live numbers: an admin reads their own workspace, nobody reads another's, signed-out cannot call.
  v_res := pg_temp.run(uA, format($q$SELECT (account_usage(%L) ->> 'contacts')$q$, acctA));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL an owner could not read their own usage: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT (account_usage(%L) ->> 'contacts')$q$, acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a member of another workspace read this usage: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$SELECT account_usage(%L)::text$q$, acctA), 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL anon called account_usage: %', v_res; END IF;
  v_res := pg_temp.run(uOp, format($q$SELECT (account_usage(%L) ->> 'members')$q$, acctA));
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL the operator could not read a workspace''s usage: %', v_res; END IF;

  -- 2. Messages count only what the workspace sent: not customers, not internal notes, not failures.
  INSERT INTO contacts (account_id, user_id, phone) VALUES (acctA, uA, '+60100000152') RETURNING id INTO ctA;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (acctA, uA, ctA) RETURNING id INTO convA;
  INSERT INTO messages (conversation_id, account_id, sender_type, content_type, content_text, channel_type) VALUES
    (convA, acctA, 'customer', 'text', 'hi', 'whatsapp'),
    (convA, acctA, 'agent',    'text', 'one', 'whatsapp'),
    (convA, acctA, 'bot',      'text', 'two', 'whatsapp');
  INSERT INTO messages (conversation_id, account_id, sender_type, content_type, content_text, channel_type, is_internal)
    VALUES (convA, acctA, 'agent', 'text', 'a note', 'whatsapp', true);
  INSERT INTO messages (conversation_id, account_id, sender_type, content_type, content_text, channel_type, status)
    VALUES (convA, acctA, 'agent', 'text', 'failed', 'whatsapp', 'failed');
  v_res := pg_temp.run(uA, format($q$SELECT (account_usage(%L) ->> 'messages_month')$q$, acctA));
  IF v_res <> '2' THEN RAISE EXCEPTION 'FAIL outbound messages this month should be 2, got %', v_res; END IF;

  -- 3. AI tokens this month.
  INSERT INTO ai_usage_log (account_id, mode, provider, model, prompt_tokens, completion_tokens, total_tokens)
    VALUES (acctA, 'draft', 'openai', 'x', 100, 50, 150);
  v_res := pg_temp.run(uA, format($q$SELECT (account_usage(%L) ->> 'ai_tokens_month')$q$, acctA));
  IF v_res <> '150' THEN RAISE EXCEPTION 'FAIL AI tokens this month should be 150, got %', v_res; END IF;

  -- 4. The contact limit: a person adding contacts is stopped at the limit; a soft-deleted contact
  --    frees a place; a customer writing in (service role) and another workspace are never stopped.
  UPDATE account_platform SET limits = '{"contacts": 2}'::jsonb WHERE account_id = acctA;
  v_res := pg_temp.run(uA, format($q$INSERT INTO contacts (account_id, user_id, phone) VALUES (%L, %L, '+60100000153')$q$, acctA, uA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the second contact (limit 2) was refused: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO contacts (account_id, user_id, phone) VALUES (%L, %L, '+60100000154')$q$, acctA, uA));
  IF v_res NOT LIKE 'ERR 53400: contact_limit_reached%' THEN RAISE EXCEPTION 'FAIL a third contact (limit 2) was not refused: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$INSERT INTO contacts (account_id, user_id, phone) VALUES (%L, %L, '+60100000155')$q$, acctA, uA), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a customer writing in (service role) was refused: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$DELETE FROM contacts WHERE account_id = %L AND phone = '+60100000155'$q$, acctA));
  v_res := pg_temp.run(uA, format($q$DELETE FROM contacts WHERE account_id = %L AND phone = '+60100000153'$q$, acctA));
  v_res := pg_temp.run(uA, format($q$INSERT INTO contacts (account_id, user_id, phone) VALUES (%L, %L, '+60100000156')$q$, acctA, uA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL removing a contact did not free a place: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$INSERT INTO contacts (account_id, user_id, phone) VALUES (%L, %L, '+60100000157')$q$, acctB, uB));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL one workspace''s limit stopped another: %', v_res; END IF;
  UPDATE account_platform SET limits = '{}'::jsonb WHERE account_id = acctA;
  v_res := pg_temp.run(uA, format($q$INSERT INTO contacts (account_id, user_id, phone) VALUES (%L, %L, '+60100000158')$q$, acctA, uA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL with no limit a contact was refused: %', v_res; END IF;

  -- 5. The daily job: one row per active workspace, none for a suspended one, nothing on a second run,
  --    storage counted from the workspace's folder.
  INSERT INTO storage.objects (bucket_id, name, metadata)
    VALUES ('chat-media', 'account-' || acctA || '/verify-152.bin', '{"size": 4096}'::jsonb);
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE account_platform SET status = 'suspended' WHERE account_id = acctB;
  SELECT usage_snapshot_run(10000) INTO v_n;
  IF v_n < 1 THEN RAISE EXCEPTION 'FAIL the daily job measured nothing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM account_usage_daily WHERE account_id = acctA AND day = (now() AT TIME ZONE 'utc')::date) THEN
    RAISE EXCEPTION 'FAIL no snapshot for the active workspace';
  END IF;
  IF EXISTS (SELECT 1 FROM account_usage_daily WHERE account_id = acctB) THEN
    RAISE EXCEPTION 'FAIL a suspended workspace was measured';
  END IF;
  IF (SELECT storage_bytes FROM account_usage_daily WHERE account_id = acctA) <> 4096
     OR (SELECT messages_month FROM account_usage_daily WHERE account_id = acctA) <> 2
     OR (SELECT ai_tokens_month FROM account_usage_daily WHERE account_id = acctA) <> 150
     OR (SELECT contacts FROM account_usage_daily WHERE account_id = acctA) <> 3 THEN
    RAISE EXCEPTION 'FAIL the snapshot numbers are wrong: %', (SELECT row_to_json(d)::text FROM account_usage_daily d WHERE account_id = acctA);
  END IF;
  SELECT usage_snapshot_run(10000) INTO v_n;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL a second run on the same day measured % workspaces again', v_n; END IF;
  UPDATE account_platform SET status = 'active' WHERE account_id = acctB;

  -- 6. Who sees the history: the workspace's own admins, nobody else.
  v_res := pg_temp.run(uA, format($q$SELECT count(*)::text FROM account_usage_daily WHERE account_id = %L$q$, acctA));
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL an owner could not read their daily usage: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT count(*)::text FROM account_usage_daily WHERE account_id = %L$q$, acctA));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace read this daily usage: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO account_usage_daily (account_id, day) VALUES (%L, current_date - 5)$q$, acctA));
  IF v_res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL a member wrote to the usage history: %', v_res; END IF;

  -- 7. The operator overview: operator only, every workspace present.
  v_res := pg_temp.run(uA, 'SELECT platform_usage_overview()::text');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a tenant read the operator overview: %', left(v_res, 80); END IF;
  v_res := pg_temp.run(uOp, 'SELECT platform_usage_overview()::text');
  IF v_res NOT LIKE '%' || acctA::text || '%' OR v_res NOT LIKE '%' || acctB::text || '%' THEN
    RAISE EXCEPTION 'FAIL the operator overview is missing a workspace';
  END IF;

  -- 8. The job is for the service role only.
  IF has_function_privilege('authenticated', 'public.usage_snapshot_run(integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.usage_snapshot_run(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL a client role can run the usage job';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.usage_snapshot_run(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the service role cannot run the usage job';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: usage numbers readable by the workspace admin and operator only; outbound messages, AI tokens and contacts counted correctly; contact limit stops a person at the limit, never a customer writing in or another workspace; daily job writes one row per active workspace and none for a suspended one; history and overview are scoped; job is service-role only';
END
$verify$;
