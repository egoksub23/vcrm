-- ============================================================
-- Verification for migration 100 (Sembang P2: direct messages as
-- is_dm channels, moderate-policy DM carve-out, starred messages,
-- DM-aware channel list RPC, DM message notifications).
--
-- Migrations 098/099 are NOT yet applied to production, so this must
-- run with ALL THREE drafts in front (the whole thing rolls back):
--   cat supabase/ci/drafts/098_sembang_p0.sql \
--       supabase/ci/drafts/099_sembang_p1.sql \
--       supabase/ci/drafts/100_sembang_p2.sql \
--       supabase/ci/verify-100-sembang-p2.sql > /tmp/all.sql
--   supabase db query --linked -f /tmp/all.sql
-- Once 098/099 ship to production, this can run with just 100 + this file.
--
-- One DO block ending RAISE EXCEPTION 'ROLLBACK-OK: ...' — nothing is
-- ever committed. Same pg_temp.run(user, sql, role) helper as
-- verify-098/099, simulating RLS as different users via JWT claims.
-- ============================================================

DO $verify$
DECLARE
  a        UUID;
  owner_a  UUID := gen_random_uuid();
  admin_a  UUID := gen_random_uuid();
  dm_a     UUID := gen_random_uuid(); -- creates the DM, auto-moderator
  dm_b     UUID := gen_random_uuid(); -- the other DM participant
  out_a    UUID := gen_random_uuid(); -- has menu.sembang, never joins the DM
  ch_dm    UUID;
  ch_plain UUID;
  msg1     UUID;
  msg2     UUID;
  msg3     UUID;
  dm_key1  TEXT;
  res      TEXT;
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
         'verify100-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, admin_a, dm_a, dm_b, out_a]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  IF a IS NULL THEN RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create an account'; END IF;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = admin_a;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (dm_a, dm_b, out_a);
  DELETE FROM accounts WHERE owner_user_id IN (admin_a, dm_a, dm_b, out_a);

  INSERT INTO role_capabilities (account_id, role, capability, granted, changed_by)
  VALUES (a, 'agent', 'menu.sembang', true, admin_a);

  dm_key1 := (SELECT string_agg(x::text, ',' ORDER BY x) FROM unnest(ARRAY[dm_a, dm_b]) AS x);

  -- ---------------------------------------------------------
  -- 1. DM creation + new constraints
  -- ---------------------------------------------------------
  res := pg_temp.run(dm_a, format(
    'INSERT INTO sembang_channels (account_id, is_private, is_dm, dm_key, created_by) VALUES (%L, true, true, %L, %L)',
    a, dm_key1, dm_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 1a create a DM with NULL name: %', res; END IF;
  SELECT id INTO ch_dm FROM sembang_channels WHERE account_id = a AND is_dm AND dm_key = dm_key1;

  res := pg_temp.run(dm_a, format(
    'INSERT INTO sembang_channels (account_id, is_private, is_dm, created_by) VALUES (%L, false, false, %L)', a, dm_a));
  IF res NOT LIKE '%sembang_channels_dm_name_check%' THEN
    RAISE EXCEPTION 'FAIL 1b a non-DM channel with NULL name was accepted: %', res;
  END IF;

  res := pg_temp.run(dm_a, format(
    'INSERT INTO sembang_channels (account_id, is_private, is_dm, dm_key, created_by) VALUES (%L, false, true, ''x,y'', %L)', a, dm_a));
  IF res NOT LIKE '%sembang_channels_dm_private_check%' THEN
    RAISE EXCEPTION 'FAIL 1c a non-private DM was accepted: %', res;
  END IF;

  res := pg_temp.run(dm_a, format(
    'INSERT INTO sembang_channels (account_id, is_private, is_dm, created_by) VALUES (%L, true, true, %L)', a, dm_a));
  IF res NOT LIKE '%sembang_channels_dm_key_check%' THEN
    RAISE EXCEPTION 'FAIL 1d a DM with NULL dm_key was accepted: %', res;
  END IF;

  res := pg_temp.run(dm_a, format(
    'INSERT INTO sembang_channels (account_id, name, is_private, is_dm, dm_key, created_by) VALUES (%L, ''oops'', false, false, ''x,y'', %L)', a, dm_a));
  IF res NOT LIKE '%sembang_channels_dm_key_check%' THEN
    RAISE EXCEPTION 'FAIL 1e a non-DM channel with a dm_key set was accepted: %', res;
  END IF;

  res := pg_temp.run(dm_a, format(
    'INSERT INTO sembang_channels (account_id, is_private, is_dm, dm_key, created_by) VALUES (%L, true, true, %L, %L)',
    a, dm_key1, dm_a));
  IF res NOT LIKE 'ERR%' THEN
    RAISE EXCEPTION 'FAIL 1f a second DM with the same participant set (dm_key) was accepted: %', res;
  END IF;

  -- a plain named channel for regression checks throughout — public,
  -- so dm_b can self-join it (self-insert into channel_members only
  -- works for a non-private channel; adding someone to a private one
  -- requires a moderator/admin, exercised separately above for the DM)
  PERFORM pg_temp.run(dm_a, format(
    'INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (%L, ''p2-general'', false, %L)', a, dm_a));
  SELECT id INTO ch_plain FROM sembang_channels WHERE account_id = a AND name = 'p2-general';

  -- ---------------------------------------------------------
  -- 2. Add the other DM participant + membership visibility
  -- ---------------------------------------------------------
  res := pg_temp.run(dm_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', ch_dm, a, dm_b));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 2a DM creator (auto-moderator) could not add the other participant: %', res; END IF;

  res := pg_temp.run(dm_b, format('SELECT count(*)::text FROM sembang_channels WHERE id = %L', ch_dm));
  IF res <> '1' THEN RAISE EXCEPTION 'FAIL 2b DM participant cannot see the DM: %', res; END IF;

  res := pg_temp.run(out_a, format('SELECT count(*)::text FROM sembang_channels WHERE id = %L', ch_dm));
  IF res <> '0' THEN RAISE EXCEPTION 'FAIL 2c a non-participant with only menu.sembang saw a private DM: %', res; END IF;

  res := pg_temp.run(admin_a, format('SELECT count(*)::text FROM sembang_channels WHERE id = %L', ch_dm));
  IF res <> '1' THEN RAISE EXCEPTION 'FAIL 2d account admin could not see the DM (Q1 admin-sees-everything continuity broken): %', res; END IF;

  -- ---------------------------------------------------------
  -- 3. Messaging + DM notifications (every message notifies, not
  --    just @mentions; a mention doesn't also double-notify)
  -- ---------------------------------------------------------
  res := pg_temp.run(dm_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''hello B'')', ch_dm, a, dm_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 3a send a DM message: %', res; END IF;
  SELECT id INTO msg1 FROM sembang_messages WHERE channel_id = ch_dm AND body = 'hello B';

  IF (SELECT count(*) FROM notifications WHERE user_id = dm_b AND type = 'sembang_dm_message' AND sembang_message_id = msg1) <> 1 THEN
    RAISE EXCEPTION 'FAIL 3b recipient did not get a sembang_dm_message notification for a plain (unmentioned) DM message';
  END IF;
  IF (SELECT count(*) FROM notifications WHERE user_id = dm_a AND sembang_message_id = msg1) <> 0 THEN
    RAISE EXCEPTION 'FAIL 3c sender got notified of their own DM message';
  END IF;

  res := pg_temp.run(dm_b, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body, mentions) VALUES (%L, %L, %L, ''hi back'', %L)',
    ch_dm, a, dm_b, ('["' || dm_a || '"]')::jsonb));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 3d send a DM message that also @mentions the recipient: %', res; END IF;
  SELECT id INTO msg2 FROM sembang_messages WHERE channel_id = ch_dm AND body = 'hi back';

  IF (SELECT count(*) FROM notifications WHERE user_id = dm_a AND sembang_message_id = msg2) <> 1 THEN
    RAISE EXCEPTION 'FAIL 3e a mentioned DM recipient got double-notified (or zero-notified) instead of exactly once';
  END IF;
  IF (SELECT type FROM notifications WHERE user_id = dm_a AND sembang_message_id = msg2) <> 'sembang_mention' THEN
    RAISE EXCEPTION 'FAIL 3f the single notification for a mentioned DM reply should be the mention type, not the generic DM type';
  END IF;

  -- a third message, used by the star tests below
  res := pg_temp.run(dm_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''star me'')', ch_dm, a, dm_a));
  SELECT id INTO msg3 FROM sembang_messages WHERE channel_id = ch_dm AND body = 'star me';

  -- ---------------------------------------------------------
  -- 4. Moderate-policy DM carve-out
  -- ---------------------------------------------------------
  PERFORM pg_temp.run(dm_a, format(
    'UPDATE sembang_messages SET deleted_at = now(), deleted_by = %L WHERE id = %L', dm_a, msg2));
  IF (SELECT deleted_at FROM sembang_messages WHERE id = msg2) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 4a DM creator (moderator) was able to remove the other participant''s message';
  END IF;

  -- regression: a moderator in a REAL (non-DM) channel can still
  -- remove another member's message
  PERFORM pg_temp.run(dm_b, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', ch_plain, a, dm_b));
  PERFORM pg_temp.run(dm_b, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''plain channel msg'')', ch_plain, a, dm_b));
  DECLARE v_plain_msg UUID; BEGIN
    SELECT id INTO v_plain_msg FROM sembang_messages WHERE channel_id = ch_plain AND body = 'plain channel msg';
    PERFORM pg_temp.run(dm_a, format(
      'UPDATE sembang_messages SET deleted_at = now(), deleted_by = %L WHERE id = %L', dm_a, v_plain_msg));
    IF (SELECT deleted_at FROM sembang_messages WHERE id = v_plain_msg) IS NULL THEN
      RAISE EXCEPTION 'FAIL 4b a real channel''s moderator could no longer remove another member''s message (regression)';
    END IF;
  END;

  -- admin can still remove a message inside a DM
  PERFORM pg_temp.run(admin_a, format(
    'UPDATE sembang_messages SET deleted_at = now(), deleted_by = %L WHERE id = %L', admin_a, msg2));
  IF (SELECT deleted_at FROM sembang_messages WHERE id = msg2) IS NULL THEN
    RAISE EXCEPTION 'FAIL 4c account admin could not remove a message inside a DM';
  END IF;

  -- ---------------------------------------------------------
  -- 5. Author edit/self-delete inside a DM still work (untouched policy)
  -- ---------------------------------------------------------
  res := pg_temp.run(dm_a, format(
    'UPDATE sembang_messages SET body = ''edited'', edited_at = now() WHERE id = %L', msg1));
  IF res <> 'OK' OR (SELECT body FROM sembang_messages WHERE id = msg1) <> 'edited' THEN
    RAISE EXCEPTION 'FAIL 5a author could not edit their own DM message: %', res;
  END IF;

  res := pg_temp.run(dm_a, format(
    'UPDATE sembang_messages SET deleted_at = now(), deleted_by = %L WHERE id = %L', dm_a, msg1));
  IF res <> 'OK' OR (SELECT deleted_at FROM sembang_messages WHERE id = msg1) IS NULL THEN
    RAISE EXCEPTION 'FAIL 5b author could not self-delete their own DM message: %', res;
  END IF;

  -- ---------------------------------------------------------
  -- 6. Starred messages — personal, visibility-checked, cross-account safe
  -- ---------------------------------------------------------
  res := pg_temp.run(dm_a, format(
    'INSERT INTO sembang_stars (message_id, account_id, user_id) VALUES (%L, %L, %L)', msg3, a, dm_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 6a star a visible message: %', res; END IF;

  res := pg_temp.run(dm_b, format('SELECT count(*)::text FROM sembang_stars WHERE message_id = %L', msg3));
  IF res <> '0' THEN RAISE EXCEPTION 'FAIL 6b another user could see someone else''s star (should be personal-only)'; END IF;

  res := pg_temp.run(dm_a, format('SELECT count(*)::text FROM sembang_stars WHERE message_id = %L AND user_id = %L', msg3, dm_a));
  IF res <> '1' THEN RAISE EXCEPTION 'FAIL 6c the starrer could not see their own star: %', res; END IF;

  res := pg_temp.run(out_a, format(
    'INSERT INTO sembang_stars (message_id, account_id, user_id) VALUES (%L, %L, %L)', msg3, a, out_a));
  IF res NOT LIKE 'ERR%' THEN
    RAISE EXCEPTION 'FAIL 6d a non-member of the DM was able to star a message they cannot see: %', res;
  END IF;

  res := pg_temp.run(dm_a, format('DELETE FROM sembang_stars WHERE message_id = %L AND user_id = %L', msg3, dm_a));
  IF res <> 'OK' OR (SELECT count(*) FROM sembang_stars WHERE message_id = msg3 AND user_id = dm_a) <> 0 THEN
    RAISE EXCEPTION 'FAIL 6e the starrer could not remove their own star: %', res;
  END IF;

  -- cross-account hygiene: pair a real message from account B with account A's own id
  DECLARE
    owner_b UUID := gen_random_uuid();
    b       UUID;
    ch_b    UUID;
    msg_b   UUID;
  BEGIN
    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (owner_b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'verify100-b-' || owner_b || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now());
    SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
    INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (b, 'b-chan', false, owner_b) RETURNING id INTO ch_b;
    INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (ch_b, b, owner_b, 'account b msg') RETURNING id INTO msg_b;

    res := pg_temp.run(dm_a, format(
      'INSERT INTO sembang_stars (message_id, account_id, user_id) VALUES (%L, %L, %L)', msg_b, a, dm_a));
    IF res NOT LIKE 'ERR%' THEN
      RAISE EXCEPTION 'FAIL 6f starred account B''s message paired with account A''s id: %', res;
    END IF;

    -- ---------------------------------------------------------
    -- 7. Cross-account isolation on the DM itself
    -- ---------------------------------------------------------
    res := pg_temp.run(owner_b, format('SELECT count(*)::text FROM sembang_channels WHERE id = %L', ch_dm));
    IF res <> '0' THEN RAISE EXCEPTION 'FAIL 7a a different account''s owner could see account A''s DM: %', res; END IF;
  END;

  -- ---------------------------------------------------------
  -- 8. list_sembang_channels_for_current_user — DM-aware
  --    (the RPC keys off auth.uid(), so every call must run through
  --    pg_temp.run as a specific user, not unqualified as this block's
  --    own role)
  -- ---------------------------------------------------------
  res := pg_temp.run(dm_b, format(
    'SELECT is_dm::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch_dm));
  IF res <> 'true' THEN RAISE EXCEPTION 'FAIL 8a RPC did not report is_dm = true for the DM row: %', res; END IF;

  -- run as dm_b: the "other participant" is dm_a, so exactly 1 name back
  res := pg_temp.run(dm_b, format(
    'SELECT COALESCE(array_length((SELECT dm_participant_names FROM list_sembang_channels_for_current_user(%L) WHERE id = %L), 1), 0)::text',
    a, ch_dm));
  IF res <> '1' THEN RAISE EXCEPTION 'FAIL 8b RPC dm_participant_names did not return exactly the one other participant: %', res; END IF;

  res := pg_temp.run(dm_a, format(
    'SELECT is_dm::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch_plain));
  IF res <> 'false' THEN RAISE EXCEPTION 'FAIL 8c RPC reported is_dm = true for a regular channel (regression): %', res; END IF;

  res := pg_temp.run(dm_a, format(
    'SELECT COALESCE((SELECT dm_participant_names FROM list_sembang_channels_for_current_user(%L) WHERE id = %L) IS NULL, true)::text',
    a, ch_plain));
  IF res <> 'true' THEN RAISE EXCEPTION 'FAIL 8d RPC computed dm_participant_names for a regular (non-DM) channel: %', res; END IF;

  -- ---------------------------------------------------------
  -- 9. notifications.type widened, not replaced
  -- ---------------------------------------------------------
  DECLARE v_def TEXT; BEGIN
    SELECT pg_get_constraintdef(oid) INTO v_def
      FROM pg_constraint WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';
    IF v_def NOT LIKE '%sembang_dm_message%' THEN RAISE EXCEPTION 'FAIL 9a sembang_dm_message missing from the widened constraint'; END IF;
    IF v_def NOT LIKE '%sembang_mention%' THEN RAISE EXCEPTION 'FAIL 9b sembang_mention (098) was dropped by the 100 widen'; END IF;
    IF v_def NOT LIKE '%sembang_task_assigned%' THEN RAISE EXCEPTION 'FAIL 9c sembang_task_assigned (099) was dropped by the 100 widen'; END IF;
  END;

  RAISE EXCEPTION 'ROLLBACK-OK: Sembang P2 (DMs as is_dm sembang_channels rows with dm_key dedup + adjusted name/private constraints, moderate-policy DM carve-out with real-channel moderation left intact, author edit/self-delete unaffected, starred messages personal+visibility-checked+cross-account-safe, DM-aware list_sembang_channels_for_current_user RPC, every-message DM notifications that skip a redundant mention notification, notifications.type widened not replaced, cross-account isolation on the DM itself) checked in 9 groups';
END
$verify$;
