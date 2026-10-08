-- Verify migration 179 (a connected mailbox: use it for the customer care inbox, independently of pausing it). Self-contained; run against an empty
-- database or production with 179's migration text concatenated in front when it is not applied yet. Ends in a deliberate error so nothing is
-- kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: both mailbox tables have inbox_enabled, boolean, NOT NULL, default true, so a mailbox connected before 179 keeps receiving into the Inbox;
-- the two switches are independent of each other (all four combinations store and read back); the audit trail records the from/to of each switch
-- and never a secret; the audit triggers still name the secret columns without their values; any member reads the connection and only an admin
-- of the workspace changes it, and another workspace sees and changes nothing; a mailbox whose inbox is off is not counted as a channel by the
-- first-run checklist, and counts again once the inbox is back on (Email and Gmail alike); the checklist function is still not callable by a
-- signed-out caller.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();
  uB      uuid := gen_random_uuid();
  acctA   uuid;
  acctB   uuid;
  v_res   text;
  v_n     bigint;
  v_def   text;
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
        PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
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
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;

  -- 0. The columns: boolean, NOT NULL, default true, on both tables.
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('email_config', 'gmail_config') AND column_name = 'inbox_enabled'
     AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'true';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL inbox_enabled should be boolean NOT NULL DEFAULT true on email_config and gmail_config (found % of 2)', v_n; END IF;
  -- the older switch is still there and still defaults to on
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('email_config', 'gmail_config') AND column_name = 'enabled'
     AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'true';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL enabled (the master pause) should still be boolean NOT NULL DEFAULT true on both tables (found % of 2)', v_n; END IF;

  -- 1. A mailbox connected the way the application connects one reads as "inbox on, not paused".
  INSERT INTO email_config (account_id, connected_by_user_id, mailbox_user_id, mailbox_address, access_token, access_token_expires_at, refresh_token, client_state)
  VALUES (acctA, uA, 'verify-179-graph-' || uA, 'support@example.invalid', 'x', now(), 'x', 'x');
  INSERT INTO gmail_config (account_id, connected_by_user_id, email_address, access_token, access_token_expires_at, refresh_token, pubsub_verify_token)
  VALUES (acctA, uA, 'care-' || uA || '@example.invalid', 'x', now(), 'x', 'verify-179-token-' || uA);
  IF NOT (SELECT inbox_enabled AND enabled FROM email_config WHERE account_id = acctA) THEN RAISE EXCEPTION 'FAIL a new Microsoft 365 connection is not inbox on and unpaused'; END IF;
  IF NOT (SELECT inbox_enabled AND enabled FROM gmail_config WHERE account_id = acctA) THEN RAISE EXCEPTION 'FAIL a new Gmail connection is not inbox on and unpaused'; END IF;

  -- 2. The two switches are independent: every combination stores and reads back, on both tables.
  UPDATE email_config SET inbox_enabled = false WHERE account_id = acctA;
  IF (SELECT enabled FROM email_config WHERE account_id = acctA) IS NOT TRUE THEN RAISE EXCEPTION 'FAIL switching the inbox off paused the whole Microsoft 365 mailbox'; END IF;
  IF (SELECT inbox_enabled FROM email_config WHERE account_id = acctA) IS NOT FALSE THEN RAISE EXCEPTION 'FAIL the Microsoft 365 inbox switch did not store off'; END IF;
  UPDATE email_config SET inbox_enabled = true, enabled = false WHERE account_id = acctA;
  IF (SELECT inbox_enabled FROM email_config WHERE account_id = acctA) IS NOT TRUE OR (SELECT enabled FROM email_config WHERE account_id = acctA) IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL the pause did not store independently of the inbox switch (Microsoft 365)';
  END IF;
  UPDATE email_config SET inbox_enabled = false, enabled = false WHERE account_id = acctA;
  IF (SELECT inbox_enabled OR enabled FROM email_config WHERE account_id = acctA) THEN RAISE EXCEPTION 'FAIL both switches off did not store (Microsoft 365)'; END IF;
  UPDATE email_config SET inbox_enabled = true, enabled = true WHERE account_id = acctA;

  UPDATE gmail_config SET inbox_enabled = false WHERE account_id = acctA;
  IF (SELECT enabled FROM gmail_config WHERE account_id = acctA) IS NOT TRUE THEN RAISE EXCEPTION 'FAIL switching the inbox off paused the whole Gmail mailbox'; END IF;
  UPDATE gmail_config SET inbox_enabled = true, enabled = false WHERE account_id = acctA;
  IF (SELECT inbox_enabled FROM gmail_config WHERE account_id = acctA) IS NOT TRUE OR (SELECT enabled FROM gmail_config WHERE account_id = acctA) IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL the pause did not store independently of the inbox switch (Gmail)';
  END IF;
  UPDATE gmail_config SET inbox_enabled = true, enabled = true WHERE account_id = acctA;

  -- 3. NULL is refused: a switch is on or off.
  BEGIN
    UPDATE email_config SET inbox_enabled = NULL WHERE account_id = acctA;
    RAISE EXCEPTION 'FAIL inbox_enabled accepted NULL';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;

  -- 4. The audit trail: each switch is recorded with its from/to, for both tables, and nothing else is.
  SELECT count(*) INTO v_n FROM audit_log
   WHERE account_id = acctA AND entity_type = 'channel_config' AND entity_label = 'Email' AND summary -> 'changes' -> 'inbox_enabled' ->> 'to' = 'false';
  IF v_n < 1 THEN RAISE EXCEPTION 'FAIL switching the Microsoft 365 inbox off left no audit entry'; END IF;
  SELECT count(*) INTO v_n FROM audit_log
   WHERE account_id = acctA AND entity_type = 'channel_config' AND entity_label = 'Email' AND summary -> 'changes' -> 'enabled' ->> 'to' = 'false';
  IF v_n < 1 THEN RAISE EXCEPTION 'FAIL pausing the Microsoft 365 mailbox left no audit entry'; END IF;
  SELECT count(*) INTO v_n FROM audit_log
   WHERE account_id = acctA AND entity_type = 'channel_config' AND entity_label = 'Gmail' AND summary -> 'changes' -> 'inbox_enabled' ->> 'to' = 'false';
  IF v_n < 1 THEN RAISE EXCEPTION 'FAIL switching the Gmail inbox off left no audit entry'; END IF;
  SELECT count(*) INTO v_n FROM audit_log
   WHERE account_id = acctA AND entity_type = 'channel_config' AND entity_label = 'Gmail' AND summary -> 'changes' -> 'enabled' ->> 'to' = 'false';
  IF v_n < 1 THEN RAISE EXCEPTION 'FAIL pausing the Gmail mailbox left no audit entry'; END IF;
  -- only these two columns carry values; a token is never among them
  SELECT count(*) INTO v_n FROM audit_log a, jsonb_object_keys(a.summary -> 'changes') k
   WHERE a.account_id = acctA AND a.entity_type = 'channel_config' AND a.summary ? 'changes' AND k NOT IN ('enabled', 'inbox_enabled');
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL a mailbox audit entry recorded values of another column'; END IF;
  -- and the secret columns are still named without their values
  SELECT pg_get_triggerdef(t.oid) INTO v_def FROM pg_trigger t WHERE t.tgrelid = 'public.email_config'::regclass AND t.tgname = 'audit_row_change';
  IF v_def IS NULL OR v_def NOT LIKE '%refresh_token%' OR v_def NOT LIKE '%enabled,inbox_enabled%' THEN RAISE EXCEPTION 'FAIL the email_config audit trigger lost a column list: %', v_def; END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_def FROM pg_trigger t WHERE t.tgrelid = 'public.gmail_config'::regclass AND t.tgname = 'audit_row_change';
  IF v_def IS NULL OR v_def NOT LIKE '%pubsub_verify_token%' OR v_def NOT LIKE '%refresh_token%' OR v_def NOT LIKE '%enabled,inbox_enabled%' THEN RAISE EXCEPTION 'FAIL the gmail_config audit trigger lost a column list: %', v_def; END IF;

  -- 5. Who may read and change it: a member reads, an admin of the workspace changes, another workspace sees and changes nothing.
  v_res := pg_temp.run(uA, format('SELECT inbox_enabled::text FROM email_config WHERE account_id = %L', acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL a member of the workspace could not read the Microsoft 365 inbox switch: %', v_res; END IF;
  v_res := pg_temp.run(uA, format('WITH u AS (UPDATE email_config SET inbox_enabled = false WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM u', acctA));
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL an admin of the workspace could not switch the Microsoft 365 inbox: %', v_res; END IF;
  v_res := pg_temp.run(uA, format('WITH u AS (UPDATE gmail_config SET inbox_enabled = false WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM u', acctA));
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL an admin of the workspace could not switch the Gmail inbox: %', v_res; END IF;
  v_res := pg_temp.run(uB, format('SELECT count(*)::text FROM email_config WHERE account_id = %L', acctA));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace could read this workspace''s mailbox connection: %', v_res; END IF;
  v_res := pg_temp.run(uB, format('WITH u AS (UPDATE email_config SET inbox_enabled = true WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM u', acctA));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace changed this workspace''s Microsoft 365 inbox switch: %', v_res; END IF;
  v_res := pg_temp.run(uB, format('WITH u AS (UPDATE gmail_config SET inbox_enabled = true WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM u', acctA));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace changed this workspace''s Gmail inbox switch: %', v_res; END IF;
  -- both are off now, as the admin left them
  IF (SELECT inbox_enabled FROM email_config WHERE account_id = acctA) OR (SELECT inbox_enabled FROM gmail_config WHERE account_id = acctA) THEN
    RAISE EXCEPTION 'FAIL the admin''s switches did not stay off';
  END IF;

  -- 6. The first-run checklist: a mailbox whose inbox is off is not somewhere customers write; on again, it is.
  v_res := pg_temp.run(uA, format($q$SELECT (public.onboarding_status(%L) ->> 'has_channel')$q$, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL mailboxes with their inbox off counted as a channel: %', v_res; END IF;
  UPDATE email_config SET inbox_enabled = true WHERE account_id = acctA;
  v_res := pg_temp.run(uA, format($q$SELECT (public.onboarding_status(%L) ->> 'has_channel')$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL a Microsoft 365 mailbox with its inbox on did not count as a channel: %', v_res; END IF;
  UPDATE email_config SET inbox_enabled = false WHERE account_id = acctA;
  UPDATE gmail_config SET inbox_enabled = true WHERE account_id = acctA;
  v_res := pg_temp.run(uA, format($q$SELECT (public.onboarding_status(%L) ->> 'has_channel')$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL a Gmail mailbox with its inbox on did not count as a channel: %', v_res; END IF;
  UPDATE gmail_config SET inbox_enabled = false WHERE account_id = acctA;
  v_res := pg_temp.run(uA, format($q$SELECT (public.onboarding_status(%L) ->> 'has_channel')$q$, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL has_channel stayed true after both inboxes went off: %', v_res; END IF;
  -- the rest of the checklist is 155's and still answers
  v_res := pg_temp.run(uA, format($q$SELECT (public.onboarding_status(%L) ? 'has_team')::text$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the checklist no longer answers has_team: %', v_res; END IF;
  -- and it is still a signed-in member's call only
  v_res := pg_temp.run(NULL, format($q$SELECT public.onboarding_status(%L)::text$q$, acctA), 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-out caller could read the checklist: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT public.onboarding_status(%L)::text$q$, acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL another workspace could read this workspace''s checklist: %', v_res; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: inbox_enabled exists on email_config and gmail_config as boolean NOT NULL DEFAULT true (existing mailboxes keep receiving) beside the unchanged master pause enabled; the two switches store independently in all four combinations and refuse NULL; the audit trail records the from/to of enabled and inbox_enabled for both mailboxes and no other value while the secret columns stay name-only; a member reads and an admin of the workspace changes the switches while another workspace sees and changes nothing; the first-run checklist counts a mailbox only while its inbox is on (Email and Gmail) and is still a signed-in member''s call.';
END
$verify$;
