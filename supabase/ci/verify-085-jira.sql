-- ============================================================
-- Verification for migration 085 (Jira Cloud two-way link).
--
-- Run against a database that already has 085 applied (or, before it ships,
-- run supabase/ci/drafts/085_jira_link.sql and this file as ONE script):
--   supabase db query --linked -f <the combined file>
--
-- Everything happens inside one DO block that ends with
-- RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing is ever committed, and the
-- draft's DDL, sent in the same batch, is rolled back with it. A message
-- starting with ROLLBACK-OK means every check passed; any other error names
-- the check that failed.
--
-- People are simulated the way PostgREST does it: set the JWT claims and
-- SET LOCAL ROLE authenticated, so RLS and column privileges apply for real.
-- ============================================================

DO $verify$
DECLARE
  a        UUID;
  b        UUID;
  owner_a  UUID := gen_random_uuid();
  admin_a  UUID := gen_random_uuid();
  agent_a  UUID := gen_random_uuid();
  viewer_a UUID := gen_random_uuid();
  owner_b  UUID := gen_random_uuid();
  contact1 UUID := gen_random_uuid();
  contact2 UUID := gen_random_uuid();
  t1       UUID := gen_random_uuid();
  t2       UUID := gen_random_uuid();
  tb       UUID := gen_random_uuid();
  conn_a   UUID;
  conn_b   UUID;
  link1    UUID;
  link2    UUID;
  cm1      UUID := gen_random_uuid();
  cm2      UUID := gen_random_uuid();
  cm3      UUID := gen_random_uuid();
  n        INTEGER := 0;
  res      TEXT;
  cnt      INTEGER;
  i        INTEGER;
  j1       UUID;
  j2       UUID;
  j3       UUID;
  ids_a    UUID[];
  ids_b    UUID[];
  rec      RECORD;
  tokver   INTEGER;
