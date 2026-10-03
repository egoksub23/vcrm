-- Verify migration 153. Self-contained (builds its own tenants), so it runs against an
-- empty database as well as production. Concatenate 153's migration text in front when
-- the database does not have it yet, then run it. Ends in a deliberate error so nothing
-- is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();   -- owner of tenant A, the workspace that gets deleted
  uM     uuid := gen_random_uuid();   -- an agent in A (changed a capability, wrote in Sembang, is a team member)
  uB     uuid := gen_random_uuid();   -- owner of tenant B, which must be untouched
  uC     uuid := gen_random_uuid();   -- a login in B that changed a capability, deleted at the end
  uOp    uuid := gen_random_uuid();   -- the platform operator (works in their own workspace)
  uAnon  uuid := gen_random_uuid();   -- an anonymous web-widget visitor of A
  a      uuid;
  b      uuid;
  acctOp uuid;
  mAcct  uuid;
  cfgA   uuid;
  ctA    uuid;
  ctV    uuid;
  convA  uuid;
  tagA   uuid;
  pipeA  uuid;
  stageA uuid;
  schedA uuid;
  roleA  uuid;
  roleB  uuid;
  teamA  uuid;
  chA    uuid;
  msgA   uuid;
  taskA  uuid;
  tkA    uuid;
  v_res  text;
  v_json jsonb;
  v_n    bigint;
  v_begin jsonb;
  r      record;
  v_cols jsonb;
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
          json_build_object('sub', u, 'role', r)::text, true);
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

  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;

  -- ------------------------------------------------------------
  -- Fixtures: two tenants, an operator, an anonymous visitor
  -- ------------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'  || uA  || '@example.invalid', '{"full_name":"Owner A"}', now()),
    (uM,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'm-'  || uM  || '@example.invalid', '{"full_name":"Agent A"}', now()),
    (uB,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'  || uB  || '@example.invalid', '{"full_name":"Owner B"}', now()),
    (uC,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c-'  || uC  || '@example.invalid', '{"full_name":"Agent B"}', now()),
    (uOp, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op-' || uOp || '@example.invalid', '{"full_name":"Operator"}', now());
  INSERT INTO auth.users (id, instance_id, aud, role, is_anonymous)
  VALUES (uAnon, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', true);

  SELECT account_id INTO a FROM profiles WHERE user_id = uA;
  SELECT account_id INTO b FROM profiles WHERE user_id = uB;
  SELECT account_id INTO acctOp FROM profiles WHERE user_id = uOp;
  INSERT INTO platform_admins (user_id, note) VALUES (uOp, 'verify-153');

  -- uM joins A as an agent (their personal workspace goes), uC joins B
  SELECT account_id INTO mAcct FROM profiles WHERE user_id = uM;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id = uM;
  DELETE FROM accounts WHERE id = mAcct;
  SELECT account_id INTO mAcct FROM profiles WHERE user_id = uC;
  UPDATE profiles SET account_id = b, account_role = 'agent' WHERE user_id = uC;
  DELETE FROM accounts WHERE id = mAcct;

  -- ------------------------------------------------------------
  -- Seed workspace A across the tables most likely to block a delete
  -- ------------------------------------------------------------
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, uA, '+60100001531', 'Casey') RETURNING id INTO ctA;
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (a, uA, '+60100001532', 'Visitor') RETURNING id INTO ctV;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (a, uA, ctA) RETURNING id INTO convA;
  INSERT INTO messages (conversation_id, account_id, sender_type, content_type, content_text, channel_type)
    VALUES (convA, a, 'customer', 'text', 'hello', 'whatsapp'), (convA, a, 'agent', 'text', 'hi', 'whatsapp');
  INSERT INTO tags (user_id, name, account_id, for_contacts, for_conversations) VALUES (uA, 'verify-153', a, true, true) RETURNING id INTO tagA;
  INSERT INTO contact_tags (contact_id, tag_id, added_by) VALUES (ctA, tagA, uM);
  INSERT INTO pipelines (user_id, name, account_id) VALUES (uA, 'P', a) RETURNING id INTO pipeA;
  INSERT INTO pipeline_stages (pipeline_id, name) VALUES (pipeA, 'S') RETURNING id INTO stageA;
  INSERT INTO deals (user_id, pipeline_id, stage_id, contact_id, conversation_id, title, account_id)
    VALUES (uA, pipeA, stageA, ctA, convA, 'D', a);

  -- a ticket that was resolved (tickets -> ticket_resolutions is NO ACTION), with business hours and
  -- an SLA policy on them (RESTRICT)
  INSERT INTO tickets (account_id, ticket_number, contact_id, subject) VALUES (a, 153001, ctA, 'T') RETURNING id INTO tkA;
  UPDATE tickets SET resolution_id = (SELECT id FROM ticket_resolutions WHERE account_id = a ORDER BY position LIMIT 1) WHERE id = tkA;
  INSERT INTO business_hours_schedules (account_id, name, timezone, weekly) VALUES (a, 'Office', 'UTC', '{"1":[{"start":"09:00","end":"17:00"}],"2":[],"3":[],"4":[],"5":[],"6":[],"7":[]}'::jsonb) RETURNING id INTO schedA;
  INSERT INTO ticket_sla_policies (account_id, name, conditions, first_response_minutes, resolution_minutes, schedule_id)
    VALUES (a, 'P1', '{}'::jsonb, 30, 240, schedA);

  -- a custom role whose capability changes were logged, by a member (append-only log, FK to the role and to the login)
  INSERT INTO account_roles (account_id, name, base_role, created_by) VALUES (a, 'Support lead', 'agent', uM) RETURNING id INTO roleA;
  INSERT INTO role_capability_log (account_id, role, capability, old_granted, new_granted, actor, account_role_id)
    VALUES (a, 'agent', 'contacts.edit', false, true, uM, roleA);
  INSERT INTO role_capability_log (account_id, role, capability, old_granted, new_granted, actor)
    VALUES (a, 'agent', 'tags.manage', false, true, uM);

  INSERT INTO teams (account_id, name) VALUES (a, 'Support') RETURNING id INTO teamA;
  INSERT INTO team_members (team_id, user_id, added_by) VALUES (teamA, uM, uA);

  -- Sembang rows authored by the member (author columns are NO ACTION to auth.users)
  INSERT INTO sembang_channels (account_id, name, is_private, created_by) VALUES (a, 'general', false, uM) RETURNING id INTO chA;
  INSERT INTO sembang_messages (channel_id, account_id, author_id, body) VALUES (chA, a, uM, 'hello') RETURNING id INTO msgA;
  INSERT INTO sembang_tasks (channel_id, account_id, title, created_by) VALUES (chA, a, 'do it', uM) RETURNING id INTO taskA;
  INSERT INTO sembang_task_assignees (task_id, user_id, account_id, added_by) VALUES (taskA, uA, a, uM);

  -- an anonymous web-widget visitor: a login with no profile, tied to the workspace only through widget_visitors
  INSERT INTO web_widget_config (account_id, user_id, widget_token) VALUES (a, uA, 'verify-153-' || uA) RETURNING id INTO cfgA;
  INSERT INTO widget_visitors (id, account_id, contact_id, widget_config_id) VALUES (uAnon, a, ctV, cfgA);

  INSERT INTO notifications (account_id, user_id, type, title, body) VALUES (a, uM, 'sembang_mention', 't', 'b');
  PERFORM public.log_audit(a, 'created', 'tag', tagA, 'verify-153', '{}'::jsonb, uM, 0);
  INSERT INTO storage.objects (bucket_id, name, metadata)
    VALUES ('chat-media', 'account-' || a || '/verify-153.bin', '{"size": 2048}'::jsonb),
           ('avatars', uM::text || '/avatar.png', '{"size": 10}'::jsonb);

  -- tenant B: a login that changed a capability, a custom role with a log row, one contact
  INSERT INTO account_roles (account_id, name, base_role, created_by) VALUES (b, 'B role', 'agent', uC) RETURNING id INTO roleB;
  INSERT INTO role_capability_log (account_id, role, capability, old_granted, new_granted, actor, account_role_id)
    VALUES (b, 'agent', 'contacts.edit', false, true, uC, roleB);
  INSERT INTO contacts (account_id, user_id, phone, name) VALUES (b, uB, '+60100001539', 'B contact');

  -- ------------------------------------------------------------
  -- 1. The two bugs found on the way, in a workspace that is NOT being deleted
  -- ------------------------------------------------------------
  -- deleting a custom role that has log rows works (the log row goes with it)
  DELETE FROM account_roles WHERE id = roleB;
  IF EXISTS (SELECT 1 FROM role_capability_log WHERE account_role_id = roleB) THEN
    RAISE EXCEPTION 'FAIL the log rows of a deleted custom role are still there';
  END IF;
  -- deleting a login that changed a capability works; the log row stays, with no actor
  INSERT INTO role_capability_log (account_id, role, capability, old_granted, new_granted, actor)
    VALUES (b, 'agent', 'tags.manage', false, true, uC);
  SELECT account_id INTO mAcct FROM profiles WHERE user_id = uC;
  DELETE FROM profiles WHERE user_id = uC;
  DELETE FROM auth.users WHERE id = uC;
  IF NOT EXISTS (SELECT 1 FROM role_capability_log WHERE account_id = b AND capability = 'tags.manage' AND actor IS NULL) THEN
    RAISE EXCEPTION 'FAIL the capability log row of a deleted login should stay, with no actor';
  END IF;
  -- but the log is still append-only for everyone else
  BEGIN
    UPDATE role_capability_log SET note = 'edited' WHERE account_id = b AND capability = 'tags.manage';
    RAISE EXCEPTION 'FAIL a capability log row was edited';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM role_capability_log WHERE account_id = b AND capability = 'tags.manage';
    RAISE EXCEPTION 'FAIL a capability log row was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM audit_log WHERE account_id = a;
    RAISE EXCEPTION 'FAIL an audit log row was deleted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- ------------------------------------------------------------
  -- 2. Who may ask for a deletion, and cancel it
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uM, format($q$SELECT public.workspace_deletion_request(%L)::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent asked to delete the workspace: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT public.workspace_deletion_request(%L)::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL another workspace''s owner asked to delete this one: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$SELECT public.workspace_deletion_request(%L)::text$q$, a), 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL anon asked to delete a workspace: %', v_res; END IF;
  v_res := pg_temp.run(uOp, format($q$SELECT public.workspace_deletion_request(%L)::text$q$, acctOp));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL the operator''s own workspace could be marked for deletion: %', v_res; END IF;

  v_res := pg_temp.run(uA, format($q$SELECT public.workspace_deletion_request(%L, 1, 'not wanted')::text$q$, a));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the owner could not ask to delete: %', v_res; END IF;
  -- the owner always gets 30 days, whatever they pass
  IF (SELECT deletion_due_at FROM account_platform WHERE account_id = a) < now() + interval '29 days' THEN
    RAISE EXCEPTION 'FAIL the owner was given less than 30 days';
  END IF;
  -- a member can see the pending deletion (the banner), another workspace cannot
  v_res := pg_temp.run(uM, format($q$SELECT (deletion_due_at IS NOT NULL)::text FROM account_platform WHERE account_id = %L$q$, a));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL a member cannot see the pending deletion: %', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT count(*)::text FROM account_platform WHERE account_id = %L$q$, a));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace can see this deletion request'; END IF;
  -- only the operator sees the overview
  v_res := pg_temp.run(uA, 'SELECT public.platform_deletion_overview()::text');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a tenant read the operator deletion overview: %', left(v_res, 60); END IF;
  v_res := pg_temp.run(uOp, 'SELECT public.platform_deletion_overview()::text');
  IF v_res NOT LIKE '%' || a::text || '%' THEN RAISE EXCEPTION 'FAIL the overview does not list the pending deletion'; END IF;

  v_res := pg_temp.run(uM, format($q$SELECT public.workspace_deletion_cancel(%L)::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent cancelled the deletion: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$SELECT public.workspace_deletion_cancel(%L)::text$q$, a));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the owner could not cancel: %', v_res; END IF;
  IF (SELECT deletion_due_at FROM account_platform WHERE account_id = a) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL cancel left the deletion date';
  END IF;

  -- the operator may shorten it; the job picks it up when due
  v_res := pg_temp.run(uOp, format($q$SELECT public.workspace_deletion_request(%L, 0, 'requested by the customer')::text$q$, a));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the operator could not request a deletion: %', v_res; END IF;
  v_res := pg_temp.run(NULL, 'SELECT public.workspace_deletions_due()::text', 'service_role');
  IF v_res NOT LIKE '%' || a::text || '%' THEN RAISE EXCEPTION 'FAIL a due deletion was not offered to the job: %', v_res; END IF;

  -- ------------------------------------------------------------
  -- 3. The export lists what it should, and never secrets
  -- ------------------------------------------------------------
  v_json := public.workspace_export_manifest();
  FOREACH v_res IN ARRAY ARRAY['accounts', 'contacts', 'messages', 'conversations', 'contact_tags', 'audit_log', 'role_capability_log', 'tickets', 'sembang_messages'] LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json) e WHERE e ->> 'table' = v_res) THEN
      RAISE EXCEPTION 'FAIL the export manifest has no %', v_res;
    END IF;
  END LOOP;
  FOREACH v_res IN ARRAY ARRAY['jira_connection_secrets', 'oauth_pending_connections', 'widget_verification_codes', 'ai_knowledge_chunks'] LOOP
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_json) e WHERE e ->> 'table' = v_res) THEN
      RAISE EXCEPTION 'FAIL the export manifest includes the secret table %', v_res;
    END IF;
  END LOOP;
  -- no column anywhere that looks like a secret
  SELECT string_agg((e ->> 'table') || '.' || c, ', ') INTO v_res
    FROM jsonb_array_elements(v_json) e, jsonb_array_elements_text(e -> 'columns') c
   WHERE c ~* '(token|secret|hash|password|api_key|embedding|client_state|signing|_enc$)';
  IF v_res IS NOT NULL THEN RAISE EXCEPTION 'FAIL secret-looking columns in the export: %', v_res; END IF;
  -- the secrets that exist today are really absent
  SELECT e -> 'columns' INTO v_cols FROM jsonb_array_elements(v_json) e WHERE e ->> 'table' = 'whatsapp_config';
  IF v_cols IS NULL OR v_cols ? 'access_token' OR v_cols ? 'verify_token' OR v_cols ? 'app_secret_enc' THEN
    RAISE EXCEPTION 'FAIL whatsapp_config would export its secrets: %', v_cols;
  END IF;

  -- rows: direct tables, child tables, the account itself, paging, and nothing from another workspace
  v_json := public.workspace_export_rows(a, 'contacts', NULL, 1);
  IF jsonb_array_length(v_json -> 'rows') <> 1 OR v_json ->> 'last' IS NULL THEN RAISE EXCEPTION 'FAIL first page of contacts: %', v_json; END IF;
  v_json := public.workspace_export_rows(a, 'contacts', v_json ->> 'last', 10);
  IF jsonb_array_length(v_json -> 'rows') <> 1 THEN RAISE EXCEPTION 'FAIL second page of contacts should hold the other contact: %', v_json; END IF;
  v_json := public.workspace_export_rows(a, 'contact_tags');
  IF jsonb_array_length(v_json -> 'rows') <> 1 THEN RAISE EXCEPTION 'FAIL the child table contact_tags should export its one row: %', v_json; END IF;
  v_json := public.workspace_export_rows(a, 'accounts');
  IF jsonb_array_length(v_json -> 'rows') <> 1 THEN RAISE EXCEPTION 'FAIL the account row did not export'; END IF;
  v_json := public.workspace_export_rows(a, 'messages');
  IF jsonb_array_length(v_json -> 'rows') <> 2 THEN RAISE EXCEPTION 'FAIL messages should export 2 rows: %', jsonb_array_length(v_json -> 'rows'); END IF;
  v_json := public.workspace_export_rows(b, 'contacts');
  IF v_json::text LIKE '%Casey%' THEN RAISE EXCEPTION 'FAIL tenant A''s contact came out of tenant B''s export'; END IF;
  BEGIN
    PERFORM public.workspace_export_rows(a, 'jira_connection_secrets');
    RAISE EXCEPTION 'FAIL a secret table could be exported';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.workspace_export_rows(a, 'contacts; DROP TABLE contacts');
    RAISE EXCEPTION 'FAIL a table name was not checked';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- stored files by prefix
  v_json := public.storage_objects_by_prefix('account-' || a || '/');
  IF jsonb_array_length(v_json) <> 1 OR (v_json -> 0 ->> 'size')::int <> 2048 THEN RAISE EXCEPTION 'FAIL the workspace''s stored file was not listed: %', v_json; END IF;
  v_json := public.storage_objects_by_prefix('account-');
  IF jsonb_array_length(v_json) <> 0 THEN RAISE EXCEPTION 'FAIL a short prefix listed other workspaces'' files'; END IF;
  -- none of it is callable by a signed-in user
  v_res := pg_temp.run(uA, format($q$SELECT public.workspace_export_rows(%L, 'contacts')::text$q$, a));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in user called the export function directly: %', left(v_res, 60); END IF;
  v_res := pg_temp.run(uA, format($q$SELECT public.delete_workspace_data(%L)::text$q$, a), 'authenticated');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in user called delete_workspace_data: %', left(v_res, 60); END IF;

  -- ------------------------------------------------------------
  -- 4. The deletion
  -- ------------------------------------------------------------
  -- data cannot be deleted before the deletion has begun
  BEGIN
    PERFORM public.delete_workspace_data(a);
    RAISE EXCEPTION 'FAIL data was deleted without the deletion having begun';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- begin: an early (not yet due) request is refused unless forced
  UPDATE account_platform SET deletion_due_at = now() + interval '5 days' WHERE account_id = a;
  BEGIN
    PERFORM public.workspace_deletion_begin(a);
    RAISE EXCEPTION 'FAIL a deletion that is not yet due began';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  UPDATE account_platform SET deletion_due_at = now() - interval '1 minute' WHERE account_id = a;
  v_begin := public.workspace_deletion_begin(a);
  IF NOT (v_begin -> 'member_user_ids') @> to_jsonb(ARRAY[uA, uM]) OR NOT (v_begin -> 'visitor_user_ids') @> to_jsonb(ARRAY[uAnon]) THEN
    RAISE EXCEPTION 'FAIL begin did not return the members and visitors to delete: %', v_begin;
  END IF;
  IF (SELECT status FROM account_platform WHERE account_id = a) <> 'suspended'
     OR (SELECT enabled FROM web_widget_config WHERE id = cfgA) THEN
    RAISE EXCEPTION 'FAIL begin did not suspend the workspace and switch its widget off';
  END IF;
  IF (SELECT (row_counts ->> 'contacts')::int FROM workspace_deletions WHERE account_id = a) <> 2 THEN
    RAISE EXCEPTION 'FAIL the tombstone did not record the contact count: %', (SELECT row_counts FROM workspace_deletions WHERE account_id = a);
  END IF;
  -- it is no longer cancellable
  v_res := pg_temp.run(uA, format($q$SELECT public.workspace_deletion_cancel(%L)::text$q$, a));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL a deletion in progress could be cancelled: %', v_res; END IF;
  -- and calling begin again is harmless (a resumed run)
  PERFORM public.workspace_deletion_begin(a);

  PERFORM public.workspace_deletion_note(a, 'teardown_done', '{"gmail": "none"}'::jsonb, 1, NULL);
  IF (SELECT teardown ->> 'gmail' FROM workspace_deletions WHERE account_id = a) <> 'none' THEN RAISE EXCEPTION 'FAIL progress note lost'; END IF;

  v_json := public.delete_workspace_data(a);
  IF (v_json ->> 'log_rows_removed')::int < 3 THEN RAISE EXCEPTION 'FAIL the workspace''s log rows were not removed: %', v_json; END IF;

  -- zero rows left for the workspace in any table that carries an account id
  FOR r IN
    SELECT c.table_name::text AS t
      FROM information_schema.columns c
      JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'account_id' AND c.table_name <> 'workspace_deletions'
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE account_id = $1', r.t) INTO v_n USING a;
    IF v_n > 0 THEN RAISE EXCEPTION 'FAIL % row(s) of the deleted workspace remain in %', v_n, r.t; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM accounts WHERE id = a) THEN RAISE EXCEPTION 'FAIL the workspace row remains'; END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE account_id = a) OR EXISTS (SELECT 1 FROM widget_visitors WHERE account_id = a) THEN
    RAISE EXCEPTION 'FAIL profiles or widget visitors remain';
  END IF;
  -- and the child tables it reached through a parent
  IF EXISTS (SELECT 1 FROM contact_tags WHERE tag_id = tagA) OR EXISTS (SELECT 1 FROM team_members WHERE team_id = teamA)
     OR EXISTS (SELECT 1 FROM pipeline_stages WHERE id = stageA) OR EXISTS (SELECT 1 FROM conversation_events WHERE conversation_id = convA)
     OR EXISTS (SELECT 1 FROM account_role_capabilities WHERE account_role_id = roleA) THEN
    RAISE EXCEPTION 'FAIL child rows of the deleted workspace remain';
  END IF;
  -- running it again changes nothing and does not fail
  v_json := public.delete_workspace_data(a);

  -- another workspace is untouched
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE account_id = b AND name = 'B contact') OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = b)
     OR NOT EXISTS (SELECT 1 FROM role_capability_log WHERE account_id = b) THEN
    RAISE EXCEPTION 'FAIL the other workspace lost data';
  END IF;

  -- the logins can be deleted afterwards (the member wrote in Sembang and changed a capability)
  DELETE FROM auth.users WHERE id = ANY (ARRAY[uA, uM, uAnon]);
  IF EXISTS (SELECT 1 FROM auth.users WHERE id IN (uA, uM, uAnon)) THEN RAISE EXCEPTION 'FAIL the workspace''s logins remain'; END IF;
  -- the stored files are removed by the app through the Storage API; here only that they were listed
  PERFORM public.workspace_deletion_finish(a);
  IF (SELECT owner_email FROM workspace_deletions WHERE account_id = a) IS NOT NULL
     OR cardinality((SELECT member_user_ids FROM workspace_deletions WHERE account_id = a)) <> 0
     OR (SELECT deleted_at FROM workspace_deletions WHERE account_id = a) IS NULL
     OR (SELECT account_name FROM workspace_deletions WHERE account_id = a) IS NULL THEN
    RAISE EXCEPTION 'FAIL the tombstone still holds personal data or lacks its record: %', (SELECT row_to_json(d)::text FROM workspace_deletions d WHERE account_id = a);
  END IF;
  -- nobody but the service role can read it
  IF has_table_privilege('authenticated', 'public.workspace_deletions', 'SELECT') OR has_table_privilege('anon', 'public.workspace_deletions', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL a client role can read the deletion tombstones';
  END IF;

  -- ------------------------------------------------------------
  -- 5. Ratchets: a table or constraint added later forces a decision
  -- ------------------------------------------------------------
  -- every public table is either keyed by account_id, a reviewed child of one, or reviewed as not tenant data
  SELECT string_agg(c.relname, ', ') INTO v_res
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'account_id')
     AND c.relname NOT IN (SELECT child FROM public.workspace_export_children())
     AND c.relname NOT IN ('accounts', 'capability_catalogue', 'comment_webhook_events', 'cron_heartbeats', 'platform_admins',
                           'platform_settings', 'rate_limit_buckets', 'role_capability_defaults');
  IF v_res IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL table(s) with no account_id that are neither a listed child nor reviewed as not tenant data: %. Add them to workspace_export_children() (and check delete cascades) or to this list.', v_res;
  END IF;
  -- every table keyed by account_id is removed with the workspace: a cascading FK to accounts, or reviewed here
  SELECT string_agg(c.table_name, ', ') INTO v_res
    FROM information_schema.columns c
    JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
   WHERE c.table_schema = 'public' AND c.column_name = 'account_id'
     AND c.table_name NOT IN ('audit_log', 'role_capability_log', 'messages', 'workspace_deletions')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint k
        WHERE k.conrelid = ('public.' || c.table_name)::regclass AND k.contype = 'f'
          AND k.confrelid = 'public.accounts'::regclass AND k.confdeltype = 'c');
  IF v_res IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL table(s) keyed by account_id with no ON DELETE CASCADE to accounts (they would survive a deletion): %', v_res;
  END IF;
  -- restrictive foreign keys between tenant tables: only the reviewed ones, each handled by delete_workspace_data
  SELECT string_agg(k.conrelid::regclass::text || '.' || k.conname, ', ') INTO v_res
    FROM pg_constraint k
   WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace AND k.confdeltype IN ('a', 'r')
     AND k.confrelid::regclass::text NOT LIKE 'auth.%'
     AND k.conname NOT IN ('deals_conversation_id_fkey', 'deals_stage_id_fkey', 'incident_escalation_policies_schedule_id_fkey',
                           'ticket_sla_policies_schedule_id_fkey', 'tickets_resolution_id_fkey');
  IF v_res IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL new restrictive foreign key(s) between tables: %. Decide how a workspace deletion gets past it (delete_workspace_data) and add it to this list.', v_res;
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: owner and operator can ask, agents and other workspaces cannot; 30 days for the owner; cancellable until it begins; export lists every tenant table, child tables and the account, no secret columns or tables, pages by position, scoped to the workspace; deletion leaves zero rows in every account_id table, in the logs that have no foreign key and in the children, then the logins delete (member who wrote in Sembang, anonymous visitor); the other workspace is untouched; tombstone keeps no personal data; capability and audit logs stay append-only otherwise; table and foreign-key ratchets';
END
$verify$;
