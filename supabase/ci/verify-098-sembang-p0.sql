-- ============================================================
-- Verification for migration 098 (Sembang P0: channels, membership
-- with a moderator role, messages, attachments, mention
-- notifications, the private storage bucket).
--
-- Run against a database that already has 098 applied:
--   supabase db query --linked -f supabase/ci/verify-098-sembang-p0.sql
--
-- Or BEFORE applying, with the draft in front (the whole thing rolls back):
--   cat supabase/ci/drafts/098_sembang_p0.sql \
--       supabase/ci/verify-098-sembang-p0.sql > /tmp/both.sql
--   supabase db query --linked -f /tmp/both.sql
--
-- One DO block that ends with RAISE EXCEPTION 'ROLLBACK-OK: ...', so
-- nothing is ever committed. A message starting with ROLLBACK-OK means
-- every check passed; any other error message names the check that
-- failed.
--
-- People are simulated the way PostgREST does it: set the JWT claims
-- and SET LOCAL ROLE authenticated, so RLS, grants and capability
-- resolution apply for real. Same helper shape as verify-096.
-- ============================================================

DO $verify$
DECLARE
  a         UUID;
  b         UUID;
  owner_a   UUID := gen_random_uuid();
  admin_a   UUID := gen_random_uuid();
  agent_a   UUID := gen_random_uuid(); -- never granted Sembang access
  agent2_a  UUID := gen_random_uuid(); -- granted Sembang access mid-test
  owner_b   UUID := gen_random_uuid();
  pub_ch    UUID;
  priv_ch   UUID;
  pub_ch_b  UUID;
  msg1      UUID;
  res       TEXT;
