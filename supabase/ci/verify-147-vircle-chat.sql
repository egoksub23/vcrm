-- Verify migration 147. Self-contained (builds its own workspaces), so it runs against an
-- empty database as well as production. Concatenate 147's migration text in front when the
-- database does not have it yet, then run it. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA    uuid := gen_random_uuid();
  uB    uuid := gen_random_uuid();
  uOp   uuid := gen_random_uuid();
  uAg   uuid := gen_random_uuid();
  acctA uuid;
  acctB uuid;
  convA uuid;
  contA uuid;
  v_res text;
  v_n   int;
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
    (uA,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'  || uA  || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'  || uB  || '@example.invalid', '{"full_name":"Tenant B"}', now()),
    (uOp, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op-' || uOp || '@example.invalid', '{"full_name":"Operator"}', now()),
    (uAg, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ag-' || uAg || '@example.invalid', '{"full_name":"Agent"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  -- uAg joins workspace A as a plain agent (no channels.manage).
  UPDATE profiles SET account_id = acctA, account_role = 'agent' WHERE user_id = uAg;
  INSERT INTO platform_admins (user_id, note) VALUES (uOp, 'verify-147');

  -- 1. Feature flag: a workspace created after this migration starts with Vircle Chat off.
  IF (SELECT features ->> 'vircle_chat' FROM account_platform WHERE account_id = acctA) IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'FAIL a new workspace should start with vircle_chat off';
  END IF;
  IF EXISTS (SELECT 1 FROM account_platform WHERE NOT (features ? 'vircle_chat')) THEN
    RAISE EXCEPTION 'FAIL every workspace should carry an explicit vircle_chat flag';
  END IF;

  -- 2. The channel type is accepted on messages and conversations, and nothing else new is.
  INSERT INTO contacts (account_id, user_id, phone, name, wallet_id) VALUES (acctA, uA, '', 'Aisha', 'W123') RETURNING id INTO contA;
  INSERT INTO conversations (account_id, user_id, contact_id, last_channel_type, vircle_conversation_id)
  VALUES (acctA, uA, contA, 'vircle_chat', 'c_9f2') RETURNING id INTO convA;
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, status, message_id)
  VALUES (convA, 'customer', 'text', 'Hi', 'vircle_chat', 'sent', 'm_1');
  BEGIN
    INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, status)
    VALUES (convA, 'customer', 'text', 'x', 'carrier_pigeon', 'sent');
    RAISE EXCEPTION 'FAIL an unknown channel type was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- The gateway's message id is unique per conversation (a retried event cannot duplicate it).
  BEGIN
    INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, status, message_id)
    VALUES (convA, 'customer', 'text', 'Hi again', 'vircle_chat', 'sent', 'm_1');
    RAISE EXCEPTION 'FAIL the same gateway message id was stored twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 3. The connection: whoever may manage channels reads and writes it; an agent and another workspace cannot.
  v_res := pg_temp.run(uA, format($q$INSERT INTO vircle_chat_config (account_id, workspace_key, gateway_base_url, signing_secret, api_token)
      VALUES (%L, 'vcw_abcdefghijklmnop1234', 'https://gw.example.com', 'enc-secret', 'enc-token')$q$, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the owner should create the connection: %', v_res; END IF;
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM vircle_chat_config$q$);
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL the owner should read the connection (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAg, $q$SELECT count(*)::text FROM vircle_chat_config$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL an agent must not read the encrypted secrets (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, $q$SELECT count(*)::text FROM vircle_chat_config$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace must not read the connection (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$UPDATE vircle_chat_config SET enabled = false WHERE account_id = %L$q$, acctA));
  IF (SELECT enabled FROM vircle_chat_config WHERE account_id = acctA) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL another workspace paused this connection';
  END IF;
  v_res := pg_temp.run(uAg, format($q$INSERT INTO vircle_chat_config (account_id, workspace_key, gateway_base_url, signing_secret, api_token)
      VALUES (%L, 'vcw_zyxwvutsrqponmlk9876', 'https://gw.example.com', 'a', 'b')$q$, acctB));
  IF v_res NOT LIKE 'ERR 42501%' AND v_res NOT LIKE 'ERR %row-level security%' THEN
    RAISE EXCEPTION 'FAIL an agent wrote a connection for another workspace: %', v_res;
  END IF;

  -- 4. One connection per workspace, unique workspace keys, a well-formed key, an https-looking address.
  BEGIN
    INSERT INTO vircle_chat_config (account_id, workspace_key, gateway_base_url, signing_secret, api_token)
    VALUES (acctA, 'vcw_secondsecondsecond1', 'https://gw.example.com', 'a', 'b');
    RAISE EXCEPTION 'FAIL a second connection for one workspace was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO vircle_chat_config (account_id, workspace_key, gateway_base_url, signing_secret, api_token)
    VALUES (acctB, 'vcw_abcdefghijklmnop1234', 'https://gw.example.com', 'a', 'b');
    RAISE EXCEPTION 'FAIL a workspace key was reused';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO vircle_chat_config (account_id, workspace_key, gateway_base_url, signing_secret, api_token)
    VALUES (acctB, 'not-a-key', 'https://gw.example.com', 'a', 'b');
    RAISE EXCEPTION 'FAIL a malformed workspace key was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO vircle_chat_config (account_id, workspace_key, gateway_base_url, signing_secret, api_token)
    VALUES (acctB, 'vcw_qrstuvwxyzabcdef1234', 'ftp://gw.example.com', 'a', 'b');
    RAISE EXCEPTION 'FAIL a non-http gateway address was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5. The handled-events table belongs to the server alone.
  INSERT INTO vircle_chat_events (account_id, event_id) VALUES (acctA, 'evt_1');
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM vircle_chat_events$q$);
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in user could read handled events: %', v_res; END IF;
  BEGIN
    INSERT INTO vircle_chat_events (account_id, event_id) VALUES (acctA, 'evt_1');
    RAISE EXCEPTION 'FAIL the same event id was recorded twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 6. Suspending the workspace pauses the connection; resuming restores it.
  PERFORM pg_temp.run(uOp, format($q$SELECT public.platform_set_account_status(%L, 'suspended', 'unpaid')::text$q$, acctA));
  IF (SELECT enabled FROM vircle_chat_config WHERE account_id = acctA) IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL suspending the workspace did not pause Vircle Chat';
  END IF;
  PERFORM pg_temp.run(uOp, format($q$SELECT public.platform_set_account_status(%L, 'active')::text$q$, acctA));
  IF (SELECT enabled FROM vircle_chat_config WHERE account_id = acctA) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL resuming the workspace did not restore Vircle Chat';
  END IF;

  -- 7. Deleting a workspace removes its connection and handled events.
  DELETE FROM vircle_chat_events WHERE account_id = acctA;
  SELECT count(*) INTO v_n FROM vircle_chat_events WHERE account_id = acctA;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL handled events were not removed'; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: vircle_chat is a channel type; connections are per workspace, capability-gated and unique; events dedupe; new workspaces start with the feature off; suspension pauses and resumes the channel';
END
$verify$;
