-- ============================================================
-- Verification for the Sembang unread-mention-count migration
-- (list_sembang_channels_for_current_user gains unread_mention_count).
--
-- Migrations 098-101 are now confirmed applied to production, so this
-- only needs its own draft in front (the whole thing rolls back):
--   cat supabase/ci/drafts/102_sembang_mentions.sql \
--       supabase/ci/verify-102-sembang-mentions.sql > /tmp/all.sql
--   supabase db query --linked -f /tmp/all.sql
--
-- One DO block ending RAISE EXCEPTION 'ROLLBACK-OK: ...' — nothing is
-- ever committed. Same pg_temp.run(user, sql, role) helper as every
-- prior Sembang verify script.
-- ============================================================

DO $verify$
DECLARE
  a       UUID;
  owner_a UUID := gen_random_uuid();
  mod_a   UUID := gen_random_uuid(); -- creates the channel, auto-moderator
  mem_a   UUID := gen_random_uuid(); -- self-joins
  ch      UUID;
  ch_dm   UUID;
  v_dm_key  TEXT;
  res     TEXT;
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

  -- ---------------------------------------------------------
  -- fixtures
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify102-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, mod_a, mem_a]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  IF a IS NULL THEN RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create an account'; END IF;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (mod_a, mem_a);
  DELETE FROM accounts WHERE owner_user_id IN (mod_a, mem_a);

  INSERT INTO role_capabilities (account_id, role, capability, granted, changed_by)
  VALUES (a, 'agent', 'menu.sembang', true, owner_a);

  PERFORM pg_temp.run(mod_a, format(
    'INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (%L, ''m-general'', false, %L)', a, mod_a));
  SELECT id INTO ch FROM sembang_channels WHERE account_id = a AND name = 'm-general';
  PERFORM pg_temp.run(mem_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', ch, a, mem_a));

  -- ---------------------------------------------------------
  -- 1. A mention creates an unread-mention count of 1 for the
  --    mentioned member, 0 for the sender
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body, mentions) VALUES (%L, %L, %L, ''hey you'', %L)',
    ch, a, mod_a, ('["' || mem_a || '"]')::jsonb));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 1a send a mention: %', res; END IF;

  res := pg_temp.run(mem_a, format(
    'SELECT unread_mention_count::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch));
  IF res <> '1' THEN RAISE EXCEPTION 'FAIL 1b mentioned member did not see unread_mention_count = 1: %', res; END IF;

  res := pg_temp.run(mod_a, format(
    'SELECT unread_mention_count::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch));
  IF res <> '0' THEN RAISE EXCEPTION 'FAIL 1c sender saw a nonzero unread_mention_count for their own channel: %', res; END IF;

  -- ---------------------------------------------------------
  -- 2. Marking the notification read drops the count back to 0
  -- ---------------------------------------------------------
  res := pg_temp.run(mem_a, format(
    'UPDATE notifications SET read_at = now() WHERE user_id = %L AND sembang_channel_id = %L AND type = ''sembang_mention''',
    mem_a, ch));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 2a mark the mention notification read: %', res; END IF;

  res := pg_temp.run(mem_a, format(
    'SELECT unread_mention_count::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch));
  IF res <> '0' THEN RAISE EXCEPTION 'FAIL 2b unread_mention_count did not drop to 0 after marking read: %', res; END IF;

  -- ---------------------------------------------------------
  -- 3. A DM message (no explicit @mention) also counts
  -- ---------------------------------------------------------
  v_dm_key := (SELECT string_agg(x::text, ',' ORDER BY x) FROM unnest(ARRAY[mod_a, mem_a]) AS x);
  PERFORM pg_temp.run(mod_a, format(
    'INSERT INTO sembang_channels (account_id, is_private, is_dm, dm_key, created_by) VALUES (%L, true, true, %L, %L)', a, v_dm_key, mod_a));
  SELECT id INTO ch_dm FROM sembang_channels WHERE account_id = a AND dm_key = v_dm_key;
  PERFORM pg_temp.run(mod_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', ch_dm, a, mem_a));

  res := pg_temp.run(mod_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''ping'')', ch_dm, a, mod_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 3a send a plain DM message: %', res; END IF;

  res := pg_temp.run(mem_a, format(
    'SELECT unread_mention_count::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch_dm));
  IF res <> '1' THEN RAISE EXCEPTION 'FAIL 3b DM recipient did not see unread_mention_count = 1 for an unmentioned DM message: %', res; END IF;

  -- ---------------------------------------------------------
  -- 4. A task assignment does NOT bump unread_mention_count
  --    (channel's count is still 0 from step 2)
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format(
    'INSERT INTO sembang_tasks (channel_id, account_id, title, assignee_id, created_by) VALUES (%L, %L, ''do the thing'', %L, %L)',
    ch, a, mem_a, mod_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 4a assign a task: %', res; END IF;

  res := pg_temp.run(mem_a, format(
    'SELECT unread_mention_count::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch));
  IF res <> '0' THEN RAISE EXCEPTION 'FAIL 4b a task-assignment notification incorrectly counted as an unread mention: %', res; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: Sembang unread-mention-count (mentions and DM messages counted per channel, sender never counted, marking read drops the count, task-assignment notifications excluded) checked in 4 groups';
END
$verify$;
