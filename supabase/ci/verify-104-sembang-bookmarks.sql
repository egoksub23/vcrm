-- ============================================================
-- Verification for sembang_bookmarks (migration 104).
--
-- Migrations 098-103 are confirmed applied to production (checked via
-- `supabase migration list --linked` before writing this), so this
-- only needs its own draft in front:
--   cat supabase/ci/drafts/104_sembang_bookmarks.sql \
--       supabase/ci/verify-104-sembang-bookmarks.sql > /tmp/all.sql
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
  mem_a   UUID := gen_random_uuid(); -- self-joins, plain member, adds the bookmark
  other_a UUID := gen_random_uuid(); -- self-joins, plain member, did NOT add it
  ch      UUID;
  bm      UUID;
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
         'verify104-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, mod_a, mem_a, other_a]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  IF a IS NULL THEN RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create an account'; END IF;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (mod_a, mem_a, other_a);
  DELETE FROM accounts WHERE owner_user_id IN (mod_a, mem_a, other_a);

  INSERT INTO role_capabilities (account_id, role, capability, granted, changed_by)
  VALUES (a, 'agent', 'menu.sembang', true, owner_a);

  PERFORM pg_temp.run(mod_a, format(
    'INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (%L, ''resources'', false, %L)', a, mod_a));
  SELECT id INTO ch FROM sembang_channels WHERE account_id = a AND name = 'resources';
  PERFORM pg_temp.run(mem_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', ch, a, mem_a));
  PERFORM pg_temp.run(other_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', ch, a, other_a));

  -- ---------------------------------------------------------
  -- 1. A plain member can add a bookmark
  -- ---------------------------------------------------------
  res := pg_temp.run(mem_a, format(
    'INSERT INTO sembang_bookmarks (channel_id, account_id, url, title, added_by) VALUES (%L, %L, ''https://example.com/runbook'', ''Runbook'', %L)',
    ch, a, mem_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 1 member adds a bookmark: %', res; END IF;
  SELECT id INTO bm FROM sembang_bookmarks WHERE channel_id = ch AND url = 'https://example.com/runbook';

  -- ---------------------------------------------------------
  -- 2. A non-http(s) URL is rejected by the CHECK constraint
  -- ---------------------------------------------------------
  res := pg_temp.run(mem_a, format(
    'INSERT INTO sembang_bookmarks (channel_id, account_id, url, added_by) VALUES (%L, %L, ''javascript:alert(1)'', %L)',
    ch, a, mem_a));
  IF res NOT LIKE '%ERR%' THEN RAISE EXCEPTION 'FAIL 2 a non-http(s) URL should have been rejected: %', res; END IF;

  -- ---------------------------------------------------------
  -- 3. A DIFFERENT plain member (not the adder, not a moderator) CANNOT
  --    delete someone else's bookmark
  -- ---------------------------------------------------------
  res := pg_temp.run(other_a, format(
    'DELETE FROM sembang_bookmarks WHERE id = %L RETURNING id', bm));
  -- A 0-row delete under RLS returns 'OK' (no exception), so check the
  -- row still exists rather than trusting the run() result string here.
  res := pg_temp.run(NULL, format('SELECT count(*)::text FROM sembang_bookmarks WHERE id = %L', bm), 'postgres');
  IF res <> '1' THEN RAISE EXCEPTION 'FAIL 3 a non-adder, non-moderator member should not have been able to delete the bookmark: %', res; END IF;

  -- ---------------------------------------------------------
  -- 4. The channel's moderator (mod_a, the creator) CAN delete it
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format('DELETE FROM sembang_bookmarks WHERE id = %L RETURNING id', bm));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 4 the moderator''s delete errored: %', res; END IF;

  res := pg_temp.run(NULL, format('SELECT count(*)::text FROM sembang_bookmarks WHERE id = %L', bm), 'postgres');
  IF res <> '0' THEN RAISE EXCEPTION 'FAIL 4b bookmark still exists after the moderator deleted it: %', res; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: sembang_bookmarks (member can add, non-http(s) URL rejected, only adder/moderator/admin can delete) checked in 4 groups';
END
$verify$;
