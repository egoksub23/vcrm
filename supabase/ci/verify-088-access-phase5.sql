-- ============================================================
-- Verification for migration 088 (access control phase 5: every
-- capability that guards data is enforced by the database).
--
-- Run against a database that already has 088 applied:
--   supabase db query --linked -f supabase/ci/verify-088-access-phase5.sql
--
-- Everything happens inside one DO block that ends with
-- RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing is ever committed.
-- A message starting with ROLLBACK-OK means every check passed; any
-- other error message names the check that failed.
--
-- People are simulated the way PostgREST does it: set the JWT claims and
-- SET LOCAL ROLE authenticated, so RLS applies for real.
--
-- What it proves
--   1. catalogue tiers, grant floors and the helper's shape
--   2. defaults: for every capability and role, has_capability() equals the
--      OLD role floor (nothing changes until someone edits the matrix)
--   3. for ~50 groups of tables: INSERT / UPDATE / DELETE succeed exactly for
--      the roles that hold the capability, in three configurations (defaults,
--      an Agent granted it BELOW the old floor, an Admin who lost it), and are
--      refused for a Viewer and for a member of another account
--   4. special rules: own-row rules, the conversations and accounts guards,
--      comment deletion, invitations, functions that used a role floor
--   5. pending_edit is no longer readable by other members
--   6. the policy-parity check, the role-floor allow-list, typos
--   7. Owner lockout safety, cross-account isolation
-- ============================================================

DO $verify$
DECLARE
  a        UUID;
  b        UUID;
  owner_a  UUID := gen_random_uuid();
  admin_a  UUID := gen_random_uuid();
  agent_a  UUID := gen_random_uuid();
  agent2_a UUID := gen_random_uuid();
  viewer_a UUID := gen_random_uuid();
  owner_b  UUID := gen_random_uuid();
  fx       RECORD;
  n        INTEGER := 0;
  res      TEXT;
  cnt      INTEGER;
  rec      RECORD;
  cap      TEXT;
  role_k   TEXT;
  tag1     UUID;
  snip1    UUID;
  badge    INTEGER;
  st       TEXT;
  uid      UUID;
