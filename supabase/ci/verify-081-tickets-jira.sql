-- ============================================================
-- Verification for migration 081 (Jira-style tickets).
--
-- Run against a database that already has 081 applied:
--   supabase db query --linked -f supabase/ci/verify-081-tickets-jira.sql
--
-- Everything happens inside one DO block that ends with
-- RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing is ever committed.
-- A message starting with ROLLBACK-OK means every check passed; any
-- other error message names the check that failed.
--
-- Users act the way PostgREST runs them: JWT claims plus
-- SET LOCAL ROLE authenticated, so RLS applies for real.
-- ============================================================

DO $verify$
DECLARE
  a        UUID;                       -- account A
  b        UUID;                       -- account B (isolation)
  owner_a  UUID := gen_random_uuid();
  agent_a  UUID := gen_random_uuid();  -- creator / actor
  agent2_a UUID := gen_random_uuid();  -- first assignee
  admin_a  UUID := gen_random_uuid();  -- second assignee
  viewer_a UUID := gen_random_uuid();
  owner_b  UUID := gen_random_uuid();
  contact_a UUID := gen_random_uuid();
  contact_b UUID := gen_random_uuid();
  t1       UUID := gen_random_uuid();
  t2       UUID := gen_random_uuid();
  tb       UUID := gen_random_uuid();
  c1       UUID := gen_random_uuid();
  att1     UUID := gen_random_uuid();
  sf_priv  UUID := gen_random_uuid();
  sf_shared UUID := gen_random_uuid();
  n        INTEGER := 0;
  r        TEXT;
  old_ts   TIMESTAMPTZ := now() - interval '1 day';