BEGIN
  -- ---------------------------------------------------------
  -- helper (identical shape to verify-096's pg_temp.run)
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

  -- ---------------------------------------------------------
  -- fixtures: users -> (trigger) accounts + profiles
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify098-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, admin_a, agent_a, agent2_a, owner_b]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create accounts';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'admin' WHERE user_id = admin_a;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (agent_a, agent2_a);
  DELETE FROM accounts WHERE owner_user_id IN (admin_a, agent_a, agent2_a);

  -- ---------------------------------------------------------
  -- 1. Capability catalogue: seeded, default owner+admin only
  -- ---------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM capability_catalogue WHERE capability = 'menu.sembang' AND enforced_by = 'database') THEN
    RAISE EXCEPTION 'FAIL 1a menu.sembang missing from the catalogue or not database-enforced';
  END IF;
  -- account_role_enum sorts by declaration order (owner, admin, agent, viewer), not alphabetically
  IF (SELECT array_agg(role::text ORDER BY role) FROM role_capability_defaults WHERE capability = 'menu.sembang')
       IS DISTINCT FROM ARRAY['owner', 'admin'] THEN
    RAISE EXCEPTION 'FAIL 1b menu.sembang default roles are not exactly owner+admin';
  END IF;

  -- ---------------------------------------------------------
  -- 2. RLS is on; no client UPDATE policy on the members table
  --    (role self-promotion must be impossible)
  -- ---------------------------------------------------------
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sembang_channels'::regclass) THEN
    RAISE EXCEPTION 'FAIL 2a sembang_channels has no row level security';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sembang_channel_members'::regclass) THEN
    RAISE EXCEPTION 'FAIL 2b sembang_channel_members has no row level security';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sembang_messages'::regclass) THEN
    RAISE EXCEPTION 'FAIL 2c sembang_messages has no row level security';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sembang_attachments'::regclass) THEN
    RAISE EXCEPTION 'FAIL 2d sembang_attachments has no row level security';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sembang_channel_members' AND cmd = 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL 2e sembang_channel_members has a client UPDATE policy';
  END IF;

  -- ---------------------------------------------------------
  -- 3. Without menu.sembang, an agent creates nothing
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, format(
    'INSERT INTO sembang_channels (account_id, name, created_by) VALUES (%L, ''blocked'', %L)', a, agent_a));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 3a an agent without menu.sembang created a channel: %', res; END IF;

  -- ---------------------------------------------------------
  -- 4. An admin (default access) creates a public + a private channel;
  --    the creator is auto-promoted to moderator by the trigger
  -- ---------------------------------------------------------
  res := pg_temp.run(admin_a, format(
    'INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (%L, ''general'', false, %L)',
    a, admin_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 4a admin could not create a public channel: %', res; END IF;
  SELECT id INTO pub_ch FROM sembang_channels WHERE account_id = a AND name = 'general';

  res := pg_temp.run(admin_a, format(
    'INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (%L, ''oncall'', true, %L)',
    a, admin_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 4b admin could not create a private channel: %', res; END IF;
  SELECT id INTO priv_ch FROM sembang_channels WHERE account_id = a AND name = 'oncall';

  IF NOT EXISTS (
    SELECT 1 FROM sembang_channel_members WHERE channel_id = priv_ch AND user_id = admin_a AND role = 'moderator'
  ) THEN
    RAISE EXCEPTION 'FAIL 4c the creator was not auto-promoted to moderator';
  END IF;

  res := pg_temp.run(admin_a, format(
    'INSERT INTO sembang_channels (account_id, name, created_by) VALUES (%L, ''General'', %L)', a, admin_a));
  IF res NOT LIKE 'ERR 23505%' THEN RAISE EXCEPTION 'FAIL 4d a case-insensitive duplicate channel name was accepted: %', res; END IF;

  -- ---------------------------------------------------------
  -- 5. An agent without menu.sembang cannot see either channel
  -- ---------------------------------------------------------
  IF pg_temp.run(agent_a, format('SELECT count(*)::text FROM sembang_channels WHERE id = %L', pub_ch)) <> '0' THEN
    RAISE EXCEPTION 'FAIL 5a an agent without menu.sembang can see a public channel';
  END IF;

  -- ---------------------------------------------------------
  -- 6. The admin grants menu.sembang down to Agent for this account
  --    (the real "given access" mechanism) — agent2 gets it, agent stays out
  -- ---------------------------------------------------------
  INSERT INTO role_capabilities (account_id, role, capability, granted, changed_by)
  VALUES (a, 'agent', 'menu.sembang', true, admin_a);

  IF pg_temp.run(agent2_a, format('SELECT count(*)::text FROM sembang_channels WHERE id = %L', pub_ch)) <> '1' THEN
    RAISE EXCEPTION 'FAIL 6a agent2 (granted access) still cannot see the public channel';
  END IF;
  IF pg_temp.run(agent2_a, format('SELECT count(*)::text FROM sembang_channels WHERE id = %L', priv_ch)) <> '0' THEN
    RAISE EXCEPTION 'FAIL 6b agent2 (not a member) can see the private channel';
  END IF;
  -- the grant is role-wide for the account (there is no per-user override
  -- mechanism in this app — see migration 079), so agent_a, same role and
  -- account as agent2_a, now ALSO has access. That is correct, not a leak:
  -- "given access" in this app means "an admin granted it to your role".
  IF pg_temp.run(agent_a, format('SELECT count(*)::text FROM sembang_channels WHERE id = %L', pub_ch)) <> '1' THEN
    RAISE EXCEPTION 'FAIL 6c the role-wide grant did not extend to every agent in the account';
  END IF;

  -- ---------------------------------------------------------
  -- 7. Public channel: self-join works for someone with access;
  --    a private channel cannot be self-joined even with access;
  --    only a moderator/admin can add someone else
  -- ---------------------------------------------------------
  res := pg_temp.run(agent2_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', pub_ch, a, agent2_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 7a agent2 could not self-join the public channel: %', res; END IF;

  res := pg_temp.run(agent2_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', pub_ch, a, agent_a));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 7b agent2 added someone else without being a moderator: %', res; END IF;

  res := pg_temp.run(agent2_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', priv_ch, a, agent2_a));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 7c a private channel was self-joinable: %', res; END IF;

  res := pg_temp.run(admin_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)', priv_ch, a, agent2_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 7d the moderator could not add a member to the private channel: %', res; END IF;
  IF pg_temp.run(agent2_a, format('SELECT count(*)::text FROM sembang_channels WHERE id = %L', priv_ch)) <> '1' THEN
    RAISE EXCEPTION 'FAIL 7e agent2 still cannot see the private channel after being added';
  END IF;

  -- ---------------------------------------------------------
  -- 8. Posting requires membership; author cannot be spoofed
  -- ---------------------------------------------------------
  res := pg_temp.run(agent2_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''hello'')',
    pub_ch, a, agent2_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 8a a member could not post to the public channel: %', res; END IF;
  SELECT id INTO msg1 FROM sembang_messages WHERE channel_id = pub_ch AND body = 'hello';

  res := pg_temp.run(agent2_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''spoofed'')',
    pub_ch, a, admin_a));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 8b a member posted a message authored as someone else: %', res; END IF;

  -- ---------------------------------------------------------
  -- 9. Moderators remove messages; a plain member cannot
  -- ---------------------------------------------------------
  PERFORM pg_temp.run(agent2_a, format('UPDATE sembang_messages SET deleted_at = now() WHERE id = %L', msg1));
  IF (SELECT deleted_at FROM sembang_messages WHERE id = msg1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 9a a plain member removed a message';
  END IF;
  res := pg_temp.run(admin_a, format(
    'UPDATE sembang_messages SET deleted_at = now(), deleted_by = %L WHERE id = %L', admin_a, msg1));
  IF res <> 'OK' OR (SELECT deleted_at FROM sembang_messages WHERE id = msg1) IS NULL THEN
    RAISE EXCEPTION 'FAIL 9b the moderator could not remove a message: %', res;
  END IF;

  -- ---------------------------------------------------------
  -- 10. A SECOND admin, who never joined the private channel, still
  --     sees and can moderate it
  -- ---------------------------------------------------------
  UPDATE profiles SET account_role = 'admin' WHERE user_id = agent_a;
  IF pg_temp.run(agent_a, format('SELECT count(*)::text FROM sembang_channels WHERE id = %L', priv_ch)) <> '1' THEN
    RAISE EXCEPTION 'FAIL 10a a second admin (never a member) cannot see the private channel';
  END IF;
  IF EXISTS (SELECT 1 FROM sembang_channel_members WHERE channel_id = priv_ch AND user_id = agent_a) THEN
    RAISE EXCEPTION 'FAIL 10b merely reading auto-added the admin as a member';
  END IF;
  UPDATE profiles SET account_role = 'agent' WHERE user_id = agent_a; -- restore

  -- ---------------------------------------------------------
  -- 11. Unread counting + mark-as-read RPC
  --
  -- now() is frozen for the whole transaction, so every row this test
  -- inserts gets the SAME created_at unless a column explicitly calls
  -- clock_timestamp() (the real, advancing time). Backdate agent2's
  -- last_read_at with clock_timestamp() so "a message posted after I
  -- last read" is actually true here.
  -- ---------------------------------------------------------
  UPDATE sembang_channel_members SET last_read_at = clock_timestamp() - interval '1 minute'
    WHERE channel_id = pub_ch AND user_id = agent2_a;

  res := pg_temp.run(admin_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''second one'')',
    pub_ch, a, admin_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 11a seeding a second message: %', res; END IF;

  IF pg_temp.run(agent2_a, format(
    'SELECT unread_count::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, pub_ch
  )) <> '1' THEN
    RAISE EXCEPTION 'FAIL 11b unread_count is not 1 after a new message from someone else';
  END IF;
  PERFORM pg_temp.run(agent2_a, format('SELECT mark_sembang_channel_read(%L)', pub_ch));
  IF pg_temp.run(agent2_a, format(
    'SELECT unread_count::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, pub_ch
  )) <> '0' THEN
    RAISE EXCEPTION 'FAIL 11c unread_count did not clear after mark_sembang_channel_read';
  END IF;
  -- own messages never count as unread
  res := pg_temp.run(agent2_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (%L, %L, %L, ''own msg'')',
    pub_ch, a, agent2_a));
  IF pg_temp.run(agent2_a, format(
    'SELECT unread_count::text FROM list_sembang_channels_for_current_user(%L) WHERE id = %L', a, pub_ch
  )) <> '0' THEN
    RAISE EXCEPTION 'FAIL 11d own message counted as unread';
  END IF;

  -- ---------------------------------------------------------
  -- 12. Mention notifications: only actual channel members get one;
  --     self-mentions are skipped
  -- ---------------------------------------------------------
  res := pg_temp.run(agent2_a, format(
    'INSERT INTO sembang_messages (channel_id, account_id, author_id, body, mentions) VALUES (%L, %L, %L, ''hi'', %L)',
    pub_ch, a, agent2_a, jsonb_build_array(admin_a, agent2_a, owner_b)::text));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 12a posting a message with mentions failed: %', res; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM notifications WHERE account_id = a AND user_id = admin_a AND type = 'sembang_mention'
  ) THEN
    RAISE EXCEPTION 'FAIL 12b a mentioned channel member got no notification';
  END IF;
  IF EXISTS (SELECT 1 FROM notifications WHERE account_id = a AND user_id = agent2_a AND type = 'sembang_mention') THEN
    RAISE EXCEPTION 'FAIL 12c a self-mention created a notification';
  END IF;
  IF EXISTS (SELECT 1 FROM notifications WHERE user_id = owner_b AND type = 'sembang_mention') THEN
    RAISE EXCEPTION 'FAIL 12d a non-member mention created a notification anyway';
  END IF;

  -- ---------------------------------------------------------
  -- 13. notifications.type still allows a pre-existing value
  --     alongside the new one (the CHECK was widened, not replaced)
  -- ---------------------------------------------------------
  BEGIN
    INSERT INTO notifications (account_id, user_id, type, title, body)
    VALUES (a, admin_a, 'ticket_mention', 'still allowed', 'x');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL 13a a pre-existing notification type was dropped by the widen: %', SQLERRM;
  END;

  -- ---------------------------------------------------------
  -- 14. Storage bucket
  -- ---------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'sembang-files' AND public = false AND file_size_limit = 16777216) THEN
    RAISE EXCEPTION 'FAIL 14a sembang-files bucket missing or not private/16MB';
  END IF;

  -- ---------------------------------------------------------
  -- 15. Realtime publication
  -- ---------------------------------------------------------
  IF (SELECT count(*) FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
          AND tablename IN ('sembang_channels', 'sembang_channel_members', 'sembang_messages')) <> 3 THEN
    RAISE EXCEPTION 'FAIL 15a not all three Sembang tables are in the realtime publication';
  END IF;

  -- ---------------------------------------------------------
  -- 16. Cross-account isolation: account B's owner (has menu.sembang
  --     by default as owner) still cannot see account A's channels.
  --     And: a PLAIN member (no moderator/admin rank anywhere) cannot
  --     land a sembang_channel_members row that pairs a real channel
  --     from one account with a DIFFERENT account_id — the exact gap
  --     the top-level EXISTS check on the insert policy closes (a
  --     first version of this policy let the self-join branch through
  --     on this, and separately let is_account_member(account_id,
  --     'admin') through too since it never checked channel_id against
  --     account_id at all — both are covered by testing this one case,
  --     since the top-level check runs before any branch is tried).
  -- ---------------------------------------------------------
  IF pg_temp.run(owner_b, format('SELECT count(*)::text FROM sembang_channels WHERE id = %L', pub_ch)) <> '0' THEN
    RAISE EXCEPTION 'FAIL 16a a user of another account can see this account''s public channel';
  END IF;

  -- A real public channel that belongs to account B (inserted directly,
  -- as the migration owner, so this isn't itself subject to RLS — the
  -- point is what agent2 can do with the resulting id next).
  INSERT INTO sembang_channels (account_id, name, is_private, created_by)
  VALUES (b, 'b-general', false, owner_b)
  RETURNING id INTO pub_ch_b;

  -- ...agent2 (account A, has menu.sembang, so has_capability(a, ...) is
  -- true — the only capability check this insert could otherwise pass)
  -- tries to self-join it while pairing it with THEIR OWN account_id:
  res := pg_temp.run(agent2_a, format(
    'INSERT INTO sembang_channel_members (channel_id, account_id, user_id) VALUES (%L, %L, %L)',
    pub_ch_b, a, agent2_a));
  IF res NOT LIKE 'ERR%' THEN
    RAISE EXCEPTION 'FAIL 16b agent2 landed a membership row pairing account B''s real channel with account A''s id: %', res;
  END IF;

  -- ---------------------------------------------------------
  -- 17. Deleting an account cascades cleanly
  -- ---------------------------------------------------------
  DELETE FROM accounts WHERE id = a;
  IF EXISTS (SELECT 1 FROM sembang_channels WHERE account_id = a)
     OR EXISTS (SELECT 1 FROM sembang_channel_members WHERE account_id = a)
     OR EXISTS (SELECT 1 FROM sembang_messages WHERE account_id = a) THEN
    RAISE EXCEPTION 'FAIL 17a deleting the account left orphaned Sembang rows';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: Sembang P0 (capability default owner+admin, grant-down to Agent, public/private visibility, self-join vs moderator-invite, membership required to post, no author spoofing, moderator message removal, admin sees every channel, unread count + mark-read RPC, mention notifications scoped to members with self-mention skipped, notifications.type widened not replaced, private storage bucket, realtime publication, cross-account isolation, cascade on account delete) checked in % groups', 17;
END
$verify$;
