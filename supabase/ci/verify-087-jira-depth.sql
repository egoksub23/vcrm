-- ============================================================
-- Verification for migration 087 (Jira depth: attachments, field mapping,
-- bulk actions, hardening).
--
-- Run against a database that already has 085 (and 087 applied), or, before
-- 087 ships, run supabase/ci/drafts/087_jira_depth.sql and this file as ONE
-- script:
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
  fd1      UUID := gen_random_uuid();
  fd2      UUID := gen_random_uuid();
  fdb      UUID := gen_random_uuid();
  att1     UUID := gen_random_uuid();
  att2     UUID := gen_random_uuid();
  att3     UUID := gen_random_uuid();
  batch1   UUID;
  batch2   UUID;
  map1     UUID;
  n        INTEGER := 0;
  res      TEXT;
  cnt      INTEGER;
  rec      RECORD;
  ids_a    UUID[];
  ids_b    UUID[];
  j1       UUID;
  j2       UUID;
  ty       TEXT;
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

  -- ---------------------------------------------------------
  -- fixtures: users -> (trigger) accounts + profiles
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify087-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
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

  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (contact1, owner_a, a, '+10000000087', 'Casey');
  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (contact2, owner_b, b, '+10000000088', 'Dana');
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, created_by)
    VALUES (t1, a, 1, contact1, 'Login fails on Safari', agent_a);
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, created_by)
    VALUES (t2, a, 2, contact1, 'Invoice PDF is blank', agent_a);
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, created_by)
    VALUES (tb, b, 1, contact2, 'Other workspace', owner_b);

  INSERT INTO jira_connections (account_id, cloud_id, site_url, site_name, connected_by, settings)
    VALUES (a, '11111111-2222-4333-8444-555555555555', 'https://acme.atlassian.net', 'Acme', admin_a, '{}'::jsonb)
    RETURNING id INTO conn_a;
  INSERT INTO jira_connections (account_id, cloud_id, site_url, site_name, connected_by)
    VALUES (b, '99999999-2222-4333-8444-555555555555', 'https://other.atlassian.net', 'Other', owner_b)
    RETURNING id INTO conn_b;
  INSERT INTO ticket_jira_links (account_id, ticket_id, connection_id, issue_id, issue_key, project_key, summary,
                                 status_id, status_name, status_category, linked_by)
    VALUES (a, t1, conn_a, '10001', 'ENG-1', 'ENG', 'Issue 1', '1', 'To Do', 'new', agent_a)
    RETURNING id INTO link1;
  INSERT INTO ticket_jira_links (account_id, ticket_id, connection_id, issue_id, issue_key, project_key, summary,
                                 status_id, status_name, status_category, linked_by)
    VALUES (a, t2, conn_a, '10001', 'ENG-1', 'ENG', 'Issue 1', '1', 'To Do', 'new', agent_a)
    RETURNING id INTO link2;

  INSERT INTO ticket_field_definitions (id, account_id, label, field_type) VALUES (fd1, a, 'Browser', 'text');
  INSERT INTO ticket_field_definitions (id, account_id, label, field_type) VALUES (fd2, a, 'Urgent for VIP', 'checkbox');
  INSERT INTO ticket_field_definitions (id, account_id, label, field_type) VALUES (fdb, b, 'Other', 'text');

  -- ---------------------------------------------------------
  -- 1. New columns and the migration is in place
  -- ---------------------------------------------------------
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'jira_connections' AND column_name IN ('webhook_stats', 'last_report_result'))
           OR (table_name = 'ticket_jira_links' AND column_name = 'field_state')
           OR (table_name = 'ticket_attachments' AND column_name IN ('source', 'jira_attachment_id')))) <> 5 THEN
    RAISE EXCEPTION 'FAIL the new columns are missing';
  END IF;
  -- jira_connections still carries no secret-looking column
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'jira_connections'
                AND column_name ~ '(enc$|secret|refresh|access_token|webhook_token)') THEN
    RAISE EXCEPTION 'FAIL jira_connections carries a secret-looking column';
  END IF;
  -- members read the new columns of their own connection only
  IF pg_temp.run(agent_a, 'SELECT count(*)::text FROM jira_connections') <> '1'
  OR pg_temp.run(agent_a, 'SELECT (webhook_stats IS NOT NULL)::text FROM jira_connections') <> 'true'
  OR pg_temp.run(owner_b, format('SELECT count(*)::text FROM jira_connections WHERE id = %L', conn_a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL jira_connections visibility with the new columns';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 2. Webhook trust counters
  -- ---------------------------------------------------------
  PERFORM jira_bump_webhook_stat(conn_a, 'signed');
  PERFORM jira_bump_webhook_stat(conn_a, 'unsigned');
  PERFORM jira_bump_webhook_stat(conn_a, 'unsigned');
  PERFORM jira_bump_webhook_stat(conn_a, 'rejected_unsigned');
  SELECT webhook_stats INTO rec FROM jira_connections WHERE id = conn_a;
  IF (rec.webhook_stats ->> 'signed')::int <> 1 OR (rec.webhook_stats ->> 'unsigned')::int <> 2
     OR (rec.webhook_stats ->> 'rejected_unsigned')::int <> 1
     OR rec.webhook_stats -> 'since' IS NULL OR rec.webhook_stats -> 'last_unsigned_at' IS NULL THEN
    RAISE EXCEPTION 'FAIL webhook stats: %', rec.webhook_stats;
  END IF;
  BEGIN
    PERFORM jira_bump_webhook_stat(conn_a, 'bogus');
    RAISE EXCEPTION 'FAIL an unknown webhook stat kind was accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;
  IF pg_temp.run(agent_a, format($q$SELECT jira_bump_webhook_stat(%L, 'signed')::text$q$, conn_a)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL a client could call jira_bump_webhook_stat';
  END IF;
  -- the personal-data report result is stored on the connection (service role writes it)
  UPDATE jira_connections SET last_report_result = '{"at": "2026-09-20T00:00:00Z", "ok": false, "error": "x"}'::jsonb WHERE id = conn_a;
  IF pg_temp.run(agent_a, 'SELECT (last_report_result ->> ''ok'') FROM jira_connections') <> 'false' THEN
    RAISE EXCEPTION 'FAIL last_report_result is not readable';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 3. ticket_attachments: a client cannot claim a file came from Jira
  -- ---------------------------------------------------------
  IF pg_temp.run(agent_a, format(
       $q$INSERT INTO ticket_attachments (id, ticket_id, account_id, storage_path, url, filename, uploaded_by, source, jira_attachment_id)
          VALUES (%L, %L, %L, 'account-x/tickets/a.png', 'https://x/a.png', 'a.png', %L, 'jira', '777')$q$,
       att1, t1, a, agent_a)) <> 'OK' THEN
    RAISE EXCEPTION 'FAIL an agent could not add an attachment';
  END IF;
  SELECT source, jira_attachment_id INTO rec FROM ticket_attachments WHERE id = att1;
  IF rec.source <> 'vircle' OR rec.jira_attachment_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a client forged source/jira_attachment_id: %', rec;
  END IF;
  -- the same on UPDATE (run with the client's identity but the owner's table rights, so the guard trigger is what stops it)
  PERFORM pg_temp.run(agent_a, format($q$UPDATE ticket_attachments SET source = 'jira', jira_attachment_id = '1' WHERE id = %L$q$, att1), 'postgres');
  SELECT source, jira_attachment_id INTO rec FROM ticket_attachments WHERE id = att1;
  IF rec.source <> 'vircle' OR rec.jira_attachment_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a client changed where an attachment came from';
  END IF;
  -- the service role (no user session) can store a file that came from Jira
  INSERT INTO ticket_attachments (id, ticket_id, account_id, storage_path, url, filename, uploaded_by, source, jira_attachment_id)
    VALUES (att2, t1, a, 'account-x/tickets/j.png', 'https://x/j.png', 'j.png', NULL, 'jira', '9001');
  IF (SELECT source FROM ticket_attachments WHERE id = att2) <> 'jira' THEN
    RAISE EXCEPTION 'FAIL the service role could not store a Jira file';
  END IF;
  BEGIN
    INSERT INTO ticket_attachments (ticket_id, account_id, storage_path, url, filename, source)
      VALUES (t1, a, 'p', 'u', 'f', 'other');
    RAISE EXCEPTION 'FAIL an unknown attachment source was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- members read both, nobody else
  IF pg_temp.run(viewer_a, 'SELECT count(*)::text FROM ticket_attachments') <> '2'
  OR pg_temp.run(owner_b, 'SELECT count(*)::text FROM ticket_attachments') <> '0' THEN
    RAISE EXCEPTION 'FAIL ticket_attachments visibility';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 4. jira_attachment_map: uniqueness (duplicates and echo), RLS
  -- ---------------------------------------------------------
  INSERT INTO jira_attachment_map (account_id, link_id, ticket_attachment_id, jira_attachment_id, direction, status, content_hash, filename)
    VALUES (a, link1, att1, '5001', 'to_jira', 'synced', 'hash-1', 'a.png')
    RETURNING id INTO map1;
  -- the same Jira attachment twice on one link
  BEGIN
    INSERT INTO jira_attachment_map (account_id, link_id, jira_attachment_id, direction) VALUES (a, link1, '5001', 'from_jira');
    RAISE EXCEPTION 'FAIL the same Jira attachment was recorded twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- the same ticket attachment sent to one link twice
  BEGIN
    INSERT INTO jira_attachment_map (account_id, link_id, ticket_attachment_id, jira_attachment_id, direction, status, content_hash)
      VALUES (a, link1, att1, '5002', 'to_jira', 'synced', 'hash-other');
    RAISE EXCEPTION 'FAIL a ticket attachment was sent to one issue twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- the same bytes on one issue twice
  BEGIN
    INSERT INTO jira_attachment_map (account_id, link_id, jira_attachment_id, direction, status, content_hash)
      VALUES (a, link1, '5003', 'from_jira', 'synced', 'hash-1');
    RAISE EXCEPTION 'FAIL the same content hash was stored twice on one issue';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- a recorded duplicate and skipped files do not collide
  INSERT INTO jira_attachment_map (account_id, link_id, jira_attachment_id, direction, status, content_hash)
    VALUES (a, link1, '5004', 'from_jira', 'duplicate', NULL);
  INSERT INTO jira_attachment_map (account_id, link_id, jira_attachment_id, direction, status, filename, mime_type, jira_url)
    VALUES (a, link1, '5005', 'from_jira', 'skipped_type', 'demo.exe', 'application/x-msdownload', 'https://acme.atlassian.net/secure/attachment/5005/demo.exe');
  -- the same file on ANOTHER link (another issue) is fine
  INSERT INTO jira_attachment_map (account_id, link_id, ticket_attachment_id, jira_attachment_id, direction, status, content_hash)
    VALUES (a, link2, att1, '6001', 'to_jira', 'synced', 'hash-1');
  -- bad values
  BEGIN
    INSERT INTO jira_attachment_map (account_id, link_id, jira_attachment_id, direction) VALUES (a, link1, '5006', 'sideways');
    RAISE EXCEPTION 'FAIL a bad direction was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO jira_attachment_map (account_id, link_id, jira_attachment_id, direction, status) VALUES (a, link1, '5007', 'to_jira', 'maybe');
    RAISE EXCEPTION 'FAIL a bad status was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- removing the ticket attachment keeps the map row (the file is still in Jira) and its hash
  DELETE FROM ticket_attachments WHERE id = att1;
  IF (SELECT ticket_attachment_id FROM jira_attachment_map WHERE id = map1) IS NOT NULL
     OR (SELECT content_hash FROM jira_attachment_map WHERE id = map1) <> 'hash-1' THEN
    RAISE EXCEPTION 'FAIL removing a ticket attachment must clear the link but keep the hash';
  END IF;
  -- RLS: members read their workspace only, nobody writes from the client
  IF pg_temp.run(agent_a, 'SELECT count(*)::text FROM jira_attachment_map') <> '4'
  OR pg_temp.run(owner_b, 'SELECT count(*)::text FROM jira_attachment_map') <> '0'
  OR pg_temp.run(agent_a, format($q$UPDATE jira_attachment_map SET status = 'failed' WHERE id = %L$q$, map1)) NOT LIKE 'ERR 42501%'
  OR pg_temp.run(agent_a, format($q$DELETE FROM jira_attachment_map WHERE id = %L$q$, map1)) NOT LIKE 'ERR 42501%'
  OR pg_temp.run(agent_a, format(
       $q$INSERT INTO jira_attachment_map (account_id, link_id, jira_attachment_id, direction) VALUES (%L, %L, '1', 'to_jira')$q$, a, link1)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL jira_attachment_map access';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 5. jira_field_mappings: uniqueness, guard, RLS, cascade
  -- ---------------------------------------------------------
  INSERT INTO jira_field_mappings (account_id, connection_id, project_key, ticket_field_id, jira_field_id, jira_field_name, jira_kind, direction)
    VALUES (a, conn_a, 'ENG', fd1, 'customfield_10042', 'Browser', 'text', 'both');
  INSERT INTO jira_field_mappings (account_id, connection_id, project_key, ticket_field_id, jira_field_id, jira_field_name, jira_kind, direction, when_missing, config)
    VALUES (a, conn_a, '*', fd2, 'labels', 'Labels', 'labels', 'to_jira', 'clear', '{"label": "vip"}'::jsonb);
  BEGIN
    INSERT INTO jira_field_mappings (account_id, connection_id, project_key, ticket_field_id, jira_field_id, jira_field_name, jira_kind)
      VALUES (a, conn_a, 'ENG', fd1, 'customfield_10043', 'Other', 'text');
    RAISE EXCEPTION 'FAIL one ticket field was mapped twice in one project';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- the same field in another project is fine
  INSERT INTO jira_field_mappings (account_id, connection_id, project_key, ticket_field_id, jira_field_id, jira_field_name, jira_kind)
    VALUES (a, conn_a, 'OPS', fd1, 'customfield_10099', 'Browser', 'text');
  -- guard: a field of another workspace
  BEGIN
    INSERT INTO jira_field_mappings (account_id, connection_id, project_key, ticket_field_id, jira_field_id, jira_field_name, jira_kind)
      VALUES (a, conn_a, 'ENG', fdb, 'customfield_1', 'X', 'text');
    RAISE EXCEPTION 'FAIL a mapping to another workspace field was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO jira_field_mappings (account_id, connection_id, project_key, ticket_field_id, jira_field_id, jira_field_name, jira_kind)
      VALUES (b, conn_a, 'ENG', fdb, 'customfield_1', 'X', 'text');
    RAISE EXCEPTION 'FAIL a mapping with the wrong account id was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- shape checks
  BEGIN
    INSERT INTO jira_field_mappings (account_id, connection_id, project_key, ticket_field_id, jira_field_id, jira_field_name, jira_kind)
      VALUES (a, conn_a, 'eng lower', fd2, 'customfield_2', 'X', 'text');
    RAISE EXCEPTION 'FAIL a bad project key was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO jira_field_mappings (account_id, connection_id, project_key, ticket_field_id, jira_field_id, jira_field_name, jira_kind)
      VALUES (a, conn_a, 'ENG', fd2, 'customfield_2', 'X', 'user');
    RAISE EXCEPTION 'FAIL an unsupported Jira kind was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO jira_field_mappings (account_id, connection_id, project_key, ticket_field_id, jira_field_id, jira_field_name, jira_kind)
      VALUES (a, conn_a, 'ENG', fd2, '../evil', 'X', 'text');
    RAISE EXCEPTION 'FAIL a hostile Jira field id was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- RLS: managers of the workspace read, agents and viewers do not, no client writes
  IF pg_temp.run(admin_a, 'SELECT count(*)::text FROM jira_field_mappings') <> '3'
  OR pg_temp.run(owner_a, 'SELECT count(*)::text FROM jira_field_mappings') <> '3'
  OR pg_temp.run(agent_a, 'SELECT count(*)::text FROM jira_field_mappings') <> '0'
  OR pg_temp.run(viewer_a, 'SELECT count(*)::text FROM jira_field_mappings') <> '0'
  OR pg_temp.run(owner_b, 'SELECT count(*)::text FROM jira_field_mappings') <> '0'
  OR pg_temp.run(admin_a, format($q$DELETE FROM jira_field_mappings WHERE connection_id = %L$q$, conn_a)) NOT LIKE 'ERR 42501%'
  OR pg_temp.run(admin_a, format($q$UPDATE jira_field_mappings SET direction = 'to_jira' WHERE connection_id = %L$q$, conn_a)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL jira_field_mappings access';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 6. The metadata cache: no client access at all
  -- ---------------------------------------------------------
  INSERT INTO jira_field_meta_cache (connection_id, account_id, project_key, issue_type_id, fields)
    VALUES (conn_a, a, 'ENG', '10004', '[{"id": "customfield_10042"}]'::jsonb);
  FOREACH res IN ARRAY ARRAY['owner', 'admin', 'agent'] LOOP
    IF pg_temp.run(CASE res WHEN 'owner' THEN owner_a WHEN 'admin' THEN admin_a ELSE agent_a END,
                   'SELECT count(*)::text FROM jira_field_meta_cache') NOT LIKE 'ERR 42501%' THEN
      RAISE EXCEPTION 'FAIL a % could read jira_field_meta_cache', res;
    END IF;
  END LOOP;
  BEGIN
    INSERT INTO jira_field_meta_cache (connection_id, account_id, project_key, issue_type_id)
      VALUES (conn_a, a, 'ENG', '10004');
    RAISE EXCEPTION 'FAIL the cache accepted a duplicate key';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 7. Bulk batches and items
  -- ---------------------------------------------------------
  INSERT INTO jira_bulk_batches (account_id, connection_id, kind, created_by, total)
    VALUES (a, conn_a, 'create', agent_a, 2) RETURNING id INTO batch1;
  INSERT INTO jira_bulk_batches (account_id, connection_id, kind, created_by, total, target_issue_id, target_issue_key)
    VALUES (a, conn_a, 'link', agent_a, 2, '10001', 'ENG-1') RETURNING id INTO batch2;
  INSERT INTO jira_bulk_items (batch_id, account_id, ticket_id, project_key, issue_type_id) VALUES (batch1, a, t1, 'ENG', '10004');
  INSERT INTO jira_bulk_items (batch_id, account_id, ticket_id, project_key, issue_type_id) VALUES (batch1, a, t2, 'ENG', '10004');
  BEGIN
    INSERT INTO jira_bulk_items (batch_id, account_id, ticket_id) VALUES (batch1, a, t1);
    RAISE EXCEPTION 'FAIL a ticket was added twice to one batch';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO jira_bulk_batches (account_id, connection_id, kind, total) VALUES (a, conn_a, 'create', 26);
    RAISE EXCEPTION 'FAIL a batch of 26 was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO jira_bulk_batches (account_id, connection_id, kind, total) VALUES (a, conn_a, 'sideways', 1);
    RAISE EXCEPTION 'FAIL a bad batch kind was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO jira_bulk_items (batch_id, account_id, ticket_id, status) VALUES (batch2, a, t1, 'exploded');
    RAISE EXCEPTION 'FAIL a bad item status was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- jira.link holders (agents) read their workspace, viewers and other workspaces do not, nobody writes
  IF pg_temp.run(agent_a, 'SELECT count(*)::text FROM jira_bulk_batches') <> '2'
  OR pg_temp.run(agent_a, 'SELECT count(*)::text FROM jira_bulk_items') <> '2'
  OR pg_temp.run(viewer_a, 'SELECT count(*)::text FROM jira_bulk_batches') <> '0'
  OR pg_temp.run(owner_b, 'SELECT count(*)::text FROM jira_bulk_batches') <> '0'
  OR pg_temp.run(owner_b, 'SELECT count(*)::text FROM jira_bulk_items') <> '0'
  OR pg_temp.run(agent_a, format($q$UPDATE jira_bulk_items SET status = 'done' WHERE batch_id = %L$q$, batch1)) NOT LIKE 'ERR 42501%'
  OR pg_temp.run(agent_a, format($q$DELETE FROM jira_bulk_batches WHERE id = %L$q$, batch1)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL bulk table access';
  END IF;
  -- deleting a ticket removes its item; deleting a batch removes its items
  DELETE FROM tickets WHERE id = t2;
  IF (SELECT count(*) FROM jira_bulk_items WHERE batch_id = batch1) <> 1 THEN
    RAISE EXCEPTION 'FAIL deleting a ticket must remove its bulk item';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 8. The queue accepts the new job kinds and still refuses others
  -- ---------------------------------------------------------
  FOREACH ty IN ARRAY ARRAY['sync_issue', 'push_status', 'post_comment', 'edit_comment',
                            'push_fields', 'push_attachment', 'pull_attachments', 'bulk_item'] LOOP
    PERFORM jira_enqueue_job(a, conn_a, ty, '{}'::jsonb, 'kind-test:' || ty);
  END LOOP;
  BEGIN
    PERFORM jira_enqueue_job(a, conn_a, 'delete_everything', '{}'::jsonb, 'bad');
    RAISE EXCEPTION 'FAIL an unknown job kind was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- claim still works: two claimants get different jobs, none twice
  SELECT array_agg(id) INTO ids_a FROM jira_claim_jobs(3, 'wA', 120);
  SELECT array_agg(id) INTO ids_b FROM jira_claim_jobs(50, 'wB', 120);
  IF cardinality(ids_a) <> 3 OR ids_a && ids_b THEN
    RAISE EXCEPTION 'FAIL two claimants must get different jobs (% / %)', ids_a, ids_b;
  END IF;
  IF cardinality(ids_a) + cardinality(ids_b) < 8 THEN
    RAISE EXCEPTION 'FAIL the claims did not cover all eight kinds';
  END IF;
  IF (SELECT count(*) FROM jira_claim_jobs(50, 'wC', 120)) <> 0 THEN
    RAISE EXCEPTION 'FAIL a third claim found work that is already taken';
  END IF;
  IF jira_finish_job(ids_a[1], 'wA', 'ok') <> 'done' OR jira_finish_job(ids_a[2], 'wB', 'ok') <> 'lost' THEN
    RAISE EXCEPTION 'FAIL finishing jobs';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 9. notifications CHECK keeps every earlier value and adds jira_sync_stalled
  -- ---------------------------------------------------------
  FOREACH ty IN ARRAY ARRAY['conversation_assigned', 'mention', 'ticket_assigned', 'ticket_mention', 'ai_budget',
                            'ticket_updated', 'ticket_comment', 'approval_requested', 'approval_decided',
                            'jira_reauth_required', 'jira_issue_done', 'jira_sync_stalled'] LOOP
    BEGIN
      INSERT INTO notifications (account_id, user_id, type, title, body) VALUES (a, owner_a, ty, 't', 'b');
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION 'FAIL the notification type % is no longer accepted', ty;
    END;
  END LOOP;
  BEGIN
    INSERT INTO notifications (account_id, user_id, type, title, body) VALUES (a, owner_a, 'made_up_type', 't', 'b');
    RAISE EXCEPTION 'FAIL an unknown notification type was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  DELETE FROM notifications WHERE user_id = owner_a AND type = 'jira_sync_stalled';
  n := n + 1;

  -- ---------------------------------------------------------
  -- 10. jira_notify_stalled: owners and admins, once a day
  -- ---------------------------------------------------------
  IF jira_notify_stalled(conn_a, 45) <> 2 THEN
    RAISE EXCEPTION 'FAIL the stall alert must reach the owner and the admin (got %)', jira_notify_stalled(conn_a, 45);
  END IF;
  IF (SELECT count(*) FROM notifications WHERE type = 'jira_sync_stalled' AND account_id = a) <> 2
  OR (SELECT count(*) FROM notifications WHERE type = 'jira_sync_stalled' AND user_id IN (agent_a, viewer_a, owner_b)) <> 0 THEN
    RAISE EXCEPTION 'FAIL the stall alert reached the wrong people';
  END IF;
  IF jira_notify_stalled(conn_a, 45) <> 0 THEN
    RAISE EXCEPTION 'FAIL the stall alert must not repeat within a day';
  END IF;
  UPDATE notifications SET created_at = now() - interval '25 hours' WHERE type = 'jira_sync_stalled' AND account_id = a;
  IF jira_notify_stalled(conn_a, 45) <> 2 THEN
    RAISE EXCEPTION 'FAIL the stall alert must come again after a day';
  END IF;
  -- a connection that needs reconnecting gets the reauth alert, not this one
  UPDATE jira_connections SET status = 'reauth_required' WHERE id = conn_b;
  IF jira_notify_stalled(conn_b, 45) <> 0 THEN
    RAISE EXCEPTION 'FAIL a connection that is not active must not raise the stall alert';
  END IF;
  IF pg_temp.run(agent_a, format($q$SELECT jira_notify_stalled(%L, 45)::text$q$, conn_a)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL a client could call jira_notify_stalled';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 11. Custom-field edits queue a push; a value from Jira never does
  -- ---------------------------------------------------------
  UPDATE jira_sync_jobs SET status = 'done', finished_at = now() WHERE connection_id = conn_a;
  -- t1 has an ok link and mapping fd1 (to/both) -> a push_fields job
  IF pg_temp.run(agent_a, format($q$UPDATE tickets SET custom_fields = jsonb_build_object(%L, 'Safari 17') WHERE id = %L$q$, fd1::text, t1)) <> 'OK' THEN
    RAISE EXCEPTION 'FAIL an agent could not edit a custom field';
  END IF;
  SELECT count(*) INTO cnt FROM jira_sync_jobs WHERE connection_id = conn_a AND kind = 'push_fields' AND status = 'pending';
  IF cnt <> 1 THEN RAISE EXCEPTION 'FAIL a field edit must queue exactly one push_fields job (got %)', cnt; END IF;
  IF (SELECT next_try_at FROM jira_sync_jobs WHERE kind = 'push_fields' AND status = 'pending' AND connection_id = conn_a) < now() + interval '3 seconds' THEN
    RAISE EXCEPTION 'FAIL the field push must wait a few seconds so a burst of edits is one write';
  END IF;
  -- a second edit coalesces into the same pending job
  PERFORM pg_temp.run(agent_a, format($q$UPDATE tickets SET custom_fields = jsonb_build_object(%L, 'Safari 18') WHERE id = %L$q$, fd1::text, t1));
  IF (SELECT count(*) FROM jira_sync_jobs WHERE connection_id = conn_a AND kind = 'push_fields' AND status = 'pending') <> 1 THEN
    RAISE EXCEPTION 'FAIL a burst of field edits must stay one job';
  END IF;
  -- a value applied FROM Jira: merged, activity kept, nothing queued
  UPDATE jira_sync_jobs SET status = 'done', finished_at = now() WHERE connection_id = conn_a AND kind = 'push_fields';
  IF NOT jira_apply_ticket_fields(t1, jsonb_build_object(fd2::text, true, fd1::text, 'Firefox 130')) THEN
    RAISE EXCEPTION 'FAIL jira_apply_ticket_fields changed nothing';
  END IF;
  IF (SELECT custom_fields ->> fd1::text FROM tickets WHERE id = t1) <> 'Firefox 130'
  OR (SELECT (custom_fields -> fd2::text)::text FROM tickets WHERE id = t1) <> 'true' THEN
    RAISE EXCEPTION 'FAIL jira_apply_ticket_fields did not merge the values';
  END IF;
  IF (SELECT count(*) FROM jira_sync_jobs WHERE connection_id = conn_a AND kind = 'push_fields' AND status = 'pending') <> 0 THEN
    RAISE EXCEPTION 'FAIL a field value that came from Jira was queued back to Jira';
  END IF;
  IF jira_apply_ticket_fields(t1, jsonb_build_object(fd2::text, true)) THEN
    RAISE EXCEPTION 'FAIL applying the same value again must change nothing';
  END IF;
  IF NOT jira_apply_ticket_fields(t1, jsonb_build_object(fd2::text, NULL)) THEN
    RAISE EXCEPTION 'FAIL clearing a value from Jira did nothing';
  END IF;
  IF (SELECT custom_fields ? fd2::text FROM tickets WHERE id = t1) THEN
    RAISE EXCEPTION 'FAIL a JSON null must clear the field';
  END IF;
  IF COALESCE(current_setting('vircle.source', true), '') <> '' THEN
    RAISE EXCEPTION 'FAIL the source marker leaked out of jira_apply_ticket_fields';
  END IF;
  IF pg_temp.run(agent_a, format($q$SELECT jira_apply_ticket_fields(%L, '{}'::jsonb)::text$q$, t1)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL a client could call jira_apply_ticket_fields';
  END IF;
  -- with only from_jira mappings a ticket edit queues nothing
  DELETE FROM jira_field_mappings WHERE connection_id = conn_a;
  INSERT INTO jira_field_mappings (account_id, connection_id, project_key, ticket_field_id, jira_field_id, jira_field_name, jira_kind, direction)
    VALUES (a, conn_a, 'ENG', fd1, 'customfield_10042', 'Browser', 'text', 'from_jira');
  PERFORM pg_temp.run(agent_a, format($q$UPDATE tickets SET custom_fields = jsonb_build_object(%L, 'Edge') WHERE id = %L$q$, fd1::text, t1));
  IF (SELECT count(*) FROM jira_sync_jobs WHERE connection_id = conn_a AND kind = 'push_fields' AND status = 'pending') <> 0 THEN
    RAISE EXCEPTION 'FAIL a from-Jira-only mapping must not queue a push';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 12. Attachments: "send all new attachments" queues, a Jira file never does
  -- ---------------------------------------------------------
  UPDATE jira_sync_jobs SET status = 'done', finished_at = now() WHERE connection_id = conn_a;
  -- attachments on but not "send all": nothing queued
  UPDATE jira_connections SET settings = '{"direction": {"attachments": true, "attachments_auto": false}}'::jsonb WHERE id = conn_a;
  PERFORM pg_temp.run(agent_a, format(
    $q$INSERT INTO ticket_attachments (id, ticket_id, account_id, storage_path, url, filename, uploaded_by)
       VALUES (%L, %L, %L, 'account-x/tickets/b.png', 'https://x/b.png', 'b.png', %L)$q$, att3, t1, a, agent_a));
  IF (SELECT count(*) FROM jira_sync_jobs WHERE connection_id = conn_a AND kind = 'push_attachment' AND status = 'pending') <> 0 THEN
    RAISE EXCEPTION 'FAIL an attachment was queued without "send all new attachments"';
  END IF;
  -- "send all new attachments" on: queued once, marked auto
  DELETE FROM ticket_attachments WHERE id = att3;
  UPDATE jira_connections SET settings = '{"direction": {"attachments": true, "attachments_auto": true}}'::jsonb WHERE id = conn_a;
  PERFORM pg_temp.run(agent_a, format(
    $q$INSERT INTO ticket_attachments (id, ticket_id, account_id, storage_path, url, filename, uploaded_by)
       VALUES (%L, %L, %L, 'account-x/tickets/b.png', 'https://x/b.png', 'b.png', %L)$q$, att3, t1, a, agent_a));
  SELECT payload INTO rec FROM jira_sync_jobs WHERE connection_id = conn_a AND kind = 'push_attachment' AND status = 'pending';
  IF rec.payload IS NULL OR (rec.payload ->> 'attachment_id') <> att3::text OR (rec.payload ->> 'auto') <> 'true' THEN
    RAISE EXCEPTION 'FAIL "send all new attachments" did not queue the file: %', rec;
  END IF;
  -- a file that came from Jira is never queued
  UPDATE jira_sync_jobs SET status = 'done', finished_at = now() WHERE connection_id = conn_a;
  INSERT INTO ticket_attachments (ticket_id, account_id, storage_path, url, filename, uploaded_by, source, jira_attachment_id)
    VALUES (t1, a, 'account-x/tickets/c.png', 'https://x/c.png', 'c.png', NULL, 'jira', '9002');
  IF (SELECT count(*) FROM jira_sync_jobs WHERE connection_id = conn_a AND kind = 'push_attachment' AND status = 'pending') <> 0 THEN
    RAISE EXCEPTION 'FAIL a file that came from Jira was queued back to Jira';
  END IF;
  -- a per-project override alone (workspace off) also queues
  UPDATE jira_connections
     SET settings = '{"project_overrides": {"ENG": {"direction": {"attachments": true, "attachments_auto": true}}}}'::jsonb
   WHERE id = conn_a;
  PERFORM pg_temp.run(agent_a, format(
    $q$INSERT INTO ticket_attachments (ticket_id, account_id, storage_path, url, filename, uploaded_by)
       VALUES (%L, %L, 'account-x/tickets/d.png', 'https://x/d.png', 'd.png', %L)$q$, t1, a, agent_a));
  IF (SELECT count(*) FROM jira_sync_jobs WHERE connection_id = conn_a AND kind = 'push_attachment' AND status = 'pending') <> 1 THEN
    RAISE EXCEPTION 'FAIL a project override for "send all new attachments" did not queue';
  END IF;
  -- everything off: nothing queued
  UPDATE jira_sync_jobs SET status = 'done', finished_at = now() WHERE connection_id = conn_a;
  UPDATE jira_connections SET settings = '{}'::jsonb WHERE id = conn_a;
  PERFORM pg_temp.run(agent_a, format(
    $q$INSERT INTO ticket_attachments (ticket_id, account_id, storage_path, url, filename, uploaded_by)
       VALUES (%L, %L, 'account-x/tickets/e.png', 'https://x/e.png', 'e.png', %L)$q$, t1, a, agent_a));
  IF (SELECT count(*) FROM jira_sync_jobs WHERE connection_id = conn_a AND kind = 'push_attachment' AND status = 'pending') <> 0 THEN
    RAISE EXCEPTION 'FAIL an attachment was queued with everything off';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 13. Status push honours a per-project override
  -- ---------------------------------------------------------
  UPDATE jira_sync_jobs SET status = 'done', finished_at = now() WHERE connection_id = conn_a;
  UPDATE tickets SET status = 'in_progress' WHERE id = t1;
  IF (SELECT count(*) FROM jira_sync_jobs WHERE connection_id = conn_a AND kind = 'push_status' AND status = 'pending') <> 0 THEN
    RAISE EXCEPTION 'FAIL a status push was queued although "status to Jira" is off everywhere';
  END IF;
  UPDATE jira_connections SET settings = '{"direction": {"status_to_jira": true}}'::jsonb WHERE id = conn_a;
  UPDATE tickets SET status = 'open' WHERE id = t1;
  IF (SELECT count(*) FROM jira_sync_jobs WHERE connection_id = conn_a AND kind = 'push_status' AND status = 'pending') <> 1 THEN
    RAISE EXCEPTION 'FAIL the workspace status push stopped working';
  END IF;
  UPDATE jira_sync_jobs SET status = 'done', finished_at = now() WHERE connection_id = conn_a;
  UPDATE jira_connections
     SET settings = '{"direction": {"status_to_jira": false}, "project_overrides": {"ENG": {"direction": {"status_to_jira": true}}}}'::jsonb
   WHERE id = conn_a;
  UPDATE tickets SET status = 'in_progress' WHERE id = t1;
  IF (SELECT count(*) FROM jira_sync_jobs WHERE connection_id = conn_a AND kind = 'push_status' AND status = 'pending') <> 1 THEN
    RAISE EXCEPTION 'FAIL a project override for "status to Jira" did not queue a push';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 14. jira_prune retires old bulk batches and cached metadata
  -- ---------------------------------------------------------
  UPDATE jira_bulk_batches SET created_at = now() - interval '31 days' WHERE id = batch2;
  UPDATE jira_field_meta_cache SET fetched_at = now() - interval '8 days' WHERE connection_id = conn_a;
  IF jira_prune() < 2 THEN RAISE EXCEPTION 'FAIL jira_prune removed nothing'; END IF;
  IF EXISTS (SELECT 1 FROM jira_bulk_batches WHERE id = batch2)
  OR NOT EXISTS (SELECT 1 FROM jira_bulk_batches WHERE id = batch1)
  OR EXISTS (SELECT 1 FROM jira_field_meta_cache WHERE connection_id = conn_a) THEN
    RAISE EXCEPTION 'FAIL jira_prune kept or removed the wrong rows';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 15. Cascades: a link, a connection, a workspace
  -- ---------------------------------------------------------
  -- (t2 was deleted in section 7, which took link2 and its attachment map with it)
  IF EXISTS (SELECT 1 FROM jira_attachment_map WHERE link_id = link2) THEN
    RAISE EXCEPTION 'FAIL deleting a ticket must delete its links attachment map';
  END IF;
  INSERT INTO jira_field_meta_cache (connection_id, account_id, project_key, issue_type_id)
    VALUES (conn_a, a, 'ENG', '10004');
  DELETE FROM jira_connections WHERE id = conn_a;
  IF EXISTS (SELECT 1 FROM jira_field_mappings WHERE connection_id = conn_a)
  OR EXISTS (SELECT 1 FROM jira_bulk_batches WHERE connection_id = conn_a)
  OR EXISTS (SELECT 1 FROM jira_attachment_map WHERE link_id = link1)
  OR EXISTS (SELECT 1 FROM jira_field_meta_cache WHERE connection_id = conn_a) THEN
    RAISE EXCEPTION 'FAIL deleting a connection must remove mappings, batches, maps and metadata';
  END IF;
  DELETE FROM accounts WHERE id = b;
  IF EXISTS (SELECT 1 FROM jira_connections WHERE account_id = b) THEN
    RAISE EXCEPTION 'FAIL account deletion must remove its Jira data';
  END IF;
  n := n + 1;

  RAISE EXCEPTION 'ROLLBACK-OK: % check groups passed', n;
END
$verify$;
