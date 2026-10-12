-- Verify migration 182 (KYC review: the three capabilities, the `kyc` platform flag, the access log).
-- Self-contained; run against an empty database or production with 182's migration text concatenated in front when it is not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: (1) menu.kyc, kyc.view and kyc.reveal are in the catalogue (app tier, grantable down to agent), the owner and the admin hold them by default
-- and an agent and a viewer do not, an admin can grant one to an agent and the database refuses to grant it to a viewer; (2) the `kyc` flag is an
-- explicit false on every workspace that exists, is not flipped back by a second run, and a workspace made by the signup flow starts with it false
-- (and the other flags as before); (3) kyc_access_log: row level security on, the admins and the owner of a workspace read its rows and nobody else
-- does (an agent, a viewer, another workspace's admin, the signed-out role), no signed-in role can insert, update or delete (privilege and policy),
-- the service role can insert and cannot update, delete or truncate, the table owner cannot either unless a workspace is being purged, the purge
-- exception works only for that workspace, the checks refuse an unknown action or outcome and a friend id of 0 or 101 characters, a row for a login
-- that does not exist is fine (no foreign key on the person); (4) the log leaves with its workspace (delete_workspace_data when it exists, the purge
-- exception otherwise) and is in the workspace export; (5) the new trigger function is not callable by the API roles.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();  -- owner of workspace A
  uAd     uuid := gen_random_uuid();  -- admin of A
  uG      uuid := gen_random_uuid();  -- an agent of A
  uV      uuid := gen_random_uuid();  -- a viewer of A
  uB      uuid := gen_random_uuid();  -- owner of workspace B (an admin of another workspace)
  uC      uuid := gen_random_uuid();  -- owner of workspace C, which gets deleted
  acctA   uuid;
  acctB   uuid;
  acctC   uuid;
  v_res   text;
  v_n     int;
  v_json  jsonb;
  v_feat  jsonb;
  k       text;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      -- a NULL person is a caller with no session at all (what the signed-out role is): auth.uid() is then null
      PERFORM set_config('request.jwt.claims', CASE WHEN u IS NULL THEN '' ELSE json_build_object('sub', u, 'role', r)::text END, true);
      PERFORM set_config('request.jwt.claim.sub', COALESCE(u::text, ''), true);
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
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'  || uA  || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uAd, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ad-' || uAd || '@example.invalid', '{"full_name":"Admin"}', now()),
    (uG,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g-'  || uG  || '@example.invalid', '{"full_name":"Agent"}', now()),
    (uV,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'v-'  || uV  || '@example.invalid', '{"full_name":"Viewer"}', now()),
    (uB,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'  || uB  || '@example.invalid', '{"full_name":"Tenant B"}', now()),
    (uC,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c-'  || uC  || '@example.invalid', '{"full_name":"Tenant C"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  SELECT account_id INTO acctC FROM profiles WHERE user_id = uC;
  UPDATE profiles SET account_id = acctA, account_role = 'admin'  WHERE user_id = uAd;
  UPDATE profiles SET account_id = acctA, account_role = 'agent'  WHERE user_id = uG;
  UPDATE profiles SET account_id = acctA, account_role = 'viewer' WHERE user_id = uV;

  -- ------------------------------------------------------------
  -- 1. The capabilities
  -- ------------------------------------------------------------
  FOREACH k IN ARRAY ARRAY['menu.kyc', 'kyc.view', 'kyc.reveal'] LOOP
    IF NOT EXISTS (SELECT 1 FROM capability_catalogue WHERE capability = k AND min_grant_role = 'agent' AND enforced_by = 'app') THEN
      RAISE EXCEPTION 'FAIL % is not in the catalogue as an agent-grantable app capability', k;
    END IF;
    IF (SELECT count(*) FROM role_capability_defaults WHERE capability = k) <> 2
       OR NOT EXISTS (SELECT 1 FROM role_capability_defaults WHERE capability = k AND role = 'owner')
       OR NOT EXISTS (SELECT 1 FROM role_capability_defaults WHERE capability = k AND role = 'admin') THEN
      RAISE EXCEPTION 'FAIL % should default to the owner and the admin only', k;
    END IF;
    v_res := pg_temp.run(uA,  format($q$SELECT has_capability(%L, %L)::text$q$, acctA, k));
    IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the owner should hold % (saw %)', k, v_res; END IF;
    v_res := pg_temp.run(uAd, format($q$SELECT has_capability(%L, %L)::text$q$, acctA, k));
    IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the admin should hold % (saw %)', k, v_res; END IF;
    v_res := pg_temp.run(uG,  format($q$SELECT has_capability(%L, %L)::text$q$, acctA, k));
    IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL an agent should not hold % by default (saw %)', k, v_res; END IF;
    v_res := pg_temp.run(uV,  format($q$SELECT has_capability(%L, %L)::text$q$, acctA, k));
    IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL a viewer should not hold % (saw %)', k, v_res; END IF;
  END LOOP;

  -- an admin can grant one to an agent; the database refuses to grant it to a viewer
  IF to_regproc('public.set_role_capabilities') IS NOT NULL THEN
    v_res := pg_temp.run(uA, format($q$SELECT public.set_role_capabilities(%L, 'agent'::account_role_enum, '{"kyc.view": true}'::jsonb)::text$q$, acctA));
    IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the owner could not grant kyc.view to the agent role: %', v_res; END IF;
    v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'kyc.view')::text$q$, acctA));
    IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the agent did not receive the granted kyc.view (saw %)', v_res; END IF;
    v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'kyc.reveal')::text$q$, acctA));
    IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL granting kyc.view also granted kyc.reveal (saw %)', v_res; END IF;
    v_res := pg_temp.run(uA, format($q$SELECT public.set_role_capabilities(%L, 'viewer'::account_role_enum, '{"kyc.view": true}'::jsonb)::text$q$, acctA));
    IF v_res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL kyc.view could be granted to the viewer role: %', v_res; END IF;
  END IF;

  -- ------------------------------------------------------------
  -- 2. The flag
  -- ------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM account_platform WHERE NOT (features ? 'kyc')) THEN
    RAISE EXCEPTION 'FAIL a workspace has no explicit kyc flag';
  END IF;
  -- a workspace made by the signup flow starts with it off, and the others as they were
  SELECT features INTO v_feat FROM account_platform WHERE account_id = acctB;
  IF v_feat IS NULL THEN RAISE EXCEPTION 'FAIL the new workspace has no platform row'; END IF;
  IF (v_feat -> 'kyc') IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'FAIL a new workspace should start with kyc off: %', v_feat; END IF;
  IF (v_feat -> 'sign') IS DISTINCT FROM 'false'::jsonb OR (v_feat -> 'sign_merchant') IS DISTINCT FROM 'false'::jsonb
     OR (v_feat -> 'incidents') IS DISTINCT FROM 'false'::jsonb OR (v_feat -> 'jira') IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'FAIL the seed changed the other flags: %', v_feat;
  END IF;
  -- the operator turns it on for one workspace; the migration's own UPDATE (run again) leaves that alone and touches no other workspace
  UPDATE account_platform SET features = features || '{"kyc": true}'::jsonb WHERE account_id = acctA;
  UPDATE account_platform SET features = features || '{"kyc": false}'::jsonb WHERE NOT (features ? 'kyc');
  IF (SELECT features -> 'kyc' FROM account_platform WHERE account_id = acctA) IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL the default UPDATE turned off a workspace the operator had turned on';
  END IF;
  IF (SELECT features -> 'kyc' FROM account_platform WHERE account_id = acctB) IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'FAIL another workspace changed when the operator turned kyc on for A';
  END IF;

  -- ------------------------------------------------------------
  -- 3. The access log
  -- ------------------------------------------------------------
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.kyc_access_log'::regclass) THEN
    RAISE EXCEPTION 'FAIL row level security is off on kyc_access_log';
  END IF;
  -- the server writes (service role); nobody else
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, validation_id, outcome) VALUES (%L, %L, 'lookup', 'child-1', NULL, 'ok')$q$, acctA, uAd), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the service role could not write a log row: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, validation_id, outcome) VALUES (%L, %L, 'view_image', 'child-1', 'val-9', 'ok')$q$, acctA, uAd), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the service role could not write a second log row: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, outcome) VALUES (%L, %L, 'config_error', 'error')$q$, acctA, uAd), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a log row without a friend id or validation id was refused: %', v_res; END IF;
  -- a row for a login that does not exist (or was deleted) is fine: no foreign key on the person
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, outcome) VALUES (%L, %L, 'reveal', 'child-2', 'forbidden')$q$, acctA, gen_random_uuid()), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a log row for an unknown login was refused: %', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, outcome) VALUES (%L, %L, 'list', 'b-child', 'not_found')$q$, acctB, uB), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the service role could not write a row for workspace B: %', v_res; END IF;

  -- who reads what
  v_res := pg_temp.run(uA, format($q$SELECT count(*)::text FROM kyc_access_log WHERE account_id = %L$q$, acctA));
  IF v_res <> '4' THEN RAISE EXCEPTION 'FAIL the owner should read the 4 rows of workspace A (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, 'SELECT count(*)::text FROM kyc_access_log');
  IF v_res <> '4' THEN RAISE EXCEPTION 'FAIL the admin should read exactly the 4 rows of workspace A (saw %)', v_res; END IF;
  v_res := pg_temp.run(uG, 'SELECT count(*)::text FROM kyc_access_log');
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL an agent read the access log (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, 'SELECT count(*)::text FROM kyc_access_log');
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer read the access log (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, 'SELECT count(*)::text FROM kyc_access_log');
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL the owner of workspace B should read only its own row (saw %)', v_res; END IF;
  v_res := pg_temp.run(NULL, 'SELECT count(*)::text FROM kyc_access_log', 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the signed-out role could read or probe the access log (saw %)', v_res; END IF;

  -- no signed-in role writes
  v_res := pg_temp.run(uAd, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, outcome) VALUES (%L, %L, 'lookup', 'ok')$q$, acctA, uAd));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an admin could insert into the access log from the browser (saw %)', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$UPDATE kyc_access_log SET outcome = 'ok' WHERE account_id = %L$q$, acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner could update the access log from the browser (saw %)', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$DELETE FROM kyc_access_log WHERE account_id = %L$q$, acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner could delete from the access log from the browser (saw %)', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, outcome) VALUES (%L, %L, 'lookup', 'ok')$q$, acctA, uAd), 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the signed-out role could insert into the access log (saw %)', v_res; END IF;

  -- append-only, whoever asks (the service role, the table owner)
  v_res := pg_temp.run(NULL, format($q$UPDATE kyc_access_log SET outcome = 'ok' WHERE account_id = %L$q$, acctA), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%append-only%' THEN RAISE EXCEPTION 'FAIL the service role could update a log row (saw %)', v_res; END IF;
  v_res := pg_temp.run(NULL, format($q$DELETE FROM kyc_access_log WHERE account_id = %L$q$, acctA), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%append-only%' THEN RAISE EXCEPTION 'FAIL the service role could delete a log row (saw %)', v_res; END IF;
  v_res := pg_temp.run(NULL, 'TRUNCATE kyc_access_log', 'service_role');
  IF v_res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the service role could truncate the access log (saw %)', v_res; END IF;
  BEGIN
    UPDATE kyc_access_log SET outcome = 'ok' WHERE account_id = acctA;
    RAISE EXCEPTION 'FAIL the table owner could update a log row';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM kyc_access_log WHERE account_id = acctA;
    RAISE EXCEPTION 'FAIL the table owner could delete a log row without a purge';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    TRUNCATE kyc_access_log;
    RAISE EXCEPTION 'FAIL the table owner could truncate the log';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- the purge exception is for the workspace being purged only
  PERFORM set_config('vircle.purge_account', acctB::text, true);
  BEGIN
    DELETE FROM kyc_access_log WHERE account_id = acctA;
    RAISE EXCEPTION 'FAIL a purge of workspace B deleted a row of workspace A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  v_res := pg_temp.run(NULL, format($q$DELETE FROM kyc_access_log WHERE account_id = %L$q$, acctB), 'service_role');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the purge exception applied to the service role (saw %)', v_res; END IF;
  DELETE FROM kyc_access_log WHERE account_id = acctB;
  IF EXISTS (SELECT 1 FROM kyc_access_log WHERE account_id = acctB) THEN RAISE EXCEPTION 'FAIL the purge of workspace B left its rows'; END IF;
  PERFORM set_config('vircle.purge_account', '', true);
  SELECT count(*) INTO v_n FROM kyc_access_log WHERE account_id = acctA;
  IF v_n <> 4 THEN RAISE EXCEPTION 'FAIL workspace A should still hold its 4 rows (found %)', v_n; END IF;

  -- the checks
  FOREACH k IN ARRAY ARRAY[
    $s$action, outcome) VALUES ('delete', 'ok')$s$,
    $s$action, outcome) VALUES ('lookup', 'maybe')$s$,
    $s$action, friend_id, outcome) VALUES ('lookup', '', 'ok')$s$,
    $s$action, friend_id, outcome) VALUES ('lookup', repeat('x', 101), 'ok')$s$,
    $s$action, validation_id, outcome) VALUES ('view_image', repeat('x', 201), 'ok')$s$
  ] LOOP
    v_res := pg_temp.run(NULL, format('INSERT INTO kyc_access_log (account_id, %s', replace(k, 'VALUES (', format('VALUES (%L, ', acctA))), 'service_role');
    IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL the table accepted a bad row (% -> %)', k, v_res; END IF;
  END LOOP;
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, action, friend_id, outcome) VALUES (%L, 'lookup', repeat('x', 100), 'ok')$q$, acctA), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a 100-character friend id was refused: %', v_res; END IF;

  -- ------------------------------------------------------------
  -- 4. The log leaves with its workspace, and is in the export
  -- ------------------------------------------------------------
  v_res := pg_temp.run(NULL, format($q$INSERT INTO kyc_access_log (account_id, user_id, action, friend_id, outcome) VALUES (%L, %L, 'lookup', 'c-child', 'ok')$q$, acctC, uC), 'service_role');
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not write a row for workspace C: %', v_res; END IF;
  IF to_regproc('public.workspace_export_manifest') IS NOT NULL THEN
    v_json := public.workspace_export_manifest();
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json) e WHERE e ->> 'table' = 'kyc_access_log') THEN
      RAISE EXCEPTION 'FAIL kyc_access_log is not in the workspace export';
    END IF;
    v_json := public.workspace_export_rows(acctA, 'kyc_access_log');
    IF jsonb_array_length(v_json -> 'rows') < 4 OR v_json::text LIKE '%' || acctC::text || '%' THEN
      RAISE EXCEPTION 'FAIL the export of kyc_access_log is wrong: %', left(v_json::text, 200);
    END IF;
  END IF;
  IF to_regproc('public.delete_workspace_data') IS NOT NULL AND to_regproc('public.workspace_deletion_begin') IS NOT NULL THEN
    UPDATE account_platform SET deletion_due_at = now() - interval '1 minute' WHERE account_id = acctC;
    PERFORM public.workspace_deletion_begin(acctC);
    PERFORM public.delete_workspace_data(acctC);
  ELSE
    -- no deletion machinery here: the cascade of the workspace row, under the purge exception it relies on
    PERFORM set_config('vircle.purge_account', acctC::text, true);
    PERFORM set_config('vircle.hard_delete', 'on', true);
    DELETE FROM public.accounts WHERE id = acctC;
  END IF;
  IF EXISTS (SELECT 1 FROM kyc_access_log WHERE account_id = acctC) THEN
    RAISE EXCEPTION 'FAIL the access log rows of a deleted workspace remain';
  END IF;
  PERFORM set_config('vircle.purge_account', '', true);
  IF (SELECT count(*) FROM kyc_access_log WHERE account_id = acctA) <> 5 THEN
    RAISE EXCEPTION 'FAIL deleting workspace C touched workspace A''s log';
  END IF;

  -- ------------------------------------------------------------
  -- 5. The new function and the table's privileges
  -- ------------------------------------------------------------
  IF has_function_privilege('authenticated', 'public.kyc_access_log_append_only()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.kyc_access_log_append_only()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the append-only trigger function is callable by the API roles';
  END IF;
  IF has_table_privilege('authenticated', 'public.kyc_access_log', 'INSERT') OR has_table_privilege('authenticated', 'public.kyc_access_log', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.kyc_access_log', 'DELETE') OR has_table_privilege('authenticated', 'public.kyc_access_log', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.kyc_access_log', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL a browser role holds a privilege it should not on kyc_access_log';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'kyc_access_log_append_only'
                AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'FAIL the trigger function does not pin its search_path';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: the three KYC capabilities (owner and admin by default, grantable to an agent, never to a viewer); the kyc flag is an explicit false on every workspace, survives a second run and starts false for a new workspace; kyc_access_log is readable by the admins and owner of its own workspace only, written by the service role only, append-only (service role and table owner refused, purge exception limited to the workspace being purged), checked, exported and removed with its workspace; the trigger function is not callable by the API roles';
END
$verify$;
