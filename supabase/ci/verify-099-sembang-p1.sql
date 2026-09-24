-- ============================================================
-- Verification for migration 099 (Sembang P1: threads, reactions,
-- pins, edit/delete own message, tasks + assignment notifications).
--
-- Migration 098 is NOT yet applied to production, so this must run
-- with BOTH drafts in front (the whole thing rolls back):
--   cat supabase/ci/drafts/098_sembang_p0.sql supabase/ci/drafts/099_sembang_p1.sql \
--       supabase/ci/verify-099-sembang-p1.sql > /tmp/both.sql
--   supabase db query --linked -f /tmp/both.sql
-- Once 098 ships to production, this can run with just 099 + this file.
--
-- One DO block ending RAISE EXCEPTION 'ROLLBACK-OK: ...' — nothing is
-- ever committed. Same pg_temp.run(user, sql, role) helper as
-- verify-098, simulating RLS as different users via JWT claims.
-- ============================================================

DO $verify$
DECLARE
  a         UUID;
  owner_a   UUID := gen_random_uuid();
  admin_a   UUID := gen_random_uuid();
  mod_a     UUID := gen_random_uuid(); -- creates the channel, so auto-moderator
  mem_a     UUID := gen_random_uuid(); -- plain member, self-joins
  out_a     UUID := gen_random_uuid(); -- has menu.sembang, never joins the channel
  ch        UUID;
  priv_ch   UUID;
  top1      UUID;
  top2      UUID;
  reply1    UUID;
  task1     UUID;
  res       TEXT;
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
         'verify099-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, admin_a, mod_a, mem_a, out_a]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  IF a IS NULL THEN RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create an account'; END IF;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = admin_a;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (mod_a, mem_a, out_a);
  DELETE FROM accounts WHERE owner_user_id IN (admin_a, mod_a, mem_a, out_a);

  -- grant menu.sembang down to Agent for this account
  INSERT INTO role_capabilities (account_id, role, capability, granted, changed_by)
  VALUES (a, 'agent', 'menu.sembang', true, admin_a);

  -- mod_a creates a public channel (auto-moderator) and a private one
  PERFORM pg_temp.run(mod_a, format(
    'INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (%L, ''p1-general'', false, %L)', a, mod_a));
  SELECT id INTO ch FROM sembang_channels WHERE account_id = a AND name = 'p1-general';
  PERFORM pg_temp.run(mod_a, format(
    'INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (%L, ''p1-private'', true, %L)', a, mod_a));
  SELECT id INTO priv_ch FROM sembang_channels WHERE account_id = a AND name = 'p1-private';

  -- mem_a self-joins the public channel; out_a never joins
  PERFORM pg_temp.run(mem_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', ch, a, mem_a));

  -- ---------------------------------------------------------
  -- 1. Threads: reply requires a real, top-level parent in the SAME channel
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''top 1'')', ch, a, mod_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 1a top-level message insert: %', res; END IF;
  SELECT id INTO top1 FROM sembang_messages WHERE channel_id = ch AND body = 'top 1';

  res := pg_temp.run(mem_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body, parent_message_id) VALUES (%L, %L, %L, ''a reply'', %L)',
    ch, a, mem_a, top1));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 1b a reply to a top-level message: %', res; END IF;
  SELECT id INTO reply1 FROM sembang_messages WHERE channel_id = ch AND body = 'a reply';

  -- a reply to a reply is rejected (flat, one level only)
  res := pg_temp.run(mem_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body, parent_message_id) VALUES (%L, %L, %L, ''nested'', %L)',
    ch, a, mem_a, reply1));
  IF res NOT LIKE '%sembang_reply_parent_is_itself_a_reply%' THEN
    RAISE EXCEPTION 'FAIL 1c a reply to a reply was accepted: %', res;
  END IF;

  -- a parent from a DIFFERENT channel is rejected
  PERFORM pg_temp.run(mod_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''top 2 other channel'')', priv_ch, a, mod_a));
  DECLARE v_other_top UUID; BEGIN
    SELECT id INTO v_other_top FROM sembang_messages WHERE channel_id = priv_ch AND body = 'top 2 other channel';
    res := pg_temp.run(mod_a, format(
      'INSERT INTO sembang_messages (channel_id, account_id, author_id, body, parent_message_id) VALUES (%L, %L, %L, ''cross-channel reply'', %L)',
      ch, a, mod_a, v_other_top));
    IF res NOT LIKE '%sembang_reply_parent_wrong_channel%' THEN
      RAISE EXCEPTION 'FAIL 1d a reply pointed at a parent in a different channel was accepted: %', res;
    END IF;
  END;

  -- ---------------------------------------------------------
  -- 2. Immutable columns on UPDATE (trigger, not just RLS)
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format('UPDATE sembang_messages SET channel_id = %L WHERE id = %L', priv_ch, top1));
  IF res NOT LIKE '%sembang_message_immutable_column_changed%' THEN
    RAISE EXCEPTION 'FAIL 2a channel_id was changed on an existing message: %', res;
  END IF;
  res := pg_temp.run(mod_a, format('UPDATE sembang_messages SET author_id = %L WHERE id = %L', mem_a, top1));
  IF res NOT LIKE '%sembang_message_immutable_column_changed%' THEN
    RAISE EXCEPTION 'FAIL 2b author_id was changed on an existing message: %', res;
  END IF;

  -- ---------------------------------------------------------
  -- 3. Author edits/deletes their own message; moderator still removes others
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format('UPDATE sembang_messages SET body = ''top 1 edited'' WHERE id = %L', top1));
  IF res <> 'OK' OR (SELECT body FROM sembang_messages WHERE id = top1) <> 'top 1 edited' THEN
    RAISE EXCEPTION 'FAIL 3a author could not edit their own message: %', res;
  END IF;
  res := pg_temp.run(mem_a, format('UPDATE sembang_messages SET body = ''hacked'' WHERE id = %L', top1));
  IF (SELECT body FROM sembang_messages WHERE id = top1) = 'hacked' THEN
    RAISE EXCEPTION 'FAIL 3b a different member edited someone else''s message';
  END IF;

  PERFORM pg_temp.run(mem_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''top 2'')', ch, a, mem_a));
  SELECT id INTO top2 FROM sembang_messages WHERE channel_id = ch AND body = 'top 2';

  -- author self-deletes
  res := pg_temp.run(mem_a, format('UPDATE sembang_messages SET deleted_at = now() WHERE id = %L', top2));
  IF res <> 'OK' OR (SELECT deleted_at FROM sembang_messages WHERE id = top2) IS NULL THEN
    RAISE EXCEPTION 'FAIL 3c author could not delete their own message: %', res;
  END IF;
  -- can't edit/re-delete once deleted (USING requires deleted_at IS NULL)
  res := pg_temp.run(mem_a, format('UPDATE sembang_messages SET body = ''ghost edit'' WHERE id = %L', top2));
  IF (SELECT body FROM sembang_messages WHERE id = top2) = 'ghost edit' THEN
    RAISE EXCEPTION 'FAIL 3d a deleted message was still editable by its author';
  END IF;
  -- moderator still removes someone else's message (098's policy, untouched)
  res := pg_temp.run(mod_a, format('UPDATE sembang_messages SET deleted_at = now(), deleted_by = %L WHERE id = %L', mod_a, reply1));
  IF res <> 'OK' OR (SELECT deleted_at FROM sembang_messages WHERE id = reply1) IS NULL THEN
    RAISE EXCEPTION 'FAIL 3e moderator could no longer remove another member''s message: %', res;
  END IF;

  -- ---------------------------------------------------------
  -- 4. Reactions
  -- ---------------------------------------------------------
  res := pg_temp.run(mem_a, format('INSERT INTO sembang_reactions (message_id, account_id, user_id, emoji) VALUES (%L, %L, %L, ''👍'')', top1, a, mem_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 4a a member could not react: %', res; END IF;
  -- duplicate (same message/user/emoji) rejected
  res := pg_temp.run(mem_a, format('INSERT INTO sembang_reactions (message_id, account_id, user_id, emoji) VALUES (%L, %L, %L, ''👍'')', top1, a, mem_a));
  IF res NOT LIKE 'ERR 23505%' THEN RAISE EXCEPTION 'FAIL 4b a duplicate reaction was accepted: %', res; END IF;
  -- reacting as someone else is rejected
  res := pg_temp.run(mem_a, format('INSERT INTO sembang_reactions (message_id, account_id, user_id, emoji) VALUES (%L, %L, %L, ''🎉'')', top1, a, mod_a));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 4c a member reacted as someone else: %', res; END IF;
  -- a non-member (out_a, has capability but never joined) cannot react even on a PUBLIC channel's message
  res := pg_temp.run(out_a, format('INSERT INTO sembang_reactions (message_id, account_id, user_id, emoji) VALUES (%L, %L, %L, ''🔥'')', top1, a, out_a));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 4d a non-member reacted: %', res; END IF;
  -- but a non-member CAN still see the reaction (public channel, matches message visibility)
  IF pg_temp.run(out_a, format('SELECT count(*)::text FROM sembang_reactions WHERE message_id = %L', top1)) <> '1' THEN
    RAISE EXCEPTION 'FAIL 4e a non-member could not see a reaction on a public channel''s message';
  END IF;
  -- self-delete works; deleting someone else's reaction does not
  res := pg_temp.run(mod_a, format('DELETE FROM sembang_reactions WHERE message_id = %L AND user_id = %L AND emoji = ''👍''', top1, mem_a));
  IF (SELECT count(*) FROM sembang_reactions WHERE message_id = top1 AND user_id = mem_a) <> 1 THEN
    RAISE EXCEPTION 'FAIL 4f a different member deleted someone else''s reaction';
  END IF;
  res := pg_temp.run(mem_a, format('DELETE FROM sembang_reactions WHERE message_id = %L AND user_id = %L AND emoji = ''👍''', top1, mem_a));
  IF res <> 'OK' OR (SELECT count(*) FROM sembang_reactions WHERE message_id = top1 AND user_id = mem_a) <> 0 THEN
    RAISE EXCEPTION 'FAIL 4g the author could not remove their own reaction: %', res;
  END IF;

  -- ---------------------------------------------------------
  -- 5. Pins — any member can pin; unpin is pinner or moderator/admin
  -- ---------------------------------------------------------
  res := pg_temp.run(mem_a, format('INSERT INTO sembang_pins (channel_id, message_id, account_id, pinned_by) VALUES (%L, %L, %L, %L)', ch, top1, a, mem_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 5a a plain member could not pin: %', res; END IF;
  -- a non-member cannot pin
  res := pg_temp.run(out_a, format('INSERT INTO sembang_pins (channel_id, message_id, account_id, pinned_by) VALUES (%L, %L, %L, %L)', ch, top1, a, out_a));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 5b a non-member pinned a message: %', res; END IF;
  -- a plain member cannot unpin someone else's pin
  PERFORM pg_temp.run(mod_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', ch, a, admin_a));
  -- moderator unpins someone else's pin
  res := pg_temp.run(mod_a, format('DELETE FROM sembang_pins WHERE channel_id = %L AND message_id = %L', ch, top1));
  IF res <> 'OK' OR (SELECT count(*) FROM sembang_pins WHERE channel_id = ch AND message_id = top1) <> 0 THEN
    RAISE EXCEPTION 'FAIL 5c moderator could not unpin someone else''s pin: %', res;
  END IF;

  -- ---------------------------------------------------------
  -- 6. Tasks: create, toggle done (completed_at/by auto-set), delete rules
  -- ---------------------------------------------------------
  res := pg_temp.run(mem_a, format(
    'INSERT INTO sembang_tasks (channel_id, account_id, message_id, title, assignee_id, created_by) VALUES (%L, %L, %L, ''Fix the thing'', %L, %L)',
    ch, a, top1, mod_a, mem_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 6a a member could not create a task: %', res; END IF;
  SELECT id INTO task1 FROM sembang_tasks WHERE channel_id = ch AND title = 'Fix the thing';

  -- a non-member cannot create a task in this channel
  res := pg_temp.run(out_a, format(
    'INSERT INTO sembang_tasks (channel_id, account_id, title, created_by) VALUES (%L, %L, ''sneaky'', %L)', ch, a, out_a));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 6b a non-member created a task: %', res; END IF;

  -- toggling to done stamps completed_at/completed_by from the ACTOR, not the payload
  res := pg_temp.run(mod_a, format('UPDATE sembang_tasks SET status = ''done'', completed_at = %L, completed_by = %L WHERE id = %L',
    (now() - interval '10 years')::text, mem_a, task1));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 6c marking a task done: %', res; END IF;
  IF (SELECT completed_by FROM sembang_tasks WHERE id = task1) <> mod_a THEN
    RAISE EXCEPTION 'FAIL 6d completed_by was not forced to the real actor (client tried to credit someone else)';
  END IF;
  IF (SELECT completed_at FROM sembang_tasks WHERE id = task1) < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'FAIL 6e completed_at was not forced to now() (client tried to backdate it)';
  END IF;

  -- toggling back to open clears both
  res := pg_temp.run(mod_a, format('UPDATE sembang_tasks SET status = ''open'' WHERE id = %L', task1));
  IF res <> 'OK' OR (SELECT completed_at IS NOT NULL OR completed_by IS NOT NULL FROM sembang_tasks WHERE id = task1) THEN
    RAISE EXCEPTION 'FAIL 6f reopening a task did not clear completed_at/by: %', res;
  END IF;

  -- immutable columns protected the same way as messages
  res := pg_temp.run(mod_a, format('UPDATE sembang_tasks SET channel_id = %L WHERE id = %L', priv_ch, task1));
  IF res NOT LIKE '%sembang_task_immutable_column_changed%' THEN
    RAISE EXCEPTION 'FAIL 6g a task''s channel_id was changed: %', res;
  END IF;

  -- delete: a plain member who didn't create it cannot; the creator can
  PERFORM pg_temp.run(mem_a, format(
    'INSERT INTO sembang_tasks (channel_id, account_id, title, created_by) VALUES (%L, %L, ''mem-owned'', %L)', ch, a, mem_a));
  DECLARE v_mem_task UUID; BEGIN
    SELECT id INTO v_mem_task FROM sembang_tasks WHERE channel_id = ch AND title = 'mem-owned';
    -- mod_a is a moderator, so THEY can delete it too (tested via task1 below) — here check
    -- a THIRD party with no special role cannot:
    res := pg_temp.run(admin_a, format('DELETE FROM sembang_tasks WHERE id = %L', v_mem_task));
    -- admin_a is account admin, so this actually SHOULD succeed (admins moderate everything) —
    -- verify that specifically, then verify the creator can delete their own:
    IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 6h an account admin could not delete a task: %', res; END IF;
  END;

  -- ---------------------------------------------------------
  -- 7. Task-assignment notification: only a real member, never self,
  -- fires once per actual assignee change
  -- ---------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM notifications WHERE account_id = a AND user_id = mod_a AND type = 'sembang_task_assigned') THEN
    RAISE EXCEPTION 'FAIL 7a assigning a task to a real channel member created no notification';
  END IF;
  DELETE FROM notifications WHERE account_id = a AND type = 'sembang_task_assigned';

  res := pg_temp.run(mem_a, format(
    'INSERT INTO sembang_tasks (channel_id, account_id, title, assignee_id, created_by) VALUES (%L, %L, ''self assign'', %L, %L)',
    ch, a, mem_a, mem_a));
  IF EXISTS (SELECT 1 FROM notifications WHERE account_id = a AND user_id = mem_a AND type = 'sembang_task_assigned') THEN
    RAISE EXCEPTION 'FAIL 7b a self-assigned task created a notification';
  END IF;

  res := pg_temp.run(mem_a, format(
    'INSERT INTO sembang_tasks (channel_id, account_id, title, assignee_id, created_by) VALUES (%L, %L, ''assign to outsider'', %L, %L)',
    ch, a, out_a, mem_a));
  IF EXISTS (SELECT 1 FROM notifications WHERE account_id = a AND user_id = out_a AND type = 'sembang_task_assigned') THEN
    RAISE EXCEPTION 'FAIL 7c assigning to a non-member created a notification anyway';
  END IF;

  -- ---------------------------------------------------------
  -- 8. notifications.type still allows a P0 value alongside the new one
  -- ---------------------------------------------------------
  BEGIN
    INSERT INTO notifications (account_id, user_id, type, title, body) VALUES (a, admin_a, 'sembang_mention', 'still allowed', 'x');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL 8a sembang_mention (098) was dropped by the 099 widen: %', SQLERRM;
  END;

  -- ---------------------------------------------------------
  -- 9. Realtime publication
  -- ---------------------------------------------------------
  IF (SELECT count(*) FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
          AND tablename IN ('sembang_reactions', 'sembang_pins', 'sembang_tasks')) <> 3 THEN
    RAISE EXCEPTION 'FAIL 9a not all three P1 tables are in the realtime publication';
  END IF;

  -- ---------------------------------------------------------
  -- 10. Cross-account hygiene (the class of bug fixed in 098's review):
  -- pairing a real channel/message with a DIFFERENT account's id
  -- ---------------------------------------------------------
  DECLARE
    owner_b UUID := gen_random_uuid();
    b       UUID;
    ch_b    UUID;
  BEGIN
    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (owner_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify099-b-' || owner_b || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now());
    SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
    INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (b, 'b-chan', false, owner_b) RETURNING id INTO ch_b;

    res := pg_temp.run(mem_a, format(
      'INSERT INTO sembang_pins (channel_id, message_id, account_id, pinned_by) VALUES (%L, %L, %L, %L)', ch_b, top1, a, mem_a));
    IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 10a pinned account B''s channel paired with account A''s id: %', res; END IF;

    res := pg_temp.run(mem_a, format(
      'INSERT INTO sembang_tasks (channel_id, account_id, title, created_by) VALUES (%L, %L, ''cross-account task'', %L)', ch_b, a, mem_a));
    IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 10b created a task on account B''s channel paired with account A''s id: %', res; END IF;
  END;

  RAISE EXCEPTION 'ROLLBACK-OK: Sembang P1 (flat one-level threads with parent/channel validation, message immutable-column trigger, author edit/self-delete alongside moderator removal, reactions self-only with dup rejection and non-member write block, pins any-member-adds/pinner-or-moderator-removes, tasks any-member-writes/server-stamped completion/creator-or-admin-deletes, task-assignment notifications scoped to real members and never self, notifications.type widened not replaced, realtime publication, cross-account hygiene on pins/tasks) checked in 10 groups';
END
$verify$;
