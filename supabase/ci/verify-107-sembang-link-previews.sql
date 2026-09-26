-- ============================================================
-- Verification for Sembang link previews (migration 107).
--
-- Migrations 098-106 are confirmed applied to production (checked via
-- `supabase migration list --linked` before writing this), so this
-- only needs its own draft in front:
--   cat supabase/ci/drafts/107_sembang_link_previews.sql \
--       supabase/ci/verify-107-sembang-link-previews.sql > /tmp/all.sql
--   supabase db query --linked -f /tmp/all.sql
--
-- One DO block ending RAISE EXCEPTION 'ROLLBACK-OK: ...' — nothing is
-- ever committed. Same pg_temp.run(user, sql, role) helper as every
-- prior Sembang verify script.
-- ============================================================

DO $verify$
DECLARE
  a       UUID;
  mem_a   UUID := gen_random_uuid(); -- channel creator/moderator
  other_a UUID := gen_random_uuid(); -- outside account, never a member
  ch      UUID;
  msg     UUID;
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
         'verify107-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[mem_a, other_a]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = mem_a;
  IF a IS NULL THEN RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create an account'; END IF;

  INSERT INTO role_capabilities (account_id, role, capability, granted, changed_by)
  VALUES (a, 'agent', 'menu.sembang', true, mem_a);

  PERFORM pg_temp.run(mem_a, format(
    'INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (%L, ''unfurl-test'', false, %L)', a, mem_a));
  SELECT id INTO ch FROM sembang_channels WHERE account_id = a AND name = 'unfurl-test';
  PERFORM pg_temp.run(mem_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''check out https://example.com'')',
    ch, a, mem_a));
  SELECT id INTO msg FROM sembang_messages WHERE channel_id = ch AND author_id = mem_a;

  -- Only the server (service role) ever writes this table — simulate
  -- the after() callback's insert directly as postgres.
  PERFORM pg_temp.run(NULL, format(
    'INSERT INTO sembang_link_previews (message_id, account_id, url, title, domain) VALUES (%L, %L, ''https://example.com'', ''Example Domain'', ''example.com'')',
    msg, a), 'postgres');

  -- ---------------------------------------------------------
  -- 1. A member of the (public) channel can read the preview
  -- ---------------------------------------------------------
  res := pg_temp.run(mem_a, format('SELECT title FROM sembang_link_previews WHERE message_id = %L', msg));
  IF res <> 'Example Domain' THEN RAISE EXCEPTION 'FAIL 1 a channel member should be able to read the preview: %', res; END IF;

  -- ---------------------------------------------------------
  -- 2. Someone outside the account (no membership, no capability) sees nothing
  -- ---------------------------------------------------------
  res := pg_temp.run(other_a, format('SELECT count(*)::text FROM sembang_link_previews WHERE message_id = %L', msg));
  IF res <> '0' THEN RAISE EXCEPTION 'FAIL 2 a non-member outside the account should see no rows: %', res; END IF;

  -- ---------------------------------------------------------
  -- 3. A regular member CANNOT insert a preview directly (server/service-role only)
  -- ---------------------------------------------------------
  res := pg_temp.run(mem_a, format(
    'INSERT INTO sembang_link_previews (message_id, account_id, url) VALUES (%L, %L, ''https://evil.example'')',
    msg, a));
  IF res NOT LIKE '%ERR%' THEN RAISE EXCEPTION 'FAIL 3 a client should not be able to insert a preview row directly: %', res; END IF;

  -- ---------------------------------------------------------
  -- 4. Deleting the message cascades to its preview
  -- ---------------------------------------------------------
  PERFORM pg_temp.run(NULL, format('DELETE FROM sembang_messages WHERE id = %L', msg), 'postgres');
  res := pg_temp.run(NULL, format('SELECT count(*)::text FROM sembang_link_previews WHERE message_id = %L', msg), 'postgres');
  IF res <> '0' THEN RAISE EXCEPTION 'FAIL 4 the preview row should be gone after its message is deleted: %', res; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: sembang_link_previews (member can read, outsider cannot, client cannot write directly, cascades on message delete) checked in 4 groups';
END
$verify$;
