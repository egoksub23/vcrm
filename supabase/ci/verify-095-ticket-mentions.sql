-- ============================================================
-- Verification for migration 095 (ticket @mentions, needs-a-response tracking).
--
-- Run against a database that already has 095 applied:
--   supabase db query --linked -f supabase/ci/verify-095-ticket-mentions.sql
--
-- Or BEFORE applying, together with the draft (the whole thing rolls back):
--   cat supabase/ci/drafts/095_ticket_mentions.sql supabase/ci/verify-095-ticket-mentions.sql > /tmp/both.sql
--   supabase db query --linked -f /tmp/both.sql
--
-- One DO block that ends with RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing
-- is ever committed. A message starting with ROLLBACK-OK means every check
-- passed; any other error message names the check that failed.
--
-- People are simulated the way PostgREST does it: set the JWT claims and
-- SET LOCAL ROLE authenticated, so RLS and grants apply for real.
-- ============================================================

DO $verify$
DECLARE
  a        UUID;
  b        UUID;
  owner_a  UUID := gen_random_uuid();
  agent_a  UUID := gen_random_uuid();
  agent2_a UUID := gen_random_uuid();
  agent3_a UUID := gen_random_uuid();
  owner_b  UUID := gen_random_uuid();
  contact_a UUID := gen_random_uuid();
  tk       UUID := gen_random_uuid();
  tk2      UUID := gen_random_uuid();
  team_t   UUID := gen_random_uuid();
  c1       UUID := gen_random_uuid();
  c2       UUID := gen_random_uuid();
  c3       UUID := gen_random_uuid();
  m1       UUID := gen_random_uuid();
  m2       UUID := gen_random_uuid();
  m3       UUID := gen_random_uuid();
  m4       UUID := gen_random_uuid();
  m5       UUID := gen_random_uuid();
  res      TEXT;
  rec      RECORD;
