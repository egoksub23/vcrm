-- Verify migration 183 (Compliance requests, Part A: capabilities, the `compliance` flag, the tables and the rules in the database).
-- Self-contained; run against an empty database or production with 182 and 183's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: (1) the six capabilities are in the catalogue (app tier, grantable down to agent), owner and admin hold them by default and an agent and
-- a viewer do not; (2) the `compliance` flag is an explicit false on every workspace, a new workspace starts with it false and with the three system
-- types, a second run changes nothing; (3) the types: closure 14/30 days, the others none, the key and the system mark cannot change, a system type
-- cannot be deleted, a hard stop before the target is refused; (4) privileges and row level security: nobody signed in writes, the ciphertext and the
-- storage path cannot be selected by a browser role, a case is seen by a holder of menu.compliance or the person who raised it and by nobody else
-- (not an agent without the capability, not a viewer, not another workspace, not the signed-out role), events, checklist and files follow the case;
-- (5) creation: the reference CMP-YYYY-NNNNNN counts per workspace, a supplied reference is ignored, the clocks come from the type, the checklist is
-- copied, a created event is written, a case cannot start past 'received', a link to another workspace's contact, ticket, conversation or incident is
-- refused; (6) no plain UPDATE of any protected column from any role (the table owner too), except an emptied link and a re-encrypted data_enc;
-- (7) the state machine: every illegal move refused, each legal one stamped and logged, the capability each move needs checked in the database for
-- the named person, the identity check payload, the recommendation, the reject reason, the dues override, the maker-checker rule (the person who
-- recorded the identity check cannot sign off, someone else can), the checklist must be complete, close; (8) edits: unknown keys refused, frozen
-- after sign-off, the request date moves the clocks, the assignee must be able to see requests; (9) the pause shifts the deadlines and needs the
-- Head's capability, a note and a type that allows it; (10) the clock sweep alerts once per threshold, honours the flag, a pause and a finished case,
-- notifies holders only; (11) retention: a case, its events, checklist and files cannot be deleted while retention_until is in the future (service
-- role, table owner, browser roles), events never change, a case past its retention and a purged workspace can go; (12) the files table (mime and
-- hash checks, an attachment event, no change); (13) the export leaves out data_enc; (14) the functions are not callable by the API roles and pin
-- their search_path; the private bucket exists.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();  -- owner of workspace A
  uAd     uuid := gen_random_uuid();  -- admin of A (the "Head of Compliance" in these tests: holds every capability)
  uAd2    uuid := gen_random_uuid();  -- a second admin of A
  uG      uuid := gen_random_uuid();  -- an agent of A
  uV      uuid := gen_random_uuid();  -- a viewer of A
  uB      uuid := gen_random_uuid();  -- owner of workspace B
  uC      uuid := gen_random_uuid();  -- owner of workspace C, which gets purged
  acctA   uuid;
  acctB   uuid;
  acctC   uuid;
  cA      uuid := gen_random_uuid();  -- a contact of A
  cB      uuid := gen_random_uuid();  -- a contact of B
  tkB     uuid := gen_random_uuid();
  cvB     uuid := gen_random_uuid();
  inB     uuid := gen_random_uuid();
  tkA     uuid := gen_random_uuid();
  r1      uuid := gen_random_uuid();  -- the closure that goes all the way
  r2      uuid := gen_random_uuid();  -- a closure that is rejected
  r3      uuid := gen_random_uuid();  -- a withdrawal
  r4      uuid := gen_random_uuid();  -- a phone change
  rB      uuid := gen_random_uuid();  -- a case in B
  rC      uuid := gen_random_uuid();  -- a case in C
  rS      uuid := gen_random_uuid();  -- a case for the sweep
  rP      uuid := gen_random_uuid();  -- a paused case
  v_res   text;
  v_n     int;
  v_json  jsonb;
  v_feat  jsonb;
  v_ts    timestamptz;
  v_ts2   timestamptz;
  k       text;
  fn      text;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
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
  -- the server: the service role, no session
  EXECUTE $f$ CREATE FUNCTION pg_temp.svc(q TEXT) RETURNS TEXT LANGUAGE sql AS $b$ SELECT pg_temp.run(NULL, q, 'service_role') $b$; $f$;

  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'   || uA   || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uAd,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ad-'  || uAd  || '@example.invalid', '{"full_name":"Admin"}', now()),
    (uAd2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ad2-' || uAd2 || '@example.invalid', '{"full_name":"Admin Two"}', now()),
    (uG,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g-'   || uG   || '@example.invalid', '{"full_name":"Agent"}', now()),
    (uV,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'v-'   || uV   || '@example.invalid', '{"full_name":"Viewer"}', now()),
    (uB,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'   || uB   || '@example.invalid', '{"full_name":"Tenant B"}', now()),
    (uC,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c-'   || uC   || '@example.invalid', '{"full_name":"Tenant C"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  SELECT account_id INTO acctC FROM profiles WHERE user_id = uC;
  UPDATE profiles SET account_id = acctA, account_role = 'admin'  WHERE user_id = uAd;
  UPDATE profiles SET account_id = acctA, account_role = 'admin'  WHERE user_id = uAd2;
  UPDATE profiles SET account_id = acctA, account_role = 'agent'  WHERE user_id = uG;
  UPDATE profiles SET account_id = acctA, account_role = 'viewer' WHERE user_id = uV;

  -- ------------------------------------------------------------
  -- 1. The capabilities
  -- ------------------------------------------------------------
  FOREACH k IN ARRAY ARRAY['menu.compliance', 'compliance.review', 'compliance.approve', 'compliance.reveal', 'compliance.execute', 'compliance.manage'] LOOP
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
  IF to_regproc('public.set_role_capabilities') IS NOT NULL THEN
    v_res := pg_temp.run(uA, format($q$SELECT public.set_role_capabilities(%L, 'viewer'::account_role_enum, '{"compliance.review": true}'::jsonb)::text$q$, acctA));
    IF v_res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL compliance.review could be granted to the viewer role: %', v_res; END IF;
  END IF;

  -- ------------------------------------------------------------
  -- 2. The flag and the seeded types
  -- ------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM account_platform WHERE NOT (features ? 'compliance')) THEN
    RAISE EXCEPTION 'FAIL a workspace has no explicit compliance flag';
  END IF;
  IF EXISTS (SELECT 1 FROM account_platform WHERE (features -> 'compliance') IS DISTINCT FROM 'false'::jsonb) THEN
    RAISE EXCEPTION 'FAIL a workspace has compliance on before the operator turned it on';
  END IF;
  SELECT features INTO v_feat FROM account_platform WHERE account_id = acctB;
  IF (v_feat -> 'compliance') IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'FAIL a new workspace should start with compliance off: %', v_feat; END IF;
  IF (v_feat -> 'kyc') IS DISTINCT FROM 'false'::jsonb OR (v_feat -> 'sign') IS DISTINCT FROM 'false'::jsonb
     OR (v_feat -> 'incidents') IS DISTINCT FROM 'false'::jsonb OR (v_feat -> 'jira') IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'FAIL the seed changed the other flags: %', v_feat;
  END IF;
  UPDATE account_platform SET features = features || '{"compliance": true}'::jsonb WHERE account_id = acctA;
  UPDATE account_platform SET features = features || '{"compliance": false}'::jsonb WHERE NOT (features ? 'compliance');
  IF (SELECT features -> 'compliance' FROM account_platform WHERE account_id = acctA) IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'FAIL the default UPDATE turned off a workspace the operator had turned on';
  END IF;
  IF (SELECT features -> 'compliance' FROM account_platform WHERE account_id = acctB) IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'FAIL another workspace changed when the operator turned compliance on for A';
  END IF;

  IF EXISTS (SELECT 1 FROM accounts a WHERE (SELECT count(*) FROM compliance_request_types t WHERE t.account_id = a.id AND t.is_system) <> 3) THEN
    RAISE EXCEPTION 'FAIL a workspace does not have exactly its three system types';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types WHERE account_id = acctA AND key = 'closure' AND target_days = 14 AND hard_stop_days = 30
                   AND requires_identity_check AND check_dues AND NOT allow_pause AND jsonb_array_length(checklist) = 3) THEN
    RAISE EXCEPTION 'FAIL the closure type is not 14 / 30 days with three checklist steps';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types WHERE account_id = acctA AND key = 'withdrawal' AND target_days IS NULL AND hard_stop_days IS NULL AND NOT check_dues) THEN
    RAISE EXCEPTION 'FAIL the withdrawal type should have no clocks';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types WHERE account_id = acctA AND key = 'phone_change' AND target_days IS NULL) THEN
    RAISE EXCEPTION 'FAIL the phone_change type is missing or has a clock';
  END IF;
  IF (SELECT count(*) FROM compliance_request_types, jsonb_array_elements(fields) f
       WHERE account_id = acctA AND key = 'closure' AND (f ->> 'sensitive') = 'true') <> 3 THEN
    RAISE EXCEPTION 'FAIL the closure type should mark exactly the three bank fields sensitive';
  END IF;
  -- the seed never overwrites an administrator's edit
  UPDATE compliance_request_types SET label = 'Closing an account' WHERE account_id = acctA AND key = 'closure';
  PERFORM public.compliance_seed_types(acctA);
  IF (SELECT label FROM compliance_request_types WHERE account_id = acctA AND key = 'closure') <> 'Closing an account' THEN
    RAISE EXCEPTION 'FAIL running the seed again overwrote an edit';
  END IF;
  UPDATE compliance_request_types SET label = 'Account closure' WHERE account_id = acctA AND key = 'closure';

  -- the types' own rules
  v_res := pg_temp.svc(format($q$UPDATE compliance_request_types SET key = 'other' WHERE account_id = %L AND key = 'closure'$q$, acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a type key could change (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$DELETE FROM compliance_request_types WHERE account_id = %L AND key = 'closure'$q$, acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a system type could be deleted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$UPDATE compliance_request_types SET hard_stop_days = 5 WHERE account_id = %L AND key = 'closure'$q$, acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a hard stop before the target was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_types (account_id, key, label, fields) VALUES (%L, 'Bad Key', 'x', '{}')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a bad type key or non-array fields were accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_types (account_id, key, label, fields, checklist, target_days, hard_stop_days, position)
                                  VALUES (%L, 'custom_one', 'Custom one', '[]', '[{"key":"only","label":{"en":"Only step"}}]', 7, 20, 9)$q$, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the service role could not add a custom type: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$DELETE FROM compliance_request_types WHERE account_id = %L AND key = 'custom_one'$q$, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a custom type with no cases could not be deleted: %', v_res; END IF;

  -- ------------------------------------------------------------
  -- 3. Privileges
  -- ------------------------------------------------------------
  FOREACH k IN ARRAY ARRAY['compliance_request_types', 'compliance_request_counters', 'compliance_requests', 'compliance_request_events',
                           'compliance_request_checklist', 'compliance_request_files'] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = ('public.' || k)::regclass) THEN
      RAISE EXCEPTION 'FAIL row level security is off on %', k;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || k, 'INSERT') OR has_table_privilege('authenticated', 'public.' || k, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || k, 'DELETE') OR has_table_privilege('authenticated', 'public.' || k, 'TRUNCATE')
       OR has_table_privilege('anon', 'public.' || k, 'SELECT') THEN
      RAISE EXCEPTION 'FAIL a browser role holds a privilege it should not on %', k;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.compliance_request_counters', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL a browser role can read the counters';
  END IF;
  IF has_column_privilege('authenticated', 'public.compliance_requests', 'data_enc', 'SELECT')
     OR has_column_privilege('authenticated', 'public.compliance_request_files', 'path', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL a browser role can select the ciphertext or the storage path';
  END IF;

  -- who holds a capability (one call for the assignee list)
  v_res := pg_temp.svc(format($q$SELECT public.compliance_holders(%L, 'compliance.approve')::text$q$, acctA));
  IF v_res NOT LIKE '%' || uA::text || '%' OR v_res NOT LIKE '%' || uAd::text || '%' OR v_res LIKE '%' || uG::text || '%' OR v_res LIKE '%' || uV::text || '%' OR v_res LIKE '%' || uB::text || '%' THEN
    RAISE EXCEPTION 'FAIL compliance_holders is wrong: %', v_res;
  END IF;

  -- contacts, tickets and so on of two workspaces (the link checks)
  INSERT INTO contacts (id, account_id, phone) VALUES (cA, acctA, '+60100000183'), (cB, acctB, '+60100000184');
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject) VALUES (tkA, acctA, 1, cA, 'verify A'), (tkB, acctB, 1, cB, 'verify B');
  INSERT INTO conversations (id, user_id, account_id, contact_id) VALUES (cvB, uB, acctB, cB);
  INSERT INTO incidents (id, account_id, incident_number, title, incident_type) VALUES (inB, acctB, 1, 'verify B', 'SB');

  -- ------------------------------------------------------------
  -- 4. Creation
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, reference, type_key, source, channel, customer_name, customer_phone, contact_id, created_by, data, data_enc)
                                 VALUES (%L, %L, 'CMP-1999-000001', 'closure', 'staff', 'whatsapp', 'Parent One', '+60123456789', %L, %L, '{"reason":"moving"}', 'ciphertext-1')$q$, r1, acctA, cA, uG));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not create a case: %', v_res; END IF;
  IF (SELECT reference FROM compliance_requests WHERE id = r1) <> 'CMP-' || to_char(now() AT TIME ZONE 'utc', 'YYYY') || '-000001' THEN
    RAISE EXCEPTION 'FAIL the first reference is % (a supplied reference should be ignored)', (SELECT reference FROM compliance_requests WHERE id = r1);
  END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name, created_by) VALUES (%L, %L, 'closure', 'form', 'Parent Two', NULL)$q$, r2, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not create a second case: %', v_res; END IF;
  IF (SELECT reference FROM compliance_requests WHERE id = r2) NOT LIKE '%-000002' THEN RAISE EXCEPTION 'FAIL the second reference is not 000002'; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name) VALUES (%L, %L, 'withdrawal', 'staff', 'Parent Three')$q$, r3, acctA));
  v_res := v_res || pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name) VALUES (%L, %L, 'phone_change', 'inbox', 'Parent Four')$q$, r4, acctA));
  IF v_res <> 'OKOK' THEN RAISE EXCEPTION 'FAIL could not create the withdrawal and the phone change: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name) VALUES (%L, %L, 'closure', 'staff', 'B Parent')$q$, rB, acctB));
  IF v_res <> 'OK' OR (SELECT reference FROM compliance_requests WHERE id = rB) NOT LIKE '%-000001' THEN
    RAISE EXCEPTION 'FAIL workspace B should count its own references from 000001 (%): %', v_res, (SELECT reference FROM compliance_requests WHERE id = rB);
  END IF;
  -- the clocks and the checklist come from the type; the case has an event
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r1 AND target_days = 14 AND hard_stop_days = 30
                   AND target_due_at = received_at + interval '14 days' AND hard_stop_at = received_at + interval '30 days'
                   AND status = 'received' AND retention_until >= received_at + interval '7 years' - interval '1 minute') THEN
    RAISE EXCEPTION 'FAIL the closure case has wrong clocks or retention';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r3 AND target_due_at IS NULL AND hard_stop_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL the withdrawal got a clock';
  END IF;
  IF (SELECT count(*) FROM compliance_request_checklist WHERE request_id = r1) <> 3
     OR NOT EXISTS (SELECT 1 FROM compliance_request_checklist WHERE request_id = r1 AND step_key = 'refund' AND label LIKE 'Refund%' AND label_l10n ? 'ms') THEN
    RAISE EXCEPTION 'FAIL the checklist was not copied from the type';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'created' AND actor = uG AND detail ->> 'source' = 'staff') THEN
    RAISE EXCEPTION 'FAIL no created event';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'created' AND (detail ->> 'backdated')::boolean = false AND detail ? 'received_at') THEN
    RAISE EXCEPTION 'FAIL the created event does not carry the request date';
  END IF;
  -- a change of the type does not rewrite the clocks of a case that exists
  UPDATE compliance_request_types SET target_days = 10, hard_stop_days = 20 WHERE account_id = acctA AND key = 'closure';
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r1 AND target_days = 14 AND hard_stop_days = 30) THEN
    RAISE EXCEPTION 'FAIL changing the type rewrote an existing case';
  END IF;
  UPDATE compliance_request_types SET target_days = 14, hard_stop_days = 30 WHERE account_id = acctA AND key = 'closure';

  -- refused creations
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, status) VALUES (%L, 'closure', 'staff', 'X', 'approved')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a case could start past received (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name) VALUES (%L, 'nope', 'staff', 'X')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23503%' AND v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an unknown type was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, received_at) VALUES (%L, 'closure', 'staff', 'X', now() + interval '2 days')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a request date in the future was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, received_at) VALUES (%L, 'closure', 'staff', 'X', now() - interval '500 days')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a request date 500 days ago was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, contact_id) VALUES (%L, 'closure', 'staff', 'X', %L)$q$, acctA, cB));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a link to another workspace contact was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, ticket_id) VALUES (%L, 'closure', 'staff', 'X', %L)$q$, acctA, tkB));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a link to another workspace ticket was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, conversation_id) VALUES (%L, 'closure', 'staff', 'X', %L)$q$, acctA, cvB));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a link to another workspace conversation was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, incident_id) VALUES (%L, 'closure', 'staff', 'X', %L)$q$, acctA, inB));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a link to another workspace incident was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, customer_phone) VALUES (%L, 'closure', 'staff', 'X', '0123456')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a phone number that is not +digits was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name) VALUES (%L, 'closure', 'sms', 'X')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an unknown source was accepted (saw %)', v_res; END IF;
  -- a type in another workspace is not usable (the composite foreign key)
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_types (account_id, key, label, is_system) VALUES (%L, 'b_only', 'B only', false)$q$, acctB));
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name) VALUES (%L, 'b_only', 'staff', 'X')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23503%' AND v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a type of another workspace was usable (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 5. Who sees what (row level security)
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uA, format($q$SELECT count(*)::text FROM compliance_requests WHERE account_id = %L$q$, acctA));
  IF v_res <> '4' THEN RAISE EXCEPTION 'FAIL the owner should see the 4 cases of A (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, 'SELECT count(*)::text FROM compliance_requests');
  IF v_res <> '4' THEN RAISE EXCEPTION 'FAIL the admin should see exactly the 4 cases of A (saw %)', v_res; END IF;
  v_res := pg_temp.run(uG, 'SELECT count(*)::text FROM compliance_requests');
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL an agent without the capability should see only the case they raised (saw %)', v_res; END IF;
  v_res := pg_temp.run(uG, 'SELECT count(*)::text FROM compliance_request_events');
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL the agent should see the events of their own case only (saw %)', v_res; END IF;
  v_res := pg_temp.run(uG, 'SELECT count(*)::text FROM compliance_request_checklist');
  IF v_res <> '3' THEN RAISE EXCEPTION 'FAIL the agent should see the checklist of their own case only (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, 'SELECT count(*)::text FROM compliance_requests');
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer saw a case (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, 'SELECT count(*)::text FROM compliance_requests');
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL the owner of workspace B should see only its own case (saw %)', v_res; END IF;
  v_res := pg_temp.run(uG, 'SELECT count(*)::text FROM compliance_request_types');
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL an agent without menu.compliance read the types (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, 'SELECT count(*)::text FROM compliance_request_types');
  IF v_res::int < 3 THEN RAISE EXCEPTION 'FAIL the admin could not read the types (saw %)', v_res; END IF;
  v_res := pg_temp.run(NULL, 'SELECT count(*)::text FROM compliance_requests', 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the signed-out role could read the cases (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, 'SELECT data_enc FROM compliance_requests LIMIT 1');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the admin could select the ciphertext (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, 'SELECT * FROM compliance_requests LIMIT 1');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL select * is not refused for a browser role (saw %)', v_res; END IF;
  -- granting the capability to the agent role makes the agent a reader (the roles screen does the same through the defaults / overrides)
  INSERT INTO role_capability_defaults (role, capability) VALUES ('agent', 'menu.compliance') ON CONFLICT DO NOTHING;
  v_res := pg_temp.run(uG, 'SELECT count(*)::text FROM compliance_requests');
  IF v_res <> '4' THEN RAISE EXCEPTION 'FAIL an agent holding menu.compliance should see the 4 cases (saw %)', v_res; END IF;
  DELETE FROM role_capability_defaults WHERE role = 'agent' AND capability = 'menu.compliance';
  -- no browser role writes
  FOREACH k IN ARRAY ARRAY[
    format($s$INSERT INTO compliance_requests (account_id, type_key, source, customer_name) VALUES (%L, 'closure', 'staff', 'X')$s$, acctA),
    $s$UPDATE compliance_requests SET customer_name = 'x'$s$,
    $s$DELETE FROM compliance_requests$s$,
    $s$UPDATE compliance_request_checklist SET note = 'x'$s$,
    $s$INSERT INTO compliance_request_events (account_id, request_id, kind) SELECT account_id, id, 'note' FROM compliance_requests$s$,
    $s$UPDATE compliance_request_types SET label = 'x'$s$
  ] LOOP
    v_res := pg_temp.run(uAd, k);
    IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the admin wrote from the browser: % -> %', k, v_res; END IF;
    v_res := pg_temp.run(uA, k);
    IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner wrote from the browser: % -> %', k, v_res; END IF;
  END LOOP;

  -- ------------------------------------------------------------
  -- 6. No plain UPDATE of a protected column, from any role
  -- ------------------------------------------------------------
  FOREACH k IN ARRAY ARRAY[
    $s$status = 'approved'$s$, $s$customer_name = 'Changed'$s$, $s$identity_check = '{"outcome":"pass"}'$s$, $s$signoff = '{"decision":"approved"}'$s$,
    $s$hard_stop_at = now() + interval '90 days'$s$, $s$retention_until = now()$s$, $s$data = '{}'$s$, $s$assigned_to = gen_random_uuid()$s$,
    $s$reference = 'CMP-2026-999999'$s$, $s$type_key = 'withdrawal'$s$, $s$created_by = NULL$s$, $s$account_standing = '{"dues_outstanding":false}'$s$,
    $s$clock_alert_level = 3$s$, $s$clock_paused_at = now()$s$
  ] LOOP
    v_res := pg_temp.svc(format('UPDATE compliance_requests SET %s WHERE id = %L', k, r1));
    IF v_res NOT LIKE 'ERR 42501%' AND v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL the service role could update directly: % -> %', k, v_res; END IF;
    BEGIN
      EXECUTE format('UPDATE compliance_requests SET %s WHERE id = %L', k, r1);
      RAISE EXCEPTION 'FAIL the table owner could update directly: %', k;
    EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
    END;
  END LOOP;
  -- the two things that need no function
  v_res := pg_temp.svc(format($q$UPDATE compliance_requests SET data_enc = 'ciphertext-2' WHERE id = %L$q$, r1));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the re-encryption job could not rewrite data_enc: %', v_res; END IF;
  -- deleting the contact empties the link and nothing else
  DELETE FROM contacts WHERE id = cA;
  -- (in production a contact is soft-deleted by a trigger, so the link stays; on a plain database the foreign key empties it: both are fine, nothing else may change)
  IF COALESCE((SELECT contact_id FROM compliance_requests WHERE id = r1), cA) <> cA OR (SELECT customer_name FROM compliance_requests WHERE id = r1) <> 'Parent One' THEN
    RAISE EXCEPTION 'FAIL deleting a contact did not empty the link cleanly';
  END IF;

  -- ------------------------------------------------------------
  -- 7. The state machine. "Officer" = the first admin (uAd), "Head" = the owner (uA).
  -- ------------------------------------------------------------
  -- every move that is not in the table
  FOREACH k IN ARRAY ARRAY['approved', 'awaiting_signoff', 'executing', 'completed', 'rejected', 'received'] LOOP
    v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, %L, %L)::text$q$, r1, k, uAd));
    IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL received -> % was not refused as an invalid move (saw %)', k, v_res; END IF;
  END LOOP;
  -- the permission each move needs, for the named person
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'identity_check', %L)::text$q$, r1, uV));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a viewer moved a case (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'identity_check', %L)::text$q$, r1, uG));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent without compliance.review moved a case (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'identity_check', %L)::text$q$, r1, gen_random_uuid()));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a person with no profile moved a case (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'identity_check', %L)::text$q$, r1, uB));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner of another workspace moved a case (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'nonsense', %L)::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an unknown status was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'identity_check', %L)::text$q$, gen_random_uuid(), uAd));
  IF v_res NOT LIKE 'ERR P0002%' THEN RAISE EXCEPTION 'FAIL a missing case was not reported (saw %)', v_res; END IF;
  -- the agent gains compliance.review (a role grant) but never the sign-off
  INSERT INTO role_capability_defaults (role, capability) VALUES ('agent', 'compliance.review') ON CONFLICT DO NOTHING;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'identity_check', %L)::text$q$, r1, uG));
  IF v_res NOT LIKE '%"to": "identity_check"%' THEN RAISE EXCEPTION 'FAIL an agent holding compliance.review could not start the identity check (saw %)', v_res; END IF;
  IF (SELECT assigned_to FROM compliance_requests WHERE id = r1) <> uG THEN RAISE EXCEPTION 'FAIL starting the identity check did not assign the case'; END IF;
  DELETE FROM role_capability_defaults WHERE role = 'agent' AND capability = 'compliance.review';

  -- the identity check is recorded with the move to officer_review, and needs its facts
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'officer_review', %L)::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 22023%method_required%' THEN RAISE EXCEPTION 'FAIL the identity check needs a method (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'officer_review', %L, NULL, '{"method":"other","outcome":"pass"}')::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 22023%method_other_required%' THEN RAISE EXCEPTION 'FAIL method other needs words (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'officer_review', %L, NULL, '{"method":"call_back"}')::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 22023%outcome_required%' THEN RAISE EXCEPTION 'FAIL the identity check needs an outcome (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'officer_review', %L, NULL, '{"method":"call_back","outcome":"fail"}')::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 22023%note_required%' THEN RAISE EXCEPTION 'FAIL a failed identity check needs a note (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'officer_review', %L, 'Called the registered number, answered the security questions', '{"method":"call_back","outcome":"pass"}')::text$q$, r1, uAd));
  IF v_res NOT LIKE '%"to": "officer_review"%' THEN RAISE EXCEPTION 'FAIL could not record the identity check: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r1 AND identity_check ->> 'outcome' = 'pass' AND identity_check ->> 'verified_by' = uAd::text
                   AND identity_check ->> 'recorded_by' = uAd::text AND identity_check ->> 'method' = 'call_back' AND identity_check -> 'verified_at' IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL the identity check was not stamped with who and when: %', (SELECT identity_check FROM compliance_requests WHERE id = r1);
  END IF;

  -- the recommendation
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'awaiting_signoff', %L)::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 22023%recommendation_required%' THEN RAISE EXCEPTION 'FAIL a recommendation is needed to hand over (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'awaiting_signoff', %L, 'x', '{"recommendation":"maybe"}')::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL a bad recommendation was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'awaiting_signoff', %L, NULL, '{"recommendation":"reject"}')::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 22023%note_required%' THEN RAISE EXCEPTION 'FAIL a reject recommendation needs notes (saw %)', v_res; END IF;
  -- the dues block (closure): record "outstanding", then try to approve
  v_res := pg_temp.svc(format($q$SELECT public.compliance_set_standing(%L, %L, true, 'Two unpaid allowances')::text$q$, r1, uV));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a viewer recorded the standing (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_set_standing(%L, %L, true, 'Two unpaid allowances')::text$q$, r1, uAd));
  IF v_res NOT LIKE '%"dues_outstanding": true%' THEN RAISE EXCEPTION 'FAIL could not record the standing: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_set_standing(%L, %L, true)::text$q$, r3, uAd));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL the standing was recorded on a type that does not check dues (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'awaiting_signoff', %L, 'Looks genuine', '{"recommendation":"approve"}')::text$q$, r1, uAd));
  IF v_res NOT LIKE '%"to": "awaiting_signoff"%' THEN RAISE EXCEPTION 'FAIL could not hand over for sign-off: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r1 AND review ->> 'recommendation' = 'approve' AND review ->> 'by' = uAd::text) THEN
    RAISE EXCEPTION 'FAIL the recommendation was not stamped';
  END IF;
  -- frozen once with the Head: the answers, not the assignee
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, '{"data": {"reason": "changed"}}')::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 23514%frozen%' THEN RAISE EXCEPTION 'FAIL the answers could change after hand-over (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_set_standing(%L, %L, false)::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL the standing could change after hand-over (saw %)', v_res; END IF;
  -- sign-off: the maker-checker rule, the permission, the dues override
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'approved', %L, NULL, '{"override_reason":"x"}')::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 42501%maker_checker%' THEN RAISE EXCEPTION 'FAIL the person who did the identity check signed off (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'rejected', %L, 'No')::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 42501%maker_checker%' THEN RAISE EXCEPTION 'FAIL the person who did the identity check rejected (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'approved', %L)::text$q$, r1, uG));
  IF v_res NOT LIKE 'ERR 42501%approve%' THEN RAISE EXCEPTION 'FAIL an agent without compliance.approve signed off (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'approved', %L)::text$q$, r1, uA));
  IF v_res NOT LIKE 'ERR 23514%dues_outstanding%' THEN RAISE EXCEPTION 'FAIL approved with dues outstanding and no override (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'approved', %L, 'Dues settled by the family', '{"override_reason":"Settled by bank transfer on 3 Oct"}')::text$q$, r1, uA));
  IF v_res NOT LIKE '%"to": "approved"%' THEN RAISE EXCEPTION 'FAIL the Head could not approve with an override: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r1 AND signoff ->> 'decision' = 'approved' AND signoff ->> 'by' = uA::text
                   AND signoff ->> 'override_reason' LIKE 'Settled%' AND decided_at IS NOT NULL AND status = 'approved') THEN
    RAISE EXCEPTION 'FAIL the sign-off was not stamped: %', (SELECT signoff FROM compliance_requests WHERE id = r1);
  END IF;
  -- execution
  v_res := pg_temp.svc(format($q$SELECT public.compliance_tick_step(%L, 'close_in_backoffice', true, %L)::text$q$, r1, uG));
  IF v_res NOT LIKE 'ERR 42501%execute%' THEN RAISE EXCEPTION 'FAIL an agent without compliance.execute ticked a step (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_tick_step(%L, 'no_such_step', true, %L)::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR P0002%' THEN RAISE EXCEPTION 'FAIL a missing step was not reported (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_tick_step(%L, 'close_in_backoffice', true, %L)::text$q$, r2, uAd));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a step was ticked on a case that is not approved (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'completed', %L)::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 23514%checklist_incomplete%' THEN RAISE EXCEPTION 'FAIL completed with an empty checklist tick (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_tick_step(%L, 'close_in_backoffice', true, %L, 'Done at 10:15')::text$q$, r1, uAd));
  IF v_res NOT LIKE '%"done": true%' THEN RAISE EXCEPTION 'FAIL could not tick a step: %', v_res; END IF;
  IF (SELECT status FROM compliance_requests WHERE id = r1) <> 'executing' THEN RAISE EXCEPTION 'FAIL the first tick should move the case to executing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_checklist WHERE request_id = r1 AND step_key = 'close_in_backoffice' AND done_by = uAd AND done_at IS NOT NULL AND note = 'Done at 10:15') THEN
    RAISE EXCEPTION 'FAIL the tick did not record who, when and the note';
  END IF;
  v_res := pg_temp.svc(format($q$UPDATE compliance_request_checklist SET label = 'Renamed' WHERE request_id = %L$q$, r1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a checklist item was changed without the function (saw %)', v_res; END IF;
  PERFORM public.compliance_tick_step(r1, 'refund', true, uAd);
  PERFORM public.compliance_tick_step(r1, 'refund', false, uAd, 'Not yet, bank rejected the transfer');
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'completed', %L)::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 23514%checklist_incomplete%' THEN RAISE EXCEPTION 'FAIL completed with an unticked step (saw %)', v_res; END IF;
  PERFORM public.compliance_tick_step(r1, 'refund', true, uAd);
  PERFORM public.compliance_tick_step(r1, 'confirm_customer', true, uAd);
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'completed', %L)::text$q$, r1, uAd));
  IF v_res NOT LIKE '%"to": "completed"%' THEN RAISE EXCEPTION 'FAIL could not complete: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'closed', %L, 'Customer told by email')::text$q$, r1, uAd));
  IF v_res NOT LIKE '%"to": "closed"%' THEN RAISE EXCEPTION 'FAIL could not close: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r1 AND status = 'closed' AND closed_at IS NOT NULL AND completed_at IS NOT NULL
                   AND retention_until >= closed_at + interval '7 years' - interval '1 minute') THEN
    RAISE EXCEPTION 'FAIL closing did not stamp the dates and extend the retention';
  END IF;
  FOREACH k IN ARRAY ARRAY['received', 'identity_check', 'officer_review', 'awaiting_signoff', 'approved', 'rejected', 'executing', 'completed', 'closed'] LOOP
    v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, %L, %L, 'x')::text$q$, r1, k, uAd));
    IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a closed case moved to % (saw %)', k, v_res; END IF;
  END LOOP;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, '{"assigned_to": null}')::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 23514%closed%' THEN RAISE EXCEPTION 'FAIL a closed case could be edited (saw %)', v_res; END IF;
  -- the trail of the whole walk
  SELECT string_agg(kind || coalesce(':' || (detail ->> 'to'), ''), ' ' ORDER BY seq) INTO v_res FROM compliance_request_events WHERE request_id = r1;
  IF v_res NOT LIKE 'created status:identity_check identity_check status:officer_review standing review status:awaiting_signoff signoff status:approved status:executing execute_step%status:completed status:closed' THEN
    RAISE EXCEPTION 'FAIL the trail of the case is not what the walk did: %', v_res;
  END IF;

  -- the rejection path (r2, raised by the form: no created_by) and send-back
  PERFORM public.compliance_transition(r2, 'officer_review', uAd, NULL, '{"method":"video_call","outcome":"pass"}');
  PERFORM public.compliance_transition(r2, 'awaiting_signoff', uAd, 'Please check the name', '{"recommendation":"more_info"}');
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'officer_review', %L)::text$q$, r2, uAd2));
  IF v_res NOT LIKE 'ERR 22023%note_required%' THEN RAISE EXCEPTION 'FAIL sending back needs a note (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'officer_review', %L, 'Name does not match')::text$q$, r2, uG));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL only the Head sends a case back (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'officer_review', %L, 'Name does not match')::text$q$, r2, uAd2));
  IF v_res NOT LIKE '%"to": "officer_review"%' THEN RAISE EXCEPTION 'FAIL the Head could not send a case back: %', v_res; END IF;
  PERFORM public.compliance_transition(r2, 'awaiting_signoff', uAd, 'Not the registered holder', '{"recommendation":"reject"}');
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'rejected', %L)::text$q$, r2, uA));
  IF v_res NOT LIKE 'ERR 22023%note_required%' THEN RAISE EXCEPTION 'FAIL a rejection needs a reason (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'rejected', %L, 'Could not verify the account holder')::text$q$, r2, uAd2));
  IF v_res NOT LIKE '%"to": "rejected"%' THEN RAISE EXCEPTION 'FAIL a second admin could not reject: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r2 AND outcome_reason = 'Could not verify the account holder' AND signoff ->> 'decision' = 'rejected') THEN
    RAISE EXCEPTION 'FAIL the rejection reason was not kept';
  END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'closed', %L, 'Customer told')::text$q$, r2, uAd));
  IF v_res NOT LIKE '%"to": "closed"%' THEN RAISE EXCEPTION 'FAIL a rejected case could not be closed: %', v_res; END IF;

  -- closing without a decision (a duplicate), and an approval needs a passed identity check
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'closed', %L)::text$q$, r3, uAd));
  IF v_res NOT LIKE 'ERR 22023%note_required%' THEN RAISE EXCEPTION 'FAIL closing without a decision needs a note (saw %)', v_res; END IF;
  PERFORM public.compliance_transition(r3, 'officer_review', uAd, 'Could not reach the parent', '{"method":"call_back","outcome":"fail"}');
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'awaiting_signoff', %L, 'ok', '{"recommendation":"approve"}')::text$q$, r3, uAd));
  IF v_res NOT LIKE 'ERR 23514%identity_not_passed%' THEN RAISE EXCEPTION 'FAIL recommended approval after a failed identity check (saw %)', v_res; END IF;
  PERFORM public.compliance_transition(r3, 'awaiting_signoff', uAd, 'Failed identity check', '{"recommendation":"reject"}');
  -- a type that needs no identity check goes straight through, and anyone who signs off may (nobody recorded a check)
  UPDATE compliance_request_types SET requires_identity_check = false WHERE account_id = acctA AND key = 'phone_change';
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'officer_review', %L)::text$q$, r4, uAd));
  IF v_res NOT LIKE '%"to": "officer_review"%' THEN RAISE EXCEPTION 'FAIL a type with no identity check could not skip it: %', v_res; END IF;
  PERFORM public.compliance_transition(r4, 'awaiting_signoff', uAd, NULL, '{"recommendation":"approve"}');
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'approved', %L)::text$q$, r4, uAd));
  IF v_res NOT LIKE '%"to": "approved"%' THEN RAISE EXCEPTION 'FAIL maker-checker blocked a case with no identity check: %', v_res; END IF;
  UPDATE compliance_request_types SET requires_identity_check = true WHERE account_id = acctA AND key = 'phone_change';

  -- ------------------------------------------------------------
  -- 8. Edits
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, '{"status": "approved"}')::text$q$, r3, uAd));
  IF v_res NOT LIKE 'ERR 22023%unknown_field%' THEN RAISE EXCEPTION 'FAIL an unknown key in an edit was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, '{"assigned_to": null}')::text$q$, r3, uV));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a viewer edited a case (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, jsonb_build_object('assigned_to', %L))::text$q$, r3, uAd, uV));
  IF v_res NOT LIKE 'ERR 23514%assignee%' THEN RAISE EXCEPTION 'FAIL a case was assigned to someone who cannot see it (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, jsonb_build_object('ticket_id', %L))::text$q$, r3, uAd, tkB));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an edit linked another workspace ticket (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, jsonb_build_object('ticket_id', %L, 'assigned_to', %L, 'kyc_validation_ref', 'val_123'))::text$q$, r3, uAd, tkA, uAd2));
  IF v_res NOT LIKE '%"id"%' THEN RAISE EXCEPTION 'FAIL a legal edit was refused: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r3 AND kind = 'link' AND detail ->> 'field' = 'ticket_id' AND detail ->> 'to' = tkA::text)
     OR NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r3 AND kind = 'assigned' AND detail ->> 'to' = uAd2::text)
     OR NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r3 AND kind = 'link' AND detail ->> 'field' = 'kyc_validation_ref') THEN
    RAISE EXCEPTION 'FAIL the edit did not write its events';
  END IF;
  -- the request date moves the clocks and is audited
  PERFORM public.compliance_update_request(r4, uAd, '{"kyc_validation_ref": "val_9"}');
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name) VALUES (%L, %L, 'closure', 'staff', 'Dated')$q$, rS, acctA));
  SELECT hard_stop_at, received_at INTO v_ts, v_ts2 FROM compliance_requests WHERE id = rS;
  PERFORM public.compliance_update_request(rS, uAd, jsonb_build_object('received_at', (v_ts2 - interval '4 days')::text));
  IF (SELECT hard_stop_at FROM compliance_requests WHERE id = rS) <> v_ts - interval '4 days'
     OR (SELECT target_due_at FROM compliance_requests WHERE id = rS) <> v_ts2 - interval '4 days' + interval '14 days' THEN
    RAISE EXCEPTION 'FAIL moving the request date did not move the clocks';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = rS AND kind = 'edited' AND detail -> 'fields' ? 'received_at' AND detail ? 'from' AND detail ? 'to') THEN
    RAISE EXCEPTION 'FAIL the request date change was not audited with from and to';
  END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, jsonb_build_object('received_at', (now() + interval '3 days')::text))::text$q$, rS, uAd));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a request date in the future was accepted by an edit (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 9. The pause
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$SELECT public.compliance_clock(%L, %L, 'pause', 'Waiting for the parent')::text$q$, rS, uAd));
  IF v_res NOT LIKE 'ERR 23514%pause_not_allowed%' THEN RAISE EXCEPTION 'FAIL a type that does not allow a pause was paused (saw %)', v_res; END IF;
  UPDATE compliance_request_types SET allow_pause = true WHERE account_id = acctA AND key = 'closure';
  v_res := pg_temp.svc(format($q$SELECT public.compliance_clock(%L, %L, 'pause', 'x')::text$q$, rS, uG));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent paused the clock (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_clock(%L, %L, 'pause', '   ')::text$q$, rS, uAd));
  IF v_res NOT LIKE 'ERR 22023%note_required%' THEN RAISE EXCEPTION 'FAIL a pause without a note was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_clock(%L, %L, 'resume', 'x')::text$q$, rS, uAd));
  IF v_res NOT LIKE 'ERR 23514%not_paused%' THEN RAISE EXCEPTION 'FAIL resumed a clock that was not paused (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_clock(%L, %L, 'pause', 'Waiting for the parent')::text$q$, rS, uAd));
  IF v_res NOT LIKE '%"action": "pause"%' THEN RAISE EXCEPTION 'FAIL could not pause: %', v_res; END IF;
  IF (SELECT clock_paused_at FROM compliance_requests WHERE id = rS) IS NULL THEN RAISE EXCEPTION 'FAIL the pause was not stamped'; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_clock(%L, %L, 'pause', 'again')::text$q$, rS, uAd));
  IF v_res NOT LIKE 'ERR 23514%already_paused%' THEN RAISE EXCEPTION 'FAIL paused twice (saw %)', v_res; END IF;
  -- three days later (the owner of the table rewinds the pause start to say so), the resume moves both deadlines by that time
  SELECT hard_stop_at, target_due_at INTO v_ts, v_ts2 FROM compliance_requests WHERE id = rS;
  ALTER TABLE compliance_requests DISABLE TRIGGER compliance_requests_guard;
  UPDATE compliance_requests SET clock_paused_at = clock_paused_at - interval '3 days' WHERE id = rS;
  ALTER TABLE compliance_requests ENABLE TRIGGER compliance_requests_guard;
  PERFORM public.compliance_clock(rS, uA, 'resume', 'Parent replied');
  IF (SELECT hard_stop_at FROM compliance_requests WHERE id = rS) - v_ts NOT BETWEEN interval '3 days' AND interval '3 days 1 minute'
     OR (SELECT target_due_at FROM compliance_requests WHERE id = rS) - v_ts2 NOT BETWEEN interval '3 days' AND interval '3 days 1 minute'
     OR (SELECT paused_total_seconds FROM compliance_requests WHERE id = rS) < 259200
     OR (SELECT clock_paused_at FROM compliance_requests WHERE id = rS) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL resuming did not shift the deadlines by the time paused';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = rS AND kind = 'clock_pause' AND detail ->> 'note' = 'Waiting for the parent')
     OR NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = rS AND kind = 'clock_resume') THEN
    RAISE EXCEPTION 'FAIL the pause and the resume were not logged with their notes';
  END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_clock(%L, %L, 'pause', 'x')::text$q$, r3, uAd));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a withdrawal with no clock was paused (saw %)', v_res; END IF;
  UPDATE compliance_request_types SET allow_pause = false WHERE account_id = acctA AND key = 'closure';

  -- ------------------------------------------------------------
  -- 10. The clock sweep
  -- ------------------------------------------------------------
  -- rS: request date 4 days ago, 30-day stop: not near. A case 22 days old is 8 days from the stop (10-day threshold), a paused one never alerts.
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name, received_at) VALUES (%L, %L, 'closure', 'staff', 'Old', now() - interval '22 days')$q$, rP, acctA));
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name, received_at) VALUES (%L, %L, 'closure', 'staff', 'Old B', now() - interval '22 days')$q$, rC, acctB));
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = rP AND kind = 'created' AND (detail ->> 'backdated')::boolean) THEN
    RAISE EXCEPTION 'FAIL a back-dated case is not flagged in its created event';
  END IF;
  v_json := public.compliance_clock_alert_sweep(now());
  IF (v_json ->> 'alerted')::int <> 1 THEN RAISE EXCEPTION 'FAIL the sweep should alert the one case 8 days from its stop (A only; B has the flag off): %', v_json; END IF;
  IF (v_json ->> 'notified')::int <> 3 THEN RAISE EXCEPTION 'FAIL the sweep should notify the owner and the two admins (holders of review / approve): %', v_json; END IF;
  IF (SELECT clock_alert_level FROM compliance_requests WHERE id = rP) <> 1 OR (SELECT clock_alert_level FROM compliance_requests WHERE id = rC) <> 0 THEN
    RAISE EXCEPTION 'FAIL the alert levels are wrong after the first sweep';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = rP AND kind = 'clock_alert' AND (detail ->> 'threshold')::int = 10) THEN
    RAISE EXCEPTION 'FAIL no clock_alert event for the 10-day threshold';
  END IF;
  IF EXISTS (SELECT 1 FROM notifications WHERE type = 'compliance_clock' AND (user_id IN (uG, uV, uB))) THEN
    RAISE EXCEPTION 'FAIL a notification went to someone who holds neither compliance.review nor compliance.approve';
  END IF;
  IF (SELECT count(*) FROM notifications WHERE type = 'compliance_clock' AND compliance_request_id = rP) <> 3 THEN
    RAISE EXCEPTION 'FAIL the notifications do not carry the case';
  END IF;
  v_json := public.compliance_clock_alert_sweep(now());
  IF (v_json ->> 'alerted')::int <> 0 THEN RAISE EXCEPTION 'FAIL the sweep repeated an alert: %', v_json; END IF;
  v_json := public.compliance_clock_alert_sweep(now() + interval '4 days');
  IF (v_json ->> 'alerted')::int <> 1 OR (SELECT clock_alert_level FROM compliance_requests WHERE id = rP) <> 2 THEN
    RAISE EXCEPTION 'FAIL the 5-day alert did not fire once: %', v_json;
  END IF;
  v_json := public.compliance_clock_alert_sweep(now() + interval '4 days');
  IF (v_json ->> 'alerted')::int <> 0 THEN RAISE EXCEPTION 'FAIL the 5-day alert repeated'; END IF;
  v_json := public.compliance_clock_alert_sweep(now() + interval '9 days');
  IF (v_json ->> 'alerted')::int <> 1 OR (SELECT clock_alert_level FROM compliance_requests WHERE id = rP) <> 3 THEN
    RAISE EXCEPTION 'FAIL the alert at the hard stop did not fire once: %', v_json;
  END IF;
  IF (SELECT count(*) FROM compliance_request_events WHERE request_id = rP AND kind = 'clock_alert') <> 3 THEN
    RAISE EXCEPTION 'FAIL expected exactly three clock_alert events for the case';
  END IF;
  -- far in the future only the case that never alerted yet (the dated one, rS) does, at its breach; rP does not repeat
  v_json := public.compliance_clock_alert_sweep(now() + interval '40 days');
  IF (v_json ->> 'alerted')::int <> 1 OR (SELECT clock_alert_level FROM compliance_requests WHERE id = rS) <> 3
     OR (SELECT count(*) FROM compliance_request_events WHERE request_id = rP AND kind = 'clock_alert') <> 3 THEN
    RAISE EXCEPTION 'FAIL a case alerted after its breach alert, or the dated case did not alert at its breach: %', v_json;
  END IF;
  v_json := public.compliance_clock_alert_sweep(now() + interval '40 days');
  IF (v_json ->> 'alerted')::int <> 0 THEN RAISE EXCEPTION 'FAIL the alert at the breach repeated: %', v_json; END IF;
  -- the flag on for B: its old case alerts, once
  UPDATE account_platform SET features = features || '{"compliance": true}'::jsonb WHERE account_id = acctB;
  v_json := public.compliance_clock_alert_sweep(now());
  IF (v_json ->> 'alerted')::int <> 1 OR (v_json ->> 'notified')::int <> 1 THEN RAISE EXCEPTION 'FAIL B''s case did not alert once to its owner after the flag went on: %', v_json; END IF;
  UPDATE account_platform SET features = features || '{"compliance": false}'::jsonb WHERE account_id = acctB;
  -- a paused case and a finished case never alert
  ALTER TABLE compliance_requests DISABLE TRIGGER compliance_requests_guard;
  UPDATE compliance_requests SET clock_alert_level = 0, clock_paused_at = now() WHERE id = rP;
  ALTER TABLE compliance_requests ENABLE TRIGGER compliance_requests_guard;
  v_json := public.compliance_clock_alert_sweep(now() + interval '40 days');
  IF (v_json ->> 'alerted')::int <> 0 THEN RAISE EXCEPTION 'FAIL a paused case alerted: %', v_json; END IF;
  v_res := pg_temp.svc(format($q$SELECT * FROM notifications WHERE type = 'bogus'$q$));
  v_res := pg_temp.svc($q$INSERT INTO notifications (account_id, user_id, type, title) SELECT account_id, user_id, 'not_a_type', 'x' FROM profiles LIMIT 1$q$);
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL the notification type check no longer refuses an unknown type (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 11. Files
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_files (account_id, request_id, field_key, name, mime, size_bytes, sha256, path, uploaded_by)
                                 VALUES (%L, %L, 'authorization_letter', 'letter.pdf', 'application/pdf', 1234, repeat('a', 64), 'account-x/y/letter.pdf', %L)$q$, acctA, r3, uAd));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not record a file: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r3 AND kind = 'attachment' AND actor = uAd AND detail ->> 'name' = 'letter.pdf') THEN
    RAISE EXCEPTION 'FAIL the upload wrote no attachment event';
  END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_files (account_id, request_id, name, mime, size_bytes, sha256, path) VALUES (%L, %L, 'x.html', 'text/html', 5, repeat('a', 64), 'account-x/y/x')$q$, acctA, r3));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a text/html file was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_files (account_id, request_id, name, mime, size_bytes, sha256, path) VALUES (%L, %L, 'x.pdf', 'application/pdf', 5, 'zz', 'account-x/y/x')$q$, acctA, r3));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a bad hash was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$UPDATE compliance_request_files SET name = 'renamed.pdf' WHERE request_id = %L$q$, r3));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a file row was changed (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT count(*)::text FROM compliance_request_files WHERE request_id = %L$q$, r3));
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL the admin could not list the file metadata (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, 'SELECT path FROM compliance_request_files LIMIT 1');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a browser role selected the storage path (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_files (account_id, request_id, name, mime, size_bytes, sha256, path) VALUES (%L, %L, 'x.pdf', 'application/pdf', 5, repeat('b', 64), 'account-x/y/x')$q$, acctB, r3));
  IF v_res NOT LIKE 'ERR 23503%' THEN RAISE EXCEPTION 'FAIL a file was attached to a case of another workspace (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_events (account_id, request_id, kind) VALUES (%L, %L, 'note')$q$, acctB, r3));
  IF v_res NOT LIKE 'ERR 23503%' THEN RAISE EXCEPTION 'FAIL an event was written for a case of another workspace (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_events (account_id, request_id, kind, detail) VALUES (%L, %L, 'view', '{"x":1}')$q$, acctA, r3));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the server could not write a view event: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_events (account_id, request_id, kind) VALUES (%L, %L, 'made_up')$q$, acctA, r3));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an unknown event kind was accepted (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 12. Retention
  -- ------------------------------------------------------------
  FOREACH k IN ARRAY ARRAY[
    format($s$DELETE FROM compliance_requests WHERE id = %L$s$, r1),
    format($s$DELETE FROM compliance_request_events WHERE request_id = %L$s$, r1),
    format($s$DELETE FROM compliance_request_checklist WHERE request_id = %L$s$, r1),
    format($s$DELETE FROM compliance_request_files WHERE request_id = %L$s$, r3),
    format($s$UPDATE compliance_request_events SET kind = 'note' WHERE request_id = %L$s$, r1),
    $s$TRUNCATE compliance_request_events$s$,
    $s$TRUNCATE compliance_requests$s$
  ] LOOP
    v_res := pg_temp.svc(k);
    -- a TRUNCATE of a table other tables reference is refused by the database itself (0A000) before the trigger is reached; either way it is refused
    IF v_res NOT LIKE 'ERR 42501%' AND NOT (k LIKE 'TRUNCATE%' AND v_res LIKE 'ERR 0A000%') THEN RAISE EXCEPTION 'FAIL the service role could change retained data: % -> %', k, v_res; END IF;
    BEGIN
      EXECUTE k;
      RAISE EXCEPTION 'FAIL the table owner could change retained data: %', k;
    EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN NULL;
    END;
  END LOOP;
  IF (SELECT count(*) FROM compliance_request_events WHERE request_id = r1) < 12 OR (SELECT count(*) FROM compliance_request_checklist WHERE request_id = r1) <> 3 THEN
    RAISE EXCEPTION 'FAIL retained rows went missing';
  END IF;
  -- the purge exception is for the workspace being purged only
  PERFORM set_config('vircle.purge_account', acctB::text, true);
  BEGIN
    DELETE FROM compliance_requests WHERE id = r1;
    RAISE EXCEPTION 'FAIL a purge of workspace B deleted a case of workspace A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  v_res := pg_temp.svc(format($q$DELETE FROM compliance_requests WHERE id = %L$q$, rB));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the purge exception applied to the service role (saw %)', v_res; END IF;
  PERFORM set_config('vircle.purge_account', '', true);
  -- a case past its retention may go, with its children (no job does this; Halo never deletes a case)
  ALTER TABLE compliance_requests DISABLE TRIGGER compliance_requests_guard;
  UPDATE compliance_requests SET retention_until = now() - interval '1 day' WHERE id = r2;
  ALTER TABLE compliance_requests ENABLE TRIGGER compliance_requests_guard;
  v_res := pg_temp.svc(format($q$DELETE FROM compliance_requests WHERE id = %L$q$, r2));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a case past its retention could not be deleted (saw %)', v_res; END IF;
  IF EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r2) OR EXISTS (SELECT 1 FROM compliance_request_checklist WHERE request_id = r2) THEN
    RAISE EXCEPTION 'FAIL the children of a case that was allowed to go remain';
  END IF;

  -- ------------------------------------------------------------
  -- 13. A workspace leaves with everything (the purge), and the export leaves out the ciphertext
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name, data_enc) VALUES (%L, %L, 'closure', 'staff', 'C Parent', 'cipher')$q$, gen_random_uuid(), acctC));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not create a case in C: %', v_res; END IF;
  IF to_regproc('public.workspace_export_manifest') IS NOT NULL THEN
    v_json := public.workspace_export_manifest();
    FOREACH k IN ARRAY ARRAY['compliance_requests', 'compliance_request_events', 'compliance_request_checklist', 'compliance_request_files', 'compliance_request_types'] LOOP
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_json) e WHERE e ->> 'table' = k) THEN
        RAISE EXCEPTION 'FAIL % is not in the workspace export', k;
      END IF;
    END LOOP;
    v_json := public.workspace_export_rows(acctA, 'compliance_requests');
    IF v_json::text LIKE '%data_enc%' OR v_json::text LIKE '%ciphertext-2%' THEN
      RAISE EXCEPTION 'FAIL the export carries the ciphertext column';
    END IF;
    IF jsonb_array_length(v_json -> 'rows') < 3 OR v_json::text LIKE '%' || acctC::text || '%' THEN
      RAISE EXCEPTION 'FAIL the export of compliance_requests is wrong: %', left(v_json::text, 200);
    END IF;
  END IF;
  IF to_regproc('public.delete_workspace_data') IS NOT NULL AND to_regproc('public.workspace_deletion_begin') IS NOT NULL THEN
    UPDATE account_platform SET deletion_due_at = now() - interval '1 minute' WHERE account_id = acctC;
    PERFORM public.workspace_deletion_begin(acctC);
    PERFORM public.delete_workspace_data(acctC);
  ELSE
    PERFORM set_config('vircle.purge_account', acctC::text, true);
    PERFORM set_config('vircle.hard_delete', 'on', true);
    DELETE FROM public.profiles WHERE account_id = acctC;
    DELETE FROM public.account_platform WHERE account_id = acctC;
    DELETE FROM public.accounts WHERE id = acctC;
  END IF;
  PERFORM set_config('vircle.purge_account', '', true);
  IF EXISTS (SELECT 1 FROM compliance_requests WHERE account_id = acctC) OR EXISTS (SELECT 1 FROM compliance_request_events WHERE account_id = acctC)
     OR EXISTS (SELECT 1 FROM compliance_request_types WHERE account_id = acctC) THEN
    RAISE EXCEPTION 'FAIL the cases, events or types of a deleted workspace remain';
  END IF;
  IF (SELECT count(*) FROM compliance_requests WHERE account_id = acctA) <> 5 THEN
    RAISE EXCEPTION 'FAIL deleting workspace C touched workspace A';
  END IF;

  -- ------------------------------------------------------------
  -- 14. Functions and the bucket
  -- ------------------------------------------------------------
  FOREACH fn IN ARRAY ARRAY[
    'compliance_user_can(uuid,uuid,text)', 'compliance_holders(uuid,text)', 'compliance_label(text,text,text,text)', 'compliance_seed_types(uuid)', 'compliance_accounts_seed()',
    'compliance_types_guard()', 'compliance_requests_guard()', 'compliance_requests_after_insert()', 'compliance_requests_no_delete()',
    'compliance_children_no_delete()', 'compliance_events_no_update()', 'compliance_checklist_guard()', 'compliance_files_after_insert()',
    'compliance_update_request(uuid,uuid,jsonb)', 'compliance_event(uuid,uuid,uuid,text,jsonb)', 'compliance_transition(uuid,text,uuid,text,jsonb)',
    'compliance_tick_step(uuid,text,boolean,uuid,text)', 'compliance_set_standing(uuid,uuid,boolean,text)', 'compliance_clock(uuid,uuid,text,text)',
    'compliance_clock_alert_sweep(timestamptz)'
  ] LOOP
    IF has_function_privilege('authenticated', 'public.' || fn, 'EXECUTE') OR has_function_privilege('anon', 'public.' || fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL % is callable by the API roles', fn;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname LIKE 'compliance\_%'
                AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'FAIL a compliance function does not pin its search_path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'compliance-files' AND NOT public) THEN
    RAISE EXCEPTION 'FAIL the private bucket compliance-files is missing or public';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: the six compliance capabilities (owner and admin by default, never a viewer); the compliance flag is an explicit false on every workspace and starts false for a new one; three system types per workspace, closure 14 / 30 days; references count per workspace per year; clocks and checklist come from the type and are not rewritten; status moves only through compliance_transition (invalid moves, capability per move for the named person, identity check, recommendation, reject reason, dues override, maker-checker, checklist complete); no plain UPDATE of a protected column from any role; edits, standing, pause and ticks have their functions and events; the sweep alerts once per threshold and honours the flag, a pause and the recipients; rows are visible to menu.compliance holders and the case raiser only, ciphertext and storage path are not selectable; retention refuses delete and truncate for every role except the purge of the workspace itself; the export leaves out data_enc; the functions are not callable by the API roles';
END
$verify$;
