-- ============================================================
-- Verification for the Sembang task -> Ticket bridge migration
-- (sembang_tasks.ticket_id, write-once, same-account-only).
--
-- Migrations 098-102 are confirmed applied to production (checked via
-- `supabase migration list --linked` before writing this), so this
-- only needs its own draft in front:
--   cat supabase/ci/drafts/103_sembang_task_ticket_bridge.sql \
--       supabase/ci/verify-103-sembang-task-ticket-bridge.sql > /tmp/all.sql
--   supabase db query --linked -f /tmp/all.sql
--
-- One DO block ending RAISE EXCEPTION 'ROLLBACK-OK: ...' — nothing is
-- ever committed. Same pg_temp.run(user, sql, role) helper as every
-- prior Sembang verify script.
-- ============================================================

DO $verify$
DECLARE
  a         UUID;
  owner_a   UUID := gen_random_uuid();
  mod_a     UUID := gen_random_uuid(); -- creates the channel, auto-moderator
  b         UUID; -- a second, unrelated account
  owner_b   UUID := gen_random_uuid();
  ch        UUID;
  task      UUID;
  contact_a UUID;
  contact_b UUID;
  ticket_a  UUID;
  ticket_b  UUID;
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
  -- fixtures: two separate accounts (a, b), a channel + task in a,
  -- a contact + ticket in each account
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify103-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, mod_a, owner_b]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
  IF a IS NULL OR b IS NULL THEN RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create an account'; END IF;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id = mod_a;
  DELETE FROM accounts WHERE owner_user_id = mod_a;

  INSERT INTO role_capabilities (account_id, role, capability, granted, changed_by)
  VALUES (a, 'agent', 'menu.sembang', true, owner_a);

  INSERT INTO contacts (user_id, account_id, phone, name) VALUES (owner_a, a, '+10000000001', 'Test Contact A') RETURNING id INTO contact_a;
  INSERT INTO tickets (account_id, ticket_number, contact_id, subject, created_by)
  VALUES (a, 9001, contact_a, 'Ticket in account A', owner_a) RETURNING id INTO ticket_a;

  INSERT INTO contacts (user_id, account_id, phone, name) VALUES (owner_b, b, '+10000000002', 'Test Contact B') RETURNING id INTO contact_b;
  INSERT INTO tickets (account_id, ticket_number, contact_id, subject, created_by)
  VALUES (b, 9001, contact_b, 'Ticket in account B', owner_b)
  RETURNING id INTO ticket_b;

  PERFORM pg_temp.run(mod_a, format(
    'INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (%L, ''bridge-test'', false, %L)', a, mod_a));
  SELECT id INTO ch FROM sembang_channels WHERE account_id = a AND name = 'bridge-test';

  res := pg_temp.run(mod_a, format(
    'INSERT INTO sembang_tasks (channel_id, account_id, title, created_by) VALUES (%L, %L, ''ship the thing'', %L)',
    ch, a, mod_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL fixtures: create task: %', res; END IF;
  SELECT id INTO task FROM sembang_tasks WHERE channel_id = ch AND title = 'ship the thing';

  -- ---------------------------------------------------------
  -- 1. Linking to a real ticket in the SAME account succeeds
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format(
    'UPDATE sembang_tasks SET ticket_id = %L WHERE id = %L', ticket_a, task));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 1 link task to same-account ticket: %', res; END IF;

  res := pg_temp.run(mod_a, format(
    'SELECT ticket_id::text FROM sembang_tasks WHERE id = %L', task));
  IF res <> ticket_a::text THEN RAISE EXCEPTION 'FAIL 1b ticket_id did not persist: %', res; END IF;

  -- ---------------------------------------------------------
  -- 2. Changing an already-set ticket_id is rejected (write-once)
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format(
    'UPDATE sembang_tasks SET ticket_id = %L WHERE id = %L', ticket_b, task));
  IF res NOT LIKE '%sembang_task_ticket_id_immutable_once_set%' THEN
    RAISE EXCEPTION 'FAIL 2 re-linking an already-linked task should have been rejected: %', res;
  END IF;

  -- Confirm it's still pointed at the original ticket after the rejected attempt
  res := pg_temp.run(mod_a, format(
    'SELECT ticket_id::text FROM sembang_tasks WHERE id = %L', task));
  IF res <> ticket_a::text THEN RAISE EXCEPTION 'FAIL 2b ticket_id changed despite the rejected update: %', res; END IF;

  -- ---------------------------------------------------------
  -- 3. Linking a DIFFERENT (unlinked) task to a ticket in ANOTHER
  --    account is rejected (cross-account hygiene)
  -- ---------------------------------------------------------
  res := pg_temp.run(mod_a, format(
    'INSERT INTO sembang_tasks (channel_id, account_id, title, created_by) VALUES (%L, %L, ''second task'', %L)',
    ch, a, mod_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 3a create second task: %', res; END IF;

  res := pg_temp.run(mod_a, format(
    'UPDATE sembang_tasks SET ticket_id = %L WHERE channel_id = %L AND title = ''second task''', ticket_b, ch));
  IF res NOT LIKE '%sembang_task_ticket_id_cross_account_or_missing%' THEN
    RAISE EXCEPTION 'FAIL 3b linking to another account''s ticket should have been rejected: %', res;
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: sembang_tasks.ticket_id bridge (same-account link succeeds, write-once enforced, cross-account link rejected) checked in 3 groups';
END
$verify$;