BEGIN
  -- ---------------------------------------------------------
  -- helpers (temp objects live only for this session)
  -- ---------------------------------------------------------
  -- Run one statement as a person (NULL = no session) or another role.
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

  -- Run a write as a person and report the affected rows: 'ROWS n' or 'ERR ...'.
  EXECUTE $f$
    CREATE FUNCTION pg_temp.dml(u UUID, q TEXT) RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT; c BIGINT;
    BEGIN
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      BEGIN
        EXECUTE q;
        GET DIAGNOSTICS c = ROW_COUNT;
        res := 'ROWS ' || c;
      EXCEPTION WHEN OTHERS THEN
        res := 'ERR ' || SQLSTATE || ': ' || SQLERRM;
      END;
      EXECUTE 'RESET ROLE';
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      RETURN res;
    END $b$;
  $f$;

  CREATE TEMP TABLE ctx (k TEXT PRIMARY KEY, v TEXT);
  CREATE TEMP TABLE actors (uid UUID, role TEXT, ord INTEGER);
  CREATE TEMP TABLE counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
  INSERT INTO counters VALUES ('cases', 0), ('checks', 0);

  EXECUTE $f$
    CREATE FUNCTION pg_temp.tpl(q TEXT, actor UUID) RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE r RECORD; s TEXT := q;
    BEGIN
      FOR r IN SELECT k, v FROM pg_temp.ctx LOOP
        s := replace(s, '{' || r.k || '}', r.v);
      END LOOP;
      s := replace(s, '{ACTOR}', COALESCE(actor::text, ''));
      s := replace(s, '{N}', gen_random_uuid()::text);
      RETURN s;
    END $b$;
  $f$;

  -- One table group. For each configuration and each person, an INSERT, an
  -- UPDATE and a DELETE must succeed exactly when the person's effective
  -- capability set holds one of the listed capabilities (Owner: always), and
  -- a member of another account must always be refused.
  --   p_main   the capability the configurations grant / revoke
  --   p_ci/cu/cd  capabilities of which ANY one allows insert / update / delete
  --   p_seed   run as postgres before each person (fresh {ID}..{ID4})
  EXECUTE $f$
    CREATE FUNCTION pg_temp.exercise(p_label TEXT, p_main TEXT, p_ci TEXT[], p_cu TEXT[], p_cd TEXT[],
                                     p_seed TEXT, p_ins TEXT, p_upd TEXT, p_del TEXT) RETURNS VOID
    LANGUAGE plpgsql AS $b$
    DECLARE
      cfg   TEXT;
      act   RECORD;
      op    TEXT;
      q     TEXT;
      caps  TEXT[];
      res   TEXT;
      exp   BOOLEAN;
      got   BOOLEAN;
      acct  UUID := (SELECT v::uuid FROM pg_temp.ctx WHERE k = 'A');
      other UUID := (SELECT v::uuid FROM pg_temp.ctx WHERE k = 'OWNER_B');
    BEGIN
      FOREACH cfg IN ARRAY ARRAY['default', 'agent+main', 'admin-main'] LOOP
        DELETE FROM role_capabilities WHERE account_id = acct;
        IF cfg = 'agent+main' THEN
          INSERT INTO role_capabilities (account_id, role, capability, granted)
          VALUES (acct, 'agent', p_main, true);
        ELSIF cfg = 'admin-main' THEN
          INSERT INTO role_capabilities (account_id, role, capability, granted)
          VALUES (acct, 'admin', p_main, false);
        END IF;

        FOR act IN SELECT uid, role FROM pg_temp.actors ORDER BY ord LOOP
          UPDATE pg_temp.ctx SET v = gen_random_uuid()::text WHERE k IN ('ID', 'ID2', 'ID3', 'ID4');
          IF p_seed IS NOT NULL THEN
            EXECUTE pg_temp.tpl(p_seed, act.uid);
          END IF;
          FOREACH op IN ARRAY ARRAY['ins', 'upd', 'del'] LOOP
            q    := CASE op WHEN 'ins' THEN p_ins WHEN 'upd' THEN p_upd ELSE p_del END;
            caps := CASE op WHEN 'ins' THEN p_ci  WHEN 'upd' THEN p_cu  ELSE p_cd  END;
            CONTINUE WHEN q IS NULL;
            IF q LIKE 'SOFT:%' THEN
              -- a table whose DELETE turns into a soft delete (082): the row count is 0
              -- either way, so look at deleted_at afterwards
              res := pg_temp.dml(act.uid, pg_temp.tpl(substr(q, length(split_part(q, ':', 1) || ':' || split_part(q, ':', 2)) + 2), act.uid));
              EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = %L AND deleted_at IS NOT NULL)',
                             split_part(q, ':', 2), (SELECT v FROM pg_temp.ctx WHERE k = 'ID'))
                INTO got;
              IF res LIKE 'ERR%' AND res NOT LIKE 'ERR 42501%' THEN
                RAISE EXCEPTION 'FAIL % (%): % as % gave an unexpected error: %', p_label, cfg, op, act.role, res;
              END IF;
            ELSE
              res := pg_temp.dml(act.uid, pg_temp.tpl(q, act.uid));
              IF res LIKE 'ERR%' AND res NOT LIKE 'ERR 42501%' THEN
                RAISE EXCEPTION 'FAIL % (%): % as % gave an unexpected error: %', p_label, cfg, op, act.role, res;
              END IF;
              got := res LIKE 'ROWS %' AND split_part(res, ' ', 2)::int > 0;
            END IF;
            exp := act.role = 'owner' OR EXISTS (
              SELECT 1 FROM unnest(caps) c
               WHERE effective_capability(acct, act.role::account_role_enum, c));
            IF got IS DISTINCT FROM exp THEN
              RAISE EXCEPTION 'FAIL % (%): % as % expected %, got % [%]',
                p_label, cfg, op, act.role,
                CASE WHEN exp THEN 'allowed' ELSE 'refused' END, res, array_to_string(caps, ' or ');
            END IF;
            UPDATE pg_temp.counters SET n = n + 1 WHERE k = 'checks';
          END LOOP;
        END LOOP;

        -- a member of ANOTHER account is always refused
        UPDATE pg_temp.ctx SET v = gen_random_uuid()::text WHERE k IN ('ID', 'ID2', 'ID3', 'ID4');
        IF p_seed IS NOT NULL THEN
          EXECUTE pg_temp.tpl(p_seed, other);
        END IF;
        FOREACH op IN ARRAY ARRAY['ins', 'upd', 'del'] LOOP
          q := CASE op WHEN 'ins' THEN p_ins WHEN 'upd' THEN p_upd ELSE p_del END;
          CONTINUE WHEN q IS NULL;
          IF q LIKE 'SOFT:%' THEN
            q := substr(q, length(split_part(q, ':', 1) || ':' || split_part(q, ':', 2)) + 2);
          END IF;
          res := pg_temp.dml(other, pg_temp.tpl(q, other));
          IF res NOT LIKE 'ERR 42501%' AND res <> 'ROWS 0' THEN
            RAISE EXCEPTION 'FAIL % (%): % by a member of another account gave %', p_label, cfg, op, res;
          END IF;
          UPDATE pg_temp.counters SET n = n + 1 WHERE k = 'checks';
        END LOOP;
      END LOOP;
      DELETE FROM role_capabilities WHERE account_id = acct;
      UPDATE pg_temp.counters SET n = n + 1 WHERE k = 'cases';
    END $b$;
  $f$;

  -- audit rows / notifications helpers are not needed here; approvals use
  -- direct table reads.

  -- ---------------------------------------------------------
  -- fixtures: users -> (trigger) accounts + profiles
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify088-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, admin_a, agent_a, agent2_a, viewer_a, owner_b]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create accounts';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'admin'  WHERE user_id = admin_a;
  UPDATE profiles SET account_id = a, account_role = 'agent'  WHERE user_id IN (agent_a, agent2_a);
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = viewer_a;
  DELETE FROM accounts WHERE owner_user_id IN (admin_a, agent_a, agent2_a, viewer_a);

  INSERT INTO actors VALUES (owner_a, 'owner', 1), (admin_a, 'admin', 2), (agent_a, 'agent', 3), (viewer_a, 'viewer', 4);

  -- shared rows of account A (created as the table owner: RLS does not apply)
  INSERT INTO ctx VALUES
    ('A', a::text), ('B', b::text), ('O', owner_a::text), ('OWNER_B', owner_b::text),
    ('AGENT', agent_a::text), ('AGENT2', agent2_a::text), ('VIEWER', viewer_a::text), ('ADMIN', admin_a::text),
    ('C', gen_random_uuid()::text), ('V', gen_random_uuid()::text), ('P0', gen_random_uuid()::text),
    ('S0', gen_random_uuid()::text), ('T1', gen_random_uuid()::text), ('T2', gen_random_uuid()::text),
    ('TAG', gen_random_uuid()::text), ('ART', gen_random_uuid()::text), ('AUTO', gen_random_uuid()::text),
    ('FLOW', gen_random_uuid()::text), ('BC', gen_random_uuid()::text), ('CF', gen_random_uuid()::text),
    ('TEAM0', gen_random_uuid()::text), ('MSG', gen_random_uuid()::text), ('CPOST', gen_random_uuid()::text),
    ('ID', gen_random_uuid()::text), ('ID2', gen_random_uuid()::text),
    ('ID3', gen_random_uuid()::text), ('ID4', gen_random_uuid()::text);

  INSERT INTO contacts (id, user_id, account_id, phone, name)
  SELECT v::uuid, owner_a, a, '+10000000088', 'Casey' FROM ctx WHERE k = 'C';
  INSERT INTO conversations (id, user_id, account_id, contact_id)
  SELECT (SELECT v::uuid FROM ctx WHERE k = 'V'), owner_a, a, (SELECT v::uuid FROM ctx WHERE k = 'C');
  INSERT INTO pipelines (id, user_id, name, account_id)
  SELECT v::uuid, owner_a, 'Fixture pipeline', a FROM ctx WHERE k = 'P0';
  INSERT INTO pipeline_stages (id, pipeline_id, name)
  SELECT (SELECT v::uuid FROM ctx WHERE k = 'S0'), v::uuid, 'Fixture stage' FROM ctx WHERE k = 'P0';
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject)
  SELECT v::uuid, a, 880001, (SELECT v::uuid FROM ctx WHERE k = 'C'), 'Fixture ticket 1' FROM ctx WHERE k = 'T1';
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject)
  SELECT v::uuid, a, 880002, (SELECT v::uuid FROM ctx WHERE k = 'C'), 'Fixture ticket 2' FROM ctx WHERE k = 'T2';
  INSERT INTO tags (id, user_id, name, account_id, for_contacts, for_conversations)
  SELECT v::uuid, owner_a, 'Fixture tag', a, true, true FROM ctx WHERE k = 'TAG';
  INSERT INTO ai_knowledge_documents (id, account_id, title, content, status, created_by)
  SELECT v::uuid, a, 'Fixture article', 'Body', 'published', owner_a FROM ctx WHERE k = 'ART';
  INSERT INTO automations (id, user_id, name, trigger_type, account_id)
  SELECT v::uuid, owner_a, 'Fixture automation', 'new_conversation', a FROM ctx WHERE k = 'AUTO';
  INSERT INTO flows (id, user_id, name, trigger_type, account_id)
  SELECT v::uuid, owner_a, 'Fixture flow', 'manual', a FROM ctx WHERE k = 'FLOW';
  INSERT INTO broadcasts (id, user_id, name, template_name, account_id)
  SELECT v::uuid, owner_a, 'Fixture broadcast', 'tpl', a FROM ctx WHERE k = 'BC';
  INSERT INTO custom_fields (id, user_id, field_name, account_id)
  SELECT v::uuid, owner_a, 'fixture_field', a FROM ctx WHERE k = 'CF';
  INSERT INTO teams (id, account_id, name)
  SELECT v::uuid, a, 'Fixture team' FROM ctx WHERE k = 'TEAM0';
  INSERT INTO messages (id, conversation_id, sender_type, content_text)
  SELECT v::uuid, (SELECT v::uuid FROM ctx WHERE k = 'V'), 'agent', 'Fixture message' FROM ctx WHERE k = 'MSG';
  INSERT INTO comment_posts (id, account_id, provider, channel_ref_id, external_post_id)
  SELECT v::uuid, a, 'facebook', 'page-1', 'post-1' FROM ctx WHERE k = 'CPOST';

  -- ---------------------------------------------------------
  -- 1. Catalogue tiers, grant floors, helper shape
  -- ---------------------------------------------------------
  -- database tier now: everything that guards data
  FOREACH cap IN ARRAY ARRAY[
    'messages.send', 'conversations.manage', 'comments.moderate', 'comments.delete',
    'inbox.shared-views', 'contacts.edit', 'deals.manage', 'pipelines.configure',
    'broadcasts.send', 'automations.manage', 'flows.manage', 'tickets.work',
    'tickets.delete', 'tickets.configure-form', 'tags.manage', 'snippets.manage',
    'tags.propose', 'snippets.propose', 'knowledge.draft', 'knowledge.publish',
    'knowledge.manage', 'settings.workspace', 'members.invite', 'teams.manage',
    'members.change-role', 'members.remove', 'roles.manage', 'audit.view',
    'approvals.review', 'ai.configure', 'channels.manage', 'api.manage'
  ] LOOP
    IF (SELECT enforced_by FROM capability_catalogue WHERE capability = cap) IS DISTINCT FROM 'database' THEN
      RAISE EXCEPTION 'FAIL % must be database-enforced', cap;
    END IF;
  END LOOP;
  -- app tier by nature: menus and reports (they show or hide pages), the AI
  -- provider call, the service-role merge, the server-side Jira routes
  FOREACH cap IN ARRAY ARRAY[
    'menu.dashboard', 'menu.inbox', 'menu.notifications', 'menu.contacts', 'menu.pipelines',
    'menu.broadcasts', 'menu.tickets', 'menu.automations', 'menu.flows', 'menu.knowledge',
    'menu.agents', 'menu.reports', 'menu.settings', 'reports.view', 'ai.use', 'contacts.merge',
    'jira.connect', 'jira.link', 'jira.share-comments'
  ] LOOP
    IF EXISTS (SELECT 1 FROM capability_catalogue WHERE capability = cap AND enforced_by <> 'app') THEN
      RAISE EXCEPTION 'FAIL % must stay on the app tier', cap;
    END IF;
  END LOOP;
  -- grantable below the old floor (agent); a Viewer can never hold a write capability
  IF EXISTS (SELECT 1 FROM capability_catalogue
              WHERE capability IN ('pipelines.configure', 'settings.workspace', 'tags.manage', 'knowledge.publish',
                                   'knowledge.manage', 'tickets.delete', 'tickets.configure-form', 'inbox.shared-views',
                                   'members.invite', 'teams.manage', 'messages.send', 'conversations.manage')
                AND min_grant_role <> 'agent') THEN
    RAISE EXCEPTION 'FAIL min_grant_role must be agent for the write capabilities';
  END IF;
  IF EXISTS (SELECT 1 FROM capability_catalogue
              WHERE enforced_by = 'database' AND min_grant_role = 'viewer' AND capability NOT LIKE 'menu.%') THEN
    RAISE EXCEPTION 'FAIL a database capability must never be grantable to a Viewer';
  END IF;

  -- has_capability: STABLE, SECURITY DEFINER, fixed search_path, indexed overrides
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'has_capability'
                    AND p.provolatile = 's' AND p.prosecdef
                    AND p.proconfig::text LIKE '%search_path%') THEN
    RAISE EXCEPTION 'FAIL has_capability must be STABLE SECURITY DEFINER with a fixed search_path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'capability_account_ids'
                    AND p.provolatile = 's' AND p.prosecdef
                    AND p.proconfig::text LIKE '%search_path%') THEN
    RAISE EXCEPTION 'FAIL capability_account_ids must be STABLE SECURITY DEFINER with a fixed search_path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'role_capabilities'
                  AND indexdef LIKE '%(account_id, role, capability)%') THEN
    RAISE EXCEPTION 'FAIL role_capabilities needs its (account_id, role, capability) index';
  END IF;

  -- capability_account_ids: the caller's accounts only; empty for no session,
  -- another account's member, an unknown capability, a Viewer on a write capability
  IF pg_temp.run(owner_a, $q$SELECT cardinality(capability_account_ids('pipelines.configure'))::text$q$) <> '1'
  OR pg_temp.run(admin_a, $q$SELECT cardinality(capability_account_ids('pipelines.configure'))::text$q$) <> '1'
  OR pg_temp.run(agent_a, $q$SELECT cardinality(capability_account_ids('pipelines.configure'))::text$q$) <> '0'
  OR pg_temp.run(viewer_a, $q$SELECT cardinality(capability_account_ids('tickets.work'))::text$q$) <> '0'
  OR pg_temp.run(owner_a, $q$SELECT cardinality(capability_account_ids('no.such-capability'))::text$q$) <> '0'
  OR pg_temp.run(NULL, $q$SELECT cardinality(capability_account_ids('tickets.work'))::text$q$, 'anon') <> '0'
  OR pg_temp.run(owner_b, format($q$SELECT (%L::uuid = ANY (capability_account_ids('tickets.work')))::text$q$, a)) <> 'false'
  OR pg_temp.run(owner_b, format($q$SELECT has_capability(%L, 'tickets.work')::text$q$, a)) <> 'false'
  OR pg_temp.run(NULL, format($q$SELECT has_capability(%L, 'tickets.work')::text$q$, a), 'anon') <> 'false' THEN
    RAISE EXCEPTION 'FAIL capability_account_ids / has_capability must deny non-members, no session and unknown keys';
  END IF;
  n := n + 1;

  -- capability_account_ids() is effective_capability() inlined: it must agree for
  -- every capability, every role and every override state (none, grant, revoke),
  -- including a GRANT override below min_grant_role (ignored by both)
  FOR rec IN SELECT capability FROM capability_catalogue LOOP
    FOREACH role_k IN ARRAY ARRAY['owner', 'admin', 'agent', 'viewer'] LOOP
      uid := CASE role_k WHEN 'owner' THEN owner_a WHEN 'admin' THEN admin_a WHEN 'agent' THEN agent_a ELSE viewer_a END;
      FOREACH st IN ARRAY ARRAY['none', 'grant', 'revoke'] LOOP
        DELETE FROM role_capabilities WHERE account_id = a;
        IF role_k <> 'owner' AND st <> 'none' THEN
          INSERT INTO role_capabilities (account_id, role, capability, granted)
          VALUES (a, role_k::account_role_enum, rec.capability, st = 'grant');
        END IF;
        IF pg_temp.run(uid, format($q$SELECT (%L::uuid = ANY (capability_account_ids(%L)))::text$q$, a, rec.capability))
           <> effective_capability(a, role_k::account_role_enum, rec.capability)::text
        OR pg_temp.run(uid, format($q$SELECT has_capability(%L, %L)::text$q$, a, rec.capability))
           <> effective_capability(a, role_k::account_role_enum, rec.capability)::text THEN
          RAISE EXCEPTION 'FAIL capability_account_ids / has_capability disagree with effective_capability: % % %', rec.capability, role_k, st;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  DELETE FROM role_capabilities WHERE account_id = a;
  n := n + 1;

  -- Viewer guard and below-the-floor grants go through set_role_capabilities
  res := pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'viewer', '{"pipelines.configure": true}'::jsonb)::text$q$, a));
  IF res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL a Viewer must not be given pipelines.configure: %', res; END IF;
  res := pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'viewer', '{"tickets.work": true}'::jsonb)::text$q$, a));
  IF res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL a Viewer must not be given tickets.work: %', res; END IF;
  res := pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'agent', '{"pipelines.configure": true}'::jsonb)::text$q$, a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL an Agent can be given pipelines.configure (below the old floor): %', res; END IF;
  IF pg_temp.run(agent_a, format($q$SELECT has_capability(%L, 'pipelines.configure')::text$q$, a)) <> 'true' THEN
    RAISE EXCEPTION 'FAIL the granted capability must show up in has_capability';
  END IF;
  -- an Admin cannot grant what he lacks, nor edit the Admin role
  res := pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'admin', '{"pipelines.configure": false}'::jsonb)::text$q$, a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL owner revokes from admin: %', res; END IF;
  res := pg_temp.run(admin_a, format(
    $q$SELECT set_role_capabilities(%L, 'agent', '{"deals.manage": true, "teams.manage": true}'::jsonb)::text$q$, a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL an Admin can grant capabilities he holds: %', res; END IF;
  -- reset the Agent's pipelines.configure grant, then the Admin (who lost it) tries to give it
  res := pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'agent', '{"pipelines.configure": null}'::jsonb)::text$q$, a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL owner resets the agent grant: %', res; END IF;
  res := pg_temp.run(admin_a, format(
    $q$SELECT set_role_capabilities(%L, 'agent', '{"pipelines.configure": true}'::jsonb)::text$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an Admin must not grant a capability he lost: %', res; END IF;
  res := pg_temp.run(admin_a, format(
    $q$SELECT set_role_capabilities(%L, 'admin', '{"tickets.work": false}'::jsonb)::text$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an Admin must not edit the Admin role: %', res; END IF;
  DELETE FROM role_capabilities WHERE account_id = a;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 2. Defaults equal the OLD floors: nothing changes until someone edits
  -- ---------------------------------------------------------
  CREATE TEMP TABLE old_floors (capability TEXT PRIMARY KEY, floor_role TEXT NOT NULL);
  INSERT INTO old_floors VALUES
    ('menu.dashboard','viewer'),('menu.inbox','viewer'),('menu.notifications','viewer'),('menu.contacts','viewer'),
    ('menu.pipelines','viewer'),('menu.broadcasts','viewer'),('menu.tickets','viewer'),('menu.automations','viewer'),
    ('menu.flows','viewer'),('menu.knowledge','viewer'),('menu.agents','viewer'),('menu.reports','viewer'),
    ('menu.settings','viewer'),('reports.view','viewer'),
    ('messages.send','agent'),('conversations.manage','agent'),('comments.moderate','agent'),
    ('comments.delete','admin'),('inbox.shared-views','admin'),
    ('contacts.edit','agent'),('contacts.merge','agent'),('deals.manage','agent'),('pipelines.configure','admin'),
    ('broadcasts.send','agent'),('automations.manage','agent'),('flows.manage','agent'),
    ('tickets.work','agent'),('tickets.delete','admin'),('tickets.configure-form','admin'),('sla.configure','admin'),
    ('tags.manage','admin'),('snippets.manage','agent'),('tags.propose','agent'),('snippets.propose','agent'),
    ('knowledge.draft','agent'),('knowledge.publish','admin'),('knowledge.manage','admin'),
    ('ai.use','agent'),('ai.configure','admin'),('channels.manage','admin'),('api.manage','admin'),
    ('jira.connect','admin'),('jira.link','agent'),('jira.share-comments','agent'),
    ('settings.workspace','admin'),('audit.view','admin'),('approvals.review','admin'),
    ('members.invite','admin'),('members.change-role','admin'),('members.remove','admin'),
    ('teams.manage','admin'),('roles.manage','admin');

  IF EXISTS (SELECT 1 FROM capability_catalogue c WHERE NOT EXISTS (SELECT 1 FROM old_floors f WHERE f.capability = c.capability)) THEN
    RAISE EXCEPTION 'FAIL a capability exists that this script does not know the old floor of: %',
      (SELECT string_agg(c.capability, ', ') FROM capability_catalogue c
        WHERE NOT EXISTS (SELECT 1 FROM old_floors f WHERE f.capability = c.capability));
  END IF;
  FOR rec IN SELECT * FROM capability_catalogue WHERE capability IN (SELECT capability FROM old_floors) LOOP
    FOREACH role_k IN ARRAY ARRAY['owner', 'admin', 'agent', 'viewer'] LOOP
      res := pg_temp.run(
        CASE role_k WHEN 'owner' THEN owner_a WHEN 'admin' THEN admin_a WHEN 'agent' THEN agent_a ELSE viewer_a END,
        format($q$SELECT has_capability(%L, %L)::text$q$, a, rec.capability));
      IF res <> (role_rank(role_k::account_role_enum) >= role_rank((SELECT floor_role FROM old_floors WHERE capability = rec.capability)::account_role_enum))::text THEN
        RAISE EXCEPTION 'FAIL default of % for % differs from the old floor (%): got %',
          rec.capability, role_k, (SELECT floor_role FROM old_floors WHERE capability = rec.capability), res;
      END IF;
    END LOOP;
  END LOOP;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 3. Table groups: the harness. Reads (SELECT) are covered by the earlier
  --    verify scripts; these are the WRITE rules.
  -- ---------------------------------------------------------
  -- ----- configuration tables -----
  PERFORM pg_temp.exercise('pipelines', 'pipelines.configure', ARRAY['pipelines.configure'], ARRAY['pipelines.configure'], ARRAY['pipelines.configure'],
    $q$INSERT INTO pipelines (id, user_id, name, account_id) VALUES ('{ID}', '{O}', 'P', '{A}')$q$,
    $q$INSERT INTO pipelines (user_id, name, account_id) VALUES ('{O}', 'Pn', '{A}')$q$,
    $q$UPDATE pipelines SET name = 'Q' WHERE id = '{ID}'$q$,
    $q$DELETE FROM pipelines WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('pipeline_stages', 'pipelines.configure', ARRAY['pipelines.configure'], ARRAY['pipelines.configure'], ARRAY['pipelines.configure'],
    $q$INSERT INTO pipeline_stages (id, pipeline_id, name) VALUES ('{ID}', '{P0}', 'S')$q$,
    $q$INSERT INTO pipeline_stages (pipeline_id, name) VALUES ('{P0}', 'S{N}')$q$,
    $q$UPDATE pipeline_stages SET name = 'Q' WHERE id = '{ID}'$q$,
    $q$DELETE FROM pipeline_stages WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('custom_fields', 'settings.workspace', ARRAY['settings.workspace'], ARRAY['settings.workspace'], ARRAY['settings.workspace'],
    $q$INSERT INTO custom_fields (id, user_id, field_name, account_id) VALUES ('{ID}', '{O}', 'f{ID}', '{A}')$q$,
    $q$INSERT INTO custom_fields (user_id, field_name, account_id) VALUES ('{O}', 'f{N}', '{A}')$q$,
    $q$UPDATE custom_fields SET field_name = 'g{ID}' WHERE id = '{ID}'$q$,
    $q$DELETE FROM custom_fields WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('ticket_field_definitions', 'tickets.configure-form', ARRAY['tickets.configure-form'], ARRAY['tickets.configure-form'], ARRAY['tickets.configure-form'],
    $q$INSERT INTO ticket_field_definitions (id, account_id, label, field_type) VALUES ('{ID}', '{A}', 'L{ID}', 'text')$q$,
    $q$INSERT INTO ticket_field_definitions (account_id, label, field_type) VALUES ('{A}', 'L{N}', 'text')$q$,
    $q$UPDATE ticket_field_definitions SET label = 'M{ID}' WHERE id = '{ID}'$q$,
    $q$DELETE FROM ticket_field_definitions WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('auto_label_rules', 'tags.manage', ARRAY['tags.manage'], ARRAY['tags.manage'], ARRAY['tags.manage'],
    $q$INSERT INTO tags (id, user_id, name, account_id, for_contacts, for_conversations) VALUES ('{ID}', '{O}', 'T{ID}', '{A}', true, true), ('{ID2}', '{O}', 'T{ID2}', '{A}', true, true);
       INSERT INTO auto_label_rules (id, account_id, tag_id, keywords) VALUES ('{ID3}', '{A}', '{ID}', ARRAY['refund'])$q$,
    $q$INSERT INTO auto_label_rules (account_id, tag_id, keywords) VALUES ('{A}', '{ID2}', ARRAY['refund'])$q$,
    $q$UPDATE auto_label_rules SET is_active = false WHERE id = '{ID3}'$q$,
    $q$DELETE FROM auto_label_rules WHERE id = '{ID3}'$q$);
  PERFORM pg_temp.exercise('inbox_views (shared)', 'inbox.shared-views', ARRAY['inbox.shared-views'], ARRAY['inbox.shared-views'], ARRAY['inbox.shared-views'],
    $q$INSERT INTO inbox_views (id, account_id, name, owner_id) VALUES ('{ID}', '{A}', 'v', NULL)$q$,
    $q$INSERT INTO inbox_views (account_id, name, owner_id) VALUES ('{A}', 'v', NULL)$q$,
    $q$UPDATE inbox_views SET name = 'w' WHERE id = '{ID}'$q$,
    $q$DELETE FROM inbox_views WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('inbox_views (personal insert)', 'conversations.manage', ARRAY['conversations.manage'], NULL, NULL,
    NULL,
    $q$INSERT INTO inbox_views (account_id, name, owner_id) VALUES ('{A}', 'mine', '{ACTOR}')$q$,
    NULL, NULL);
  PERFORM pg_temp.exercise('knowledge_collections', 'knowledge.manage', ARRAY['knowledge.manage'], ARRAY['knowledge.manage'], ARRAY['knowledge.manage'],
    $q$INSERT INTO knowledge_collections (id, account_id, name) VALUES ('{ID}', '{A}', 'C{ID}')$q$,
    $q$INSERT INTO knowledge_collections (account_id, name) VALUES ('{A}', 'C{N}')$q$,
    $q$UPDATE knowledge_collections SET name = 'D{ID}' WHERE id = '{ID}'$q$,
    $q$DELETE FROM knowledge_collections WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('knowledge_sources', 'knowledge.draft', ARRAY['knowledge.draft', 'knowledge.publish'], ARRAY['knowledge.draft', 'knowledge.publish'], ARRAY['knowledge.publish', 'knowledge.manage'],
    $q$INSERT INTO knowledge_sources (id, account_id, kind) VALUES ('{ID}', '{A}', 'url')$q$,
    $q$INSERT INTO knowledge_sources (account_id, kind) VALUES ('{A}', 'url')$q$,
    $q$UPDATE knowledge_sources SET sync_status = 'ok' WHERE id = '{ID}'$q$,
    $q$DELETE FROM knowledge_sources WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('ai_knowledge_chunks', 'knowledge.manage', ARRAY['knowledge.publish', 'knowledge.manage'], ARRAY['knowledge.publish', 'knowledge.manage'], ARRAY['knowledge.publish', 'knowledge.manage'],
    $q$INSERT INTO ai_knowledge_chunks (id, document_id, account_id, content) VALUES ('{ID}', '{ART}', '{A}', 'c')$q$,
    $q$INSERT INTO ai_knowledge_chunks (document_id, account_id, content) VALUES ('{ART}', '{A}', 'c')$q$,
    $q$UPDATE ai_knowledge_chunks SET content = 'd' WHERE id = '{ID}'$q$,
    $q$DELETE FROM ai_knowledge_chunks WHERE id = '{ID}'$q$);
  -- articles: a drafter works on their own drafts, a publisher on anything
  PERFORM pg_temp.exercise('articles (own draft)', 'knowledge.draft', ARRAY['knowledge.draft', 'knowledge.publish'], ARRAY['knowledge.draft', 'knowledge.publish'], ARRAY['knowledge.draft', 'knowledge.publish'],
    $q$INSERT INTO ai_knowledge_documents (id, account_id, title, content, status, created_by) VALUES ('{ID}', '{A}', 'Own', 'b', 'draft', '{ACTOR}')$q$,
    $q$INSERT INTO ai_knowledge_documents (account_id, title, content, status, created_by) VALUES ('{A}', 'New', 'b', 'draft', '{ACTOR}')$q$,
    $q$UPDATE ai_knowledge_documents SET title = 'Own 2' WHERE id = '{ID}'$q$,
    $q$SOFT:ai_knowledge_documents:DELETE FROM ai_knowledge_documents WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('articles (publish, or edit someone else)', 'knowledge.publish', ARRAY['knowledge.publish'], ARRAY['knowledge.publish'], ARRAY['knowledge.publish'],
    $q$INSERT INTO ai_knowledge_documents (id, account_id, title, content, status, created_by) VALUES ('{ID}', '{A}', 'Theirs', 'b', 'draft', '{O}')$q$,
    $q$INSERT INTO ai_knowledge_documents (account_id, title, content, status, created_by) VALUES ('{A}', 'Pub', 'b', 'published', '{ACTOR}')$q$,
    $q$UPDATE ai_knowledge_documents SET title = 'Theirs 2' WHERE id = '{ID}'$q$,
    $q$SOFT:ai_knowledge_documents:DELETE FROM ai_knowledge_documents WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('knowledge_attachments (own draft)', 'knowledge.draft', ARRAY['knowledge.draft', 'knowledge.publish'], ARRAY['knowledge.draft', 'knowledge.publish'], ARRAY['knowledge.draft', 'knowledge.publish'],
    $q$INSERT INTO ai_knowledge_documents (id, account_id, title, content, status, created_by) VALUES ('{ID2}', '{A}', 'D', 'b', 'draft', '{ACTOR}');
       INSERT INTO knowledge_attachments (id, account_id, document_id, file_name, storage_path, public_url) VALUES ('{ID}', '{A}', '{ID2}', 'f.png', 'account-{A}/f.png', 'https://x.invalid/f.png')$q$,
    $q$INSERT INTO knowledge_attachments (account_id, document_id, file_name, storage_path, public_url) VALUES ('{A}', '{ID2}', 'g.png', 'account-{A}/g{N}.png', 'https://x.invalid/g.png')$q$,
    $q$UPDATE knowledge_attachments SET file_name = 'h.png' WHERE id = '{ID}'$q$,
    $q$DELETE FROM knowledge_attachments WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('knowledge_attachments (published article)', 'knowledge.publish', ARRAY['knowledge.publish'], ARRAY['knowledge.publish'], ARRAY['knowledge.publish'],
    $q$INSERT INTO knowledge_attachments (id, account_id, document_id, file_name, storage_path, public_url) VALUES ('{ID}', '{A}', '{ART}', 'f.png', 'account-{A}/f{ID}.png', 'https://x.invalid/f.png')$q$,
    $q$INSERT INTO knowledge_attachments (account_id, document_id, file_name, storage_path, public_url) VALUES ('{A}', '{ART}', 'g.png', 'account-{A}/g{N}.png', 'https://x.invalid/g.png')$q$,
    $q$UPDATE knowledge_attachments SET file_name = 'h.png' WHERE id = '{ID}'$q$,
    $q$DELETE FROM knowledge_attachments WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('knowledge_gaps', 'knowledge.draft', NULL, ARRAY['knowledge.draft', 'knowledge.publish'], NULL,
    $q$INSERT INTO knowledge_gaps (id, account_id, question, norm_text) VALUES ('{ID}', '{A}', 'q{ID}', 'q{ID}')$q$,
    NULL,
    $q$UPDATE knowledge_gaps SET status = 'dismissed' WHERE id = '{ID}'$q$,
    NULL);
  PERFORM pg_temp.exercise('automations', 'automations.manage', ARRAY['automations.manage'], ARRAY['automations.manage'], ARRAY['automations.manage'],
    $q$INSERT INTO automations (id, user_id, name, trigger_type, account_id) VALUES ('{ID}', '{O}', 'A', 'new_conversation', '{A}')$q$,
    $q$INSERT INTO automations (user_id, name, trigger_type, account_id) VALUES ('{O}', 'An', 'new_conversation', '{A}')$q$,
    $q$UPDATE automations SET name = 'B' WHERE id = '{ID}'$q$,
    $q$DELETE FROM automations WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('automation_steps', 'automations.manage', ARRAY['automations.manage'], ARRAY['automations.manage'], ARRAY['automations.manage'],
    $q$INSERT INTO automation_steps (id, automation_id, step_type, position) VALUES ('{ID}', '{AUTO}', 'send_message', 1)$q$,
    $q$INSERT INTO automation_steps (automation_id, step_type, position) VALUES ('{AUTO}', 'send_message', 2)$q$,
    $q$UPDATE automation_steps SET position = 3 WHERE id = '{ID}'$q$,
    $q$DELETE FROM automation_steps WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('flows', 'flows.manage', ARRAY['flows.manage'], ARRAY['flows.manage'], ARRAY['flows.manage'],
    $q$INSERT INTO flows (id, user_id, name, trigger_type, account_id) VALUES ('{ID}', '{O}', 'F', 'manual', '{A}')$q$,
    $q$INSERT INTO flows (user_id, name, trigger_type, account_id) VALUES ('{O}', 'Fn', 'manual', '{A}')$q$,
    $q$UPDATE flows SET name = 'G' WHERE id = '{ID}'$q$,
    $q$DELETE FROM flows WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('flow_nodes', 'flows.manage', ARRAY['flows.manage'], ARRAY['flows.manage'], ARRAY['flows.manage'],
    $q$INSERT INTO flow_nodes (id, flow_id, node_key, node_type) VALUES ('{ID}', '{FLOW}', 'k{ID}', 'start')$q$,
    $q$INSERT INTO flow_nodes (flow_id, node_key, node_type) VALUES ('{FLOW}', 'k{N}', 'start')$q$,
    $q$UPDATE flow_nodes SET node_key = 'z{ID}' WHERE id = '{ID}'$q$,
    $q$DELETE FROM flow_nodes WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('teams', 'teams.manage', ARRAY['teams.manage'], ARRAY['teams.manage'], ARRAY['teams.manage'],
    $q$INSERT INTO teams (id, account_id, name) VALUES ('{ID}', '{A}', 'T{ID}')$q$,
    $q$INSERT INTO teams (account_id, name) VALUES ('{A}', 'T{N}')$q$,
    $q$UPDATE teams SET name = 'U{ID}' WHERE id = '{ID}'$q$,
    $q$DELETE FROM teams WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('team_members', 'teams.manage', ARRAY['teams.manage'], ARRAY['teams.manage'], ARRAY['teams.manage'],
    $q$INSERT INTO teams (id, account_id, name) VALUES ('{ID}', '{A}', 'T{ID}'), ('{ID2}', '{A}', 'T{ID2}');
       INSERT INTO team_members (id, team_id, user_id) VALUES ('{ID3}', '{ID}', '{AGENT2}')$q$,
    $q$INSERT INTO team_members (team_id, user_id) VALUES ('{ID2}', '{AGENT2}')$q$,
    $q$UPDATE team_members SET user_id = user_id WHERE id = '{ID3}'$q$,
    $q$DELETE FROM team_members WHERE id = '{ID3}'$q$);
  PERFORM pg_temp.exercise('account_invitations', 'members.invite', ARRAY['members.invite'], ARRAY['members.invite'], ARRAY['members.invite'],
    $q$INSERT INTO account_invitations (id, account_id, token_hash, role, expires_at) VALUES ('{ID}', '{A}', 'h{ID}', 'viewer', now() + interval '1 day')$q$,
    $q$INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES ('{A}', 'h{N}', 'viewer', now() + interval '1 day')$q$,
    $q$UPDATE account_invitations SET expires_at = now() + interval '2 days' WHERE id = '{ID}'$q$,
    $q$DELETE FROM account_invitations WHERE id = '{ID}'$q$);
  -- accounts: one row, three capabilities, decided per column
  PERFORM pg_temp.exercise('accounts.name', 'settings.workspace', NULL, ARRAY['settings.workspace'], NULL,
    NULL, NULL, $q$UPDATE accounts SET name = 'Verify 088 ' || left('{N}', 6) WHERE id = '{A}'$q$, NULL);
  PERFORM pg_temp.exercise('accounts.ticket_key_prefix', 'tickets.configure-form', NULL, ARRAY['tickets.configure-form'], NULL,
    NULL, NULL, $q$UPDATE accounts SET ticket_key_prefix = 'ZQ' || (floor(random() * 90) + 10)::int WHERE id = '{A}'$q$, NULL);
  PERFORM pg_temp.exercise('accounts.auto_label_ai_enabled', 'tags.manage', NULL, ARRAY['tags.manage'], NULL,
    NULL, NULL, $q$UPDATE accounts SET auto_label_ai_enabled = NOT auto_label_ai_enabled WHERE id = '{A}'$q$, NULL);

  -- ----- work tables -----
  PERFORM pg_temp.exercise('tickets', 'tickets.work', ARRAY['tickets.work'], ARRAY['tickets.work'], ARRAY['tickets.delete'],
    $q$INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject) VALUES ('{ID}', '{A}', (floor(random() * 1e8) + 1e6)::int, '{C}', 'S')$q$,
    $q$INSERT INTO tickets (account_id, ticket_number, contact_id, subject) VALUES ('{A}', (floor(random() * 1e8) + 1e6)::int, '{C}', 'S')$q$,
    $q$UPDATE tickets SET subject = 'S2' WHERE id = '{ID}'$q$,
    $q$DELETE FROM tickets WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('ticket_comments (own)', 'tickets.work', ARRAY['tickets.work'], ARRAY['tickets.work'], ARRAY['tickets.work'],
    $q$INSERT INTO ticket_comments (id, ticket_id, account_id, body, author_id) VALUES ('{ID}', '{T1}', '{A}', 'c', '{ACTOR}')$q$,
    $q$INSERT INTO ticket_comments (ticket_id, account_id, body, author_id) VALUES ('{T1}', '{A}', 'c', '{ACTOR}')$q$,
    $q$UPDATE ticket_comments SET body = 'c2' WHERE id = '{ID}'$q$,
    $q$DELETE FROM ticket_comments WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('ticket_links', 'tickets.work', ARRAY['tickets.work'], NULL, ARRAY['tickets.work'],
    $q$INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject) VALUES ('{ID}', '{A}', (floor(random() * 1e8) + 1e6)::int, '{C}', 'X'), ('{ID2}', '{A}', (floor(random() * 1e8) + 1e6)::int, '{C}', 'Y');
       INSERT INTO ticket_links (id, account_id, from_ticket_id, to_ticket_id, link_type) VALUES ('{ID3}', '{A}', '{ID}', '{ID2}', 'relates')$q$,
    $q$INSERT INTO ticket_links (account_id, from_ticket_id, to_ticket_id, link_type) VALUES ('{A}', '{ID2}', '{ID}', 'blocks')$q$,
    NULL,
    $q$DELETE FROM ticket_links WHERE id = '{ID3}'$q$);
  PERFORM pg_temp.exercise('ticket_watchers (yourself)', 'tickets.work', ARRAY['tickets.work'], NULL, ARRAY['tickets.work'],
    $q$INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject) VALUES ('{ID}', '{A}', (floor(random() * 1e8) + 1e6)::int, '{C}', 'W'), ('{ID2}', '{A}', (floor(random() * 1e8) + 1e6)::int, '{C}', 'W2');
       INSERT INTO ticket_watchers (ticket_id, user_id, account_id) VALUES ('{ID}', '{ACTOR}', '{A}') ON CONFLICT DO NOTHING$q$,
    $q$INSERT INTO ticket_watchers (ticket_id, user_id, account_id) VALUES ('{ID2}', '{ACTOR}', '{A}')$q$,
    NULL,
    $q$DELETE FROM ticket_watchers WHERE ticket_id = '{ID}' AND user_id = '{ACTOR}'$q$);
  PERFORM pg_temp.exercise('ticket_attachments (own)', 'tickets.work', ARRAY['tickets.work'], NULL, ARRAY['tickets.work'],
    $q$INSERT INTO ticket_attachments (id, ticket_id, account_id, storage_path, url, filename, uploaded_by) VALUES ('{ID}', '{T1}', '{A}', 'account-{A}/{ID}', 'https://x.invalid/a', 'a.txt', '{ACTOR}')$q$,
    $q$INSERT INTO ticket_attachments (ticket_id, account_id, storage_path, url, filename, uploaded_by) VALUES ('{T1}', '{A}', 'account-{A}/{N}', 'https://x.invalid/a', 'a.txt', '{ACTOR}')$q$,
    NULL,
    $q$DELETE FROM ticket_attachments WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('deals', 'deals.manage', ARRAY['deals.manage'], ARRAY['deals.manage'], ARRAY['deals.manage'],
    $q$INSERT INTO deals (id, user_id, pipeline_id, stage_id, title, account_id) VALUES ('{ID}', '{O}', '{P0}', '{S0}', 'D', '{A}')$q$,
    $q$INSERT INTO deals (user_id, pipeline_id, stage_id, title, account_id) VALUES ('{O}', '{P0}', '{S0}', 'Dn', '{A}')$q$,
    $q$UPDATE deals SET title = 'E' WHERE id = '{ID}'$q$,
    $q$DELETE FROM deals WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('contacts', 'contacts.edit', ARRAY['contacts.edit'], ARRAY['contacts.edit'], ARRAY['contacts.edit'],
    $q$INSERT INTO contacts (id, user_id, phone, account_id) VALUES ('{ID}', '{O}', '+1' || (floor(random() * 9e9) + 1e9)::bigint, '{A}')$q$,
    $q$INSERT INTO contacts (user_id, phone, account_id) VALUES ('{O}', '+1' || (floor(random() * 9e9) + 1e9)::bigint, '{A}')$q$,
    $q$UPDATE contacts SET company = 'Acme' WHERE id = '{ID}'$q$,
    $q$DELETE FROM contacts WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('contact_notes (own)', 'contacts.edit', ARRAY['contacts.edit'], ARRAY['contacts.edit'], ARRAY['contacts.edit'],
    $q$INSERT INTO contact_notes (id, contact_id, user_id, note_text, account_id) VALUES ('{ID}', '{C}', '{ACTOR}', 'n', '{A}')$q$,
    $q$INSERT INTO contact_notes (contact_id, user_id, note_text, account_id) VALUES ('{C}', '{ACTOR}', 'n', '{A}')$q$,
    $q$UPDATE contact_notes SET note_text = 'n2' WHERE id = '{ID}'$q$,
    $q$DELETE FROM contact_notes WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('contact_tags', 'contacts.edit', ARRAY['contacts.edit'], ARRAY['contacts.edit'], ARRAY['contacts.edit'],
    $q$INSERT INTO tags (id, user_id, name, account_id, for_contacts, for_conversations) VALUES ('{ID}', '{O}', 'T{ID}', '{A}', true, true), ('{ID2}', '{O}', 'T{ID2}', '{A}', true, true);
       INSERT INTO contact_tags (contact_id, tag_id) VALUES ('{C}', '{ID}')$q$,
    $q$INSERT INTO contact_tags (contact_id, tag_id) VALUES ('{C}', '{ID2}')$q$,
    $q$UPDATE contact_tags SET contact_id = contact_id WHERE tag_id = '{ID}'$q$,
    $q$DELETE FROM contact_tags WHERE tag_id = '{ID}'$q$);
  PERFORM pg_temp.exercise('contact_custom_values', 'contacts.edit', ARRAY['contacts.edit'], ARRAY['contacts.edit'], ARRAY['contacts.edit'],
    $q$INSERT INTO custom_fields (id, user_id, field_name, account_id) VALUES ('{ID}', '{O}', 'f{ID}', '{A}'), ('{ID2}', '{O}', 'f{ID2}', '{A}');
       INSERT INTO contact_custom_values (contact_id, custom_field_id) VALUES ('{C}', '{ID}')$q$,
    $q$INSERT INTO contact_custom_values (contact_id, custom_field_id) VALUES ('{C}', '{ID2}')$q$,
    $q$UPDATE contact_custom_values SET contact_id = contact_id WHERE custom_field_id = '{ID}'$q$,
    $q$DELETE FROM contact_custom_values WHERE custom_field_id = '{ID}'$q$);
  PERFORM pg_temp.exercise('broadcasts', 'broadcasts.send', ARRAY['broadcasts.send'], ARRAY['broadcasts.send'], ARRAY['broadcasts.send'],
    $q$INSERT INTO broadcasts (id, user_id, name, template_name, account_id) VALUES ('{ID}', '{O}', 'B', 't', '{A}')$q$,
    $q$INSERT INTO broadcasts (user_id, name, template_name, account_id) VALUES ('{O}', 'Bn', 't', '{A}')$q$,
    $q$UPDATE broadcasts SET name = 'B2' WHERE id = '{ID}'$q$,
    $q$DELETE FROM broadcasts WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('broadcast_recipients', 'broadcasts.send', ARRAY['broadcasts.send'], ARRAY['broadcasts.send'], ARRAY['broadcasts.send'],
    $q$INSERT INTO broadcast_recipients (id, broadcast_id) VALUES ('{ID}', '{BC}')$q$,
    $q$INSERT INTO broadcast_recipients (broadcast_id) VALUES ('{BC}')$q$,
    $q$UPDATE broadcast_recipients SET error_message = 'x' WHERE id = '{ID}'$q$,
    $q$DELETE FROM broadcast_recipients WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('ai_knowledge_citations', 'ai.use', ARRAY['ai.use'], NULL, NULL,
    NULL,
    $q$INSERT INTO ai_knowledge_citations (account_id, document_id, mode) VALUES ('{A}', '{ART}', 'draft')$q$,
    NULL, NULL);

  -- ----- hot paths -----
  PERFORM pg_temp.exercise('conversations (activity columns)', 'conversations.manage', ARRAY['conversations.manage', 'messages.send'], ARRAY['conversations.manage', 'messages.send'], ARRAY['conversations.manage'],
    $q$INSERT INTO contacts (id, user_id, account_id, phone) VALUES ('{ID}', '{O}', '{A}', '+1' || (floor(random() * 9e9) + 1e9)::bigint), ('{ID2}', '{O}', '{A}', '+1' || (floor(random() * 9e9) + 1e9)::bigint);
       INSERT INTO conversations (id, user_id, contact_id, account_id) VALUES ('{ID3}', '{O}', '{ID}', '{A}')$q$,
    $q$INSERT INTO conversations (user_id, contact_id, account_id) VALUES ('{O}', '{ID2}', '{A}')$q$,
    $q$UPDATE conversations SET unread_count = 3, last_message_text = 'hi', awaiting_response = false WHERE id = '{ID3}'$q$,
    $q$DELETE FROM conversations WHERE id = '{ID3}'$q$);
  PERFORM pg_temp.exercise('conversations (assign, close, priority)', 'conversations.manage', NULL, ARRAY['conversations.manage'], NULL,
    $q$INSERT INTO contacts (id, user_id, account_id, phone) VALUES ('{ID}', '{O}', '{A}', '+1' || (floor(random() * 9e9) + 1e9)::bigint);
       INSERT INTO conversations (id, user_id, contact_id, account_id) VALUES ('{ID3}', '{O}', '{ID}', '{A}')$q$,
    NULL,
    $q$UPDATE conversations SET priority = 'high', status = 'closed', assigned_agent_id = '{O}' WHERE id = '{ID3}'$q$,
    NULL);
  PERFORM pg_temp.exercise('conversation_labels', 'conversations.manage', ARRAY['conversations.manage'], ARRAY['conversations.manage'], ARRAY['conversations.manage'],
    $q$INSERT INTO tags (id, user_id, name, account_id, for_contacts, for_conversations) VALUES ('{ID}', '{O}', 'T{ID}', '{A}', true, true), ('{ID2}', '{O}', 'T{ID2}', '{A}', true, true);
       INSERT INTO conversation_labels (conversation_id, tag_id) VALUES ('{V}', '{ID}')$q$,
    $q$INSERT INTO conversation_labels (conversation_id, tag_id) VALUES ('{V}', '{ID2}')$q$,
    $q$UPDATE conversation_labels SET conversation_id = conversation_id WHERE tag_id = '{ID}'$q$,
    $q$DELETE FROM conversation_labels WHERE tag_id = '{ID}'$q$);
  PERFORM pg_temp.exercise('messages (replies)', 'messages.send', ARRAY['messages.send'], ARRAY['messages.send'], ARRAY['messages.send'],
    $q$INSERT INTO messages (id, conversation_id, sender_type, content_text) VALUES ('{ID}', '{V}', 'agent', 'r')$q$,
    $q$INSERT INTO messages (conversation_id, sender_type, content_text) VALUES ('{V}', 'agent', 'r')$q$,
    $q$UPDATE messages SET content_text = 'r2' WHERE id = '{ID}'$q$,
    $q$DELETE FROM messages WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('messages (internal notes)', 'conversations.manage', ARRAY['conversations.manage'], ARRAY['conversations.manage'], ARRAY['conversations.manage'],
    $q$INSERT INTO messages (id, conversation_id, sender_type, content_text, is_internal) VALUES ('{ID}', '{V}', 'agent', 'note', true)$q$,
    $q$INSERT INTO messages (conversation_id, sender_type, content_text, is_internal) VALUES ('{V}', 'agent', 'note', true)$q$,
    $q$UPDATE messages SET content_text = 'note 2' WHERE id = '{ID}'$q$,
    $q$DELETE FROM messages WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('message_reactions', 'messages.send', ARRAY['messages.send'], ARRAY['messages.send'], ARRAY['messages.send'],
    $q$INSERT INTO messages (id, conversation_id, sender_type, content_text) VALUES ('{ID}', '{V}', 'agent', 'm1'), ('{ID2}', '{V}', 'agent', 'm2');
       INSERT INTO message_reactions (id, message_id, conversation_id, actor_type, actor_id, emoji) VALUES ('{ID3}', '{ID}', '{V}', 'agent', '{ACTOR}', 'A')$q$,
    $q$INSERT INTO message_reactions (message_id, conversation_id, actor_type, actor_id, emoji) VALUES ('{ID2}', '{V}', 'agent', '{ACTOR}', 'B')$q$,
    $q$UPDATE message_reactions SET emoji = 'C' WHERE id = '{ID3}'$q$,
    $q$DELETE FROM message_reactions WHERE id = '{ID3}'$q$);
  PERFORM pg_temp.exercise('comments (moderate)', 'comments.moderate', NULL, ARRAY['comments.moderate'], NULL,
    $q$INSERT INTO comments (id, account_id, post_id, provider, external_comment_id) VALUES ('{ID}', '{A}', '{CPOST}', 'facebook', 'x{ID}')$q$,
    NULL,
    $q$UPDATE comments SET handled_status = 'resolved' WHERE id = '{ID}'$q$,
    NULL);

  -- ----- tables that already used has_capability (sanity) -----
  PERFORM pg_temp.exercise('tags', 'tags.manage', ARRAY['tags.manage'], ARRAY['tags.manage'], ARRAY['tags.manage'],
    $q$INSERT INTO tags (id, user_id, name, account_id) VALUES ('{ID}', '{O}', 'T{ID}', '{A}')$q$,
    $q$INSERT INTO tags (user_id, name, account_id) VALUES ('{O}', 'T{N}', '{A}')$q$,
    $q$UPDATE tags SET description = 'd' WHERE id = '{ID}'$q$,
    $q$SOFT:tags:DELETE FROM tags WHERE id = '{ID}'$q$);
  PERFORM pg_temp.exercise('quick_replies', 'snippets.manage', ARRAY['snippets.manage'], ARRAY['snippets.manage'], ARRAY['snippets.manage'],
    $q$INSERT INTO quick_replies (id, account_id, user_id, title, content_text) VALUES ('{ID}', '{A}', '{O}', 'Q{ID}', 'x')$q$,
    $q$INSERT INTO quick_replies (account_id, user_id, title, content_text) VALUES ('{A}', '{O}', 'Q{N}', 'x')$q$,
    $q$UPDATE quick_replies SET content_text = 'y' WHERE id = '{ID}'$q$,
    $q$SOFT:quick_replies:DELETE FROM quick_replies WHERE id = '{ID}'$q$);

  SELECT c.n INTO cnt FROM counters c WHERE c.k = 'cases';
  n := n + 1;

  -- ---------------------------------------------------------
  -- 4. Special rules
  -- ---------------------------------------------------------
  -- 4a. Own-row rules that stay
  -- contact notes: your own; other people's stay with admins
  INSERT INTO contact_notes (id, contact_id, user_id, note_text, account_id)
  VALUES ('00000000-0000-0000-0000-0000000088a1', (SELECT v::uuid FROM ctx WHERE k = 'C'), admin_a, 'admin note', a),
         ('00000000-0000-0000-0000-0000000088a2', (SELECT v::uuid FROM ctx WHERE k = 'C'), agent_a, 'agent note', a);
  IF pg_temp.dml(agent_a, $q$UPDATE contact_notes SET note_text = 'x' WHERE id = '00000000-0000-0000-0000-0000000088a1'$q$) <> 'ROWS 0'
  OR pg_temp.dml(agent_a, $q$DELETE FROM contact_notes WHERE id = '00000000-0000-0000-0000-0000000088a1'$q$) <> 'ROWS 0' THEN
    RAISE EXCEPTION 'FAIL an agent changed an admin note';
  END IF;
  IF pg_temp.dml(admin_a, $q$UPDATE contact_notes SET note_text = 'moderated' WHERE id = '00000000-0000-0000-0000-0000000088a2'$q$) <> 'ROWS 1' THEN
    RAISE EXCEPTION 'FAIL an admin must still moderate another person note';
  END IF;
  -- ... but only while the admin still holds contacts.edit
  INSERT INTO role_capabilities (account_id, role, capability, granted) VALUES (a, 'admin', 'contacts.edit', false);
  IF pg_temp.dml(admin_a, $q$UPDATE contact_notes SET note_text = 'again' WHERE id = '00000000-0000-0000-0000-0000000088a2'$q$) <> 'ROWS 0' THEN
    RAISE EXCEPTION 'FAIL an admin without contacts.edit must not moderate notes';
  END IF;
  DELETE FROM role_capabilities WHERE account_id = a;

  -- ticket attachments: someone else can be removed by an admin only
  INSERT INTO ticket_attachments (id, ticket_id, account_id, storage_path, url, filename, uploaded_by)
  VALUES ('00000000-0000-0000-0000-0000000088b1', (SELECT v::uuid FROM ctx WHERE k = 'T1'), a, 'account-' || a || '/b1', 'https://x.invalid/b1', 'b1.txt', admin_a),
         ('00000000-0000-0000-0000-0000000088b2', (SELECT v::uuid FROM ctx WHERE k = 'T1'), a, 'account-' || a || '/b2', 'https://x.invalid/b2', 'b2.txt', agent_a);
  IF pg_temp.dml(agent_a, $q$DELETE FROM ticket_attachments WHERE id = '00000000-0000-0000-0000-0000000088b1'$q$) <> 'ROWS 0' THEN
    RAISE EXCEPTION 'FAIL an agent removed an admin attachment';
  END IF;
  IF pg_temp.dml(admin_a, $q$DELETE FROM ticket_attachments WHERE id = '00000000-0000-0000-0000-0000000088b2'$q$) <> 'ROWS 1' THEN
    RAISE EXCEPTION 'FAIL an admin must still remove an agent attachment';
  END IF;

  -- ticket comments: the author only; watchers: yourself only
  INSERT INTO ticket_comments (id, ticket_id, account_id, body, author_id)
  VALUES ('00000000-0000-0000-0000-0000000088c1', (SELECT v::uuid FROM ctx WHERE k = 'T1'), a, 'by agent', agent_a);
  IF pg_temp.dml(admin_a, $q$UPDATE ticket_comments SET body = 'edited by admin' WHERE id = '00000000-0000-0000-0000-0000000088c1'$q$) <> 'ROWS 0'
  OR pg_temp.dml(owner_a, $q$DELETE FROM ticket_comments WHERE id = '00000000-0000-0000-0000-0000000088c1'$q$) <> 'ROWS 0' THEN
    RAISE EXCEPTION 'FAIL only the author may edit or remove a ticket comment';
  END IF;
  res := pg_temp.dml(agent_a, format(
    $q$INSERT INTO ticket_watchers (ticket_id, user_id, account_id) VALUES (%L, %L, %L)$q$,
    (SELECT v FROM ctx WHERE k = 'T2'), agent2_a, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent added someone else as a watcher: %', res; END IF;

  -- inbox views: not for someone else, not shared without inbox.shared-views
  res := pg_temp.dml(agent_a, format(
    $q$INSERT INTO inbox_views (account_id, name, owner_id) VALUES (%L, 'for someone else', %L)$q$, a, agent2_a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a view for someone else: %', res; END IF;
  res := pg_temp.dml(agent_a, format(
    $q$INSERT INTO inbox_views (account_id, name, owner_id) VALUES (%L, 'shared by agent', NULL)$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent created a shared view: %', res; END IF;
  INSERT INTO inbox_views (id, account_id, name, owner_id)
  VALUES ('00000000-0000-0000-0000-0000000088d1', a, 'agent2 personal', agent2_a);
  IF pg_temp.dml(agent_a, $q$UPDATE inbox_views SET name = 'stolen' WHERE id = '00000000-0000-0000-0000-0000000088d1'$q$) <> 'ROWS 0'
  OR pg_temp.dml(agent_a, $q$DELETE FROM inbox_views WHERE id = '00000000-0000-0000-0000-0000000088d1'$q$) <> 'ROWS 0' THEN
    RAISE EXCEPTION 'FAIL an agent changed someone else personal view';
  END IF;
  IF pg_temp.dml(agent2_a, $q$UPDATE inbox_views SET name = 'renamed' WHERE id = '00000000-0000-0000-0000-0000000088d1'$q$) <> 'ROWS 1' THEN
    RAISE EXCEPTION 'FAIL the owner must be able to rename their own view';
  END IF;
  n := n + 1;

  -- 4b. conversations: a sender may bump the activity columns, nothing else
  INSERT INTO role_capabilities (account_id, role, capability, granted) VALUES (a, 'agent', 'conversations.manage', false);
  IF pg_temp.dml(agent_a, format($q$UPDATE conversations SET last_message_text = 'sent', unread_count = 0, awaiting_response = false WHERE id = %L$q$,
       (SELECT v FROM ctx WHERE k = 'V'))) <> 'ROWS 1' THEN
    RAISE EXCEPTION 'FAIL a sender (messages.send only) must be able to bump the last-message fields';
  END IF;
  FOREACH cap IN ARRAY ARRAY['priority = ''high''', 'status = ''closed''', format('assigned_agent_id = %L', agent_a),
                             'ai_autoreply_disabled = true', format('assigned_team_id = %L', (SELECT v FROM ctx WHERE k = 'TEAM0'))] LOOP
    res := pg_temp.dml(agent_a, format('UPDATE conversations SET %s WHERE id = %L', cap, (SELECT v FROM ctx WHERE k = 'V')));
    IF res NOT LIKE 'ERR 42501%' THEN
      RAISE EXCEPTION 'FAIL a sender without conversations.manage changed % : %', cap, res;
    END IF;
  END LOOP;
  -- mixing an activity column with a protected one is still refused
  res := pg_temp.dml(agent_a, format($q$UPDATE conversations SET last_message_text = 'x', priority = 'high' WHERE id = %L$q$, (SELECT v FROM ctx WHERE k = 'V')));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL mixed update by a sender: %', res; END IF;
  res := pg_temp.run(agent_a, format($q$SELECT close_conversation_with_note(%L, 'done')::text$q$, (SELECT v FROM ctx WHERE k = 'V')));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL close_conversation_with_note without conversations.manage: %', res; END IF;
  res := pg_temp.run(agent_a, format($q$SELECT reopen_conversation(%L)::text$q$, (SELECT v FROM ctx WHERE k = 'V')));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL reopen_conversation without conversations.manage: %', res; END IF;
  DELETE FROM role_capabilities WHERE account_id = a;
  -- ... and the reverse: manage without send may assign but not send
  INSERT INTO role_capabilities (account_id, role, capability, granted) VALUES (a, 'agent', 'messages.send', false);
  IF pg_temp.dml(agent_a, format($q$UPDATE conversations SET priority = 'high' WHERE id = %L$q$, (SELECT v FROM ctx WHERE k = 'V'))) <> 'ROWS 1' THEN
    RAISE EXCEPTION 'FAIL conversations.manage without messages.send must still be able to assign / prioritise';
  END IF;
  res := pg_temp.dml(agent_a, format($q$INSERT INTO messages (conversation_id, sender_type, content_text) VALUES (%L, 'agent', 'nope')$q$, (SELECT v FROM ctx WHERE k = 'V')));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a reply without messages.send: %', res; END IF;
  res := pg_temp.dml(agent_a, format($q$INSERT INTO messages (conversation_id, sender_type, content_text, is_internal) VALUES (%L, 'agent', 'note', true)$q$, (SELECT v FROM ctx WHERE k = 'V')));
  IF res <> 'ROWS 1' THEN RAISE EXCEPTION 'FAIL an internal note needs conversations.manage only: %', res; END IF;
  DELETE FROM role_capabilities WHERE account_id = a;
  -- close and reopen work for an agent by default, refused for a viewer and another account
  res := pg_temp.run(agent_a, format($q$SELECT close_conversation_with_note(%L, 'done')::text$q$, (SELECT v FROM ctx WHERE k = 'V')));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL agent closes a conversation: %', res; END IF;
  res := pg_temp.run(viewer_a, format($q$SELECT reopen_conversation(%L)::text$q$, (SELECT v FROM ctx WHERE k = 'V')));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL viewer reopens a conversation: %', res; END IF;
  res := pg_temp.run(agent_a, format($q$SELECT reopen_conversation(%L, 'again')::text$q$, (SELECT v FROM ctx WHERE k = 'V')));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL agent reopens a conversation: %', res; END IF;
  res := pg_temp.run(owner_b, format($q$SELECT reopen_conversation(%L)::text$q$, (SELECT v FROM ctx WHERE k = 'V')));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL another account reopens a conversation: %', res; END IF;
  n := n + 1;

  -- 4c. comments: moderate is not delete
  INSERT INTO comments (id, account_id, post_id, provider, external_comment_id)
  VALUES ('00000000-0000-0000-0000-0000000088e1', a, (SELECT v::uuid FROM ctx WHERE k = 'CPOST'), 'facebook', 'e1');
  IF pg_temp.dml(agent_a, $q$UPDATE comments SET status = 'hidden' WHERE id = '00000000-0000-0000-0000-0000000088e1'$q$) <> 'ROWS 1' THEN
    RAISE EXCEPTION 'FAIL an agent must be able to hide a comment';
  END IF;
  res := pg_temp.dml(agent_a, $q$UPDATE comments SET status = 'deleted' WHERE id = '00000000-0000-0000-0000-0000000088e1'$q$);
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent marked a comment deleted: %', res; END IF;
  IF pg_temp.dml(admin_a, $q$UPDATE comments SET status = 'deleted' WHERE id = '00000000-0000-0000-0000-0000000088e1'$q$) <> 'ROWS 1' THEN
    RAISE EXCEPTION 'FAIL an admin marks a comment deleted';
  END IF;
  INSERT INTO comments (id, account_id, post_id, provider, external_comment_id)
  VALUES ('00000000-0000-0000-0000-0000000088e2', a, (SELECT v::uuid FROM ctx WHERE k = 'CPOST'), 'facebook', 'e2');
  INSERT INTO role_capabilities (account_id, role, capability, granted) VALUES (a, 'agent', 'comments.delete', true);
  IF pg_temp.dml(agent_a, $q$UPDATE comments SET status = 'deleted' WHERE id = '00000000-0000-0000-0000-0000000088e2'$q$) <> 'ROWS 1' THEN
    RAISE EXCEPTION 'FAIL an agent granted comments.delete marks a comment deleted';
  END IF;
  DELETE FROM role_capabilities WHERE account_id = a;
  n := n + 1;

  -- 4d. invitations: listing needs members.invite; the role stays below the inviter's
  INSERT INTO account_invitations (id, account_id, token_hash, role, expires_at)
  VALUES ('00000000-0000-0000-0000-0000000088f1', a, 'listed-088', 'viewer', now() + interval '1 day');
  IF pg_temp.run(agent_a, $q$SELECT count(*)::text FROM account_invitations WHERE token_hash = 'listed-088'$q$) <> '0'
  OR pg_temp.run(viewer_a, $q$SELECT count(*)::text FROM account_invitations WHERE token_hash = 'listed-088'$q$) <> '0'
  OR pg_temp.run(admin_a, $q$SELECT count(*)::text FROM account_invitations WHERE token_hash = 'listed-088'$q$) <> '1'
  OR pg_temp.run(owner_b, $q$SELECT count(*)::text FROM account_invitations WHERE token_hash = 'listed-088'$q$) <> '0' THEN
    RAISE EXCEPTION 'FAIL who can list invitations';
  END IF;
  INSERT INTO role_capabilities (account_id, role, capability, granted) VALUES (a, 'agent', 'members.invite', true);
  IF pg_temp.run(agent_a, $q$SELECT count(*)::text FROM account_invitations WHERE token_hash = 'listed-088'$q$) <> '1' THEN
    RAISE EXCEPTION 'FAIL an agent granted members.invite lists invitations';
  END IF;
  res := pg_temp.dml(agent_a, format(
    $q$INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES (%L, 'a1-088', 'viewer', now() + interval '1 day')$q$, a));
  IF res <> 'ROWS 1' THEN RAISE EXCEPTION 'FAIL an agent granted members.invite invites a viewer: %', res; END IF;
  res := pg_temp.dml(agent_a, format(
    $q$INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES (%L, 'a2-088', 'agent', now() + interval '1 day')$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent invited an agent (only below the inviter): %', res; END IF;
  DELETE FROM role_capabilities WHERE account_id = a;
  res := pg_temp.dml(admin_a, format(
    $q$INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES (%L, 'a3-088', 'admin', now() + interval '1 day')$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an admin invited an admin: %', res; END IF;
  n := n + 1;

  -- 4e. next_ticket_number needs tickets.work
  res := pg_temp.run(viewer_a, format($q$SELECT next_ticket_number(%L)::text$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL viewer next_ticket_number: %', res; END IF;
  res := pg_temp.run(owner_b, format($q$SELECT next_ticket_number(%L)::text$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL another account next_ticket_number: %', res; END IF;
  res := pg_temp.run(agent_a, format($q$SELECT next_ticket_number(%L)::text$q$, a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL agent next_ticket_number: %', res; END IF;
  INSERT INTO role_capabilities (account_id, role, capability, granted) VALUES (a, 'agent', 'tickets.work', false);
  res := pg_temp.run(agent_a, format($q$SELECT next_ticket_number(%L)::text$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL agent without tickets.work next_ticket_number: %', res; END IF;
  DELETE FROM role_capabilities WHERE account_id = a;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 5. pending_edit is hidden from other members
  -- ---------------------------------------------------------
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name IN ('tags', 'quick_replies') AND column_name = 'pending_edit') THEN
    RAISE EXCEPTION 'FAIL pending_edit must no longer be a column of tags / quick_replies';
  END IF;
  IF pg_temp.run(agent2_a, $q$SELECT pending_edit::text FROM tags LIMIT 1$q$) NOT LIKE 'ERR 42703%' THEN
    RAISE EXCEPTION 'FAIL reading pending_edit from tags must fail';
  END IF;
  badge := pg_temp.run(admin_a, 'SELECT approvals_pending_count()::text')::int;  -- other drafts already count
  tag1 := gen_random_uuid();
  snip1 := gen_random_uuid();
  INSERT INTO tags (id, user_id, name, account_id, for_contacts, for_conversations, color)
  VALUES (tag1, owner_a, 'Live tag 088', a, true, true, '#112233');
  INSERT INTO quick_replies (id, account_id, user_id, title, content_text)
  VALUES (snip1, a, owner_a, 'Live snippet 088', 'Original text');
  -- an Agent proposes a snippet edit only without snippets.manage (with it, the edit goes live)
  INSERT INTO role_capabilities (account_id, role, capability, granted) VALUES (a, 'agent', 'snippets.manage', false);
  res := pg_temp.run(agent_a, format($q$SELECT propose_tag_edit(%L, '{"description": "SECRET-PROPOSAL-088"}'::jsonb)::text$q$, tag1));
  IF res LIKE 'ERR%' OR (res::jsonb) ->> 'mode' <> 'proposed' THEN RAISE EXCEPTION 'FAIL propose_tag_edit: %', res; END IF;
  res := pg_temp.run(agent_a, format($q$SELECT propose_snippet_edit(%L, '{"content_text": "SECRET-SNIPPET-088"}'::jsonb)::text$q$, snip1));
  IF res LIKE 'ERR%' OR (res::jsonb) ->> 'mode' <> 'proposed' THEN RAISE EXCEPTION 'FAIL propose_snippet_edit: %', res; END IF;
  -- the live rows carry no proposed value anywhere
  IF pg_temp.run(agent2_a, format($q$SELECT to_jsonb(t)::text FROM tags t WHERE id = %L$q$, tag1)) LIKE '%SECRET-PROPOSAL-088%'
  OR pg_temp.run(agent2_a, format($q$SELECT to_jsonb(q)::text FROM quick_replies q WHERE id = %L$q$, snip1)) LIKE '%SECRET-SNIPPET-088%'
  OR pg_temp.run(viewer_a, format($q$SELECT to_jsonb(t)::text FROM tags t WHERE id = %L$q$, tag1)) LIKE '%SECRET-PROPOSAL-088%' THEN
    RAISE EXCEPTION 'FAIL a proposed value leaked through the live row';
  END IF;
  IF (SELECT edit_status FROM tags WHERE id = tag1) <> 'pending'
  OR (SELECT edit_status FROM quick_replies WHERE id = snip1) <> 'pending' THEN
    RAISE EXCEPTION 'FAIL edit_status must still say pending';
  END IF;
  -- the side table: proposer and reviewers only
  IF pg_temp.run(agent_a,  format($q$SELECT count(*)::text FROM approval_pending_edits WHERE entity_id IN (%L, %L)$q$, tag1, snip1)) <> '2'
  OR pg_temp.run(admin_a,  format($q$SELECT count(*)::text FROM approval_pending_edits WHERE entity_id IN (%L, %L)$q$, tag1, snip1)) <> '2'
  OR pg_temp.run(owner_a,  format($q$SELECT count(*)::text FROM approval_pending_edits WHERE entity_id IN (%L, %L)$q$, tag1, snip1)) <> '2'
  OR pg_temp.run(agent2_a, format($q$SELECT count(*)::text FROM approval_pending_edits WHERE entity_id IN (%L, %L)$q$, tag1, snip1)) <> '0'
  OR pg_temp.run(viewer_a, format($q$SELECT count(*)::text FROM approval_pending_edits WHERE entity_id IN (%L, %L)$q$, tag1, snip1)) <> '0'
  OR pg_temp.run(owner_b,  format($q$SELECT count(*)::text FROM approval_pending_edits WHERE entity_id IN (%L, %L)$q$, tag1, snip1)) <> '0' THEN
    RAISE EXCEPTION 'FAIL approval_pending_edits visibility';
  END IF;
  -- a reviewer by grant sees it, and stops seeing it once the capability is gone
  INSERT INTO role_capabilities (account_id, role, capability, granted) VALUES (a, 'agent', 'approvals.review', true);
  IF pg_temp.run(agent2_a, format($q$SELECT count(*)::text FROM approval_pending_edits WHERE entity_id = %L$q$, tag1)) <> '1' THEN
    RAISE EXCEPTION 'FAIL a reviewer by grant must see pending edits';
  END IF;
  DELETE FROM role_capabilities WHERE account_id = a;
  IF pg_temp.run(agent2_a, format($q$SELECT count(*)::text FROM approval_pending_edits WHERE entity_id = %L$q$, tag1)) <> '0' THEN
    RAISE EXCEPTION 'FAIL pending edits must be hidden again once the review capability is gone';
  END IF;
  -- nobody writes the side table directly
  res := pg_temp.dml(agent_a, format($q$INSERT INTO approval_pending_edits (entity_type, entity_id, account_id, patch) VALUES ('tag', %L, %L, '{}'::jsonb)$q$, gen_random_uuid(), a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL direct insert into approval_pending_edits: %', res; END IF;
  res := pg_temp.dml(admin_a, format($q$UPDATE approval_pending_edits SET patch = '{}'::jsonb WHERE entity_id = %L$q$, tag1));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL direct update of approval_pending_edits: %', res; END IF;
  res := pg_temp.dml(admin_a, format($q$DELETE FROM approval_pending_edits WHERE entity_id = %L$q$, tag1));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL direct delete of approval_pending_edits: %', res; END IF;
  IF pg_temp.run(agent_a, format($q$SELECT approvals_pending_patch('tag', %L)::text$q$, tag1)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL approvals_pending_patch must not be callable by a member';
  END IF;
  -- the queue still shows Current vs Proposed to a reviewer
  res := pg_temp.run(admin_a, $q$SELECT (SELECT count(*) FROM jsonb_array_elements(approvals_list('pending')) e WHERE e ->> 'title' IN ('Live tag 088', 'Live snippet 088'))::text$q$);
  IF res <> '2' THEN RAISE EXCEPTION 'FAIL approvals_list must list both edits: %', res; END IF;
  res := pg_temp.run(admin_a, $q$SELECT string_agg(e -> 'proposed' ->> 'description', ',') FROM jsonb_array_elements(approvals_list('pending')) e WHERE e ->> 'title' = 'Live tag 088'$q$);
  IF res <> 'SECRET-PROPOSAL-088' THEN RAISE EXCEPTION 'FAIL approvals_list proposed value: %', res; END IF;
  IF pg_temp.run(admin_a, 'SELECT approvals_pending_count()::text')::int <> badge + 2 THEN RAISE EXCEPTION 'FAIL badge count'; END IF;
  -- approve the tag edit: the live row changes, the side row goes
  res := pg_temp.run(admin_a, format($q$SELECT decide_proposal('tag', %L, 'approve')::text$q$, tag1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL approve edit: %', res; END IF;
  IF (SELECT description FROM tags WHERE id = tag1) <> 'SECRET-PROPOSAL-088'
  OR (SELECT edit_status FROM tags WHERE id = tag1) IS NOT NULL
  OR EXISTS (SELECT 1 FROM approval_pending_edits WHERE entity_id = tag1) THEN
    RAISE EXCEPTION 'FAIL approved edit must land on the live row and clear the side row';
  END IF;
  -- reject the snippet edit: live row unchanged, patch kept for the proposer, then withdrawn
  res := pg_temp.run(admin_a, format($q$SELECT decide_proposal('snippet', %L, 'reject', 'Not now')::text$q$, snip1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL reject edit: %', res; END IF;
  IF (SELECT content_text FROM quick_replies WHERE id = snip1) <> 'Original text'
  OR (SELECT edit_status FROM quick_replies WHERE id = snip1) <> 'rejected'
  OR pg_temp.run(agent_a, format($q$SELECT patch ->> 'content_text' FROM approval_pending_edits WHERE entity_id = %L$q$, snip1)) <> 'SECRET-SNIPPET-088' THEN
    RAISE EXCEPTION 'FAIL rejected edit state';
  END IF;
  res := pg_temp.run(agent_a, format($q$SELECT withdraw_proposal('snippet', %L)::text$q$, snip1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL withdraw rejected edit: %', res; END IF;
  IF (SELECT edit_status FROM quick_replies WHERE id = snip1) IS NOT NULL
  OR EXISTS (SELECT 1 FROM approval_pending_edits WHERE entity_id = snip1) THEN
    RAISE EXCEPTION 'FAIL withdrawing must clear the side row';
  END IF;
  IF pg_temp.run(admin_a, 'SELECT approvals_pending_count()::text')::int <> badge THEN RAISE EXCEPTION 'FAIL badge after decisions'; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 6. Policy parity: a database-tier switch can never silently do nothing
  -- ---------------------------------------------------------
  FOR rec IN SELECT capability FROM capability_catalogue WHERE enforced_by = 'database' ORDER BY capability LOOP
    IF NOT EXISTS (
         SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public'
            AND (COALESCE(p.qual, '') LIKE '%''' || rec.capability || '''%'
              OR COALESCE(p.with_check, '') LIKE '%''' || rec.capability || '''%'))
       AND NOT EXISTS (
         SELECT 1 FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace
          WHERE ns.nspname = 'public'
            AND pr.proname NOT IN ('has_capability', 'effective_capability', 'capabilities_for_current_user', 'capability_account_ids')
            AND pr.prosrc LIKE '%''' || rec.capability || '''%') THEN
      RAISE EXCEPTION 'FAIL policy parity: % is marked database but no policy or function references it', rec.capability;
    END IF;
  END LOOP;
  -- and every capability literal used in a policy or function exists in the catalogue (typos)
  FOR rec IN
    SELECT DISTINCT m[1] AS lit FROM (
      SELECT regexp_matches(COALESCE(p.qual, '') || ' ' || COALESCE(p.with_check, ''),
             '(?:capability_account_ids|has_capability)\((?:[^,()]+,\s*)?''([^'']+)''', 'g') AS m
        FROM pg_policies p WHERE p.schemaname = 'public'
      UNION ALL
      SELECT regexp_matches(pr.prosrc,
             '(?:capability_account_ids|has_capability|effective_capability)\((?:[^,()]+,\s*)*''([a-z][a-z0-9.-]*)''', 'g')
        FROM pg_proc pr JOIN pg_namespace ns ON ns.oid = pr.pronamespace WHERE ns.nspname = 'public'
    ) x
  LOOP
    IF NOT EXISTS (SELECT 1 FROM capability_catalogue WHERE capability = rec.lit) THEN
      RAISE EXCEPTION 'FAIL a policy or function checks an unknown capability: %', rec.lit;
    END IF;
  END LOOP;
  -- No write policy may still test a role floor, except the documented allow-list
  -- (docs/access-control-enforcement.md, "Left on a role floor on purpose").
  FOR rec IN
    SELECT p.tablename, p.policyname FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       AND (COALESCE(p.qual, '') ~ 'is_account_member\([^)]*''(agent|admin|owner)'''
         OR COALESCE(p.with_check, '') ~ 'is_account_member\([^)]*''(agent|admin|owner)''')
  LOOP
    IF (rec.tablename, rec.policyname) NOT IN (
         ('contact_notes', 'contact_notes_update'),
         ('contact_notes', 'contact_notes_delete'),
         ('ticket_attachments', 'ticket_attachments_delete')) THEN
      RAISE EXCEPTION 'FAIL write policy %.% still tests a role floor and is not on the allow-list', rec.tablename, rec.policyname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
       AND (tablename, policyname) IN (('contact_notes', 'contact_notes_update'), ('contact_notes', 'contact_notes_delete'),
                                       ('ticket_attachments', 'ticket_attachments_delete'))) <> 3 THEN
    RAISE EXCEPTION 'FAIL the allow-list names a policy that no longer exists';
  END IF;
  -- policies that gate an admin-only READ (token hashes) also use the capability
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND cmd = 'SELECT'
              AND COALESCE(qual, '') ~ 'is_account_member\([^)]*''(agent|admin|owner)''') THEN
    RAISE EXCEPTION 'FAIL a SELECT policy still tests a role floor: %',
      (SELECT string_agg(tablename || '.' || policyname, ', ') FROM pg_policies
        WHERE schemaname = 'public' AND cmd = 'SELECT' AND COALESCE(qual, '') ~ 'is_account_member\([^)]*''(agent|admin|owner)''');
  END IF;
  -- 086 (ticket SLA) and 087 (Jira depth) tables, when they exist
  IF to_regclass('public.ticket_sla_policies') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ticket_sla_policies' AND cmd = 'INSERT'
                    AND COALESCE(with_check, '') LIKE '%''sla.configure''%') THEN
      RAISE EXCEPTION 'FAIL ticket_sla_policies write policy must use sla.configure';
    END IF;
  END IF;
  FOR rec IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
              WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'jira\_%' LOOP
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = rec.relname
                AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')) THEN
      RAISE EXCEPTION 'FAIL a Jira table has a client write policy: %', rec.relname;
    END IF;
  END LOOP;
  IF to_regclass('public.jira_connection_secrets') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'jira_connection_secrets') THEN
    RAISE EXCEPTION 'FAIL jira_connection_secrets must have no client policy at all';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 7. Owner lockout safety
  -- ---------------------------------------------------------
  INSERT INTO role_capabilities (account_id, role, capability, granted)
  SELECT a, v.r, c.capability, false
    FROM capability_catalogue c CROSS JOIN (VALUES ('admin'::account_role_enum), ('agent'), ('viewer')) AS v(r);
  FOR rec IN SELECT capability FROM capability_catalogue LOOP
    IF pg_temp.run(owner_a, format($q$SELECT has_capability(%L, %L)::text$q$, a, rec.capability)) <> 'true' THEN
      RAISE EXCEPTION 'FAIL the Owner lost % after every other role was stripped', rec.capability;
    END IF;
    FOREACH role_k IN ARRAY ARRAY['admin', 'agent', 'viewer'] LOOP
      IF pg_temp.run(CASE role_k WHEN 'admin' THEN admin_a WHEN 'agent' THEN agent_a ELSE viewer_a END,
                     format($q$SELECT has_capability(%L, %L)::text$q$, a, rec.capability)) <> 'false' THEN
        RAISE EXCEPTION 'FAIL % still holds % after being stripped', role_k, rec.capability;
      END IF;
    END LOOP;
  END LOOP;
  -- the Owner can still do the real work
  IF pg_temp.dml(owner_a, format($q$INSERT INTO pipelines (user_id, name, account_id) VALUES (%L, 'Owner still works', %L)$q$, owner_a, a)) <> 'ROWS 1'
  OR pg_temp.dml(owner_a, format($q$UPDATE contacts SET company = 'Owner' WHERE id = %L$q$, (SELECT v FROM ctx WHERE k = 'C'))) <> 'ROWS 1'
  OR pg_temp.dml(owner_a, format($q$INSERT INTO teams (account_id, name) VALUES (%L, 'Owner team')$q$, a)) <> 'ROWS 1'
  OR pg_temp.dml(owner_a, format($q$UPDATE accounts SET name = name WHERE id = %L$q$, a)) <> 'ROWS 1'
  OR pg_temp.dml(owner_a, format($q$INSERT INTO messages (conversation_id, sender_type, content_text) VALUES (%L, 'agent', 'owner')$q$, (SELECT v FROM ctx WHERE k = 'V'))) <> 'ROWS 1' THEN
    RAISE EXCEPTION 'FAIL the Owner must still be able to work after every other role was stripped';
  END IF;
  IF pg_temp.run(owner_a, format($q$SELECT cardinality(capabilities_for_current_user(%L))::text$q$, a))
     <> (SELECT count(*)::text FROM capability_catalogue) THEN
    RAISE EXCEPTION 'FAIL capabilities_for_current_user for the Owner must be the whole catalogue';
  END IF;
  -- the stripped Admin cannot touch the matrix; the Owner can, and can hand roles.manage back
  res := pg_temp.run(admin_a, format($q$SELECT set_role_capabilities(%L, 'agent', '{"menu.inbox": false}'::jsonb)::text$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a stripped Admin edited the matrix: %', res; END IF;
  res := pg_temp.run(owner_a, format($q$SELECT set_role_capabilities(%L, 'admin', '{"roles.manage": true}'::jsonb)::text$q$, a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the Owner must be able to restore roles.manage: %', res; END IF;
  -- roles.manage can never be removed from the Owner, and the Owner cannot be edited
  res := pg_temp.run(owner_a, format($q$SELECT set_role_capabilities(%L, 'owner', '{"roles.manage": false}'::jsonb)::text$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the Owner role must not be editable: %', res; END IF;
  BEGIN
    INSERT INTO role_capabilities (account_id, role, capability, granted) VALUES (a, 'owner', 'roles.manage', false);
    RAISE EXCEPTION 'FAIL an override row for the owner role must be refused';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  IF effective_capability(a, 'owner', 'roles.manage') IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL the Owner must always hold roles.manage';
  END IF;
  DELETE FROM role_capabilities WHERE account_id = a;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 8. Cross-account isolation of what this migration added
  -- ---------------------------------------------------------
  IF pg_temp.run(owner_b, $q$SELECT count(*)::text FROM approval_pending_edits$q$) <> '0'
  OR pg_temp.run(owner_b, format($q$SELECT count(*)::text FROM account_invitations WHERE account_id = %L$q$, a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL cross-account read';
  END IF;
  IF pg_temp.dml(owner_b, format($q$UPDATE accounts SET name = 'hijacked' WHERE id = %L$q$, a)) <> 'ROWS 0' THEN
    RAISE EXCEPTION 'FAIL another account renamed this one';
  END IF;
  res := pg_temp.run(owner_b, format($q$SELECT set_role_capabilities(%L, 'agent', '{"tickets.work": false}'::jsonb)::text$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL another account edited the matrix: %', res; END IF;
  n := n + 1;

  RAISE EXCEPTION 'ROLLBACK-OK: % sections, % table groups, % write checks', n, cnt, (SELECT c.n FROM counters c WHERE c.k = 'checks');
END
$verify$;