BEGIN
  -- ---------------------------------------------------------
  -- helpers (temp functions live only for this session)
  -- ---------------------------------------------------------
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT) RETURNS TEXT LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      BEGIN
        EXECUTE q INTO res;
      EXCEPTION WHEN OTHERS THEN
        res := 'ERR ' || SQLSTATE || ': ' || SQLERRM;
      END;
      EXECUTE 'RESET ROLE';
      RETURN res;
    END $b$;
  $f$;

  -- ---------------------------------------------------------
  -- fixtures
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify081-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, agent_a, agent2_a, admin_a, viewer_a, owner_b]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create accounts';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'agent'  WHERE user_id IN (agent_a, agent2_a);
  UPDATE profiles SET account_id = a, account_role = 'admin'  WHERE user_id = admin_a;
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = viewer_a;
  DELETE FROM accounts WHERE owner_user_id IN (agent_a, agent2_a, admin_a, viewer_a);

  INSERT INTO contacts (id, user_id, account_id, phone) VALUES (contact_a, owner_a, a, '+10000000001');
  INSERT INTO contacts (id, user_id, account_id, phone) VALUES (contact_b, owner_b, b, '+10000000002');

  -- ---------------------------------------------------------
  -- 1. Columns and defaults
  -- ---------------------------------------------------------
  IF (SELECT ticket_key_prefix FROM accounts WHERE id = a) IS DISTINCT FROM 'VIR' THEN
    RAISE EXCEPTION 'FAIL accounts.ticket_key_prefix default must be VIR';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='accounts'
                    AND column_name='ticket_key_prefix' AND is_nullable='NO') THEN
    RAISE EXCEPTION 'FAIL ticket_key_prefix must be NOT NULL';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='tickets'
         AND ((column_name='due_date' AND data_type='date' AND is_nullable='YES')
           OR (column_name='labels' AND data_type='ARRAY' AND is_nullable='NO')
           OR (column_name='board_rank' AND data_type='double precision' AND is_nullable='NO'))) <> 3 THEN
    RAISE EXCEPTION 'FAIL tickets.due_date / labels / board_rank shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='ticket_comments' AND column_name='edited_at') THEN
    RAISE EXCEPTION 'FAIL ticket_comments.edited_at missing';
  END IF;
  IF (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
        AND table_name IN ('ticket_watchers','ticket_links','ticket_attachments','ticket_saved_filters')) <> 4 THEN
    RAISE EXCEPTION 'FAIL new ticket tables missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_tickets_account_status_rank')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_tickets_labels' AND indexdef ILIKE '%gin%') THEN
    RAISE EXCEPTION 'FAIL board_rank / labels indexes missing';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 2. Prefix CHECK
  -- ---------------------------------------------------------
  FOREACH r IN ARRAY ARRAY['vir', 'V', 'ABCDEFG', '1AB', 'AB-C', ''] LOOP
    BEGIN
      UPDATE accounts SET ticket_key_prefix = r WHERE id = a;
      RAISE EXCEPTION 'FAIL prefix % was accepted', r;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  UPDATE accounts SET ticket_key_prefix = 'ACME2' WHERE id = a;
  UPDATE accounts SET ticket_key_prefix = 'VIR' WHERE id = a;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 3. Status CHECK accepts in_progress and still rejects junk
  -- ---------------------------------------------------------
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, status, created_by,
                       assigned_agent_id, updated_at, board_rank)
  VALUES (t1, a, 1, contact_a, 'First', 'in_progress', agent_a, agent2_a, old_ts, 100);
  BEGIN
    INSERT INTO tickets (account_id, ticket_number, contact_id, subject, status)
    VALUES (a, 99, contact_a, 'Bad', 'waiting');
    RAISE EXCEPTION 'FAIL status waiting was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- board_rank default: a fresh insert gets roughly now() in epoch seconds
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, created_by)
  VALUES (t2, a, 2, contact_a, 'Second', agent_a);
  IF abs((SELECT board_rank FROM tickets WHERE id = t2) - extract(epoch FROM now())) > 120 THEN
    RAISE EXCEPTION 'FAIL board_rank default is not the epoch time';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 4. Watchers: creator + assignee are added by the trigger
  -- ---------------------------------------------------------
  IF (SELECT count(*) FROM ticket_watchers WHERE ticket_id = t1) <> 2
     OR NOT EXISTS (SELECT 1 FROM ticket_watchers WHERE ticket_id = t1 AND user_id = agent_a)
     OR NOT EXISTS (SELECT 1 FROM ticket_watchers WHERE ticket_id = t1 AND user_id = agent2_a) THEN
    RAISE EXCEPTION 'FAIL creator and assignee must both be watchers on insert';
  END IF;
  IF (SELECT count(*) FROM ticket_watchers WHERE ticket_id = t2) <> 1 THEN
    RAISE EXCEPTION 'FAIL an unassigned ticket has only its creator as watcher';
  END IF;

  -- ---------------------------------------------------------
  -- 5. Notifications for watchers, never for the actor
  -- ---------------------------------------------------------
  r := pg_temp.run(agent_a, format(
    'WITH x AS (UPDATE tickets SET status = %L WHERE id = %L RETURNING 1) SELECT count(*)::text FROM x',
    'pending', t1));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL agent could not change status: %', r; END IF;
  IF (SELECT count(*) FROM notifications WHERE ticket_id = t1 AND type = 'ticket_updated' AND user_id = agent2_a) <> 1 THEN
    RAISE EXCEPTION 'FAIL the watcher must be told about a status change';
  END IF;
  IF EXISTS (SELECT 1 FROM notifications WHERE ticket_id = t1 AND user_id = agent_a) THEN
    RAISE EXCEPTION 'FAIL the actor must not be notified of their own change';
  END IF;

  -- reassign to admin_a: the old assignee (a watcher) hears about it via
  -- ticket_updated, the new assignee via ticket_assigned only.
  r := pg_temp.run(agent_a, format(
    'WITH x AS (UPDATE tickets SET assigned_agent_id = %L WHERE id = %L RETURNING 1) SELECT count(*)::text FROM x',
    admin_a, t1));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL agent could not reassign: %', r; END IF;
  IF (SELECT count(*) FROM notifications WHERE ticket_id = t1 AND type = 'ticket_updated' AND user_id = agent2_a) <> 2 THEN
    RAISE EXCEPTION 'FAIL the previous watcher must be told about the reassignment';
  END IF;
  IF (SELECT count(*) FROM notifications WHERE ticket_id = t1 AND type = 'ticket_assigned' AND user_id = admin_a) <> 1
     OR EXISTS (SELECT 1 FROM notifications WHERE ticket_id = t1 AND type = 'ticket_updated' AND user_id = admin_a) THEN
    RAISE EXCEPTION 'FAIL the new assignee gets ticket_assigned and no ticket_updated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ticket_watchers WHERE ticket_id = t1 AND user_id = admin_a) THEN
    RAISE EXCEPTION 'FAIL the new assignee must become a watcher';
  END IF;

  -- a comment that @mentions agent2_a: admin_a (watcher) gets ticket_comment,
  -- agent2_a gets ticket_mention only, the author gets nothing.
  r := pg_temp.run(agent_a, format(
    'WITH x AS (INSERT INTO ticket_comments (id, ticket_id, account_id, author_id, body, mentions) VALUES (%L, %L, %L, %L, %L, %L::jsonb) RETURNING 1) SELECT count(*)::text FROM x',
    c1, t1, a, agent_a, 'Hello team', json_build_array(agent2_a)::text));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL agent could not comment: %', r; END IF;
  IF (SELECT count(*) FROM notifications WHERE ticket_id = t1 AND type = 'ticket_comment' AND user_id = admin_a) <> 1 THEN
    RAISE EXCEPTION 'FAIL a watcher must be told about a new comment';
  END IF;
  IF EXISTS (SELECT 1 FROM notifications WHERE ticket_id = t1 AND type = 'ticket_comment' AND user_id IN (agent_a, agent2_a)) THEN
    RAISE EXCEPTION 'FAIL the author and a mentioned user must not get ticket_comment';
  END IF;
  IF (SELECT count(*) FROM notifications WHERE ticket_id = t1 AND type = 'ticket_mention' AND user_id = agent2_a) <> 1 THEN
    RAISE EXCEPTION 'FAIL the mention notification must still work';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 6. Watching is personal (RLS)
  -- ---------------------------------------------------------
  r := pg_temp.run(agent2_a, format(
    'WITH x AS (DELETE FROM ticket_watchers WHERE ticket_id = %L AND user_id = %L RETURNING 1) SELECT count(*)::text FROM x',
    t1, agent_a));
  IF r <> '0' THEN RAISE EXCEPTION 'FAIL an agent removed someone else as watcher: %', r; END IF;
  r := pg_temp.run(agent2_a, format(
    'WITH x AS (INSERT INTO ticket_watchers (ticket_id, user_id, account_id) VALUES (%L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    t2, agent2_a, a));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL an agent could not watch: %', r; END IF;
  r := pg_temp.run(agent2_a, format(
    'WITH x AS (INSERT INTO ticket_watchers (ticket_id, user_id, account_id) VALUES (%L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    t2, admin_a, a));
  IF r NOT LIKE 'ERR 42501:%' THEN RAISE EXCEPTION 'FAIL an agent added someone else as watcher: %', r; END IF;
  r := pg_temp.run(viewer_a, format(
    'WITH x AS (INSERT INTO ticket_watchers (ticket_id, user_id, account_id) VALUES (%L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    t2, viewer_a, a));
  IF r NOT LIKE 'ERR 42501:%' THEN RAISE EXCEPTION 'FAIL a viewer watched a ticket: %', r; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 7. Activity rows for the new fields
  -- ---------------------------------------------------------
  r := pg_temp.run(agent_a, format(
    'WITH x AS (UPDATE tickets SET due_date = %L, labels = %L, subject = %L, description = %L WHERE id = %L RETURNING 1) SELECT count(*)::text FROM x',
    '2026-10-01', '{vip,billing}'::text[], 'First (renamed)', 'Now with a description', t1));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL agent could not edit the ticket: %', r; END IF;
  IF (SELECT count(*) FROM ticket_activity WHERE ticket_id = t1 AND event_type = 'due_date_changed'
        AND from_value IS NULL AND to_value = '2026-10-01' AND actor_id = agent_a) <> 1 THEN
    RAISE EXCEPTION 'FAIL due_date_changed not logged';
  END IF;
  IF (SELECT count(*) FROM ticket_activity WHERE ticket_id = t1 AND event_type = 'labels_changed'
        AND from_value IS NULL AND to_value = 'vip,billing') <> 1 THEN
    RAISE EXCEPTION 'FAIL labels_changed not logged';
  END IF;
  IF (SELECT count(*) FROM ticket_activity WHERE ticket_id = t1 AND event_type = 'summary_changed'
        AND from_value = 'First' AND to_value = 'First (renamed)') <> 1 THEN
    RAISE EXCEPTION 'FAIL summary_changed not logged';
  END IF;
  IF (SELECT count(*) FROM ticket_activity WHERE ticket_id = t1 AND event_type = 'description_changed'
        AND from_value IS NULL AND to_value IS NULL) <> 1 THEN
    RAISE EXCEPTION 'FAIL description_changed not logged (with no values)';
  END IF;
  IF (SELECT count(*) FROM ticket_activity WHERE ticket_id = t1 AND event_type = 'status_changed') <> 1 THEN
    RAISE EXCEPTION 'FAIL status_changed must still log exactly once';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 8. Labels are normalised and capped
  -- ---------------------------------------------------------
  FOREACH r IN ARRAY ARRAY['{VIP}', '{" vip"}', '{""}', '{a,b,c,d,e,f,g,h,i,j,k}', '{aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}'] LOOP
    BEGIN
      UPDATE tickets SET labels = r::text[] WHERE id = t2;
      RAISE EXCEPTION 'FAIL labels % were accepted', r;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  UPDATE tickets SET labels = '{a,b,c,d,e,f,g,h,i,j}' WHERE id = t2;
  UPDATE tickets SET labels = '{}' WHERE id = t2;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 9. board_rank is not an edit; a real edit still bumps updated_at
  -- ---------------------------------------------------------
  -- t2 was inserted in this transaction, so plant a stale timestamp first
  -- (bypassing the trigger), then change only the rank.
  ALTER TABLE tickets DISABLE TRIGGER set_updated_at;
  UPDATE tickets SET updated_at = old_ts WHERE id = t2;
  ALTER TABLE tickets ENABLE TRIGGER set_updated_at;
  UPDATE tickets SET board_rank = 3 WHERE id = t2;
  IF (SELECT updated_at FROM tickets WHERE id = t2) <> old_ts THEN
    RAISE EXCEPTION 'FAIL board_rank-only update changed updated_at';
  END IF;
  UPDATE tickets SET priority = 'high' WHERE id = t2;
  IF (SELECT updated_at FROM tickets WHERE id = t2) <= old_ts THEN
    RAISE EXCEPTION 'FAIL a real edit must bump updated_at';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 10. Links: uniqueness, both sides logged, same-account only
  -- ---------------------------------------------------------
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, created_by)
  VALUES (tb, b, 1, contact_b, 'Other account', owner_b);

  r := pg_temp.run(agent_a, format(
    'WITH x AS (INSERT INTO ticket_links (account_id, from_ticket_id, to_ticket_id, link_type, created_by) VALUES (%L, %L, %L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    a, t1, t2, 'blocks', agent_a));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL agent could not link tickets: %', r; END IF;
  r := pg_temp.run(agent_a, format(
    'WITH x AS (INSERT INTO ticket_links (account_id, from_ticket_id, to_ticket_id, link_type, created_by) VALUES (%L, %L, %L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    a, t1, t2, 'blocks', agent_a));
  IF r NOT LIKE 'ERR 23505:%' THEN RAISE EXCEPTION 'FAIL duplicate link accepted: %', r; END IF;
  -- a different type between the same tickets is a different link
  r := pg_temp.run(agent_a, format(
    'WITH x AS (INSERT INTO ticket_links (account_id, from_ticket_id, to_ticket_id, link_type, created_by) VALUES (%L, %L, %L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    a, t1, t2, 'relates', agent_a));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL second link type refused: %', r; END IF;
  r := pg_temp.run(agent_a, format(
    'WITH x AS (INSERT INTO ticket_links (account_id, from_ticket_id, to_ticket_id, link_type, created_by) VALUES (%L, %L, %L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    a, t1, t1, 'relates', agent_a));
  -- (RLS is evaluated before the table CHECK, so either error means refused)
  IF r NOT LIKE 'ERR 42501:%' AND r NOT LIKE 'ERR 23514:%' THEN RAISE EXCEPTION 'FAIL self-link accepted: %', r; END IF;
  r := pg_temp.run(agent_a, format(
    'WITH x AS (INSERT INTO ticket_links (account_id, from_ticket_id, to_ticket_id, link_type, created_by) VALUES (%L, %L, %L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    a, t1, tb, 'relates', agent_a));
  IF r NOT LIKE 'ERR 42501:%' THEN RAISE EXCEPTION 'FAIL cross-account link accepted: %', r; END IF;
  r := pg_temp.run(viewer_a, format(
    'WITH x AS (INSERT INTO ticket_links (account_id, from_ticket_id, to_ticket_id, link_type, created_by) VALUES (%L, %L, %L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    a, t2, t1, 'duplicates', viewer_a));
  IF r NOT LIKE 'ERR 42501:%' THEN RAISE EXCEPTION 'FAIL viewer linked tickets: %', r; END IF;

  IF (SELECT count(*) FROM ticket_activity WHERE event_type = 'link_added' AND ticket_id = t1
        AND from_value = 'blocks' AND to_value = t2::text) <> 1
     OR (SELECT count(*) FROM ticket_activity WHERE event_type = 'link_added' AND ticket_id = t2
        AND from_value = 'blocked_by' AND to_value = t1::text) <> 1 THEN
    RAISE EXCEPTION 'FAIL link_added must be logged on both tickets, each from its own side';
  END IF;
  r := pg_temp.run(agent_a, format(
    'WITH x AS (DELETE FROM ticket_links WHERE from_ticket_id = %L AND link_type = %L RETURNING 1) SELECT count(*)::text FROM x',
    t1, 'relates'));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL agent could not remove a link: %', r; END IF;
  IF (SELECT count(*) FROM ticket_activity WHERE event_type = 'link_removed' AND ticket_id IN (t1, t2)) <> 2 THEN
    RAISE EXCEPTION 'FAIL link_removed must be logged on both tickets';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 11. Comments: the author edits / deletes own, nobody else's
  -- ---------------------------------------------------------
  r := pg_temp.run(agent2_a, format(
    'WITH x AS (UPDATE ticket_comments SET body = %L WHERE id = %L RETURNING 1) SELECT count(*)::text FROM x', 'hijack', c1));
  IF r <> '0' THEN RAISE EXCEPTION 'FAIL an agent edited someone else''s comment: %', r; END IF;
  r := pg_temp.run(agent2_a, format(
    'WITH x AS (DELETE FROM ticket_comments WHERE id = %L RETURNING 1) SELECT count(*)::text FROM x', c1));
  IF r <> '0' THEN RAISE EXCEPTION 'FAIL an agent deleted someone else''s comment: %', r; END IF;
  r := pg_temp.run(agent_a, format(
    'WITH x AS (UPDATE ticket_comments SET body = %L WHERE id = %L RETURNING 1) SELECT count(*)::text FROM x', 'Hello team (edited)', c1));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL author could not edit own comment: %', r; END IF;
  IF (SELECT edited_at FROM ticket_comments WHERE id = c1) IS NULL THEN
    RAISE EXCEPTION 'FAIL edited_at not set on edit';
  END IF;
  r := pg_temp.run(agent_a, format(
    'WITH x AS (DELETE FROM ticket_comments WHERE id = %L RETURNING 1) SELECT count(*)::text FROM x', c1));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL author could not delete own comment: %', r; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 12. Attachments: agent adds, only the uploader (or an admin) removes
  -- ---------------------------------------------------------
  r := pg_temp.run(agent_a, format(
    'WITH x AS (INSERT INTO ticket_attachments (id, ticket_id, account_id, storage_path, url, filename, mime_type, size_bytes, uploaded_by) VALUES (%L, %L, %L, %L, %L, %L, %L, 10, %L) RETURNING 1) SELECT count(*)::text FROM x',
    att1, t1, a, 'account-' || a || '/tickets/x.png', 'https://example.invalid/x.png', 'x.png', 'image/png', agent_a));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL agent could not attach a file: %', r; END IF;
  IF (SELECT count(*) FROM ticket_activity WHERE ticket_id = t1 AND event_type = 'attachment_added' AND to_value = 'x.png') <> 1 THEN
    RAISE EXCEPTION 'FAIL attachment_added not logged';
  END IF;
  r := pg_temp.run(agent_a, format(
    'WITH x AS (INSERT INTO ticket_attachments (ticket_id, account_id, storage_path, url, filename, uploaded_by) VALUES (%L, %L, %L, %L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    t1, a, 'p', 'u', 'spoof.png', agent2_a));
  IF r NOT LIKE 'ERR 42501:%' THEN RAISE EXCEPTION 'FAIL attachment filed under someone else: %', r; END IF;
  r := pg_temp.run(agent2_a, format(
    'WITH x AS (DELETE FROM ticket_attachments WHERE id = %L RETURNING 1) SELECT count(*)::text FROM x', att1));
  IF r <> '0' THEN RAISE EXCEPTION 'FAIL an agent deleted another agent''s upload: %', r; END IF;
  r := pg_temp.run(agent_a, format(
    'WITH x AS (DELETE FROM ticket_attachments WHERE id = %L RETURNING 1) SELECT count(*)::text FROM x', att1));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL the uploader could not delete their file: %', r; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 13. Saved filters: private stays private, shared is readable
  -- ---------------------------------------------------------
  INSERT INTO ticket_saved_filters (id, account_id, user_id, name, filter, is_shared)
  VALUES (sf_priv, a, agent_a, 'Mine', '{"mine":true}', false),
         (sf_shared, a, agent_a, 'Team view', '{"overdue":true}', true);
  IF pg_temp.run(agent2_a, 'SELECT count(*)::text FROM ticket_saved_filters') <> '1' THEN
    RAISE EXCEPTION 'FAIL a colleague must see only the shared filter';
  END IF;
  IF pg_temp.run(agent_a, 'SELECT count(*)::text FROM ticket_saved_filters') <> '2' THEN
    RAISE EXCEPTION 'FAIL the owner must see both filters';
  END IF;
  r := pg_temp.run(agent2_a, format(
    'WITH x AS (DELETE FROM ticket_saved_filters WHERE id = %L RETURNING 1) SELECT count(*)::text FROM x', sf_shared));
  IF r <> '0' THEN RAISE EXCEPTION 'FAIL a colleague deleted a shared filter: %', r; END IF;
  r := pg_temp.run(viewer_a, format(
    'WITH x AS (INSERT INTO ticket_saved_filters (account_id, user_id, name) VALUES (%L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    a, viewer_a, 'Viewer view'));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL saved filters need only membership: %', r; END IF;
  r := pg_temp.run(agent2_a, format(
    'WITH x AS (INSERT INTO ticket_saved_filters (account_id, user_id, name) VALUES (%L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    a, agent_a, 'Forged'));
  IF r NOT LIKE 'ERR 42501:%' THEN RAISE EXCEPTION 'FAIL filter saved under someone else: %', r; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 14. Another account sees and writes nothing
  -- ---------------------------------------------------------
  IF pg_temp.run(owner_b, 'SELECT ((SELECT count(*) FROM tickets WHERE account_id = ' || quote_literal(a)
       || ') + (SELECT count(*) FROM ticket_watchers WHERE account_id = ' || quote_literal(a)
       || ') + (SELECT count(*) FROM ticket_links WHERE account_id = ' || quote_literal(a)
       || ') + (SELECT count(*) FROM ticket_saved_filters WHERE account_id = ' || quote_literal(a)
       || ') + (SELECT count(*) FROM ticket_activity WHERE account_id = ' || quote_literal(a)
       || '))::text') <> '0' THEN
    RAISE EXCEPTION 'FAIL account B can read account A ticket data';
  END IF;
  r := pg_temp.run(owner_b, format(
    'WITH x AS (UPDATE tickets SET due_date = %L WHERE id = %L RETURNING 1) SELECT count(*)::text FROM x', '2030-01-01', t1));
  IF r <> '0' THEN RAISE EXCEPTION 'FAIL account B updated an A ticket: %', r; END IF;
  r := pg_temp.run(owner_b, format(
    'WITH x AS (INSERT INTO ticket_watchers (ticket_id, user_id, account_id) VALUES (%L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    t1, owner_b, a));
  IF r NOT LIKE 'ERR 42501:%' THEN RAISE EXCEPTION 'FAIL account B watched an A ticket: %', r; END IF;
  -- label suggestions are scoped by RLS to the caller's account
  UPDATE tickets SET labels = '{secretlabel}' WHERE id = tb;
  IF pg_temp.run(agent_a, 'SELECT count(*)::text FROM ticket_label_suggestions() WHERE label = ''secretlabel''') <> '0' THEN
    RAISE EXCEPTION 'FAIL label suggestions leak across accounts';
  END IF;
  IF pg_temp.run(agent_a, 'SELECT count(*)::text FROM ticket_label_suggestions() WHERE label IN (''vip'', ''billing'')') <> '2' THEN
    RAISE EXCEPTION 'FAIL label suggestions must list the account''s labels';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 15. Notification types
  -- ---------------------------------------------------------
  BEGIN
    INSERT INTO notifications (account_id, user_id, type, title) VALUES (a, agent_a, 'bogus', 'x');
    RAISE EXCEPTION 'FAIL bogus notification type accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  n := n + 1;

  RAISE EXCEPTION 'ROLLBACK-OK: % check groups passed (columns, prefix, status, watchers + notifications, watch RLS, activity, labels, board_rank, links, comments, attachments, saved filters, isolation, notification types)', n;
END
$verify$;
