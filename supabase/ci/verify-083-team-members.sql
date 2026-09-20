-- ============================================================
-- Verification for migration 083 (Team and Members as one area).
--
-- Run against a database that already has 083 applied:
--   supabase db query --linked -f supabase/ci/verify-083-team-members.sql
--
-- Everything happens inside one DO block that ends with
-- RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing is ever committed.
-- A message starting with ROLLBACK-OK means every check passed; any
-- other error message names the check that failed.
--
-- People are simulated the way PostgREST does it: set the JWT claims and
-- SET LOCAL ROLE authenticated, so RLS applies for real.
-- ============================================================

DO $verify$
DECLARE
  a        UUID;
  b        UUID;
  owner_a  UUID := gen_random_uuid();
  admin_a  UUID := gen_random_uuid();
  admin2_a UUID := gen_random_uuid();
  agent_a  UUID := gen_random_uuid();
  agent2_a UUID := gen_random_uuid();
  viewer_a UUID := gen_random_uuid();
  owner_b  UUID := gen_random_uuid();
  new1     UUID := gen_random_uuid();
  new2     UUID := gen_random_uuid();
  new3     UUID := gen_random_uuid();
  t1       UUID := gen_random_uuid();
  t2       UUID := gen_random_uuid();
  t3       UUID := gen_random_uuid();
  tb       UUID := gen_random_uuid();
  n        INTEGER := 0;
  res      TEXT;
  before_n INTEGER;
  contact  UUID;
  i        INTEGER;
