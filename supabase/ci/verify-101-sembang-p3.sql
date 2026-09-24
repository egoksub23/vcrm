-- ============================================================
-- Verification for migration 101 (Sembang P3: per-channel/DM mute
-- wired into all three notification triggers, and "also_in_channel"
-- for a thread reply that also posts to the main timeline).
--
-- Migrations 098/099/100 are NOT yet applied to production, so this
-- must run with ALL FOUR drafts in front (the whole thing rolls back):
--   cat supabase/ci/drafts/098_sembang_p0.sql \
--       supabase/ci/drafts/099_sembang_p1.sql \
--       supabase/ci/drafts/100_sembang_p2.sql \
--       supabase/ci/drafts/101_sembang_p3.sql \
--       supabase/ci/verify-101-sembang-p3.sql > /tmp/all.sql
--   supabase db query --linked -f /tmp/all.sql
-- Once 098/099/100 ship to production, this can run with just 101 +
-- this file.
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
  mem_a   UUID := gen_random_uuid(); -- self-joins, will mute
  out_a   UUID := gen_random_uuid(); -- has menu.sembang, never joins
  ch      UUID;
  top1    UUID;
  top2    UUID;
  reply1  UUID;
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
         'verify101-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, mod_a, mem_a, out_a]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  IF a IS NULL THEN RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create an account'; END IF;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (mod_a, mem_a, out_a);
  DELETE FROM accounts WHERE owner_user_id IN (mod_a, mem_a, out_a);

  INSERT INTO role_capabilities (account_id, role, capability, granted, changed_by)
  VALUES (a, 'agent', 'menu.sembang', true, owner_a);

  PERFORM pg_temp.run(mod_a, format(
    'INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (%L, ''p3-general'', false, %L)', a, mod_a));
  SELECT id INTO ch FROM sembang_channels WHERE account_id = a AND name = 'p3-general';
  PERFORM pg_temp.run(mem_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', ch, a, mem_a));

  -- ---------------------------------------------------------
  -- 1. Mute RPC — self-scoped, doesn't touch other members' rows
  -- ---------------------------------------------------------
  res := pg_temp.run(mem_a, format('SELECT set_sembang_channel_muted(%L, true)::text', ch));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 1a set_sembang_channel_muted did not run cleanly: %', res; END IF;
  IF (SELECT muted FROM sembang_channel_members WHERE channel_id = ch AND user_id = mem_a) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL 1b mem_a''s membership row was not marked muted';
  END IF;
  IF (SELECT muted FROM sembang_channel_members WHERE channel_id = ch AND user_id = mod_a) IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL 1c mod_a''s membership row was affected by mem_a muting (RPC not self-scoped)';
  END IF;

  -- a non-member (out_a) calling the RPC on this channel is a silent
  -- no-op (WHERE finds no matching row) — confirm it doesn't error and
  -- doesn't create/affect anything
  res := pg_temp.run(out_a, format('SELECT set_sembang_channel_muted(%L, true)::text', ch));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 1d a non-member calling the mute RPC errored instead of no-op: %', res; END IF;
  IF EXISTS (SELECT 1 FROM sembang_channel_members WHERE channel_id = ch AND user_id = out_a) THEN
    RAISE EXCEPTION 'FAIL 1e a non-member calling the mute RPC created a membership row';
  END IF;

  -- ---------------------------------------------------------
  -- 2. Mute suppresses mention notifications (regression: an
  --    unmuted mentioned member still gets notified)
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body, mentions) VALUES (%L, %L, %L, ''hey team'', %L)',
    ch, a, mod_a, ('["' || mem_a || '"]')::jsonb));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 2a send a message mentioning a muted member: %', res; END IF;
  SELECT id INTO top1 FROM sembang_messages WHERE channel_id = ch AND body = 'hey team';

  IF (SELECT count(*) FROM notifications WHERE user_id = mem_a AND sembang_message_id = top1) <> 0 THEN
    RAISE EXCEPTION 'FAIL 2b a muted member was notified of an @mention anyway';
  END IF;

  -- unmute, send again, confirm the mention notification now fires
  PERFORM pg_temp.run(mem_a, format('SELECT set_sembang_channel_muted(%L, false)', ch));
  res := pg_temp.run(mod_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body, mentions) VALUES (%L, %L, %L, ''hey again'', %L)',
    ch, a, mod_a, ('["' || mem_a || '"]')::jsonb));
  SELECT id INTO top2 FROM sembang_messages WHERE channel_id = ch AND body = 'hey again';
  IF (SELECT count(*) FROM notifications WHERE user_id = mem_a AND sembang_message_id = top2) <> 1 THEN
    RAISE EXCEPTION 'FAIL 2c an UNMUTED mentioned member was not notified (regression)';
  END IF;

  -- re-mute for the next groups
  PERFORM pg_temp.run(mem_a, format('SELECT set_sembang_channel_muted(%L, true)', ch));

  -- ---------------------------------------------------------
  -- 3. Mute suppresses task-assignment notifications
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format(
    'INSERT INTO sembang_tasks (channel_id, account_id, title, assignee_id, created_by) VALUES (%L, %L, ''do the thing'', %L, %L)',
    ch, a, mem_a, mod_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 3a create a task assigned to a muted member: %', res; END IF;
  IF (SELECT count(*) FROM notifications WHERE user_id = mem_a AND type = 'sembang_task_assigned') <> 0 THEN
    RAISE EXCEPTION 'FAIL 3b a muted member was notified of a task assignment anyway';
  END IF;

  -- ---------------------------------------------------------
  -- 4. Mute suppresses DM notifications
  -- ---------------------------------------------------------
  DECLARE ch_dm UUID; v_dm_key TEXT; msg_dm UUID; BEGIN
    v_dm_key := (SELECT string_agg(x::text, ',' ORDER BY x) FROM unnest(ARRAY[mod_a, mem_a]) AS x);
    PERFORM pg_temp.run(mod_a, format(
      'INSERT INTO sembang_channels (account_id, is_private, is_dm, dm_key, created_by) VALUES (%L, true, true, %L, %L)', a, v_dm_key, mod_a));
    SELECT id INTO ch_dm FROM sembang_channels WHERE account_id = a AND dm_key = v_dm_key;
    PERFORM pg_temp.run(mod_a, format(
      'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', ch_dm, a, mem_a));
    PERFORM pg_temp.run(mem_a, format('SELECT set_sembang_channel_muted(%L, true)', ch_dm));

    res := pg_temp.run(mod_a, format(
      'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''ping'')', ch_dm, a, mod_a));
    IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 4a send a DM message into a muted DM: %', res; END IF;
    SELECT id INTO msg_dm FROM sembang_messages WHERE channel_id = ch_dm AND body = 'ping';
    IF (SELECT count(*) FROM notifications WHERE user_id = mem_a AND sembang_message_id = msg_dm) <> 0 THEN
      RAISE EXCEPTION 'FAIL 4b a muted DM still produced a sembang_dm_message notification';
    END IF;
  END;

  -- ---------------------------------------------------------
  -- 5. also_in_channel — requires a reply, immutable after insert
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body, also_in_channel) VALUES (%L, %L, %L, ''top-level flagged'', true)', ch, a, mod_a));
  IF res NOT LIKE '%sembang_also_in_channel_requires_a_reply%' THEN
    RAISE EXCEPTION 'FAIL 5a a TOP-LEVEL message with also_in_channel=true was accepted: %', res;
  END IF;

  res := pg_temp.run(mem_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body, parent_message_id, also_in_channel) VALUES (%L, %L, %L, ''also visible reply'', %L, true)',
    ch, a, mem_a, top1));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 5b a reply with also_in_channel=true was rejected: %', res; END IF;
  SELECT id INTO reply1 FROM sembang_messages WHERE channel_id = ch AND body = 'also visible reply';

  res := pg_temp.run(mem_a, format('UPDATE sembang_messages SET also_in_channel = false WHERE id = %L', reply1));
  IF res NOT LIKE '%sembang_message_immutable_column_changed%' THEN
    RAISE EXCEPTION 'FAIL 5c also_in_channel was changeable after insert: %', res;
  END IF;

  -- regression: the pre-existing immutability checks (099) still fire
  -- (must be a GENUINELY different value — the guard only fires on
  -- IS DISTINCT FROM, so re-setting the same channel_id is a no-op)
  res := pg_temp.run(mem_a, format('UPDATE sembang_messages SET channel_id = %L WHERE id = %L', gen_random_uuid(), reply1));
  IF res NOT LIKE '%sembang_message_immutable_column_changed%' THEN
    RAISE EXCEPTION 'FAIL 5d channel_id immutability (099) regressed after replacing the guard function: %', res;
  END IF;

  -- ---------------------------------------------------------
  -- 6. list_sembang_channels_for_current_user — muted-aware
  -- ---------------------------------------------------------
  res := pg_temp.run(mem_a, format(
    'SELECT muted::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch));
  IF res <> 'true' THEN RAISE EXCEPTION 'FAIL 6a RPC did not report muted=true for mem_a''s muted channel: %', res; END IF;

  res := pg_temp.run(mod_a, format(
    'SELECT muted::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch));
  IF res <> 'false' THEN RAISE EXCEPTION 'FAIL 6b RPC reported muted=true for mod_a, who never muted this channel: %', res; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: Sembang P3 (self-scoped mute RPC wired into all three notification triggers with an unmute regression check, also_in_channel requiring a real reply and staying immutable after insert, pre-existing 099 immutability checks re-verified against the replaced guard function, list_sembang_channels_for_current_user now muted-aware) checked in 6 groups';
END
$verify$;