BEGIN
  -- ---------------------------------------------------------
  -- helpers
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
    CREATE FUNCTION pg_temp.act(p_ticket UUID, p_type TEXT) RETURNS INTEGER
    LANGUAGE sql AS $b$
      SELECT count(*)::int FROM ticket_activity WHERE ticket_id = p_ticket AND event_type = p_type;
    $b$;
  $f$;

  -- ---------------------------------------------------------
  -- fixtures: users -> (trigger) accounts + profiles
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify095-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, agent_a, agent2_a, agent3_a, owner_b]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create accounts';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (agent_a, agent2_a, agent3_a);
  DELETE FROM accounts WHERE owner_user_id IN (agent_a, agent2_a, agent3_a);

  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (contact_a, owner_a, a, '+10000000095', 'Casey');
  INSERT INTO teams (id, account_id, name) VALUES (team_t, a, 'Support Team');
  INSERT INTO team_members (team_id, user_id) VALUES (team_t, agent2_a), (team_t, agent3_a);

  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, status, created_by)
  VALUES (tk,  a, (SELECT COALESCE(max(ticket_number), 0) + 1 FROM tickets WHERE account_id = a),
          contact_a, 'Mentions test one', 'open', agent_a);
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, status, created_by)
  VALUES (tk2, a, (SELECT COALESCE(max(ticket_number), 0) + 1 FROM tickets WHERE account_id = a),
          contact_a, 'Mentions test two', 'open', agent_a);

  -- ---------------------------------------------------------
  -- 1. Shape and access
  -- ---------------------------------------------------------
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ticket_mentions'::regclass) THEN
    RAISE EXCEPTION 'FAIL 1a ticket_mentions has no row level security';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ticket_mentions' AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'FAIL 1b ticket_mentions has a client write policy';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'ticket_mentions') THEN
    RAISE EXCEPTION 'FAIL 1c ticket_mentions is not in the realtime publication';
  END IF;
  IF has_table_privilege('authenticated', 'public.ticket_mentions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ticket_mentions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ticket_mentions', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL 1d authenticated still has write privileges on ticket_mentions';
  END IF;
  IF has_table_privilege('anon', 'public.ticket_mentions', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL 1e anon can read ticket_mentions';
  END IF;
  IF has_function_privilege('authenticated', 'public.ticket_mentions_after_change()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ticket_mentions_on_ticket_status()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 1f a trigger function is executable by clients';
  END IF;

  -- a client cannot write a mention
  res := pg_temp.run(agent_a, format(
    'INSERT INTO ticket_mentions (account_id, ticket_id, mentioned_user_id, requested_by) VALUES (%L, %L, %L, %L)',
    a, tk, agent2_a, agent_a));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 1g a client inserted a mention: %', res; END IF;

  -- ---------------------------------------------------------
  -- 2. A comment that mentions someone, then the request rows (as the service role would)
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, format(
    'INSERT INTO ticket_comments (id, ticket_id, account_id, author_id, body, mentions, mention_teams) VALUES (%L, %L, %L, %L, %L, %L, %L)',
    c1, tk, a, agent_a, 'Please look @Agent2 and @Support Team', jsonb_build_array(agent2_a, agent3_a), jsonb_build_array(team_t)));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 2a comment insert: %', res; END IF;

  -- agent2 directly, agent3 through the team
  INSERT INTO ticket_mentions (id, account_id, ticket_id, comment_id, mentioned_user_id, requested_by, via_team_id)
  VALUES (m1, a, tk, c1, agent2_a, agent_a, NULL);
  INSERT INTO ticket_mentions (id, account_id, ticket_id, comment_id, mentioned_user_id, requested_by, via_team_id)
  VALUES (m2, a, tk, c1, agent3_a, agent_a, team_t);

  IF pg_temp.act(tk, 'mention_requested') <> 2 THEN
    RAISE EXCEPTION 'FAIL 2b expected 2 mention_requested lines, got %', pg_temp.act(tk, 'mention_requested');
  END IF;
  IF (SELECT count(*) FROM notifications WHERE comment_id = c1 AND type = 'ticket_mention') <> 2 THEN
    RAISE EXCEPTION 'FAIL 2c the mention notifications do not carry the comment id';
  END IF;

  -- duplicate request for the same comment and person
  BEGIN
    INSERT INTO ticket_mentions (account_id, ticket_id, comment_id, mentioned_user_id, requested_by)
    VALUES (a, tk, c1, agent2_a, agent_a);
    RAISE EXCEPTION 'FAIL 2d a duplicate request was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- self mention
  BEGIN
    INSERT INTO ticket_mentions (account_id, ticket_id, mentioned_user_id, requested_by)
    VALUES (a, tk, agent_a, agent_a);
    RAISE EXCEPTION 'FAIL 2e a self mention was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- an open row must not carry a resolution, a resolved one must
  BEGIN
    UPDATE ticket_mentions SET status = 'done' WHERE id = m1;
    RAISE EXCEPTION 'FAIL 2f a done row without resolved_at / reason was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- ---------------------------------------------------------
  -- 3. Who reads what
  -- ---------------------------------------------------------
  IF pg_temp.run(agent2_a, 'SELECT count(*)::text FROM ticket_mentions') <> '2' THEN
    RAISE EXCEPTION 'FAIL 3a a member of the account cannot read the rows of a ticket they can read: %',
      pg_temp.run(agent2_a, 'SELECT count(*)::text FROM ticket_mentions');
  END IF;
  IF pg_temp.run(owner_b, 'SELECT count(*)::text FROM ticket_mentions') <> '0' THEN
    RAISE EXCEPTION 'FAIL 3b a user of ANOTHER account can read mention rows';
  END IF;
  IF pg_temp.run(NULL, 'SELECT count(*)::text FROM ticket_mentions', 'anon') LIKE 'ERR%' THEN
    NULL; -- anon has no privilege at all: an error is the right answer
  ELSIF pg_temp.run(NULL, 'SELECT count(*)::text FROM ticket_mentions', 'anon') <> '0' THEN
    RAISE EXCEPTION 'FAIL 3c anon can read mention rows';
  END IF;
  -- a client cannot resolve a request by writing to the table
  res := pg_temp.run(agent2_a, format(
    'UPDATE ticket_mentions SET status = ''done'', resolved_at = now(), resolved_by = %L, resolved_reason = ''marked_done'' WHERE id = %L',
    agent2_a, m1));
  IF res LIKE 'ERR%' THEN NULL; ELSIF (SELECT status FROM ticket_mentions WHERE id = m1) <> 'open' THEN
    RAISE EXCEPTION 'FAIL 3d a client resolved a request directly';
  END IF;
  res := pg_temp.run(agent_a, format('DELETE FROM ticket_mentions WHERE id = %L', m1));
  IF (SELECT count(*) FROM ticket_mentions WHERE id = m1) <> 1 THEN
    RAISE EXCEPTION 'FAIL 3e a client deleted a request';
  END IF;

  -- ---------------------------------------------------------
  -- 4. The mentioned person replies: their request is done, the bell notification is read
  -- ---------------------------------------------------------
  res := pg_temp.run(agent2_a, format(
    'INSERT INTO ticket_comments (ticket_id, account_id, author_id, body) VALUES (%L, %L, %L, %L)',
    tk, a, agent2_a, 'On it'));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 4a reply insert: %', res; END IF;
  SELECT status, resolved_reason, resolved_by INTO rec FROM ticket_mentions WHERE id = m1;
  IF rec.status <> 'done' OR rec.resolved_reason <> 'replied' OR rec.resolved_by <> agent2_a THEN
    RAISE EXCEPTION 'FAIL 4b the reply did not resolve the request (% / % / %)', rec.status, rec.resolved_reason, rec.resolved_by;
  END IF;
  IF (SELECT status FROM ticket_mentions WHERE id = m2) <> 'open' THEN
    RAISE EXCEPTION 'FAIL 4c another person''s request was resolved by the reply';
  END IF;
  IF (SELECT read_at FROM notifications WHERE comment_id = c1 AND user_id = agent2_a AND type = 'ticket_mention') IS NULL THEN
    RAISE EXCEPTION 'FAIL 4d the bell notification of a resolved request stayed unread';
  END IF;
  IF (SELECT read_at FROM notifications WHERE comment_id = c1 AND user_id = agent3_a AND type = 'ticket_mention') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 4e a still-open request lost its unread notification';
  END IF;
  IF pg_temp.act(tk, 'mention_done') <> 1 THEN
    RAISE EXCEPTION 'FAIL 4f expected 1 mention_done line, got %', pg_temp.act(tk, 'mention_done');
  END IF;

  -- a Jira note (no author) resolves nothing
  INSERT INTO ticket_comments (ticket_id, account_id, author_id, body, source, jira_author)
  VALUES (tk, a, NULL, 'from Jira', 'jira', 'Someone');
  IF (SELECT status FROM ticket_mentions WHERE id = m2) <> 'open' THEN
    RAISE EXCEPTION 'FAIL 4g a Jira note resolved a request';
  END IF;

  -- ---------------------------------------------------------
  -- 5. The requester deletes the comment: what is still open is cancelled, kept without the comment
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, format('DELETE FROM ticket_comments WHERE id = %L', c1));
  IF res NOT IN ('OK') THEN RAISE EXCEPTION 'FAIL 5a comment delete: %', res; END IF;
  SELECT status, resolved_reason, comment_id INTO rec FROM ticket_mentions WHERE id = m2;
  IF rec.status <> 'cancelled' OR rec.resolved_reason <> 'cancelled' OR rec.comment_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 5b deleting the comment did not cancel the request (% / % / %)', rec.status, rec.resolved_reason, rec.comment_id;
  END IF;
  IF (SELECT status FROM ticket_mentions WHERE id = m1) <> 'done' THEN
    RAISE EXCEPTION 'FAIL 5c an already-answered request changed when the comment was deleted';
  END IF;
  IF pg_temp.act(tk, 'mention_cancelled') <> 1 THEN
    RAISE EXCEPTION 'FAIL 5d expected 1 mention_cancelled summary line, got %', pg_temp.act(tk, 'mention_cancelled');
  END IF;
  IF EXISTS (SELECT 1 FROM notifications WHERE comment_id = c1) THEN
    RAISE EXCEPTION 'FAIL 5e a notification of the deleted comment is still there';
  END IF;

  -- ---------------------------------------------------------
  -- 6. Team request: one history line for two members; closing the ticket completes them
  -- ---------------------------------------------------------
  INSERT INTO ticket_comments (id, ticket_id, account_id, author_id, body, mentions, mention_teams)
  VALUES (c2, tk2, a, agent_a, '@Support Team please', jsonb_build_array(agent2_a, agent3_a), jsonb_build_array(team_t));
  INSERT INTO ticket_mentions (id, account_id, ticket_id, comment_id, mentioned_user_id, requested_by, via_team_id)
  VALUES (m3, a, tk2, c2, agent2_a, agent_a, team_t), (m4, a, tk2, c2, agent3_a, agent_a, team_t);
  IF pg_temp.act(tk2, 'mention_requested') <> 1 THEN
    RAISE EXCEPTION 'FAIL 6a a team request wrote % history lines, expected 1', pg_temp.act(tk2, 'mention_requested');
  END IF;

  res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''resolved'' WHERE id = %L', tk2));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 6b status update: %', res; END IF;
  IF (SELECT count(*) FROM ticket_mentions WHERE ticket_id = tk2 AND status = 'done' AND resolved_reason = 'ticket_closed') <> 2 THEN
    RAISE EXCEPTION 'FAIL 6c resolving the ticket did not complete its requests';
  END IF;
  IF pg_temp.act(tk2, 'mention_done') <> 1 THEN
    RAISE EXCEPTION 'FAIL 6d expected 1 mention_done summary line, got %', pg_temp.act(tk2, 'mention_done');
  END IF;
  IF EXISTS (SELECT 1 FROM notifications WHERE comment_id = c2 AND type = 'ticket_mention' AND read_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 6e closing the ticket left mention notifications unread';
  END IF;

  -- reopening does not reopen the requests
  res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''open'' WHERE id = %L', tk2));
  IF (SELECT count(*) FROM ticket_mentions WHERE ticket_id = tk2 AND status = 'open') <> 0 THEN
    RAISE EXCEPTION 'FAIL 6f reopening the ticket reopened requests';
  END IF;

  -- ---------------------------------------------------------
  -- 7. The service role path (Mark as done / Cancel request): a resolved row with its reason is accepted
  -- ---------------------------------------------------------
  INSERT INTO ticket_comments (id, ticket_id, account_id, author_id, body, mentions)
  VALUES (c3, tk2, a, agent_a, '@Agent2 again', jsonb_build_array(agent2_a));
  INSERT INTO ticket_mentions (id, account_id, ticket_id, comment_id, mentioned_user_id, requested_by)
  VALUES (m5, a, tk2, c3, agent2_a, agent_a);
  UPDATE ticket_mentions
     SET status = 'done', resolved_at = now(), resolved_by = agent2_a, resolved_reason = 'marked_done'
   WHERE id = m5;
  IF pg_temp.act(tk2, 'mention_done') <> 2 THEN
    RAISE EXCEPTION 'FAIL 7a Mark as done wrote no history line';
  END IF;
  IF (SELECT read_at FROM notifications WHERE comment_id = c3 AND user_id = agent2_a AND type = 'ticket_mention') IS NULL THEN
    RAISE EXCEPTION 'FAIL 7b Mark as done left the bell notification unread';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: ticket_mentions (RLS, no client writes, cross-account isolation, reply / delete / close resolution, history lines, notification clearing) checked in % groups', 7;
END
$verify$;
