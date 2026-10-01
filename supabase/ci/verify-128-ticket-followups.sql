-- Verify migration 128. Concatenate the migration text in front of this file (the DB does
-- not have 128 yet), then run it. It ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
--
-- People are simulated the way PostgREST does it (same helper as verify-096):
-- set the JWT claims and SET LOCAL ROLE authenticated, so the guards' `current_user
-- <> 'authenticated'` branch is actually exercised, not skipped the way it would be
-- running straight as the migration owner.
DO $verify$
DECLARE
  v_account       uuid;
  v_agent         uuid;
  v_ticket        uuid;
  v_ticket_number int;
  v_resolution    uuid;
  v_type_count    int;
  v_result        jsonb;
  v_search_id     uuid;
  v_total         bigint;
  v_res           text;
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
          json_build_object('sub', u, 'role', 'authenticated')::text, true);
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

  -- 1. ticket_types seeded the 7 defaults for a real account that also has
  --    a real ticket and a real agent to impersonate.
  SELECT t.account_id, t.id, t.ticket_number, p.user_id
    INTO v_account, v_ticket, v_ticket_number, v_agent
    FROM tickets t
    JOIN profiles p ON p.account_id = t.account_id
   ORDER BY t.created_at DESC
   LIMIT 1;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK-OK: no account with both a ticket and a member to test against';
  END IF;

  SELECT count(*) INTO v_type_count FROM ticket_types WHERE account_id = v_account AND is_system;
  IF v_type_count <> 7 THEN
    RAISE EXCEPTION 'FAIL expected 7 system ticket_types for account %, got %', v_account, v_type_count;
  END IF;

  -- 2. As a real person: the category guard rejects an unknown slug and accepts a real one.
  v_res := pg_temp.run(v_agent, format('UPDATE tickets SET category = %L WHERE id = %L', 'not_a_real_type', v_ticket));
  IF v_res !~ '^ERR 22023' THEN
    RAISE EXCEPTION 'FAIL an unknown category was accepted (person path): %', v_res;
  END IF;

  v_res := pg_temp.run(v_agent, format('UPDATE tickets SET category = %L WHERE id = %L', 'bug', v_ticket));
  IF v_res <> 'OK' THEN
    RAISE EXCEPTION 'FAIL a real system type was rejected (person path): %', v_res;
  END IF;

  -- 3. As a real person: reopen clears the resolution; re-closing without a fresh one is rejected.
  SELECT id INTO v_resolution FROM ticket_resolutions WHERE account_id = v_account AND is_active LIMIT 1;
  IF v_resolution IS NOT NULL THEN
    v_res := pg_temp.run(v_agent, format('UPDATE tickets SET status = %L, resolution_id = %L WHERE id = %L', 'resolved', v_resolution, v_ticket));
    IF v_res <> 'OK' THEN
      RAISE EXCEPTION 'FAIL could not resolve the ticket with a valid resolution: %', v_res;
    END IF;

    v_res := pg_temp.run(v_agent, format('UPDATE tickets SET status = %L WHERE id = %L', 'open', v_ticket));
    IF v_res <> 'OK' THEN
      RAISE EXCEPTION 'FAIL could not reopen the ticket: %', v_res;
    END IF;
    IF (SELECT resolution_id FROM tickets WHERE id = v_ticket) IS NOT NULL THEN
      RAISE EXCEPTION 'FAIL resolution_id survived a reopen';
    END IF;

    v_res := pg_temp.run(v_agent, format('UPDATE tickets SET status = %L WHERE id = %L', 'resolved', v_ticket));
    IF v_res !~ '^ERR 22023' THEN
      RAISE EXCEPTION 'FAIL re-closing after a reopen did not demand a fresh resolution (person path): %', v_res;
    END IF;

    v_res := pg_temp.run(v_agent, format('UPDATE tickets SET status = %L, resolution_id = %L WHERE id = %L', 'resolved', v_resolution, v_ticket));
    IF v_res <> 'OK' OR (SELECT status FROM tickets WHERE id = v_ticket) <> 'resolved' THEN
      RAISE EXCEPTION 'FAIL supplying a fresh resolution did not let the close through: %', v_res;
    END IF;
    PERFORM pg_temp.run(v_agent, format('UPDATE tickets SET status = %L WHERE id = %L', 'open', v_ticket));
  END IF;

  -- 4. ticket_reports_drilldown returns a sane shape.
  v_result := ticket_reports_drilldown(v_account, now() - interval '5 years', now() + interval '1 day', 5);
  IF jsonb_typeof(v_result -> 'oldestOpen') <> 'array' OR jsonb_typeof(v_result -> 'byLabel') <> 'array' THEN
    RAISE EXCEPTION 'FAIL ticket_reports_drilldown returned an unexpected shape: %', v_result;
  END IF;

  -- 5. tickets_search finds this ticket by its exact key, and respects a type filter.
  SELECT s.id, s.total_count INTO v_search_id, v_total
    FROM tickets_search(
      p_account => v_account,
      p_search_text => v_ticket_number::text,
      p_search_number => v_ticket_number,
      p_search_prefix => NULL
    ) s
   WHERE s.id = v_ticket;
  IF v_search_id IS NULL THEN
    RAISE EXCEPTION 'FAIL tickets_search did not find ticket % by its number', v_ticket_number;
  END IF;

  SELECT count(*) INTO v_type_count FROM tickets_search(p_account => v_account, p_types => ARRAY['bug']) s WHERE s.id = v_ticket;
  IF v_type_count <> 1 THEN
    RAISE EXCEPTION 'FAIL tickets_search with p_types=[bug] did not include the bug-typed ticket';
  END IF;

  SELECT count(*) INTO v_type_count FROM tickets_search(p_account => v_account, p_types => ARRAY['billing']) s WHERE s.id = v_ticket;
  IF v_type_count <> 0 THEN
    RAISE EXCEPTION 'FAIL tickets_search with p_types=[billing] wrongly included the bug-typed ticket';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: ticket_types seeded, category guard enforced for a real person, reopen clears resolution and demands a fresh one, drilldown shape ok, search finds by key and respects a type filter (total matched for key search: %)', v_total;
END $verify$;
