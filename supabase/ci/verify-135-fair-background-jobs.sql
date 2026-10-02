-- Verify migration 135. Self-contained (builds its own workspaces), so it runs against an
-- empty database as well as production. Concatenate 135's migration text in front when the
-- database does not have it yet, then run it. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();
  uB      uuid := gen_random_uuid();
  uOp     uuid := gen_random_uuid();
  acctA   uuid;
  acctB   uuid;
  autoA   uuid;
  autoB   uuid;
  connA   uuid;
  connB   uuid;
  v_n     int;
  v_a     int;
  v_b     int;
  v_res   text;
  v_lvl_a int;
  v_lvl_b int;
  v_ids   uuid[];
  v_id    uuid;
  c       uuid;
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

  -- Fixture logins are inserted directly; keep self-service sign-up open for this transaction.
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'  || uA  || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'  || uB  || '@example.invalid', '{"full_name":"Tenant B"}', now()),
    (uOp, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op-' || uOp || '@example.invalid', '{"full_name":"Operator"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  INSERT INTO platform_admins (user_id, note) VALUES (uOp, 'verify-135');

  -- ===== 1. Automations: a busy workspace cannot take the whole batch =====
  INSERT INTO automations (account_id, user_id, name, trigger_type) VALUES (acctA, uA, 'verify A', 'new_contact_created') RETURNING id INTO autoA;
  INSERT INTO automations (account_id, user_id, name, trigger_type) VALUES (acctB, uB, 'verify B', 'new_contact_created') RETURNING id INTO autoB;
  INSERT INTO automation_pending_executions (account_id, user_id, automation_id, next_step_position, run_at)
    SELECT acctA, uA, autoA, 1, now() - interval '1 hour' - (g || ' seconds')::interval FROM generate_series(1, 12) g;
  INSERT INTO automation_pending_executions (account_id, user_id, automation_id, next_step_position, run_at)
    SELECT acctB, uB, autoB, 1, now() - interval '1 minute' - (g || ' seconds')::interval FROM generate_series(1, 3) g;

  SELECT count(*), count(*) FILTER (WHERE account_id = acctA), count(*) FILTER (WHERE account_id = acctB)
    INTO v_n, v_a, v_b FROM public.automation_claim_pending(8, 5, 60);
  IF v_n <> 8 OR v_a <> 5 OR v_b <> 3 THEN
    RAISE EXCEPTION 'FAIL fair claim: expected 8 rows (5 from A, 3 from B), got % (A %, B %)', v_n, v_a, v_b;
  END IF;
  IF EXISTS (SELECT 1 FROM automation_pending_executions WHERE status = 'running' AND locked_until IS NULL) THEN
    RAISE EXCEPTION 'FAIL a claimed row has no lease';
  END IF;

  -- a second claim does not hand out rows that are already running
  SELECT count(*) INTO v_n FROM public.automation_claim_pending(50, 50, 60);
  IF v_n <> 7 THEN RAISE EXCEPTION 'FAIL second claim should return the 7 remaining pending rows, got %', v_n; END IF;

  -- ===== 2. An expired lease is failed visibly, not run again =====
  SELECT id INTO v_id FROM automation_pending_executions WHERE account_id = acctA AND status = 'running' LIMIT 1;
  UPDATE automation_pending_executions SET locked_until = now() - interval '1 minute' WHERE id = v_id;
  SELECT count(*) INTO v_n FROM public.automation_claim_pending(50, 50, 60);
  IF (SELECT status FROM automation_pending_executions WHERE id = v_id) <> 'failed' THEN
    RAISE EXCEPTION 'FAIL a row with an expired lease was not failed';
  END IF;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL an expired-lease row was handed out again'; END IF;

  -- ===== 3. Release gives claimed-but-unstarted rows back =====
  SELECT array_agg(id) INTO v_ids FROM (SELECT id FROM automation_pending_executions WHERE status = 'running' LIMIT 4) s;
  SELECT public.automation_release_pending(v_ids) INTO v_n;
  IF v_n <> 4 THEN RAISE EXCEPTION 'FAIL release returned % rows, expected 4', v_n; END IF;
  IF (SELECT count(*) FROM automation_pending_executions WHERE id = ANY (v_ids) AND status = 'pending' AND locked_until IS NULL) <> 4 THEN
    RAISE EXCEPTION 'FAIL released rows are not pending with no lease';
  END IF;

  -- ===== 4. A suspended workspace's work is not claimed =====
  UPDATE automation_pending_executions SET status = 'pending', locked_until = NULL WHERE account_id = acctB;
  UPDATE account_platform SET status = 'suspended' WHERE account_id = acctB;
  IF public.account_is_active(acctB) THEN RAISE EXCEPTION 'FAIL account_is_active is true for a suspended workspace'; END IF;
  SELECT count(*) INTO v_n FROM public.automation_claim_pending(100, 100, 60) WHERE account_id = acctB;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL claimed % rows of a suspended workspace', v_n; END IF;
  UPDATE account_platform SET status = 'active' WHERE account_id = acctB;
  SELECT count(*) INTO v_n FROM public.automation_claim_pending(100, 100, 60) WHERE account_id = acctB;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL after resume, B''s 3 rows should be claimable, got %', v_n; END IF;

  -- ===== 5. Conversation SLA candidates: breach test, fairness and suspension in the database =====
  FOR c IN SELECT gen_random_uuid() FROM generate_series(1, 6) LOOP
    WITH ct AS (INSERT INTO contacts (account_id, user_id, phone) VALUES (acctA, uA, '+6011' || lpad((random()*1e8)::int::text, 8, '0')) RETURNING id)
    INSERT INTO conversations (account_id, user_id, contact_id, awaiting_response, last_customer_message_at)
      SELECT acctA, uA, ct.id, true, now() - interval '3 hours' FROM ct;
  END LOOP;
  FOR c IN SELECT gen_random_uuid() FROM generate_series(1, 2) LOOP
    WITH ct AS (INSERT INTO contacts (account_id, user_id, phone) VALUES (acctB, uB, '+6012' || lpad((random()*1e8)::int::text, 8, '0')) RETURNING id)
    INSERT INTO conversations (account_id, user_id, contact_id, awaiting_response, last_customer_message_at)
      SELECT acctB, uB, ct.id, true, now() - interval '3 hours' FROM ct;
  END LOOP;
  -- one that has NOT waited long enough must not appear
  WITH ct AS (INSERT INTO contacts (account_id, user_id, phone) VALUES (acctA, uA, '+60139999999') RETURNING id)
  INSERT INTO conversations (account_id, user_id, contact_id, awaiting_response, last_customer_message_at)
    SELECT acctA, uA, ct.id, true, now() FROM ct;

  SELECT count(*) FILTER (WHERE account_id = acctA), count(*) FILTER (WHERE account_id = acctB)
    INTO v_a, v_b FROM public.conversation_sla_candidates(100, 3);
  IF v_a <> 3 OR v_b <> 2 THEN
    RAISE EXCEPTION 'FAIL SLA candidates: expected A capped at 3 and B 2, got A % B %', v_a, v_b;
  END IF;
  SELECT count(*) INTO v_a FROM public.conversation_sla_candidates(100, 100) WHERE account_id = acctA;
  IF v_a <> 6 THEN RAISE EXCEPTION 'FAIL SLA candidates: the not-yet-breached conversation was included (A=%)', v_a; END IF;
  UPDATE account_platform SET status = 'suspended' WHERE account_id = acctB;
  SELECT count(*) INTO v_b FROM public.conversation_sla_candidates(100, 100) WHERE account_id = acctB;
  IF v_b <> 0 THEN RAISE EXCEPTION 'FAIL SLA candidates included a suspended workspace'; END IF;

  -- ===== 6. Incident escalation: suspended workspaces are skipped =====
  INSERT INTO incidents (account_id, incident_number, title, incident_type, severity, escalation_level_entered_at)
  VALUES (acctA, 1, 'verify A', 'SB', 'P1', now() - interval '5 days');
  INSERT INTO incidents (account_id, incident_number, title, incident_type, severity, escalation_level_entered_at)
  VALUES (acctB, 1, 'verify B', 'SB', 'P1', now() - interval '5 days');
  -- (a P1 incident can already sit above level 0 at insert, so compare before and after)
  SELECT escalation_level INTO v_lvl_a FROM incidents WHERE account_id = acctA;
  SELECT escalation_level INTO v_lvl_b FROM incidents WHERE account_id = acctB;
  PERFORM public.incident_escalation_sweep(100);
  IF (SELECT escalation_level FROM incidents WHERE account_id = acctA) <> v_lvl_a + 1 THEN
    RAISE EXCEPTION 'FAIL the active workspace''s overdue incident was not escalated (was %, now %)', v_lvl_a, (SELECT escalation_level FROM incidents WHERE account_id = acctA);
  END IF;
  IF (SELECT escalation_level FROM incidents WHERE account_id = acctB) <> v_lvl_b THEN
    RAISE EXCEPTION 'FAIL a suspended workspace''s incident was escalated';
  END IF;

  -- ===== 7. Ticket SLA sweep still runs and returns its summary =====
  IF (public.sla_sweep(50) -> 'breached') IS NULL THEN RAISE EXCEPTION 'FAIL sla_sweep did not return its summary'; END IF;

  -- ===== 8. Jira job claim: fair and skipping suspended =====
  UPDATE account_platform SET status = 'active' WHERE account_id = acctB;
  INSERT INTO jira_connections (account_id, cloud_id, site_url) VALUES (acctA, gen_random_uuid()::text, 'https://a.example.invalid') RETURNING id INTO connA;
  INSERT INTO jira_connections (account_id, cloud_id, site_url) VALUES (acctB, gen_random_uuid()::text, 'https://b.example.invalid') RETURNING id INTO connB;
  INSERT INTO jira_sync_jobs (account_id, connection_id, kind, next_try_at)
    SELECT acctA, connA, 'sync_issue', now() - interval '1 hour' - (g || ' seconds')::interval FROM generate_series(1, 6) g;
  INSERT INTO jira_sync_jobs (account_id, connection_id, kind, next_try_at)
    SELECT acctB, connB, 'sync_issue', now() - interval '1 minute' - (g || ' seconds')::interval FROM generate_series(1, 2) g;
  SELECT count(*) FILTER (WHERE account_id = acctA), count(*) FILTER (WHERE account_id = acctB)
    INTO v_a, v_b FROM public.jira_claim_jobs(4, 'verify', 60);
  IF v_b <> 2 OR v_a <> 2 THEN
    RAISE EXCEPTION 'FAIL Jira claim: expected 2 from each workspace in a batch of 4, got A % B %', v_a, v_b;
  END IF;
  UPDATE account_platform SET status = 'suspended' WHERE account_id = acctB;
  SELECT count(*) INTO v_b FROM public.jira_claim_jobs(50, 'verify', 60) WHERE account_id = acctB;
  IF v_b <> 0 THEN RAISE EXCEPTION 'FAIL Jira claimed jobs of a suspended workspace'; END IF;

  -- ===== 9. Heartbeats: recorded, visible to the operator only, flagged late =====
  PERFORM public.cron_heartbeat('verify-job', 300, 42, 'ok', '{"processed": 1}');
  v_res := pg_temp.run(uOp, $q$SELECT (SELECT e ->> 'late' FROM jsonb_array_elements(public.platform_cron_status()) e WHERE e ->> 'job' = 'verify-job')$q$);
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL a job that just ran should not be late, got %', v_res; END IF;
  UPDATE cron_heartbeats SET last_run_at = now() - interval '1 hour' WHERE job = 'verify-job';
  v_res := pg_temp.run(uOp, $q$SELECT (SELECT e ->> 'late' FROM jsonb_array_elements(public.platform_cron_status()) e WHERE e ->> 'job' = 'verify-job')$q$);
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL a job 12 intervals overdue should be late, got %', v_res; END IF;
  v_res := pg_temp.run(uA, 'SELECT public.platform_cron_status()::text');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a tenant owner could read job status: %', left(v_res, 80); END IF;
  v_res := pg_temp.run(uA, $q$SELECT public.cron_heartbeat('x', 1, 1, 'ok')::text$q$);
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a tenant owner could write a heartbeat: %', v_res; END IF;
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM public.automation_claim_pending(1, 1, 60)$q$);
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a tenant owner could claim background work: %', v_res; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: automations claim fairly (a busy workspace cannot take the batch) under leases, expired leases fail visibly and release works; suspended workspaces are skipped by automations, conversation SLA, incident escalation and Jira; SLA candidates are breach-tested and capped per workspace; heartbeats are operator-only and flag a late job';
END
$verify$;