BEGIN
  -- ---------------------------------------------------------
  -- helpers (temp functions live only for this session)
  -- ---------------------------------------------------------
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

  EXECUTE $f$
    CREATE FUNCTION pg_temp.ac(p_acct UUID, p_where TEXT) RETURNS INTEGER
    LANGUAGE plpgsql AS $b$
    DECLARE c INTEGER;
    BEGIN
      EXECUTE format('SELECT count(*)::int FROM audit_log WHERE account_id = %L AND (%s)', p_acct, p_where)
        INTO c;
      RETURN c;
    END $b$;
  $f$;

  EXECUTE $f$
    CREATE FUNCTION pg_temp.nc(p_user UUID, p_type TEXT) RETURNS INTEGER
    LANGUAGE sql AS $b$
      SELECT count(*)::int FROM notifications WHERE user_id = p_user AND type = p_type;
    $b$;
  $f$;

  -- ---------------------------------------------------------
  -- fixtures: users -> (trigger) accounts + profiles
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify085-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, admin_a, agent_a, viewer_a, owner_b]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create accounts';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'admin'  WHERE user_id = admin_a;
  UPDATE profiles SET account_id = a, account_role = 'agent'  WHERE user_id = agent_a;
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = viewer_a;
  DELETE FROM accounts WHERE owner_user_id IN (admin_a, agent_a, viewer_a);

  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (contact1, owner_a, a, '+10000000085', 'Casey');
  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (contact2, owner_b, b, '+10000000086', 'Dana');
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, created_by)
    VALUES (t1, a, 1, contact1, 'Login fails on Safari', agent_a);
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, created_by)
    VALUES (t2, a, 2, contact1, 'Invoice PDF is blank', agent_a);
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, created_by)
    VALUES (tb, b, 1, contact2, 'Other workspace', owner_b);

  INSERT INTO jira_connections (account_id, cloud_id, site_url, site_name, connected_by,
                                jira_account_id, jira_display_name, settings)
    VALUES (a, '11111111-2222-4333-8444-555555555555', 'https://acme.atlassian.net', 'Acme', admin_a,
            'acct-admin', 'Vircle Integration',
            '{"direction": {"status_to_jira": true, "comments_to_jira": true}}'::jsonb)
    RETURNING id INTO conn_a;
  INSERT INTO jira_connections (account_id, cloud_id, site_url, site_name, connected_by)
    VALUES (b, '99999999-2222-4333-8444-555555555555', 'https://other.atlassian.net', 'Other', owner_b)
    RETURNING id INTO conn_b;
  INSERT INTO jira_connection_secrets (connection_id, account_id, access_token_enc, refresh_token_enc, webhook_token)
    VALUES (conn_a, a, 'enc-access-0', 'enc-refresh-0', 'whtoken-a-' || gen_random_uuid()),
           (conn_b, b, 'enc-access-b', 'enc-refresh-b', 'whtoken-b-' || gen_random_uuid());

  -- ---------------------------------------------------------
  -- 1. Capabilities: catalogue, defaults, Viewer guard
  -- ---------------------------------------------------------
  IF (SELECT count(*) FROM capability_catalogue
       WHERE (capability = 'jira.connect' AND min_grant_role = 'admin' AND enforced_by = 'app')
          OR (capability IN ('jira.link', 'jira.share-comments') AND min_grant_role = 'agent' AND enforced_by = 'app')) <> 3 THEN
    RAISE EXCEPTION 'FAIL jira capabilities missing from the catalogue';
  END IF;
  IF (SELECT count(*) FROM role_capability_defaults WHERE capability = 'jira.connect') <> 2
  OR (SELECT count(*) FROM role_capability_defaults WHERE capability IN ('jira.link', 'jira.share-comments')) <> 6 THEN
    RAISE EXCEPTION 'FAIL default grants for the jira capabilities';
  END IF;
  IF pg_temp.run(owner_a,  format('SELECT has_capability(%L, ''jira.connect'')::text', a)) <> 'true'
  OR pg_temp.run(admin_a,  format('SELECT has_capability(%L, ''jira.connect'')::text', a)) <> 'true'
  OR pg_temp.run(agent_a,  format('SELECT has_capability(%L, ''jira.connect'')::text', a)) <> 'false'
  OR pg_temp.run(viewer_a, format('SELECT has_capability(%L, ''jira.connect'')::text', a)) <> 'false'
  OR pg_temp.run(agent_a,  format('SELECT has_capability(%L, ''jira.link'')::text', a)) <> 'true'
  OR pg_temp.run(agent_a,  format('SELECT has_capability(%L, ''jira.share-comments'')::text', a)) <> 'true'
  OR pg_temp.run(viewer_a, format('SELECT has_capability(%L, ''jira.link'')::text', a)) <> 'false' THEN
    RAISE EXCEPTION 'FAIL default capability parity';
  END IF;
  -- a Viewer can never be given a write capability
  FOREACH res IN ARRAY ARRAY['jira.link', 'jira.share-comments', 'jira.connect'] LOOP
    IF pg_temp.run(owner_a, format(
         $q$SELECT set_role_capabilities(%L, 'viewer', jsonb_build_object(%L, true))::text$q$, a, res)) NOT LIKE 'ERR 22023%' THEN
      RAISE EXCEPTION 'FAIL viewer guard for %', res;
    END IF;
  END LOOP;
  -- an Agent can be given jira.link but not jira.connect (min role admin)
  IF pg_temp.run(owner_a, format(
       $q$SELECT set_role_capabilities(%L, 'agent', '{"jira.connect": true}'::jsonb)::text$q$, a)) NOT LIKE 'ERR 22023%' THEN
    RAISE EXCEPTION 'FAIL agent must not be grantable jira.connect';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 2. Secrets are unreadable; the safe table is readable by members only
  -- ---------------------------------------------------------
  FOREACH res IN ARRAY ARRAY['owner', 'admin', 'agent'] LOOP
    IF pg_temp.run(CASE res WHEN 'owner' THEN owner_a WHEN 'admin' THEN admin_a ELSE agent_a END,
                   'SELECT count(*)::text FROM jira_connection_secrets') NOT LIKE 'ERR 42501%' THEN
      RAISE EXCEPTION 'FAIL a % could read jira_connection_secrets', res;
    END IF;
  END LOOP;
  IF pg_temp.run(agent_a, 'SELECT access_token_enc FROM jira_connection_secrets') NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL token column readable';
  END IF;
  IF pg_temp.run(agent_a, 'SELECT count(*)::text FROM jira_webhook_events') NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL jira_webhook_events readable by a client';
  END IF;
  -- no token-shaped column on the readable table
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'jira_connections'
                AND column_name ~ '(enc$|secret|refresh|access_token|webhook_token)') THEN
    RAISE EXCEPTION 'FAIL jira_connections carries a secret-looking column';
  END IF;
  -- members see their own workspace's connection, never another's
  IF pg_temp.run(agent_a,  'SELECT count(*)::text FROM jira_connections') <> '1'
  OR pg_temp.run(viewer_a, 'SELECT count(*)::text FROM jira_connections') <> '1'
  OR pg_temp.run(owner_b,  'SELECT count(*)::text FROM jira_connections') <> '1'
  OR pg_temp.run(owner_b,  format('SELECT count(*)::text FROM jira_connections WHERE id = %L', conn_a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL jira_connections isolation';
  END IF;
  -- nobody writes from the client
  IF pg_temp.run(admin_a, format($q$UPDATE jira_connections SET site_name = 'x' WHERE id = %L$q$, conn_a)) NOT LIKE 'ERR 42501%'
  OR pg_temp.run(owner_a, format($q$DELETE FROM jira_connections WHERE id = %L$q$, conn_a)) NOT LIKE 'ERR 42501%'
  OR pg_temp.run(owner_a, format($q$INSERT INTO jira_connections (account_id, cloud_id, site_url) VALUES (%L, '11111111-2222-4333-8444-555555555556', 'https://x.atlassian.net')$q$, a)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL a client could write jira_connections';
  END IF;
  -- one connection per workspace
  BEGIN
    INSERT INTO jira_connections (account_id, cloud_id, site_url) VALUES (a, '11111111-2222-4333-8444-555555555557', 'https://y.atlassian.net');
    RAISE EXCEPTION 'FAIL a second connection for one workspace';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- a cloud id must be a UUID (every API URL is built from it)
  BEGIN
    UPDATE jira_connections SET cloud_id = '../../evil' WHERE id = conn_b;
    RAISE EXCEPTION 'FAIL a non-UUID cloud id was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- diagnostics tables: managers only
  INSERT INTO jira_sync_events (account_id, connection_id, kind, message) VALUES (a, conn_a, 'test', 'hello');
  IF pg_temp.run(admin_a, 'SELECT count(*)::text FROM jira_sync_events') <> '1'
  OR pg_temp.run(agent_a, 'SELECT count(*)::text FROM jira_sync_events') <> '0'
  OR pg_temp.run(owner_b, 'SELECT count(*)::text FROM jira_sync_events') <> '0' THEN
    RAISE EXCEPTION 'FAIL jira_sync_events visibility';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 3. Links: at most 5 per ticket, account-consistent, isolated
  -- ---------------------------------------------------------
  FOR i IN 1..5 LOOP
    INSERT INTO ticket_jira_links (account_id, ticket_id, connection_id, issue_id, issue_key, summary,
                                   status_id, status_name, status_category, linked_by)
      VALUES (a, t1, conn_a, (10000 + i)::text, 'ENG-' || i, 'Issue ' || i, '1', 'To Do', 'new', agent_a)
      RETURNING id INTO link1;
  END LOOP;
  BEGIN
    INSERT INTO ticket_jira_links (account_id, ticket_id, connection_id, issue_id, issue_key)
      VALUES (a, t1, conn_a, '10006', 'ENG-6');
    RAISE EXCEPTION 'FAIL the sixth link was accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS res = PG_EXCEPTION_HINT;
    IF res IS DISTINCT FROM 'jira_link_limit' THEN RAISE EXCEPTION 'FAIL wrong error for the link limit: %', res; END IF;
  END;
  -- the same issue on another ticket is fine (an issue may be linked from several tickets)
  INSERT INTO ticket_jira_links (account_id, ticket_id, connection_id, issue_id, issue_key, summary,
                                 status_id, status_name, status_category, linked_by)
    VALUES (a, t2, conn_a, '10001', 'ENG-1', 'Issue 1', '1', 'To Do', 'new', agent_a)
    RETURNING id INTO link2;
  -- the same issue twice on one ticket is refused
  BEGIN
    INSERT INTO ticket_jira_links (account_id, ticket_id, connection_id, issue_id, issue_key)
      VALUES (a, t2, conn_a, '10001', 'ENG-1');
    RAISE EXCEPTION 'FAIL a duplicate link was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  SELECT id INTO link1 FROM ticket_jira_links WHERE ticket_id = t1 AND issue_id = '10001';
  -- ticket of one account, connection of another
  BEGIN
    INSERT INTO ticket_jira_links (account_id, ticket_id, connection_id, issue_id, issue_key)
      VALUES (a, t2, conn_b, '20001', 'OTH-1');
    RAISE EXCEPTION 'FAIL a cross-account link was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO ticket_jira_links (account_id, ticket_id, connection_id, issue_id, issue_key)
      VALUES (b, t2, conn_b, '20002', 'OTH-2');
    RAISE EXCEPTION 'FAIL a link with the wrong account id was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- reads: members of the workspace only; nobody writes from the client
  IF pg_temp.run(agent_a, format('SELECT count(*)::text FROM ticket_jira_links WHERE ticket_id = %L', t1)) <> '5'
  OR pg_temp.run(viewer_a, 'SELECT count(*)::text FROM ticket_jira_links') <> '6'
  OR pg_temp.run(owner_b, 'SELECT count(*)::text FROM ticket_jira_links') <> '0' THEN
    RAISE EXCEPTION 'FAIL ticket_jira_links visibility';
  END IF;
  IF pg_temp.run(agent_a, format($q$UPDATE ticket_jira_links SET summary = 'x' WHERE id = %L$q$, link1)) NOT LIKE 'ERR 42501%'
  OR pg_temp.run(agent_a, format($q$DELETE FROM ticket_jira_links WHERE id = %L$q$, link1)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL a client could write ticket_jira_links';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 4. Token refresh: single flight and atomic rotation
  -- ---------------------------------------------------------
  IF NOT jira_claim_refresh(conn_a, 'worker-1', 30) THEN RAISE EXCEPTION 'FAIL first claim'; END IF;
  IF jira_claim_refresh(conn_a, 'worker-2', 30) THEN RAISE EXCEPTION 'FAIL a second claimant got the lease'; END IF;
  IF NOT jira_claim_refresh(conn_a, 'worker-1', 30) THEN RAISE EXCEPTION 'FAIL the holder could not renew'; END IF;
  -- a non-holder cannot save
  IF jira_save_rotated_tokens(conn_a, 'worker-2', 'enc-refresh-0', 'a2', 'r2', now() + interval '1 hour') THEN
    RAISE EXCEPTION 'FAIL a non-holder saved tokens';
  END IF;
  -- the holder with a stale expectation cannot save either
  IF jira_save_rotated_tokens(conn_a, 'worker-1', 'enc-refresh-STALE', 'a2', 'r2', now() + interval '1 hour') THEN
    RAISE EXCEPTION 'FAIL a stale refresh token was accepted';
  END IF;
  SELECT refresh_token_enc, token_version INTO rec FROM jira_connection_secrets WHERE connection_id = conn_a;
  IF rec.refresh_token_enc <> 'enc-refresh-0' OR rec.token_version <> 1 THEN
    RAISE EXCEPTION 'FAIL a refused save changed the tokens';
  END IF;
  -- the right save rotates both tokens in one step and frees the lease
  IF NOT jira_save_rotated_tokens(conn_a, 'worker-1', 'enc-refresh-0', 'enc-access-1', 'enc-refresh-1', now() + interval '55 minutes') THEN
    RAISE EXCEPTION 'FAIL the rotation was refused';
  END IF;
  SELECT access_token_enc, refresh_token_enc, token_version, refresh_lease_owner INTO rec
    FROM jira_connection_secrets WHERE connection_id = conn_a;
  IF rec.access_token_enc <> 'enc-access-1' OR rec.refresh_token_enc <> 'enc-refresh-1'
     OR rec.token_version <> 2 OR rec.refresh_lease_owner IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL rotation result: %', rec;
  END IF;
  IF (SELECT token_expires_at FROM jira_connections WHERE id = conn_a) < now() + interval '50 minutes' THEN
    RAISE EXCEPTION 'FAIL expiry was not stored from the token response';
  END IF;
  -- the same rotation twice: the second one (same expectation) loses
  IF jira_save_rotated_tokens(conn_a, 'worker-1', 'enc-refresh-0', 'x', 'y', now()) THEN
    RAISE EXCEPTION 'FAIL a replayed rotation was accepted';
  END IF;
  -- a dead holder: its lease expires and another worker takes over
  IF NOT jira_claim_refresh(conn_a, 'worker-3', 30) THEN RAISE EXCEPTION 'FAIL claim after release'; END IF;
  UPDATE jira_connection_secrets SET refresh_lease_until = now() - interval '1 second' WHERE connection_id = conn_a;
  IF NOT jira_claim_refresh(conn_a, 'worker-4', 30) THEN RAISE EXCEPTION 'FAIL takeover of an expired lease'; END IF;
  IF jira_save_rotated_tokens(conn_a, 'worker-3', 'enc-refresh-1', 'x', 'y', now()) THEN
    RAISE EXCEPTION 'FAIL the old holder saved after losing the lease';
  END IF;
  PERFORM jira_release_refresh(conn_a, 'worker-4');
  IF (SELECT refresh_lease_owner FROM jira_connection_secrets WHERE connection_id = conn_a) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL release';
  END IF;
  -- clients cannot call any of it
  IF pg_temp.run(agent_a, format($q$SELECT jira_claim_refresh(%L, 'x', 30)::text$q$, conn_a)) NOT LIKE 'ERR 42501%'
  OR pg_temp.run(agent_a, format($q$SELECT jira_mark_reauth(%L, 'x')::text$q$, conn_a)) NOT LIKE 'ERR 42501%'
  OR pg_temp.run(agent_a, 'SELECT jira_prune()::text') NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL a client could call a service function';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 5. Queue: coalescing, claim without overlap, retry, dead letter
  -- ---------------------------------------------------------
  j1 := jira_enqueue_job(a, conn_a, 'sync_issue', '{"issue_id": "10001"}'::jsonb, 'sync:10001');
  j2 := jira_enqueue_job(a, conn_a, 'sync_issue', '{"issue_id": "10002"}'::jsonb, 'sync:10002');
  j3 := jira_enqueue_job(a, conn_a, 'sync_issue', '{"issue_id": "10003"}'::jsonb, 'sync:10003');
  IF jira_enqueue_job(a, conn_a, 'sync_issue', '{"issue_id": "10001", "again": true}'::jsonb, 'sync:10001') <> j1 THEN
    RAISE EXCEPTION 'FAIL a pending job with the same key was not reused';
  END IF;
  IF (SELECT count(*) FROM jira_sync_jobs WHERE connection_id = conn_a AND status = 'pending') <> 3 THEN
    RAISE EXCEPTION 'FAIL coalescing left the wrong number of jobs';
  END IF;
  IF (SELECT payload ->> 'again' FROM jira_sync_jobs WHERE id = j1) <> 'true' THEN
    RAISE EXCEPTION 'FAIL the reused job did not take the new payload';
  END IF;
  -- a delayed job is not due yet
  PERFORM jira_enqueue_job(a, conn_a, 'sync_issue', '{}'::jsonb, 'later', 3600);
  SELECT array_agg(id) INTO ids_a FROM jira_claim_jobs(2, 'wA', 120);
  SELECT array_agg(id) INTO ids_b FROM jira_claim_jobs(5, 'wB', 120);
  IF cardinality(ids_a) <> 2 OR cardinality(ids_b) <> 1 OR ids_a && ids_b THEN
    RAISE EXCEPTION 'FAIL two claimants must get different jobs (% / %)', ids_a, ids_b;
  END IF;
  IF (SELECT count(*) FROM jira_claim_jobs(5, 'wC', 120)) <> 0 THEN
    RAISE EXCEPTION 'FAIL a third claim found work that is already taken';
  END IF;
  IF (SELECT count(*) FROM jira_sync_jobs WHERE status = 'running' AND attempts = 1) <> 3 THEN
    RAISE EXCEPTION 'FAIL claimed jobs must be running with attempts = 1';
  END IF;
  -- only the holder finishes a job
  IF jira_finish_job(ids_a[1], 'wB', 'ok') <> 'lost' THEN RAISE EXCEPTION 'FAIL a non-holder finished a job'; END IF;
  IF jira_finish_job(ids_a[1], 'wA', 'ok') <> 'done' THEN RAISE EXCEPTION 'FAIL finish ok'; END IF;
  -- retry goes back to pending later, then dies after max attempts
  IF jira_finish_job(ids_a[2], 'wA', 'retry', 'HTTP 503', 300) <> 'retry' THEN RAISE EXCEPTION 'FAIL retry'; END IF;
  SELECT status, next_try_at, last_error INTO rec FROM jira_sync_jobs WHERE id = ids_a[2];
  IF rec.status <> 'pending' OR rec.next_try_at < now() + interval '290 seconds' OR rec.last_error <> 'HTTP 503' THEN
    RAISE EXCEPTION 'FAIL retry state: %', rec;
  END IF;
  UPDATE jira_sync_jobs SET next_try_at = now(), attempts = 5, max_attempts = 6 WHERE id = ids_a[2];
  IF (SELECT count(*) FROM jira_claim_jobs(5, 'wD', 120) WHERE id = ids_a[2]) <> 1 THEN
    RAISE EXCEPTION 'FAIL the retried job was not claimed again';
  END IF;
  IF jira_finish_job(ids_a[2], 'wD', 'retry', 'HTTP 503', 60) <> 'dead' THEN
    RAISE EXCEPTION 'FAIL a job at max attempts must dead-letter';
  END IF;
  -- a worker that died: the lease runs out and the job is claimed again
  UPDATE jira_sync_jobs SET locked_until = now() - interval '1 second' WHERE id = ids_b[1];
  IF (SELECT count(*) FROM jira_claim_jobs(5, 'wE', 120) WHERE id = ids_b[1] AND attempts = 2) <> 1 THEN
    RAISE EXCEPTION 'FAIL an expired lease was not re-claimed';
  END IF;
  IF jira_finish_job(ids_b[1], 'wB', 'ok') <> 'lost' THEN RAISE EXCEPTION 'FAIL the old holder finished a re-claimed job'; END IF;
  UPDATE jira_sync_jobs SET locked_until = now() - interval '1 second', attempts = max_attempts WHERE id = ids_b[1];
  PERFORM jira_claim_jobs(5, 'wF', 120);
  IF (SELECT status FROM jira_sync_jobs WHERE id = ids_b[1]) <> 'dead' THEN
    RAISE EXCEPTION 'FAIL an exhausted expired job must be dead-lettered';
  END IF;
  IF jira_finish_job(ids_b[1], 'wE', 'dead') <> 'lost' THEN RAISE EXCEPTION 'FAIL finishing a dead job'; END IF;
  -- a permanent error kills the job at once
  j1 := jira_enqueue_job(a, conn_a, 'sync_issue', '{}'::jsonb, 'perm');
  PERFORM jira_claim_jobs(10, 'wG', 60);
  IF jira_finish_job(j1, 'wG', 'dead', '403') <> 'dead' THEN RAISE EXCEPTION 'FAIL dead outcome'; END IF;
  -- "read the comments too" is sticky when jobs coalesce
  j2 := jira_enqueue_job(a, conn_a, 'sync_issue', '{"issue_id": "77", "comments": false}'::jsonb, 'sync:77');
  IF (SELECT payload ->> 'comments' FROM jira_sync_jobs WHERE id = j2) IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'FAIL a lone status event must keep comments = false';
  END IF;
  PERFORM jira_enqueue_job(a, conn_a, 'sync_issue', '{"issue_id": "77", "comments": true}'::jsonb, 'sync:77');
  PERFORM jira_enqueue_job(a, conn_a, 'sync_issue', '{"issue_id": "77", "comments": false}'::jsonb, 'sync:77');
  IF (SELECT payload ? 'comments' FROM jira_sync_jobs WHERE id = j2) THEN
    RAISE EXCEPTION 'FAIL a later status event dropped the request to read comments';
  END IF;
  -- jobs are not readable by agents; managers see their own workspace only
  IF pg_temp.run(agent_a, 'SELECT count(*)::text FROM jira_sync_jobs') <> '0'
  OR pg_temp.run(owner_b, 'SELECT count(*)::text FROM jira_sync_jobs') <> '0'
  OR pg_temp.run(admin_a, 'SELECT count(*)::text FROM jira_sync_jobs') = '0' THEN
    RAISE EXCEPTION 'FAIL jira_sync_jobs visibility';
  END IF;
  -- unknown job kinds are refused
  BEGIN
    INSERT INTO jira_sync_jobs (account_id, connection_id, kind) VALUES (a, conn_a, 'delete_issue');
    RAISE EXCEPTION 'FAIL an unknown job kind was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 6. Webhook de-duplication and the comment map
  -- ---------------------------------------------------------
  INSERT INTO jira_webhook_events (connection_id, delivery_id, event) VALUES (conn_a, 'delivery-1', 'comment_created');
  BEGIN
    INSERT INTO jira_webhook_events (connection_id, delivery_id, event) VALUES (conn_a, 'delivery-1', 'comment_created');
    RAISE EXCEPTION 'FAIL a repeated delivery id was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO jira_webhook_events (connection_id, delivery_id, event) VALUES (conn_b, 'delivery-1', 'comment_created');

  INSERT INTO ticket_comments (id, ticket_id, account_id, author_id, body) VALUES (cm1, t1, a, agent_a, 'Shared note');
  INSERT INTO jira_comment_map (account_id, link_id, ticket_comment_id, jira_comment_id, origin, body_hash)
    VALUES (a, link1, cm1, '9001', 'vircle', 'h1');
  BEGIN
    INSERT INTO jira_comment_map (account_id, link_id, jira_comment_id, origin) VALUES (a, link1, '9001', 'jira');
    RAISE EXCEPTION 'FAIL the same Jira comment mapped twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO jira_comment_map (account_id, link_id, ticket_comment_id, jira_comment_id, origin)
      VALUES (a, link1, cm1, '9002', 'vircle');
    RAISE EXCEPTION 'FAIL the same note mapped twice to one issue';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO jira_comment_map (account_id, link_id, jira_comment_id, origin) VALUES (a, link1, '9003', 'nobody');
    RAISE EXCEPTION 'FAIL an unknown origin was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- the same Jira comment id on another link (another ticket) is fine
  INSERT INTO jira_comment_map (account_id, link_id, jira_comment_id, origin) VALUES (a, link2, '9001', 'vircle');
  IF pg_temp.run(agent_a, 'SELECT count(*)::text FROM jira_comment_map') <> '2'
  OR pg_temp.run(owner_b, 'SELECT count(*)::text FROM jira_comment_map') <> '0' THEN
    RAISE EXCEPTION 'FAIL jira_comment_map visibility';
  END IF;
  -- user map: one row per member, one member per Jira account
  INSERT INTO jira_user_map (account_id, user_id, jira_account_id, jira_display_name, method)
    VALUES (a, agent_a, 'acct-agent', 'Maya', 'email');
  BEGIN
    INSERT INTO jira_user_map (account_id, user_id, jira_account_id, method) VALUES (a, admin_a, 'acct-agent', 'manual');
    RAISE EXCEPTION 'FAIL one Jira account mapped to two members';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF pg_temp.run(agent_a, 'SELECT count(*)::text FROM jira_user_map') <> '1'
  OR pg_temp.run(owner_b, 'SELECT count(*)::text FROM jira_user_map') <> '0'
  OR pg_temp.run(agent_a, format($q$INSERT INTO jira_user_map (account_id, user_id, jira_account_id, method) VALUES (%L, %L, 'x', 'manual')$q$, a, viewer_a)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL jira_user_map access';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 7. ticket_comments: a client cannot forge a note from Jira
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, format(
    $q$INSERT INTO ticket_comments (id, ticket_id, account_id, author_id, body, source, jira_author, jira_comment_id, deleted_in_jira)
       VALUES (%L, %L, %L, %L, 'forged', 'jira', 'Priya', '777', true)$q$, cm2, t1, a, agent_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL the agent insert: %', res; END IF;
  SELECT source, jira_author, jira_comment_id, deleted_in_jira INTO rec FROM ticket_comments WHERE id = cm2;
  IF rec.source <> 'vircle' OR rec.jira_author IS NOT NULL OR rec.jira_comment_id IS NOT NULL OR rec.deleted_in_jira THEN
    RAISE EXCEPTION 'FAIL a forged Jira note kept its markers: %', rec;
  END IF;
  res := pg_temp.run(agent_a, format(
    $q$UPDATE ticket_comments SET source = 'jira', jira_author = 'Priya', deleted_in_jira = true WHERE id = %L$q$, cm2));
  SELECT source, jira_author, deleted_in_jira INTO rec FROM ticket_comments WHERE id = cm2;
  IF rec.source <> 'vircle' OR rec.jira_author IS NOT NULL OR rec.deleted_in_jira THEN
    RAISE EXCEPTION 'FAIL an agent changed the Jira markers of a note';
  END IF;
  -- the service role (no user) writes real Jira notes, with no author
  INSERT INTO ticket_comments (id, ticket_id, account_id, author_id, body, source, jira_author, jira_comment_id)
    VALUES (cm3, t1, a, NULL, 'From engineering', 'jira', 'Priya (Engineering)', '5555');
  SELECT source, jira_author INTO rec FROM ticket_comments WHERE id = cm3;
  IF rec.source <> 'jira' OR rec.jira_author <> 'Priya (Engineering)' THEN RAISE EXCEPTION 'FAIL a Jira note was not stored'; END IF;
  PERFORM pg_temp.run(agent_a, format($q$UPDATE ticket_comments SET body = 'edit' WHERE id = %L$q$, cm3));
  PERFORM pg_temp.run(agent_a, format($q$DELETE FROM ticket_comments WHERE id = %L$q$, cm3));
  IF (SELECT body FROM ticket_comments WHERE id = cm3) IS DISTINCT FROM 'From engineering' THEN
    RAISE EXCEPTION 'FAIL an agent edited or deleted a Jira note';
  END IF;
  BEGIN
    INSERT INTO ticket_comments (ticket_id, account_id, body, source) VALUES (t1, a, 'x', 'slack');
    RAISE EXCEPTION 'FAIL an unknown note source was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- watchers hear about a Jira note as "Jira · name"
  INSERT INTO ticket_watchers (ticket_id, user_id, account_id) VALUES (t1, admin_a, a) ON CONFLICT DO NOTHING;
  INSERT INTO ticket_comments (ticket_id, account_id, author_id, body, source, jira_author, jira_comment_id)
    VALUES (t1, a, NULL, 'Second', 'jira', 'Priya', '5556');
  IF NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = admin_a AND type = 'ticket_comment' AND body LIKE 'Jira · Priya commented%') THEN
    RAISE EXCEPTION 'FAIL a Jira note must notify watchers as Jira: %', (SELECT string_agg(user_id::text || ':' || type || ':' || COALESCE(body,''), ' | ') FROM notifications WHERE type = 'ticket_comment');
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 8. Outbound triggers and the "from Jira" path
  -- ---------------------------------------------------------
  DELETE FROM jira_sync_jobs WHERE connection_id = conn_a;
  -- an agent changes the status: one push job, coalesced on the second change
  res := pg_temp.run(agent_a, format($q$UPDATE tickets SET status = 'in_progress' WHERE id = %L$q$, t1));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL ticket update: %', res; END IF;
  res := pg_temp.run(agent_a, format($q$UPDATE tickets SET status = 'pending' WHERE id = %L$q$, t1));
  SELECT count(*), max(payload ->> 'status') INTO cnt, res FROM jira_sync_jobs
   WHERE connection_id = conn_a AND kind = 'push_status' AND status = 'pending';
  IF cnt <> 1 OR res <> 'pending' THEN RAISE EXCEPTION 'FAIL push job: % jobs, status %', cnt, res; END IF;
  IF (SELECT payload ->> 'ticket_id' FROM jira_sync_jobs WHERE kind = 'push_status') <> t1::text THEN
    RAISE EXCEPTION 'FAIL push job payload';
  END IF;
  -- a ticket without links, or a workspace with the toggle off, queues nothing
  DELETE FROM jira_sync_jobs WHERE connection_id = conn_a;
  PERFORM pg_temp.run(agent_a, format($q$UPDATE tickets SET status = 'in_progress' WHERE id = %L$q$, tb));
  UPDATE jira_connections SET settings = '{"direction": {"status_to_jira": false}}'::jsonb WHERE id = conn_a;
  PERFORM pg_temp.run(agent_a, format($q$UPDATE tickets SET status = 'in_progress' WHERE id = %L$q$, t2));
  IF (SELECT count(*) FROM jira_sync_jobs WHERE kind = 'push_status') <> 0 THEN
    RAISE EXCEPTION 'FAIL a push was queued with the toggle off or without a link';
  END IF;
  UPDATE jira_connections SET settings = '{"direction": {"status_to_jira": true}}'::jsonb WHERE id = conn_a;
  -- a status that came from Jira: no push (no echo), one "by Jira" activity row, stamps
  IF NOT jira_apply_ticket_status(t1, 'resolved', 'ENG-1') THEN RAISE EXCEPTION 'FAIL jira_apply_ticket_status'; END IF;
  IF (SELECT count(*) FROM jira_sync_jobs WHERE kind = 'push_status') <> 0 THEN
    RAISE EXCEPTION 'FAIL a change from Jira queued an outbound push';
  END IF;
  SELECT actor_id, from_value, to_value, detail INTO rec FROM ticket_activity
   WHERE ticket_id = t1 AND event_type = 'jira_status_synced';
  IF rec.actor_id IS NOT NULL OR rec.from_value <> 'pending' OR rec.to_value <> 'resolved' OR rec.detail <> 'ENG-1' THEN
    RAISE EXCEPTION 'FAIL the by-Jira activity row: %', rec;
  END IF;
  IF (SELECT count(*) FROM ticket_activity WHERE ticket_id = t1 AND event_type = 'status_changed' AND to_value = 'resolved') <> 0 THEN
    RAISE EXCEPTION 'FAIL the Jira status change was also logged as a person''s change';
  END IF;
  IF (SELECT resolved_at FROM tickets WHERE id = t1) IS NULL THEN RAISE EXCEPTION 'FAIL resolved_at not stamped'; END IF;
  IF jira_apply_ticket_status(t1, 'resolved', 'ENG-1') THEN RAISE EXCEPTION 'FAIL an equal value must not change the ticket'; END IF;
  IF (SELECT count(*) FROM ticket_activity WHERE ticket_id = t1 AND event_type = 'jira_status_synced') <> 1 THEN
    RAISE EXCEPTION 'FAIL an equal value wrote another activity row';
  END IF;
  -- the markers do not leak into the next change
  PERFORM pg_temp.run(agent_a, format($q$UPDATE tickets SET status = 'open' WHERE id = %L$q$, t1));
  IF (SELECT count(*) FROM jira_sync_jobs WHERE kind = 'push_status') <> 1
  OR NOT EXISTS (SELECT 1 FROM ticket_activity WHERE ticket_id = t1 AND event_type = 'status_changed' AND to_value = 'open' AND actor_id = agent_a) THEN
    RAISE EXCEPTION 'FAIL a later human change must queue a push and be logged as theirs';
  END IF;
  -- the watchers' notification names Jira
  IF NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'ticket_updated' AND body LIKE 'Jira moved % to Resolved%') THEN
    RAISE EXCEPTION 'FAIL the status notification must say Jira moved the ticket';
  END IF;
  -- editing a note that was shared with Jira queues an edit; other notes do not
  DELETE FROM jira_sync_jobs WHERE connection_id = conn_a;
  PERFORM pg_temp.run(agent_a, format($q$UPDATE ticket_comments SET body = 'Shared note v2' WHERE id = %L$q$, cm1));
  PERFORM pg_temp.run(agent_a, format($q$UPDATE ticket_comments SET body = 'forged v2' WHERE id = %L$q$, cm2));
  IF (SELECT count(*) FROM jira_sync_jobs WHERE kind = 'edit_comment') <> 1
  OR (SELECT payload ->> 'ticket_comment_id' FROM jira_sync_jobs WHERE kind = 'edit_comment') <> cm1::text THEN
    RAISE EXCEPTION 'FAIL edit_comment queueing';
  END IF;
  -- ticket activity accepts the new events and still refuses unknown ones
  INSERT INTO ticket_activity (ticket_id, account_id, event_type, to_value) VALUES (t1, a, 'jira_linked', 'ENG-1');
  INSERT INTO ticket_activity (ticket_id, account_id, event_type, to_value) VALUES (t1, a, 'jira_unlinked', 'ENG-1');
  INSERT INTO ticket_activity (ticket_id, account_id, event_type, to_value, detail) VALUES (t1, a, 'jira_status_pushed', 'In Progress', 'ENG-1');
  INSERT INTO ticket_activity (ticket_id, account_id, event_type) VALUES (t1, a, 'attachment_added');
  BEGIN
    INSERT INTO ticket_activity (ticket_id, account_id, event_type) VALUES (t1, a, 'jira_made_up');
    RAISE EXCEPTION 'FAIL an unknown activity event was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 9. Reconnect handling and notification types
  -- ---------------------------------------------------------
  PERFORM jira_mark_reauth(conn_a, 'invalid_grant');
  SELECT status, status_reason INTO rec FROM jira_connections WHERE id = conn_a;
  IF rec.status <> 'reauth_required' OR rec.status_reason <> 'invalid_grant' THEN RAISE EXCEPTION 'FAIL reauth status'; END IF;
  IF (SELECT count(*) FROM ticket_jira_links WHERE connection_id = conn_a AND sync_state = 'ok') <> 0
  OR (SELECT count(*) FROM ticket_jira_links WHERE connection_id = conn_a AND sync_state = 'paused') <> 6 THEN
    RAISE EXCEPTION 'FAIL links must pause, not disappear';
  END IF;
  -- the connecting user and the owners / admins are told; an agent with no linked ticket is not
  IF pg_temp.nc(admin_a, 'jira_reauth_required') <> 1 OR pg_temp.nc(owner_a, 'jira_reauth_required') <> 1
  OR pg_temp.nc(agent_a, 'jira_reauth_required') <> 0 OR pg_temp.nc(viewer_a, 'jira_reauth_required') <> 0
  OR pg_temp.nc(owner_b, 'jira_reauth_required') <> 0 THEN
    RAISE EXCEPTION 'FAIL reauth notifications reached the wrong people';
  END IF;
  PERFORM jira_mark_reauth(conn_a, 'invalid_grant');
  IF pg_temp.nc(admin_a, 'jira_reauth_required') <> 1 THEN RAISE EXCEPTION 'FAIL reauth notification was repeated within a day'; END IF;
  -- an assignee of a linked ticket is told too
  UPDATE tickets SET assigned_agent_id = agent_a WHERE id = t2;
  DELETE FROM notifications WHERE type = 'jira_reauth_required';
  UPDATE jira_connections SET status = 'active' WHERE id = conn_a;
  PERFORM jira_mark_reauth(conn_a, 'again');
  IF pg_temp.nc(agent_a, 'jira_reauth_required') <> 1 THEN RAISE EXCEPTION 'FAIL the ticket owner must be told'; END IF;
  -- a revoked connection is never flipped back to reauth
  UPDATE jira_connections SET status = 'revoked' WHERE id = conn_a;
  IF jira_mark_reauth(conn_a, 'x') <> 0 OR (SELECT status FROM jira_connections WHERE id = conn_a) <> 'revoked' THEN
    RAISE EXCEPTION 'FAIL a revoked connection was changed';
  END IF;
  UPDATE jira_connections SET status = 'active' WHERE id = conn_a;
  -- notification types: old ones still insert, new ones too, unknown ones refused
  FOREACH res IN ARRAY ARRAY['ticket_updated', 'ai_budget', 'conversation_assigned', 'mention', 'ticket_comment',
                             'approval_requested', 'approval_decided', 'jira_reauth_required', 'jira_issue_done'] LOOP
    INSERT INTO notifications (account_id, user_id, type, title) VALUES (a, owner_a, res, 't');
  END LOOP;
  BEGIN
    INSERT INTO notifications (account_id, user_id, type, title) VALUES (a, owner_a, 'made_up', 't');
    RAISE EXCEPTION 'FAIL the type check must still refuse unknown types';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 10. Audit rows
  -- ---------------------------------------------------------
  PERFORM jira_audit(a, admin_a, 'connected', 'jira_connection', conn_a, 'Acme',
                     '{"site": "Acme", "jira_user": "Vircle Integration"}'::jsonb);
  PERFORM jira_audit(a, agent_a, 'linked', 'ticket_jira_link', link1, 'ENG-1',
                     '{"ticket": "VIR-1", "issue": "ENG-1", "created": false}'::jsonb);
  PERFORM jira_audit(a, agent_a, 'unlinked', 'ticket_jira_link', link1, 'ENG-1', '{"ticket": "VIR-1"}'::jsonb);
  PERFORM jira_audit(a, admin_a, 'reconnected', 'jira_connection', conn_a, 'Acme', NULL);
  PERFORM jira_audit(a, admin_a, 'disconnected', 'jira_connection', conn_a, 'Acme', '{"purged": true}'::jsonb);
  PERFORM jira_audit(a, admin_a, 'updated', 'jira_connection', conn_a, 'Acme', '{"changed": ["mapping"]}'::jsonb);
  IF pg_temp.ac(a, format($c$entity_type = 'jira_connection' AND entity_id = %L$c$, conn_a)) <> 4
  OR pg_temp.ac(a, format($c$action = 'linked' AND entity_type = 'ticket_jira_link' AND actor_id = %L AND entity_label = 'ENG-1'$c$, agent_a)) <> 1
  OR pg_temp.ac(a, $c$action IN ('connected', 'disconnected', 'reconnected', 'unlinked') AND actor_kind = 'user'$c$) <> 4 THEN
    RAISE EXCEPTION 'FAIL jira audit rows';
  END IF;
  -- other entity types are refused; other accounts see nothing; clients cannot call it
  BEGIN
    PERFORM jira_audit(a, NULL, 'created', 'tag', NULL, 'x', NULL);
    RAISE EXCEPTION 'FAIL jira_audit accepted another entity type';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  IF pg_temp.run(admin_a, format($q$SELECT jira_audit(%L, NULL, 'created', 'jira_connection', NULL, 'x', NULL)::text$q$, a)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL a client called jira_audit';
  END IF;
  IF pg_temp.run(owner_b, format('SELECT count(*)::text FROM audit_log WHERE account_id = %L', a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL audit rows leaked across workspaces (owner b holds audit.view)';
  END IF;
  -- earlier audit actions still insert
  PERFORM log_audit(a, 'created', 'tag', NULL, 'still works', NULL);
  IF pg_temp.ac(a, $c$entity_label = 'still works'$c$) <> 1 THEN RAISE EXCEPTION 'FAIL the widened audit action check dropped an old action'; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 11. oauth_pending_connections accepts the jira channel
  -- ---------------------------------------------------------
  INSERT INTO oauth_pending_connections (account_id, initiated_by_user_id, channel, state)
    VALUES (a, admin_a, 'jira', 'state-' || gen_random_uuid());
  INSERT INTO oauth_pending_connections (account_id, initiated_by_user_id, channel, state)
    VALUES (a, admin_a, 'gmail', 'state-' || gen_random_uuid());
  BEGIN
    INSERT INTO oauth_pending_connections (account_id, initiated_by_user_id, channel, state)
      VALUES (a, admin_a, 'carrier-pigeon', 'state-' || gen_random_uuid());
    RAISE EXCEPTION 'FAIL an unknown oauth channel was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 12. Retention
  -- ---------------------------------------------------------
  INSERT INTO jira_webhook_events (connection_id, delivery_id, received_at) VALUES (conn_a, 'old-delivery', now() - interval '8 days');
  INSERT INTO jira_sync_events (account_id, connection_id, kind, created_at) VALUES (a, conn_a, 'old', now() - interval '31 days');
  IF jira_prune() < 2 THEN RAISE EXCEPTION 'FAIL jira_prune removed nothing'; END IF;
  IF EXISTS (SELECT 1 FROM jira_webhook_events WHERE delivery_id = 'old-delivery')
  OR NOT EXISTS (SELECT 1 FROM jira_webhook_events WHERE delivery_id = 'delivery-1' AND connection_id = conn_a)
  OR EXISTS (SELECT 1 FROM jira_sync_events WHERE kind = 'old') THEN
    RAISE EXCEPTION 'FAIL jira_prune kept or removed the wrong rows';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 13. Cascades: deleting a ticket, a connection, a workspace
  -- ---------------------------------------------------------
  DELETE FROM tickets WHERE id = t2;
  IF EXISTS (SELECT 1 FROM ticket_jira_links WHERE id = link2)
  OR EXISTS (SELECT 1 FROM jira_comment_map WHERE link_id = link2) THEN
    RAISE EXCEPTION 'FAIL deleting a ticket must delete its links and their comment map';
  END IF;
  DELETE FROM ticket_comments WHERE id = cm1;
  IF (SELECT ticket_comment_id FROM jira_comment_map WHERE link_id = link1 AND jira_comment_id = '9001') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL deleting a note must clear its map row, not keep a dangling id';
  END IF;
  DELETE FROM accounts WHERE id = b;
  IF EXISTS (SELECT 1 FROM jira_connections WHERE account_id = b)
  OR EXISTS (SELECT 1 FROM jira_connection_secrets WHERE connection_id = conn_b)
  OR EXISTS (SELECT 1 FROM jira_webhook_events WHERE connection_id = conn_b) THEN
    RAISE EXCEPTION 'FAIL account deletion must remove its Jira data';
  END IF;
  DELETE FROM jira_connections WHERE id = conn_a;
  IF EXISTS (SELECT 1 FROM ticket_jira_links WHERE connection_id = conn_a)
  OR EXISTS (SELECT 1 FROM jira_connection_secrets WHERE connection_id = conn_a)
  OR EXISTS (SELECT 1 FROM jira_sync_jobs WHERE connection_id = conn_a) THEN
    RAISE EXCEPTION 'FAIL deleting a connection must remove secrets, links and jobs';
  END IF;
  n := n + 1;

  RAISE EXCEPTION 'ROLLBACK-OK: % check groups passed', n;
END
$verify$;