BEGIN
  -- ---------------------------------------------------------
  -- helpers (temp functions live only for this session)
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

  -- audit rows of account a matching a WHERE fragment (read as postgres)
  EXECUTE $f$
    CREATE FUNCTION pg_temp.ac(p_acct UUID, p_where TEXT) RETURNS INTEGER
    LANGUAGE plpgsql AS $b$
    DECLARE c INTEGER;
    BEGIN
      EXECUTE format('SELECT count(*)::int FROM audit_log WHERE account_id = %L AND (%s)', p_acct, p_where)
        INTO c;
      RETURN c;
    END $b$;
  $f$;

  -- ---------------------------------------------------------
  -- fixtures
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify083-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, admin_a, admin2_a, agent_a, agent2_a, viewer_a, owner_b, new1, new2, new3]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create accounts';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'admin'  WHERE user_id IN (admin_a, admin2_a);
  UPDATE profiles SET account_id = a, account_role = 'agent'  WHERE user_id IN (agent_a, agent2_a);
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = viewer_a;
  DELETE FROM accounts WHERE owner_user_id IN (admin_a, admin2_a, agent_a, agent2_a, viewer_a);

  INSERT INTO teams (id, account_id, name, color) VALUES (t1, a, 'Tech', '#3b82f6');
  INSERT INTO teams (id, account_id, name, color) VALUES (t2, a, 'Billing', '#f59e0b');
  INSERT INTO teams (id, account_id, name, color) VALUES (t3, a, 'Sales', '#10b981');
  INSERT INTO teams (id, account_id, name, color) VALUES (tb, b, 'B team', '#ef4444');

  -- ---------------------------------------------------------
  -- 1. Schema objects exist
  -- ---------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'account_invitations' AND column_name = 'team_ids'
                    AND data_type = 'ARRAY' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'FAIL account_invitations.team_ids missing or nullable';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('list_team_members', 'team_open_conversation_counts',
                       'set_member_teams', 'change_team_members')) <> 4 THEN
    RAISE EXCEPTION 'FAIL new functions missing';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname = 'remove_account_member') <> 1 THEN
    RAISE EXCEPTION 'FAIL remove_account_member must have exactly one signature';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 2. Inviting: role rule, capability, team_ids validation
  -- ---------------------------------------------------------
  res := pg_temp.run(admin_a, format(
    $q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, label, expires_at, team_ids)
       VALUES (%L, 'v083-h1', 'agent', %L, 'Newbie 1', now() + interval '7 days',
               ARRAY[%L, %L, %L, %L, %L]::uuid[])$q$,
    a, admin_a, t1, t2, tb, gen_random_uuid(), t1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL admin invite with teams: %', res; END IF;
  IF (SELECT team_ids FROM account_invitations WHERE token_hash = 'v083-h1')
       IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[t1, t2]) x) THEN
    RAISE EXCEPTION 'FAIL team_ids must keep only distinct teams of the account, got %',
      (SELECT team_ids FROM account_invitations WHERE token_hash = 'v083-h1');
  END IF;
  -- default stays empty
  PERFORM pg_temp.run(admin_a, format(
    $q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
       VALUES (%L, 'v083-h0', 'viewer', %L, now() + interval '7 days')$q$, a, admin_a));
  IF (SELECT team_ids FROM account_invitations WHERE token_hash = 'v083-h0') <> '{}' THEN
    RAISE EXCEPTION 'FAIL team_ids default';
  END IF;
  n := n + 1;

  -- an Admin cannot invite an Admin or an Owner
  IF pg_temp.run(admin_a, format(
       $q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
          VALUES (%L, 'v083-x1', 'admin', %L, now() + interval '7 days')$q$, a, admin_a)) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL an Admin must not invite an Admin';
  END IF;
  IF pg_temp.run(admin_a, format(
       $q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
          VALUES (%L, 'v083-x2', 'owner', %L, now() + interval '7 days')$q$, a, admin_a)) NOT LIKE 'ERR %' THEN
    RAISE EXCEPTION 'FAIL nobody invites an Owner';
  END IF;
  -- the Owner can invite an Admin
  IF pg_temp.run(owner_a, format(
       $q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
          VALUES (%L, 'v083-o1', 'admin', %L, now() + interval '7 days')$q$, a, owner_a)) LIKE 'ERR%' THEN
    RAISE EXCEPTION 'FAIL the Owner should be able to invite an Admin';
  END IF;
  -- an Agent cannot invite at all
  IF pg_temp.run(agent_a, format(
       $q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
          VALUES (%L, 'v083-x3', 'viewer', %L, now() + interval '7 days')$q$, a, agent_a)) NOT LIKE 'ERR%' THEN
    RAISE EXCEPTION 'FAIL an Agent must not create invitations';
  END IF;
  n := n + 1;

  -- a trimmed Admin (members.invite removed) cannot invite; restoring it works
  PERFORM pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'admin', '{"members.invite": false}'::jsonb)::text$q$, a));
  IF pg_temp.run(admin_a, format(
       $q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
          VALUES (%L, 'v083-x4', 'agent', %L, now() + interval '7 days')$q$, a, admin_a)) NOT LIKE 'ERR 42501:%members.invite%' THEN
    RAISE EXCEPTION 'FAIL members.invite must be required to create an invitation';
  END IF;
  PERFORM pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'admin', '{"members.invite": null}'::jsonb)::text$q$, a));
  IF pg_temp.run(admin_a, format(
       $q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
          VALUES (%L, 'v083-x5', 'agent', %L, now() + interval '7 days')$q$, a, admin_a)) LIKE 'ERR%' THEN
    RAISE EXCEPTION 'FAIL restored members.invite should allow inviting';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 3. Redeem adds the member to the invitation's teams
  -- ---------------------------------------------------------
  res := pg_temp.run(new1, $q$SELECT redeem_invitation('v083-h1')::text$q$);
  IF res IS DISTINCT FROM a::text THEN RAISE EXCEPTION 'FAIL redeem 1: %', res; END IF;
  IF (SELECT account_role FROM profiles WHERE user_id = new1) <> 'agent'
     OR (SELECT account_id FROM profiles WHERE user_id = new1) <> a THEN
    RAISE EXCEPTION 'FAIL redeem 1 must move the profile with the invited role';
  END IF;
  IF (SELECT count(*) FROM team_members WHERE user_id = new1) <> 2
     OR NOT EXISTS (SELECT 1 FROM team_members WHERE user_id = new1 AND team_id = t1)
     OR NOT EXISTS (SELECT 1 FROM team_members WHERE user_id = new1 AND team_id = t2) THEN
    RAISE EXCEPTION 'FAIL redeem 1 must add the member to both teams';
  END IF;
  IF EXISTS (SELECT 1 FROM team_members WHERE user_id = new1 AND added_by IS DISTINCT FROM admin_a) THEN
    RAISE EXCEPTION 'FAIL added_by must be the inviter';
  END IF;
  IF pg_temp.ac(a, format($c$action = 'team_member_added' AND summary ->> 'user_id' = %L$c$, new1)) <> 2 THEN
    RAISE EXCEPTION 'FAIL audit must log both team joins';
  END IF;
  -- the link is single use
  IF pg_temp.run(new2, $q$SELECT redeem_invitation('v083-h1')::text$q$) NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL a redeemed link must not work twice';
  END IF;
  n := n + 1;

  -- a team deleted since the invite was made is ignored silently
  PERFORM pg_temp.run(admin_a, format(
    $q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at, team_ids)
       VALUES (%L, 'v083-h2', 'agent', %L, now() + interval '7 days', ARRAY[%L, %L]::uuid[])$q$, a, admin_a, t3, t2));
  DELETE FROM teams WHERE id = t3;
  res := pg_temp.run(new2, $q$SELECT redeem_invitation('v083-h2')::text$q$);
  IF res IS DISTINCT FROM a::text THEN RAISE EXCEPTION 'FAIL redeem with a stale team: %', res; END IF;
  IF (SELECT array_agg(team_id) FROM team_members WHERE user_id = new2) IS DISTINCT FROM ARRAY[t2] THEN
    RAISE EXCEPTION 'FAIL only the surviving team should be joined';
  END IF;
  -- ...and so is a team of ANOTHER account that got past the trigger
  ALTER TABLE account_invitations DISABLE TRIGGER invitation_guard_and_sanitize;
  INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at, team_ids)
    VALUES (a, 'v083-h3', 'viewer', admin_a, now() + interval '7 days', ARRAY[tb, t1]::uuid[]);
  ALTER TABLE account_invitations ENABLE TRIGGER invitation_guard_and_sanitize;
  res := pg_temp.run(new3, $q$SELECT redeem_invitation('v083-h3')::text$q$);
  IF res IS DISTINCT FROM a::text THEN RAISE EXCEPTION 'FAIL redeem with a foreign team: %', res; END IF;
  IF EXISTS (SELECT 1 FROM team_members WHERE user_id = new3 AND team_id = tb) THEN
    RAISE EXCEPTION 'FAIL a foreign account team must never be joined';
  END IF;
  IF (SELECT array_agg(team_id) FROM team_members WHERE user_id = new3) IS DISTINCT FROM ARRAY[t1] THEN
    RAISE EXCEPTION 'FAIL redeem 3 should join only its own account team';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- Work fixtures: agent_a is on three teams and holds open work
  -- ---------------------------------------------------------
  INSERT INTO teams (id, account_id, name, color) VALUES (t3, a, 'Sales', '#10b981');
  INSERT INTO team_members (team_id, user_id) VALUES (t1, agent_a), (t2, agent_a), (t3, agent_a), (t1, agent2_a);

  FOR i IN 1..5 LOOP
    contact := gen_random_uuid();
    INSERT INTO contacts (id, user_id, account_id, phone, name)
      VALUES (contact, owner_a, a, '+1000000' || (100 + i), 'C' || i);
    INSERT INTO conversations (user_id, account_id, contact_id, status, assigned_agent_id, assigned_team_id)
      VALUES (owner_a, a, contact,
              CASE i WHEN 1 THEN 'open' WHEN 2 THEN 'open' WHEN 3 THEN 'pending' WHEN 4 THEN 'closed' ELSE 'open' END,
              CASE WHEN i = 5 THEN agent2_a ELSE agent_a END,
              CASE WHEN i IN (1, 2) THEN t1 WHEN i = 3 THEN t2 ELSE NULL END);
    INSERT INTO tickets (account_id, ticket_number, contact_id, subject, status, assigned_agent_id)
      VALUES (a, i, contact, 'T' || i,
              CASE i WHEN 1 THEN 'open' WHEN 2 THEN 'in_progress' WHEN 3 THEN 'resolved' WHEN 4 THEN 'pending' ELSE 'open' END,
              CASE WHEN i = 5 THEN agent2_a ELSE agent_a END);
  END LOOP;
  -- agent_a: conversations open,open,pending (3 live) + closed; tickets open,in_progress,pending (3 live) + resolved
  -- agent2_a: 1 conversation, 1 ticket

  -- ---------------------------------------------------------
  -- 4. list_team_members
  -- ---------------------------------------------------------
  IF pg_temp.run(owner_a, 'SELECT count(*)::text FROM list_team_members()')
       <> (SELECT count(*)::text FROM profiles WHERE account_id = a) THEN
    RAISE EXCEPTION 'FAIL list_team_members must return every member of the account';
  END IF;
  IF pg_temp.run(owner_a, format(
       $q$SELECT jsonb_array_length(teams)::text FROM list_team_members() WHERE user_id = %L$q$, agent_a)) <> '3' THEN
    RAISE EXCEPTION 'FAIL a member on three teams must list all three';
  END IF;
  IF pg_temp.run(owner_a, format(
       $q$SELECT string_agg(x ->> 'name', ',' ORDER BY x ->> 'name') FROM list_team_members(), jsonb_array_elements(teams) x WHERE user_id = %L$q$, agent_a))
       <> 'Billing,Sales,Tech'
     OR pg_temp.run(owner_a, format(
       $q$SELECT (teams -> 0 ->> 'color') FROM list_team_members() WHERE user_id = %L$q$, agent_a)) <> '#f59e0b' THEN
    RAISE EXCEPTION 'FAIL teams must carry name and colour, ordered by name';
  END IF;
  IF pg_temp.run(owner_a, format(
       $q$SELECT jsonb_array_length(teams)::text FROM list_team_members() WHERE user_id = %L$q$, viewer_a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL a member with no team lists an empty array';
  END IF;
  IF pg_temp.run(owner_a, format(
       $q$SELECT open_conversations || '/' || open_tickets FROM list_team_members() WHERE user_id = %L$q$, agent_a)) <> '3/3'
     OR pg_temp.run(owner_a, format(
       $q$SELECT open_conversations || '/' || open_tickets FROM list_team_members() WHERE user_id = %L$q$, agent2_a)) <> '1/1'
     OR pg_temp.run(owner_a, format(
       $q$SELECT open_conversations || '/' || open_tickets FROM list_team_members() WHERE user_id = %L$q$, viewer_a)) <> '0/0' THEN
    RAISE EXCEPTION 'FAIL open work counts (closed/resolved must not count)';
  END IF;
  -- emails: Owner/Admin see them, Agent/Viewer do not
  IF pg_temp.run(admin_a, format(
       $q$SELECT (email IS NOT NULL)::text FROM list_team_members() WHERE user_id = %L$q$, agent_a)) <> 'true'
     OR pg_temp.run(agent_a, format(
       $q$SELECT (email IS NULL)::text FROM list_team_members() WHERE user_id = %L$q$, agent2_a)) <> 'true'
     OR pg_temp.run(viewer_a, format(
       $q$SELECT (email IS NULL)::text FROM list_team_members() WHERE user_id = %L$q$, admin_a)) <> 'true' THEN
    RAISE EXCEPTION 'FAIL email visibility';
  END IF;
  -- a viewer can still read the roster
  IF pg_temp.run(viewer_a, 'SELECT (count(*) > 3)::text FROM list_team_members()') <> 'true' THEN
    RAISE EXCEPTION 'FAIL a viewer should read the roster';
  END IF;
  -- cross-account isolation: account B sees only its own person and teams
  IF pg_temp.run(owner_b, 'SELECT count(*)::text FROM list_team_members()') <> '1'
     OR pg_temp.run(owner_b, format(
       $q$SELECT count(*)::text FROM list_team_members() WHERE user_id = %L$q$, agent_a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL another account must not see this roster';
  END IF;
  -- anonymous / no session
  IF pg_temp.run(NULL, 'SELECT count(*)::text FROM list_team_members()') <> '0' THEN
    RAISE EXCEPTION 'FAIL no session must return no rows';
  END IF;
  IF pg_temp.run(NULL, 'SELECT count(*)::text FROM list_team_members()', 'anon') NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL anon must not execute list_team_members';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 5. team_open_conversation_counts
  -- ---------------------------------------------------------
  IF pg_temp.run(owner_a, format($q$SELECT open_conversations::text FROM team_open_conversation_counts() WHERE team_id = %L$q$, t1)) <> '2'
     OR pg_temp.run(owner_a, format($q$SELECT open_conversations::text FROM team_open_conversation_counts() WHERE team_id = %L$q$, t2)) <> '1'
     OR pg_temp.run(owner_a, format($q$SELECT open_conversations::text FROM team_open_conversation_counts() WHERE team_id = %L$q$, t3)) <> '0' THEN
    RAISE EXCEPTION 'FAIL team open conversation counts';
  END IF;
  IF pg_temp.run(owner_b, format($q$SELECT count(*)::text FROM team_open_conversation_counts() WHERE team_id IN (%L, %L, %L)$q$, t1, t2, t3)) <> '0' THEN
    RAISE EXCEPTION 'FAIL team counts leak across accounts';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 6. Team membership writes
  -- ---------------------------------------------------------
  -- set_member_teams: diff applied, foreign / unknown ids ignored
  res := pg_temp.run(admin_a, format(
    $q$SELECT set_member_teams(%L, ARRAY[%L, %L, %L]::uuid[])::text$q$, agent2_a, t2, tb, gen_random_uuid()));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL set_member_teams: %', res; END IF;
  IF (SELECT array_agg(team_id) FROM team_members WHERE user_id = agent2_a) IS DISTINCT FROM ARRAY[t2] THEN
    RAISE EXCEPTION 'FAIL set_member_teams must leave exactly the valid requested teams';
  END IF;
  IF (res::jsonb ->> 'added') <> '1' OR (res::jsonb ->> 'removed') <> '1' THEN
    RAISE EXCEPTION 'FAIL set_member_teams counts: %', res;
  END IF;
  res := pg_temp.run(admin_a, format($q$SELECT set_member_teams(%L, '{}'::uuid[])::text$q$, agent2_a));
  IF res LIKE 'ERR%' OR EXISTS (SELECT 1 FROM team_members WHERE user_id = agent2_a) THEN
    RAISE EXCEPTION 'FAIL set_member_teams with an empty set should clear memberships: %', res;
  END IF;
  -- capability and account checks
  IF pg_temp.run(agent_a, format($q$SELECT set_member_teams(%L, ARRAY[%L]::uuid[])::text$q$, agent2_a, t1)) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL an Agent must not change team memberships';
  END IF;
  IF pg_temp.run(owner_b, format($q$SELECT set_member_teams(%L, ARRAY[%L]::uuid[])::text$q$, agent2_a, tb)) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL another account must not touch this member';
  END IF;
  PERFORM pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'admin', '{"teams.manage": false}'::jsonb)::text$q$, a));
  IF pg_temp.run(admin_a, format($q$SELECT set_member_teams(%L, ARRAY[%L]::uuid[])::text$q$, agent2_a, t1)) NOT LIKE 'ERR 42501:%teams.manage%' THEN
    RAISE EXCEPTION 'FAIL teams.manage must be required';
  END IF;
  PERFORM pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'admin', '{"teams.manage": null}'::jsonb)::text$q$, a));

  -- change_team_members: bulk add / remove
  res := pg_temp.run(admin_a, format(
    $q$SELECT change_team_members(ARRAY[%L, %L, %L]::uuid[], ARRAY[%L, %L, %L]::uuid[], 'add')::text$q$,
    viewer_a, agent2_a, owner_b, t1, t3, tb));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL bulk add: %', res; END IF;
  IF (SELECT count(*) FROM team_members WHERE user_id IN (viewer_a, agent2_a) AND team_id IN (t1, t3)) <> 4
     OR EXISTS (SELECT 1 FROM team_members WHERE user_id = owner_b)
     OR EXISTS (SELECT 1 FROM team_members WHERE team_id = tb) THEN
    RAISE EXCEPTION 'FAIL bulk add must add valid people to valid teams only';
  END IF;
  IF (res::jsonb ->> 'changed') <> '4' THEN RAISE EXCEPTION 'FAIL bulk add count: %', res; END IF;
  -- adding again is a no-op
  IF (pg_temp.run(admin_a, format(
        $q$SELECT change_team_members(ARRAY[%L]::uuid[], ARRAY[%L]::uuid[], 'add')::text$q$, viewer_a, t1))::jsonb ->> 'changed') <> '0' THEN
    RAISE EXCEPTION 'FAIL bulk add must be idempotent';
  END IF;
  res := pg_temp.run(admin_a, format(
    $q$SELECT change_team_members(ARRAY[%L, %L]::uuid[], ARRAY[%L]::uuid[], 'remove')::text$q$, viewer_a, agent2_a, t1));
  IF (res::jsonb ->> 'changed') <> '2'
     OR EXISTS (SELECT 1 FROM team_members WHERE user_id IN (viewer_a, agent2_a) AND team_id = t1)
     OR (SELECT count(*) FROM team_members WHERE user_id IN (viewer_a, agent2_a) AND team_id = t3) <> 2 THEN
    RAISE EXCEPTION 'FAIL bulk remove: %', res;
  END IF;
  -- another account cannot remove people from these teams
  IF (pg_temp.run(owner_b, format(
        $q$SELECT change_team_members(ARRAY[%L]::uuid[], ARRAY[%L]::uuid[], 'remove')::text$q$, viewer_a, t3))::jsonb ->> 'changed') <> '0'
     OR NOT EXISTS (SELECT 1 FROM team_members WHERE user_id = viewer_a AND team_id = t3) THEN
    RAISE EXCEPTION 'FAIL cross-account bulk remove must change nothing';
  END IF;
  IF pg_temp.run(agent_a, format($q$SELECT change_team_members(ARRAY[%L]::uuid[], ARRAY[%L]::uuid[], 'add')::text$q$, viewer_a, t1)) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL an Agent must not bulk change teams';
  END IF;
  IF pg_temp.run(admin_a, format($q$SELECT change_team_members(ARRAY[%L]::uuid[], ARRAY[%L]::uuid[], 'purge')::text$q$, viewer_a, t1)) NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL unknown bulk action';
  END IF;
  n := n + 1;

  -- restore the fixture memberships for the removal checks
  DELETE FROM team_members WHERE user_id IN (viewer_a, agent2_a);
  INSERT INTO team_members (team_id, user_id) VALUES (t1, agent2_a);

  -- ---------------------------------------------------------
  -- 7. Safe removal
  -- ---------------------------------------------------------
  -- hierarchy and target checks
  IF pg_temp.run(admin_a, format($q$SELECT remove_account_member(%L)::text$q$, admin2_a)) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL an Admin must not remove another Admin';
  END IF;
  IF pg_temp.run(admin_a, format($q$SELECT remove_account_member(%L)::text$q$, owner_a)) NOT LIKE 'ERR %' THEN
    RAISE EXCEPTION 'FAIL an Admin must not remove the Owner';
  END IF;
  IF pg_temp.run(owner_a, format($q$SELECT remove_account_member(%L)::text$q$, owner_a)) NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL nobody removes themselves through this function';
  END IF;
  IF pg_temp.run(agent_a, format($q$SELECT remove_account_member(%L)::text$q$, viewer_a)) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL an Agent must not remove members';
  END IF;
  IF pg_temp.run(admin_a, format($q$SELECT remove_account_member(%L)::text$q$, owner_b)) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL removal must not reach another account';
  END IF;
  IF pg_temp.run(admin_a, format($q$SELECT remove_account_member(%L)::text$q$, gen_random_uuid())) NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL unknown member';
  END IF;
  PERFORM pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'admin', '{"members.remove": false}'::jsonb)::text$q$, a));
  IF pg_temp.run(admin_a, format($q$SELECT remove_account_member(%L)::text$q$, agent_a)) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL members.remove must be required';
  END IF;
  PERFORM pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'admin', '{"members.remove": null}'::jsonb)::text$q$, a));
  -- heir validation
  IF pg_temp.run(admin_a, format($q$SELECT remove_account_member(%L, %L)::text$q$, agent_a, viewer_a)) NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL work cannot be reassigned to a viewer';
  END IF;
  IF pg_temp.run(admin_a, format($q$SELECT remove_account_member(%L, %L)::text$q$, agent_a, owner_b)) NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL work cannot be reassigned to another account';
  END IF;
  IF pg_temp.run(admin_a, format($q$SELECT remove_account_member(%L, %L)::text$q$, agent_a, agent_a)) NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL work cannot be reassigned to the removed member';
  END IF;
  -- nothing above changed anything
  IF (SELECT account_id FROM profiles WHERE user_id = agent_a) <> a
     OR (SELECT count(*) FROM team_members WHERE user_id = agent_a) <> 3 THEN
    RAISE EXCEPTION 'FAIL a refused removal must change nothing';
  END IF;
  n := n + 1;

  -- removal WITH an heir: teams cleared, live work moved, closed history kept
  before_n := pg_temp.ac(a, $c$action = 'team_member_removed'$c$);
  res := pg_temp.run(admin_a, format($q$SELECT remove_account_member(%L, %L)::text$q$, agent_a, agent2_a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL removal with heir: %', res; END IF;
  IF (res::jsonb ->> 'removed') <> 'true'
     OR (res::jsonb ->> 'reassigned_conversations') <> '3'
     OR (res::jsonb ->> 'reassigned_tickets') <> '3'
     OR (res::jsonb ->> 'unassigned_conversations') <> '0'
     OR (res::jsonb ->> 'reassigned_to') <> agent2_a::text THEN
    RAISE EXCEPTION 'FAIL removal-with-heir result: %', res;
  END IF;
  IF (SELECT account_id FROM profiles WHERE user_id = agent_a) = a
     OR (SELECT account_role FROM profiles WHERE user_id = agent_a) <> 'owner' THEN
    RAISE EXCEPTION 'FAIL the removed member must land in a fresh personal account';
  END IF;
  IF EXISTS (SELECT 1 FROM team_members WHERE user_id = agent_a) THEN
    RAISE EXCEPTION 'FAIL removal must clear every team row';
  END IF;
  IF (SELECT count(*) FROM conversations WHERE account_id = a AND assigned_agent_id = agent2_a) <> 4
     OR (SELECT count(*) FROM tickets WHERE account_id = a AND assigned_agent_id = agent2_a) <> 4 THEN
    RAISE EXCEPTION 'FAIL the heir must hold the reassigned work';
  END IF;
  IF (SELECT count(*) FROM conversations WHERE account_id = a AND assigned_agent_id = agent_a AND status = 'closed') <> 1
     OR (SELECT count(*) FROM tickets WHERE account_id = a AND assigned_agent_id = agent_a AND status = 'resolved') <> 1 THEN
    RAISE EXCEPTION 'FAIL finished work keeps its history';
  END IF;
  IF pg_temp.ac(a, $c$action = 'team_member_removed'$c$) - before_n <> 3
     OR pg_temp.ac(a, format($c$action = 'member_removed' AND entity_id = %L AND actor_id = %L$c$, agent_a, admin_a)) <> 1 THEN
    RAISE EXCEPTION 'FAIL audit must log the three team removals and the member removal';
  END IF;
  n := n + 1;

  -- removal WITHOUT an heir: open work is unassigned, counts reported
  res := pg_temp.run(admin_a, format($q$SELECT remove_account_member(%L)::text$q$, agent2_a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL removal without heir: %', res; END IF;
  IF (res::jsonb ->> 'unassigned_conversations') <> '4'
     OR (res::jsonb ->> 'unassigned_tickets') <> '4'
     OR (res::jsonb ->> 'reassigned_conversations') <> '0' THEN
    RAISE EXCEPTION 'FAIL removal-without-heir result: %', res;
  END IF;
  IF EXISTS (SELECT 1 FROM conversations WHERE account_id = a AND assigned_agent_id = agent2_a)
     OR EXISTS (SELECT 1 FROM tickets WHERE account_id = a AND assigned_agent_id = agent2_a) THEN
    RAISE EXCEPTION 'FAIL open work must be unassigned';
  END IF;
  IF (SELECT count(*) FROM conversations WHERE account_id = a AND assigned_agent_id IS NULL AND status IN ('open', 'pending')) <> 4 THEN
    RAISE EXCEPTION 'FAIL unassigned conversations should stay open';
  END IF;
  IF EXISTS (SELECT 1 FROM team_members tm JOIN teams t ON t.id = tm.team_id
              WHERE t.account_id = a AND tm.user_id IN (agent_a, agent2_a)) THEN
    RAISE EXCEPTION 'FAIL no team rows may remain for removed members';
  END IF;
  n := n + 1;

  -- the list reflects it: removed members are gone, everyone else keeps their teams
  IF pg_temp.run(owner_a, format($q$SELECT count(*)::text FROM list_team_members() WHERE user_id IN (%L, %L)$q$, agent_a, agent2_a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL removed members must leave the roster';
  END IF;
  IF pg_temp.run(owner_a, format($q$SELECT jsonb_array_length(teams)::text FROM list_team_members() WHERE user_id = %L$q$, new1)) <> '2' THEN
    RAISE EXCEPTION 'FAIL the redeemed member keeps both invited teams in the list';
  END IF;
  n := n + 1;

  RAISE EXCEPTION 'ROLLBACK-OK: % check groups passed', n;
END
$verify$;
