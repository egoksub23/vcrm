-- ============================================================
-- Verification for Sembang "remove from sidebar" (migration 106).
--
-- Migrations 098-105 are confirmed applied to production (checked via
-- `supabase migration list --linked` before writing this), so this
-- only needs its own draft in front:
--   cat supabase/ci/drafts/106_sembang_hide_dm.sql \
--       supabase/ci/verify-106-sembang-hide-dm.sql > /tmp/all.sql
--   supabase db query --linked -f /tmp/all.sql
--
-- One DO block ending RAISE EXCEPTION 'ROLLBACK-OK: ...' — nothing is
-- ever committed. Same pg_temp.run(user, sql, role) helper as every
-- prior Sembang verify script.
-- ============================================================

DO $verify$
DECLARE
  a      UUID;
  u1     UUID := gen_random_uuid(); -- hides the DM, then re-opens it
  u2     UUID := gen_random_uuid(); -- the other participant
  ch     UUID;
  cnt    TEXT;
  res    TEXT;
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
         'verify106-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[u1, u2]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = u1;
  IF a IS NULL THEN RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create an account'; END IF;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id = u2;
  DELETE FROM accounts WHERE owner_user_id = u2;

  INSERT INTO role_capabilities (account_id, role, capability, granted, changed_by)
  VALUES (a, 'agent', 'menu.sembang', true, u1);

  -- A trigger already adds the creator (u1) as moderator on insert (same
  -- one /api/sembang/dms relies on) — only u2 needs an explicit insert.
  INSERT INTO sembang_channels (account_id, is_private, is_dm, dm_key, created_by)
  VALUES (a, true, true, array_to_string(ARRAY[u1, u2]::text[], ','), u1)
  RETURNING id INTO ch;
  INSERT INTO sembang_channel_members (channel_id, account_id, user_id, role) VALUES (ch, a, u2, 'member');
  INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (ch, a, u2, 'hey');

  -- ---------------------------------------------------------
  -- 1. u1 hides the DM — it drops out of their own channel list
  -- ---------------------------------------------------------
  res := pg_temp.run(u1, format('SELECT set_sembang_channel_hidden(%L, true)::text', ch));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 1 set_sembang_channel_hidden errored: %', res; END IF;

  cnt := pg_temp.run(u1, format(
    'SELECT count(*)::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch));
  IF cnt <> '0' THEN RAISE EXCEPTION 'FAIL 1b hidden DM should not appear in u1''s channel list: %', cnt; END IF;

  -- ---------------------------------------------------------
  -- 2. It's still there for u2 (hidden_at is per-member, not per-channel)
  -- ---------------------------------------------------------
  cnt := pg_temp.run(u2, format(
    'SELECT count(*)::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch));
  IF cnt <> '1' THEN RAISE EXCEPTION 'FAIL 2 the DM should still be visible to u2: %', cnt; END IF;

  -- ---------------------------------------------------------
  -- 3. A new message reaching the channel un-hides it for u1 automatically.
  --    The whole verify block runs in one transaction, where now() is
  --    constant — so this message's created_at is pinned a beat past
  --    hidden_at explicitly, standing in for the real wall-clock gap two
  --    separate requests would naturally have in production.
  -- ---------------------------------------------------------
  INSERT INTO sembang_messages (channel_id, account_id, author_id, body, created_at)
  VALUES (ch, a, u2, 'you there?', now() + interval '1 second');
  cnt := pg_temp.run(u1, format(
    'SELECT count(*)::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch));
  IF cnt <> '1' THEN RAISE EXCEPTION 'FAIL 3 a new message should have un-hidden the DM: %', cnt; END IF;

  -- ---------------------------------------------------------
  -- 4. Hide again, then confirm marking it read (opening it) un-hides it
  --    even with no new message — mark_sembang_channel_read now also
  --    clears hidden_at. The whole verify block shares one now(), so the
  --    RPC's hidden_at (transaction-start now()) would otherwise land
  --    BEFORE the check-3 message (explicitly stamped a beat past it) —
  --    nudge it forward directly to stand in for the real elapsed time a
  --    second, separate request would naturally have.
  -- ---------------------------------------------------------
  PERFORM pg_temp.run(u1, format('SELECT set_sembang_channel_hidden(%L, true)::text', ch));
  UPDATE sembang_channel_members SET hidden_at = now() + interval '2 seconds'
    WHERE channel_id = ch AND user_id = u1;
  cnt := pg_temp.run(u1, format(
    'SELECT count(*)::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch));
  IF cnt <> '0' THEN RAISE EXCEPTION 'FAIL 4 DM should be hidden again before the read-marking check: %', cnt; END IF;

  PERFORM pg_temp.run(u1, format('SELECT mark_sembang_channel_read(%L)::text', ch));
  cnt := pg_temp.run(u1, format(
    'SELECT count(*)::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, ch));
  IF cnt <> '1' THEN RAISE EXCEPTION 'FAIL 4b marking the channel read should also un-hide it: %', cnt; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: sembang hide-DM (hides for that member only, reappears on a new message or on being marked read) checked in 4 groups';
END
$verify$;
