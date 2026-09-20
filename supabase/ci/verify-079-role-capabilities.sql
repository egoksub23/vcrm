-- ============================================================
-- Verification for migration 079 (role capabilities).
--
-- Run against a database that already has 079 applied:
--   supabase db query --linked -f supabase/ci/verify-079-role-capabilities.sql
--
-- Everything happens inside one DO block that ends with
-- RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing is ever committed.
-- A message starting with ROLLBACK-OK means every check passed; any
-- other error message names the check that failed.
--
-- Roles are simulated the same way PostgREST does: set the JWT claims
-- and SET LOCAL ROLE authenticated, so RLS applies for real.
-- ============================================================

DO $verify$
DECLARE
  a        UUID;                       -- account A (owner_a's account)
  b        UUID;                       -- account B (isolation check)
  owner_a  UUID := gen_random_uuid();
  admin_a  UUID := gen_random_uuid();
  admin2_a UUID := gen_random_uuid();
  agent_a  UUID := gen_random_uuid();
  viewer_a UUID := gen_random_uuid();
  owner_b  UUID := gen_random_uuid();
  n        INTEGER := 0;
  r        TEXT;
  roles    TEXT[] := ARRAY['owner', 'admin', 'agent', 'viewer'];
  uids     UUID[];
  i        INTEGER;
  cap      TEXT;
BEGIN
  -- ---------------------------------------------------------
  -- helpers (temp functions live only for this session)
  -- ---------------------------------------------------------
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT) RETURNS TEXT LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      BEGIN
        EXECUTE q INTO res;
      EXCEPTION WHEN OTHERS THEN
        res := 'ERR ' || SQLSTATE || ': ' || SQLERRM;
      END;
      EXECUTE 'RESET ROLE';
      RETURN res;
    END $b$;
  $f$;

  -- ---------------------------------------------------------
  -- fixtures: users -> (trigger) accounts + profiles
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify079-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, admin_a, admin2_a, agent_a, viewer_a, owner_b]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create accounts';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'admin'  WHERE user_id IN (admin_a, admin2_a);
  UPDATE profiles SET account_id = a, account_role = 'agent'  WHERE user_id = agent_a;
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = viewer_a;
  -- the signup trigger gave each user a personal account; drop those so
  -- remove_account_member (which mints a fresh personal account) can run
  DELETE FROM accounts WHERE owner_user_id IN (admin_a, admin2_a, agent_a, viewer_a);
  uids := ARRAY[owner_a, admin_a, agent_a, viewer_a];

  -- one-row-per-account tables, seeded as postgres (bypasses RLS)
  INSERT INTO web_widget_config (account_id, user_id, widget_token) VALUES (a, owner_a, 'tok-seed');
  INSERT INTO ai_configs (account_id, provider, model, api_key) VALUES (a, 'openai', 'm', 'k');

  -- ---------------------------------------------------------
  -- 1. Seed: catalogue + defaults have the expected shape (45 = the 44 keys of 079
  --    plus audit.view, added by migration 082)
  -- ---------------------------------------------------------
  IF (SELECT count(*) FROM capability_catalogue) <> 45 THEN
    RAISE EXCEPTION 'FAIL catalogue size %', (SELECT count(*) FROM capability_catalogue);
  END IF;
  IF (SELECT count(*) FROM role_capability_defaults WHERE role = 'owner')  <> 45
  OR (SELECT count(*) FROM role_capability_defaults WHERE role = 'admin')  <> 45
  OR (SELECT count(*) FROM role_capability_defaults WHERE role = 'agent')  <> 27
  OR (SELECT count(*) FROM role_capability_defaults WHERE role = 'viewer') <> 14 THEN
    RAISE EXCEPTION 'FAIL default set sizes';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 2. Default parity of has_capability with the OLD role floors
  --    (owner/admin => admin floor, agent => agent floor, ...)
  -- ---------------------------------------------------------
  -- capability, lowest role that had it before this migration
  FOR cap, r IN
    SELECT * FROM (VALUES
      ('channels.manage', 'admin'), ('ai.configure', 'admin'), ('api.manage', 'admin'),
      ('roles.manage', 'admin'), ('tags.manage', 'admin'), ('settings.workspace', 'admin'),
      ('pipelines.configure', 'admin'), ('tickets.delete', 'admin'), ('knowledge.publish', 'admin'),
      ('members.invite', 'admin'), ('teams.manage', 'admin'), ('comments.delete', 'admin'),
      ('messages.send', 'agent'), ('conversations.manage', 'agent'), ('contacts.edit', 'agent'),
      ('broadcasts.send', 'agent'), ('automations.manage', 'agent'), ('ai.use', 'agent'),
      ('snippets.manage', 'agent'), ('tickets.work', 'agent'), ('knowledge.draft', 'agent'),
      ('menu.inbox', 'viewer'), ('menu.settings', 'viewer'), ('reports.view', 'viewer')
    ) AS t(c, m)
  LOOP
    FOR i IN 1..4 LOOP
      IF (pg_temp.run(uids[i], format('SELECT has_capability(%L, %L)::text', a, cap)) = 'true')
         IS DISTINCT FROM
         (CASE roles[i] WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 ELSE 1 END
            >= CASE r WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 ELSE 1 END)
      THEN
        RAISE EXCEPTION 'FAIL default parity: role % capability % (floor %)', roles[i], cap, r;
      END IF;
    END LOOP;
  END LOOP;
  n := n + 1;

  -- unknown capability => false for everyone, owner included
  FOR i IN 1..4 LOOP
    IF pg_temp.run(uids[i], format('SELECT has_capability(%L, %L)::text', a, 'nope.unknown')) <> 'false' THEN
      RAISE EXCEPTION 'FAIL unknown capability must be denied (role %)', roles[i];
    END IF;
  END LOOP;
  -- not a member of the account => false
  IF pg_temp.run(owner_b, format('SELECT has_capability(%L, %L)::text', a, 'channels.manage')) <> 'false' THEN
    RAISE EXCEPTION 'FAIL cross-account has_capability must be false';
  END IF;
  -- capabilities_for_current_user sizes
  IF pg_temp.run(owner_a,  format('SELECT cardinality(capabilities_for_current_user(%L))::text', a)) <> '44'
  OR pg_temp.run(admin_a,  format('SELECT cardinality(capabilities_for_current_user(%L))::text', a)) <> '44'
  OR pg_temp.run(agent_a,  format('SELECT cardinality(capabilities_for_current_user(%L))::text', a)) <> '27'
  OR pg_temp.run(viewer_a, format('SELECT cardinality(capabilities_for_current_user(%L))::text', a)) <> '14' THEN
    RAISE EXCEPTION 'FAIL capabilities_for_current_user sizes';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 3. Moved RLS policies, DEFAULTS (must equal the old admin floor)
  --    owner/admin allowed, agent/viewer refused; SELECT unchanged.
  -- ---------------------------------------------------------
  FOR i IN 1..4 LOOP
    -- UPDATE web_widget_config (channels.manage; one row per account, pre-seeded)
    r := pg_temp.run(uids[i], format(
      'WITH x AS (UPDATE web_widget_config SET widget_token = widget_token WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM x', a));
    IF (i <= 2) <> (r = '1') THEN
      RAISE EXCEPTION 'FAIL default web_widget_config update: role % got %', roles[i], r;
    END IF;
    -- INSERT api_keys (api.manage)
    r := pg_temp.run(uids[i], format(
      'WITH x AS (INSERT INTO api_keys (account_id, name, key_prefix, key_hash) VALUES (%L, %L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
      a, 'k-' || roles[i], 'pfx', 'hash-' || roles[i]));
    IF (i <= 2) <> (r = '1') THEN
      RAISE EXCEPTION 'FAIL default api_keys insert: role % got %', roles[i], r;
    END IF;
    -- UPDATE ai_configs (ai.configure; one row per account, pre-seeded)
    r := pg_temp.run(uids[i], format(
      'WITH x AS (UPDATE ai_configs SET model = model WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM x', a));
    IF (i <= 2) <> (r = '1') THEN
      RAISE EXCEPTION 'FAIL default ai_configs update: role % got %', roles[i], r;
    END IF;
    -- INSERT webhook_endpoints (api.manage)
    r := pg_temp.run(uids[i], format(
      'WITH x AS (INSERT INTO webhook_endpoints (account_id, url, secret) VALUES (%L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
      a, 'https://example.invalid/' || roles[i], 's'));
    IF (i <= 2) <> (r = '1') THEN
      RAISE EXCEPTION 'FAIL default webhook_endpoints insert: role % got %', roles[i], r;
    END IF;
  END LOOP;

  -- Seed rows for the SELECT checks (postgres bypasses RLS)
  INSERT INTO ai_connections (account_id, name, provider, model, api_key)
    VALUES (a, 'verify-conn', 'openai', 'm', 'k');
  INSERT INTO ai_usage_log (account_id, mode, provider, model)
    VALUES (a, 'draft', 'openai', 'm');

  -- Admin-only SELECTs: owner/admin see rows, agent/viewer do not
  FOR i IN 1..4 LOOP
    r := pg_temp.run(uids[i], format('SELECT count(*)::text FROM ai_connections WHERE account_id = %L', a));
    IF (i <= 2) <> (r::int >= 1) THEN
      RAISE EXCEPTION 'FAIL default ai_connections select: role % got %', roles[i], r;
    END IF;
    r := pg_temp.run(uids[i], format('SELECT count(*)::text FROM ai_usage_log WHERE account_id = %L', a));
    IF (i <= 2) <> (r::int >= 1) THEN
      RAISE EXCEPTION 'FAIL default ai_usage_log select: role % got %', roles[i], r;
    END IF;
    -- SELECT stays viewer-visible where it is viewer today
    r := pg_temp.run(uids[i], format('SELECT count(*)::text FROM api_keys WHERE account_id = %L', a));
    IF r::int < 1 THEN
      RAISE EXCEPTION 'FAIL api_keys select must stay visible to %, got %', roles[i], r;
    END IF;
    r := pg_temp.run(uids[i], format('SELECT count(*)::text FROM web_widget_config WHERE account_id = %L', a));
    IF r::int < 1 THEN
      RAISE EXCEPTION 'FAIL web_widget_config select must stay visible to %, got %', roles[i], r;
    END IF;
  END LOOP;
  -- UPDATE / DELETE on a moved table (api_keys)
  r := pg_temp.run(agent_a, format(
    'WITH x AS (UPDATE api_keys SET name = %L WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM x', 'hax', a));
  IF r <> '0' THEN RAISE EXCEPTION 'FAIL agent must not update api_keys, got %', r; END IF;
  r := pg_temp.run(agent_a, format(
    'WITH x AS (DELETE FROM api_keys WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM x', a));
  IF r <> '0' THEN RAISE EXCEPTION 'FAIL agent must not delete api_keys, got %', r; END IF;
  r := pg_temp.run(admin_a, format(
    'WITH x AS (UPDATE api_keys SET name = %L WHERE account_id = %L AND key_hash = %L RETURNING 1) SELECT count(*)::text FROM x',
    'renamed', a, 'hash-admin'));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL admin must update api_keys by default, got %', r; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 4. Direct writes to the capability tables are impossible
  -- ---------------------------------------------------------
  FOR i IN 1..2 LOOP
    r := pg_temp.run(uids[i], format(
      'WITH x AS (INSERT INTO role_capabilities (account_id, role, capability, granted) VALUES (%L, %L, %L, true) RETURNING 1) SELECT count(*)::text FROM x',
      a, 'agent', 'channels.manage'));
    IF r NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL % wrote role_capabilities directly: %', roles[i], r; END IF;
    r := pg_temp.run(uids[i], format(
      'WITH x AS (INSERT INTO role_capability_log (account_id, role, capability, old_granted, new_granted) VALUES (%L, %L, %L, false, true) RETURNING 1) SELECT count(*)::text FROM x',
      a, 'agent', 'channels.manage'));
    IF r NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL % wrote the log directly: %', roles[i], r; END IF;
    r := pg_temp.run(uids[i], 'WITH x AS (DELETE FROM role_capability_defaults RETURNING 1) SELECT count(*)::text FROM x');
    IF r NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL % deleted defaults directly: %', roles[i], r; END IF;
  END LOOP;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 5. Guardrails inside set_role_capabilities
  -- ---------------------------------------------------------
  -- agent / viewer hold no roles.manage
  IF pg_temp.run(agent_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'viewer', '{"menu.reports": false}'))
       NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL agent must not edit roles';
  END IF;
  IF pg_temp.run(viewer_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'viewer', '{"menu.reports": false}'))
       NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL viewer must not edit roles';
  END IF;
  -- nobody edits owner
  IF pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'owner', '{"menu.reports": false}'))
       NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL owner role must be untouchable';
  END IF;
  IF pg_temp.run(admin_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'owner', '{"menu.reports": false}'))
       NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL admin must not edit owner';
  END IF;
  -- admin cannot edit admin (own role) ...
  IF pg_temp.run(admin_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'admin', '{"menu.reports": false}'))
       NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL admin must not edit the admin role';
  END IF;
  -- ... but can edit agent and viewer
  IF pg_temp.run(admin_a, format('SELECT (set_role_capabilities(%L, %L, %L)->>''changed'')', a, 'viewer', '{"menu.reports": false}'))
       <> '1' THEN
    RAISE EXCEPTION 'FAIL admin must be able to edit viewer';
  END IF;
  -- not a member of that account
  IF pg_temp.run(owner_b, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent', '{"menu.reports": false}'))
       NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL cross-account edit must be refused';
  END IF;
  -- unknown capability, bad value, bad payload
  IF pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent', '{"nope.unknown": true}'))
       NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL unknown capability must be rejected';
  END IF;
  IF pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent', '{"menu.reports": "yes"}'))
       NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL non-boolean value must be rejected';
  END IF;
  IF pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent', '[]'))
       NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL non-object payload must be rejected';
  END IF;
  -- viewer can never receive a write capability
  IF pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'viewer', '{"messages.send": true}'))
       NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL viewer must not be granted messages.send';
  END IF;
  IF pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'viewer', '{"channels.manage": true}'))
       NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL viewer must not be granted channels.manage';
  END IF;
  -- agent cannot be granted a capability below the database floor (tags are admin-only in RLS)
  IF pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent', '{"tags.manage": true}'))
       NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL agent must not be granted tags.manage (below min_grant_role)';
  END IF;
  -- but a viewer may be granted a READ capability that is off
  PERFORM pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'viewer', '{"menu.reports": null}'));
  -- all-or-nothing: one valid + one invalid => nothing applied
  IF pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent',
                                 '{"menu.reports": false, "nope.unknown": true}')) NOT LIKE 'ERR 22023:%' THEN
    RAISE EXCEPTION 'FAIL mixed payload must fail';
  END IF;
  IF EXISTS (SELECT 1 FROM role_capabilities WHERE account_id = a AND role = 'agent' AND capability = 'menu.reports') THEN
    RAISE EXCEPTION 'FAIL partial write survived a failed call';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 6. Grant / revoke behaviour + sparse storage + log
  -- ---------------------------------------------------------
  -- Owner revokes admin's api.manage
  IF pg_temp.run(owner_a, format('SELECT (set_role_capabilities(%L, %L, %L)->>''changed'')', a, 'admin', '{"api.manage": false}')) <> '1' THEN
    RAISE EXCEPTION 'FAIL owner could not revoke admin api.manage';
  END IF;
  IF (SELECT count(*) FROM role_capabilities WHERE account_id = a AND role = 'admin' AND capability = 'api.manage' AND granted = false) <> 1 THEN
    RAISE EXCEPTION 'FAIL override row missing';
  END IF;
  IF pg_temp.run(admin_a, format('SELECT has_capability(%L, %L)::text', a, 'api.manage')) <> 'false' THEN
    RAISE EXCEPTION 'FAIL admin still has api.manage after revoke';
  END IF;
  IF pg_temp.run(owner_a, format('SELECT has_capability(%L, %L)::text', a, 'api.manage')) <> 'true' THEN
    RAISE EXCEPTION 'FAIL owner lost api.manage';
  END IF;
  -- RLS follows the override: admin can no longer write api_keys / webhook_endpoints, owner can
  r := pg_temp.run(admin_a, format(
    'WITH x AS (INSERT INTO api_keys (account_id, name, key_prefix, key_hash) VALUES (%L, %L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    a, 'after-revoke', 'pfx', 'hash-after'));
  IF r LIKE '1' THEN RAISE EXCEPTION 'FAIL admin inserted an api key after revoke'; END IF;
  r := pg_temp.run(admin_a, format(
    'WITH x AS (DELETE FROM api_keys WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM x', a));
  IF r <> '0' THEN RAISE EXCEPTION 'FAIL admin deleted api keys after revoke: %', r; END IF;
  r := pg_temp.run(owner_a, format(
    'WITH x AS (INSERT INTO api_keys (account_id, name, key_prefix, key_hash) VALUES (%L, %L, %L, %L) RETURNING 1) SELECT count(*)::text FROM x',
    a, 'owner-key', 'pfx', 'hash-owner2'));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL owner must still insert api keys: %', r; END IF;
  -- SELECT of api_keys unchanged for the admin (viewer-visible)
  IF pg_temp.run(admin_a, format('SELECT count(*)::text FROM api_keys WHERE account_id = %L', a))::int < 1 THEN
    RAISE EXCEPTION 'FAIL admin must still read api_keys';
  END IF;

  -- The admin cannot grant what they lack (api.manage) to an agent
  IF pg_temp.run(admin_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent', '{"api.manage": true}'))
       NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL admin granted a capability they do not hold';
  END IF;
  -- but the admin can still grant one they DO hold (channels.manage) to agent
  IF pg_temp.run(admin_a, format('SELECT (set_role_capabilities(%L, %L, %L)->>''changed'')', a, 'agent', '{"channels.manage": true}')) <> '1' THEN
    RAISE EXCEPTION 'FAIL admin could not grant a held capability to agent';
  END IF;
  -- agent now writes a channel config (database-enforced), viewer still cannot
  r := pg_temp.run(agent_a, format(
    'WITH x AS (UPDATE web_widget_config SET widget_token = widget_token WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM x', a));
  IF r::int < 1 THEN RAISE EXCEPTION 'FAIL granted agent could not update channel config: %', r; END IF;
  r := pg_temp.run(viewer_a, format(
    'WITH x AS (UPDATE web_widget_config SET widget_token = widget_token WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM x', a));
  IF r <> '0' THEN RAISE EXCEPTION 'FAIL viewer updated channel config: %', r; END IF;
  -- Admin revokes it again from the agent; the override equals the default so the row disappears
  PERFORM pg_temp.run(admin_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent', '{"channels.manage": false}'));
  IF EXISTS (SELECT 1 FROM role_capabilities WHERE account_id = a AND role = 'agent' AND capability = 'channels.manage') THEN
    RAISE EXCEPTION 'FAIL override equal to default must be removed';
  END IF;
  r := pg_temp.run(agent_a, format(
    'WITH x AS (UPDATE web_widget_config SET widget_token = widget_token WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM x', a));
  IF r <> '0' THEN RAISE EXCEPTION 'FAIL agent still writes channel config after revoke: %', r; END IF;
  -- reset with null
  PERFORM pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'admin', '{"api.manage": null}'));
  IF EXISTS (SELECT 1 FROM role_capabilities WHERE account_id = a AND role = 'admin') THEN
    RAISE EXCEPTION 'FAIL reset to default must clear the override';
  END IF;
  IF pg_temp.run(admin_a, format('SELECT has_capability(%L, %L)::text', a, 'api.manage')) <> 'true' THEN
    RAISE EXCEPTION 'FAIL admin lost api.manage after reset';
  END IF;
  -- menu overrides + a no-op change logs nothing
  PERFORM pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent', '{"menu.broadcasts": false}'));
  IF pg_temp.run(agent_a, format('SELECT has_capability(%L, %L)::text', a, 'menu.broadcasts')) <> 'false' THEN
    RAISE EXCEPTION 'FAIL menu override not honoured';
  END IF;
  i := (SELECT count(*) FROM role_capability_log WHERE account_id = a);
  PERFORM pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent', '{"menu.broadcasts": false, "menu.inbox": true}'));
  IF (SELECT count(*) FROM role_capability_log WHERE account_id = a) <> i THEN
    RAISE EXCEPTION 'FAIL a no-op change must not be logged';
  END IF;
  -- the log has who / old / new
  IF NOT EXISTS (SELECT 1 FROM role_capability_log
                 WHERE account_id = a AND role = 'admin' AND capability = 'api.manage'
                   AND old_granted = true AND new_granted = false AND actor = owner_a) THEN
    RAISE EXCEPTION 'FAIL revoke not logged with actor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM role_capability_log
                 WHERE account_id = a AND role = 'admin' AND capability = 'api.manage'
                   AND old_granted = false AND new_granted = true) THEN
    RAISE EXCEPTION 'FAIL reset not logged';
  END IF;
  -- append-only, even for the table owner
  BEGIN
    UPDATE role_capability_log SET new_granted = NOT new_granted WHERE account_id = a;
    RAISE EXCEPTION 'FAIL log update was allowed';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  BEGIN
    DELETE FROM role_capability_log WHERE account_id = a;
    RAISE EXCEPTION 'FAIL log delete was allowed';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  -- log / overrides visibility: members read overrides, only roles.manage reads the log
  IF pg_temp.run(agent_a, format('SELECT count(*)::text FROM role_capabilities WHERE account_id = %L', a))::int < 1 THEN
    RAISE EXCEPTION 'FAIL members must read their account overrides';
  END IF;
  IF pg_temp.run(owner_b, format('SELECT count(*)::text FROM role_capabilities WHERE account_id = %L', a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL other accounts must not read overrides';
  END IF;
  IF pg_temp.run(agent_a, format('SELECT count(*)::text FROM role_capability_log WHERE account_id = %L', a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL agent must not read the change log';
  END IF;
  IF pg_temp.run(admin_a, format('SELECT count(*)::text FROM role_capability_log WHERE account_id = %L', a))::int < 1 THEN
    RAISE EXCEPTION 'FAIL admin must read the change log';
  END IF;
  -- a stale grant override below min_grant_role is ignored by has_capability
  INSERT INTO role_capabilities (account_id, role, capability, granted, changed_by)
    VALUES (a, 'viewer', 'messages.send', true, owner_a);
  IF pg_temp.run(viewer_a, format('SELECT has_capability(%L, %L)::text', a, 'messages.send')) <> 'false' THEN
    RAISE EXCEPTION 'FAIL stale viewer write grant must be ignored';
  END IF;
  DELETE FROM role_capabilities WHERE account_id = a AND role = 'viewer' AND capability = 'messages.send';
  n := n + 1;

  -- ---------------------------------------------------------
  -- 7. ai.configure moved policies follow overrides
  -- ---------------------------------------------------------
  PERFORM pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'admin', '{"ai.configure": false}'));
  IF pg_temp.run(admin_a, format('SELECT count(*)::text FROM ai_connections WHERE account_id = %L', a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL admin without ai.configure still reads ai_connections';
  END IF;
  IF pg_temp.run(admin_a, format('SELECT count(*)::text FROM ai_usage_log WHERE account_id = %L', a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL admin without ai.configure still reads ai_usage_log';
  END IF;
  r := pg_temp.run(admin_a, format(
    'WITH x AS (UPDATE ai_configs SET model = %L WHERE account_id = %L RETURNING 1) SELECT count(*)::text FROM x', 'x', a));
  IF r <> '0' THEN RAISE EXCEPTION 'FAIL admin without ai.configure updated ai_configs: %', r; END IF;
  -- grant it to the agent (admin cannot: they lack it now) -> owner does
  IF pg_temp.run(admin_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent', '{"ai.configure": true}'))
       NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL admin granted ai.configure they no longer hold';
  END IF;
  PERFORM pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent', '{"ai.configure": true}'));
  IF pg_temp.run(agent_a, format('SELECT count(*)::text FROM ai_connections WHERE account_id = %L', a))::int < 1 THEN
    RAISE EXCEPTION 'FAIL granted agent cannot read ai_connections';
  END IF;
  IF pg_temp.run(viewer_a, format('SELECT count(*)::text FROM ai_connections WHERE account_id = %L', a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL viewer reads ai_connections';
  END IF;
  PERFORM pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'agent', '{"ai.configure": null}'));
  PERFORM pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'admin', '{"ai.configure": null}'));
  n := n + 1;

  -- ---------------------------------------------------------
  -- 8. Member rules
  -- ---------------------------------------------------------
  -- admin cannot change another admin, nor mint an admin
  IF pg_temp.run(admin_a, format('SELECT set_member_role(%L, %L)::text', admin2_a, 'agent')) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL admin changed another admin';
  END IF;
  IF pg_temp.run(admin_a, format('SELECT set_member_role(%L, %L)::text', agent_a, 'admin')) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL admin promoted an agent to admin';
  END IF;
  -- admin changes an agent to viewer and back
  IF pg_temp.run(admin_a, format('SELECT set_member_role(%L, %L)::text', agent_a, 'viewer')) LIKE 'ERR %' THEN
    RAISE EXCEPTION 'FAIL admin could not demote agent';
  END IF;
  IF pg_temp.run(admin_a, format('SELECT set_member_role(%L, %L)::text', agent_a, 'agent')) LIKE 'ERR %' THEN
    RAISE EXCEPTION 'FAIL admin could not restore agent';
  END IF;
  -- admin cannot remove an admin or the owner
  IF pg_temp.run(admin_a, format('SELECT remove_account_member(%L)::text', admin2_a)) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL admin removed another admin';
  END IF;
  IF pg_temp.run(admin_a, format('SELECT remove_account_member(%L)::text', owner_a)) NOT LIKE 'ERR %' THEN
    RAISE EXCEPTION 'FAIL admin removed the owner';
  END IF;
  -- agent / viewer cannot use the RPCs at all
  IF pg_temp.run(agent_a, format('SELECT set_member_role(%L, %L)::text', viewer_a, 'agent')) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL agent changed a role';
  END IF;
  -- the owner can change an admin and promote to admin
  IF pg_temp.run(owner_a, format('SELECT set_member_role(%L, %L)::text', admin2_a, 'agent')) LIKE 'ERR %' THEN
    RAISE EXCEPTION 'FAIL owner could not change an admin';
  END IF;
  IF pg_temp.run(owner_a, format('SELECT set_member_role(%L, %L)::text', admin2_a, 'admin')) LIKE 'ERR %' THEN
    RAISE EXCEPTION 'FAIL owner could not promote to admin';
  END IF;
  -- capability gate: revoke members.change-role / members.remove from admin
  PERFORM pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'admin',
                                      '{"members.change-role": false, "members.remove": false}'));
  IF pg_temp.run(admin_a, format('SELECT set_member_role(%L, %L)::text', agent_a, 'viewer')) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL admin without members.change-role changed a role';
  END IF;
  IF pg_temp.run(admin_a, format('SELECT remove_account_member(%L)::text', agent_a)) NOT LIKE 'ERR 42501:%' THEN
    RAISE EXCEPTION 'FAIL admin without members.remove removed a member';
  END IF;
  PERFORM pg_temp.run(owner_a, format('SELECT set_role_capabilities(%L, %L, %L)::text', a, 'admin',
                                      '{"members.change-role": null, "members.remove": null}'));
  -- with the capability back, an admin removes a viewer (RPC succeeds, user relocated)
  IF pg_temp.run(admin_a, format('SELECT remove_account_member(%L)::text', viewer_a)) LIKE 'ERR %' THEN
    RAISE EXCEPTION 'FAIL admin could not remove a viewer';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 9. Invitations: only roles strictly below the inviter's own
  -- ---------------------------------------------------------
  r := pg_temp.run(admin_a, format(
    'WITH x AS (INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at) VALUES (%L, %L, %L, %L, now() + interval ''1 day'') RETURNING 1) SELECT count(*)::text FROM x',
    a, 'h-admin-by-admin', 'admin', admin_a));
  IF r NOT LIKE 'ERR 42501:%' THEN RAISE EXCEPTION 'FAIL admin invited an admin: %', r; END IF;
  r := pg_temp.run(admin_a, format(
    'WITH x AS (INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at) VALUES (%L, %L, %L, %L, now() + interval ''1 day'') RETURNING 1) SELECT count(*)::text FROM x',
    a, 'h-agent-by-admin', 'agent', admin_a));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL admin could not invite an agent: %', r; END IF;
  r := pg_temp.run(admin_a, format(
    'WITH x AS (INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at) VALUES (%L, %L, %L, %L, now() + interval ''1 day'') RETURNING 1) SELECT count(*)::text FROM x',
    a, 'h-viewer-by-admin', 'viewer', admin_a));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL admin could not invite a viewer: %', r; END IF;
  r := pg_temp.run(owner_a, format(
    'WITH x AS (INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at) VALUES (%L, %L, %L, %L, now() + interval ''1 day'') RETURNING 1) SELECT count(*)::text FROM x',
    a, 'h-admin-by-owner', 'admin', owner_a));
  IF r <> '1' THEN RAISE EXCEPTION 'FAIL owner could not invite an admin: %', r; END IF;
  -- service-side insert (no JWT) is not restricted
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at)
    VALUES (a, 'h-admin-by-service', 'admin', now() + interval '1 day');
  -- bumping an existing invite's role is checked too
  r := pg_temp.run(admin_a, format(
    'WITH x AS (UPDATE account_invitations SET role = %L WHERE token_hash = %L RETURNING 1) SELECT count(*)::text FROM x',
    'admin', 'h-agent-by-admin'));
  IF r NOT LIKE 'ERR 42501:%' THEN RAISE EXCEPTION 'FAIL admin raised an invite to admin: %', r; END IF;
  n := n + 1;

  RAISE EXCEPTION 'ROLLBACK-OK: % check groups passed (catalogue, parity, moved RLS, direct-write lockout, guardrails, overrides+log, ai.configure, member rules, invitations)', n;
END
$verify$;
