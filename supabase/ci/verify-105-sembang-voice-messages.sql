-- ============================================================
-- Verification for Sembang voice messages (migration 105).
--
-- Migrations 098-104 are confirmed applied to production (checked via
-- `supabase migration list --linked` before writing this), so this
-- only needs its own draft in front:
--   cat supabase/ci/drafts/105_sembang_voice_messages.sql \
--       supabase/ci/verify-105-sembang-voice-messages.sql > /tmp/all.sql
--   supabase db query --linked -f /tmp/all.sql
--
-- One DO block ending RAISE EXCEPTION 'ROLLBACK-OK: ...' — nothing is
-- ever committed. Same pg_temp.run(user, sql, role) helper as every
-- prior Sembang verify script.
-- ============================================================

DO $verify$
DECLARE
  a     UUID;
  mod_a UUID := gen_random_uuid(); -- creates the channel, auto-moderator
  ch    UUID;
  res   TEXT;
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
         'verify105-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[mod_a]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = mod_a;
  IF a IS NULL THEN RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create an account'; END IF;

  INSERT INTO role_capabilities (account_id, role, capability, granted, changed_by)
  VALUES (a, 'agent', 'menu.sembang', true, mod_a);

  PERFORM pg_temp.run(mod_a, format(
    'INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (%L, ''voice-test'', false, %L)', a, mod_a));
  SELECT id INTO ch FROM sembang_channels WHERE account_id = a AND name = 'voice-test';

  -- ---------------------------------------------------------
  -- 1. `sembang-files` now allow-lists audio/ogg
  -- ---------------------------------------------------------
  res := pg_temp.run(NULL, $q$
    SELECT ('audio/ogg' = ANY(allowed_mime_types))::text FROM storage.buckets WHERE id = 'sembang-files'
  $q$, 'postgres');
  IF res <> 'true' THEN RAISE EXCEPTION 'FAIL 1 sembang-files should allow-list audio/ogg: %', res; END IF;

  -- ---------------------------------------------------------
  -- 2. A message with an empty body now inserts successfully (an
  --    attachment-only / voice-note send) — the CHECK no longer
  --    requires at least 1 char.
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, '''')',
    ch, a, mod_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 2 an empty-body message should now be allowed: %', res; END IF;

  -- ---------------------------------------------------------
  -- 3. Body still can't exceed 8000 chars (upper bound untouched)
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, %L)',
    ch, a, mod_a, repeat('x', 8001)));
  IF res NOT LIKE '%ERR%' THEN RAISE EXCEPTION 'FAIL 3 a body over 8000 chars should still be rejected: %', res; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: sembang voice messages (audio/ogg allow-listed, empty body now permitted, 8000-char cap still enforced) checked in 3 groups';
END
$verify$;
