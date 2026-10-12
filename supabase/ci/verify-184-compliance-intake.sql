-- Verify migration 184 (Compliance requests, Part B: the public parent forms, the emails, raising from the Inbox and tickets, the reports).
-- Self-contained; run against an empty database or production with the text of 183 and 184 in front when they are not applied yet (182 before 183).
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Written against the REAL schema: contacts need a phone, tickets a ticket_number, contact_id and subject, conversations a user_id and contact_id,
-- and nothing here deletes a contact (production soft-deletes them with a trigger).
--
-- Proves: (1) compliance.raise is in the catalogue (agent-grantable, app tier), owner and admin hold it by default, an agent and a viewer do not, and it
-- cannot be granted to a viewer role; (2) a notification of type compliance_signoff is accepted and an unknown type still is not; (3) the timeline accepts
-- the 'notice' kind and still refuses an unknown one; (4) the case has customer_locale (four languages only) and email_verified_at; (5) one OPEN request per
-- type per verified email from the form is held by a unique index, case-insensitively, and does not stop a staff-raised case, another type, another
-- email, another workspace, or a new request after the first was rejected; (6) the raiser can no longer read the case, its events, checklist or files
-- through the browser's access (a holder of menu.compliance still can, a viewer and another workspace cannot); (7) the public forms table: only the two
-- customer types, a slug that cannot be guessed or repeated, one form per type per workspace, the amount and the bank list checked, nothing readable or
-- writable from a browser role; (8) the emailed codes: hashes only, scoped to a form of the same workspace, attempts capped, gone with the form;
-- (9) the notices: one claim per (case, kind, key), kinds / audiences / statuses checked, tied to a case of the same workspace, a claim can be taken over
-- by the service role, never deleted while the case is under retention; (10) the exports log: written by the service role, never changed or deleted or
-- truncated by anyone; (11) the intake fields (declaration, reason_kind, proof) are on the standard types of every workspace including a new one, an
-- administrator's edit survives a second run, and a type that lost one gets it back; (12) compliance_transition still holds 183's rules (maker-checker,
-- the capability for the named person, the transition table) and now keeps a rejection's category and the customer's words in the sign-off, refuses a
-- category that is not one, and accepts a rejection without them (the route and the screen require them); (13) none of the new functions is callable
-- by a browser role and the security definer ones pin their search_path; every new table has row level security and no browser privilege.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();  -- owner of workspace A (the "Head": holds every capability)
  uAd     uuid := gen_random_uuid();  -- admin of A (the "officer" who records the identity check)
  uG      uuid := gen_random_uuid();  -- an agent of A (the raiser, holds compliance.raise only when granted)
  uV      uuid := gen_random_uuid();  -- a viewer of A
  uB      uuid := gen_random_uuid();  -- owner of workspace B
  acctA   uuid;
  acctB   uuid;
  cA      uuid := gen_random_uuid();
  cB      uuid := gen_random_uuid();
  tkA     uuid := gen_random_uuid();
  cvA     uuid := gen_random_uuid();
  r1      uuid := gen_random_uuid();  -- a form case that walks to a rejection with the customer's words
  r2      uuid := gen_random_uuid();  -- a case rejected without them
  r3      uuid := gen_random_uuid();  -- a staff-raised case (same email as r1)
  r4      uuid := gen_random_uuid();  -- a case raised by the agent (the raiser)
  r5      uuid := gen_random_uuid();  -- a case of workspace B
  fA      uuid := gen_random_uuid();  -- the public closure form of A
  fB      uuid := gen_random_uuid();  -- a public form of B
  nA      uuid := gen_random_uuid();
  v_res   text;
  v_n     int;
  v_json  jsonb;
  k       text;
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
  EXECUTE $f$ CREATE FUNCTION pg_temp.svc(q TEXT) RETURNS TEXT LANGUAGE sql AS $b$ SELECT pg_temp.run(NULL, q, 'service_role') $b$; $f$;

  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-'  || uA  || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uAd, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ad-' || uAd || '@example.invalid', '{"full_name":"Officer"}', now()),
    (uG,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g-'  || uG  || '@example.invalid', '{"full_name":"Agent"}', now()),
    (uV,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'v-'  || uV  || '@example.invalid', '{"full_name":"Viewer"}', now()),
    (uB,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'  || uB  || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  UPDATE profiles SET account_id = acctA, account_role = 'admin'  WHERE user_id = uAd;
  UPDATE profiles SET account_id = acctA, account_role = 'agent'  WHERE user_id = uG;
  UPDATE profiles SET account_id = acctA, account_role = 'viewer' WHERE user_id = uV;

  -- ------------------------------------------------------------
  -- 1. The capability
  -- ------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM capability_catalogue WHERE capability = 'compliance.raise' AND min_grant_role = 'agent' AND enforced_by = 'app') THEN
    RAISE EXCEPTION 'FAIL compliance.raise is not in the catalogue as an agent-grantable app capability';
  END IF;
  IF (SELECT count(*) FROM role_capability_defaults WHERE capability = 'compliance.raise') <> 2
     OR NOT EXISTS (SELECT 1 FROM role_capability_defaults WHERE capability = 'compliance.raise' AND role = 'owner')
     OR NOT EXISTS (SELECT 1 FROM role_capability_defaults WHERE capability = 'compliance.raise' AND role = 'admin') THEN
    RAISE EXCEPTION 'FAIL compliance.raise should default to the owner and the admin only';
  END IF;
  v_res := pg_temp.run(uA,  format($q$SELECT has_capability(%L, 'compliance.raise')::text$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the owner should hold compliance.raise (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT has_capability(%L, 'compliance.raise')::text$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the admin should hold compliance.raise (saw %)', v_res; END IF;
  v_res := pg_temp.run(uG,  format($q$SELECT has_capability(%L, 'compliance.raise')::text$q$, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL an agent should not hold compliance.raise by default (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV,  format($q$SELECT has_capability(%L, 'compliance.raise')::text$q$, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL a viewer should not hold compliance.raise (saw %)', v_res; END IF;
  IF to_regproc('public.set_role_capabilities') IS NOT NULL THEN
    v_res := pg_temp.run(uA, format($q$SELECT public.set_role_capabilities(%L, 'viewer'::account_role_enum, '{"compliance.raise": true}'::jsonb)::text$q$, acctA));
    IF v_res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL compliance.raise could be granted to the viewer role: %', v_res; END IF;
  END IF;
  -- raising does not need the Compliance menu: the capability is separate from menu.compliance
  INSERT INTO role_capability_defaults (role, capability) VALUES ('agent', 'compliance.raise') ON CONFLICT DO NOTHING;
  v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'compliance.raise')::text || has_capability(%L, 'menu.compliance')::text$q$, acctA, acctA));
  IF v_res <> 'truefalse' THEN RAISE EXCEPTION 'FAIL granting compliance.raise to the agent role should not grant menu.compliance (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 2 and 3. Notification type, event kind
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$INSERT INTO notifications (account_id, user_id, type, title, body) VALUES (%L, %L, 'compliance_signoff', 'x', 'y')$q$, acctA, uA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a compliance_signoff notification was refused: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO notifications (account_id, user_id, type, title, body) VALUES (%L, %L, 'compliance_clock', 'x', 'y')$q$, acctA, uA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL 183''s compliance_clock type was lost: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO notifications (account_id, user_id, type, title, body) VALUES (%L, %L, 'not_a_type', 'x', 'y')$q$, acctA, uA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an unknown notification type was accepted (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 4. The case: language and proof of the email; creation
  -- ------------------------------------------------------------
  INSERT INTO contacts (id, account_id, phone) VALUES (cA, acctA, '+60100000184'), (cB, acctB, '+60100000185');
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject) VALUES (tkA, acctA, 1, cA, 'verify A');
  INSERT INTO conversations (id, user_id, account_id, contact_id) VALUES (cvA, uA, acctA, cA);

  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, channel, customer_name, customer_email, customer_phone, customer_locale, email_verified_at, data)
                                 VALUES (%L, %L, 'closure', 'form', 'web_form', 'Parent One', 'Siti@Example.test', '+60123456789', 'ms', now(), '{"declaration":true}')$q$, r1, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not create a form case with a language and a verified email: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r1 AND customer_locale = 'ms' AND email_verified_at IS NOT NULL AND source = 'form' AND status = 'received') THEN
    RAISE EXCEPTION 'FAIL the language and the verified-email time were not stored';
  END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, customer_locale) VALUES (%L, 'phone_change', 'staff', 'X', 'fr')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a language other than en, ms, zh, ko was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_events (account_id, request_id, kind, detail) VALUES (%L, %L, 'notice', '{"notice":"received","status":"sent"}')$q$, acctA, r1));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the timeline refused the notice kind: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_events (account_id, request_id, kind) VALUES (%L, %L, 'emailed')$q$, acctA, r1));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an unknown event kind was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$UPDATE compliance_request_events SET kind = 'note' WHERE request_id = %L AND kind = 'notice'$q$, r1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an event could be changed (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 5. One open request per type per verified email (from the form)
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, customer_email) VALUES (%L, 'closure', 'form', 'Parent Again', 'SITI@example.TEST')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23505%compliance_requests_form_open_email%' THEN RAISE EXCEPTION 'FAIL a second open form request from the same email (any case) was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name, customer_email) VALUES (%L, %L, 'closure', 'staff', 'Staff Raised', 'siti@example.test')$q$, r3, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the index stopped a staff-raised case (it is for the form only): %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, customer_email) VALUES (%L, 'withdrawal', 'form', 'Other Type', 'siti@example.test')$q$, acctA));
  v_res := v_res || pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, customer_email) VALUES (%L, 'closure', 'form', 'Other Email', 'someone.else@example.test')$q$, acctA));
  v_res := v_res || pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name, customer_email) VALUES (%L, %L, 'closure', 'form', 'Workspace B', 'siti@example.test')$q$, r5, acctB));
  IF v_res <> 'OKOKOK' THEN RAISE EXCEPTION 'FAIL another type, another email or another workspace was stopped by the index: %', v_res; END IF;
  -- once the first is rejected (a finished case does not stop a corrected request), the same email may ask again
  PERFORM set_config('vircle.compliance_fn', 'on', true);
  UPDATE compliance_requests SET status = 'rejected' WHERE id = r1;
  PERFORM set_config('vircle.compliance_fn', 'off', true);
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name, customer_email) VALUES (%L, %L, 'closure', 'form', 'Second Try', 'siti@example.test')$q$, r2, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a rejected case still stopped a new request from the same email: %', v_res; END IF;
  -- and the new one now stands in the way of a third
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (account_id, type_key, source, customer_name, customer_email) VALUES (%L, 'closure', 'form', 'Third Try', 'siti@example.test')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23505%' THEN RAISE EXCEPTION 'FAIL the new open request did not stop a third (saw %)', v_res; END IF;
  -- put things back for the walk below: the second try is closed and the first is open again
  PERFORM set_config('vircle.compliance_fn', 'on', true);
  UPDATE compliance_requests SET status = 'closed', closed_at = now() WHERE id = r2;
  UPDATE compliance_requests SET status = 'received' WHERE id = r1;
  PERFORM set_config('vircle.compliance_fn', 'off', true);

  -- ------------------------------------------------------------
  -- 6. The raiser no longer reads the case through the browser's own access
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, channel, customer_name, created_by, conversation_id, contact_id) VALUES (%L, %L, 'phone_change', 'inbox', 'whatsapp', 'Raised By Agent', %L, %L, %L)$q$, r4, acctA, uG, cvA, cA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not create the raiser''s case: %', v_res; END IF;
  v_res := pg_temp.run(uG, 'SELECT count(*)::text FROM compliance_requests');
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL the person who raised a case can still read the case row (saw %)', v_res; END IF;
  FOREACH k IN ARRAY ARRAY['compliance_request_events', 'compliance_request_checklist', 'compliance_request_files'] LOOP
    v_res := pg_temp.run(uG, format('SELECT count(*)::text FROM %I', k));
    IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL the raiser can read %: %', k, v_res; END IF;
  END LOOP;
  v_res := pg_temp.run(uAd, 'SELECT count(*)::text FROM compliance_requests');
  IF v_res::int < 5 THEN RAISE EXCEPTION 'FAIL a holder of menu.compliance lost the right to read the cases (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, 'SELECT count(*)::text FROM compliance_request_events');
  IF v_res::int < 5 THEN RAISE EXCEPTION 'FAIL a holder of menu.compliance lost the right to read the events (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, 'SELECT count(*)::text FROM compliance_requests');
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer read a case (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, 'SELECT count(*)::text FROM compliance_requests');
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL the owner of B should see exactly B''s case (saw %)', v_res; END IF;
  -- granting the agent role the Compliance menu makes the agent a reader (the roles screen does the same), and removing it takes it away again
  INSERT INTO role_capability_defaults (role, capability) VALUES ('agent', 'menu.compliance') ON CONFLICT DO NOTHING;
  v_res := pg_temp.run(uG, 'SELECT count(*)::text FROM compliance_requests');
  IF v_res::int < 5 THEN RAISE EXCEPTION 'FAIL an agent holding menu.compliance should read the cases (saw %)', v_res; END IF;
  DELETE FROM role_capability_defaults WHERE role = 'agent' AND capability = 'menu.compliance';
  DELETE FROM role_capability_defaults WHERE role = 'agent' AND capability = 'compliance.raise';

  -- ------------------------------------------------------------
  -- 7. The public forms
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_public_forms (id, account_id, type_key, slug) VALUES (%L, %L, 'closure', 'close-account-abc23456')$q$, fA, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not create the closure form: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_public_forms WHERE id = fA AND NOT enabled AND max_amount = 10000 AND notice = '{}'::jsonb AND NOT turnstile AND banks IS NULL) THEN
    RAISE EXCEPTION 'FAIL a new form should start off, with the default amount, no notice, no Turnstile and the built-in banks';
  END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_public_forms (account_id, type_key, slug) VALUES (%L, 'phone_change', 'phone-change-abc23456')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a phone change could have a public form (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_public_forms (account_id, type_key, slug) VALUES (%L, 'closure', 'another-slug-abc23456')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23505%' THEN RAISE EXCEPTION 'FAIL a second form for the same type in a workspace was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_public_forms (id, account_id, type_key, slug) VALUES (%L, %L, 'closure', 'close-account-abc23456')$q$, fB, acctB));
  IF v_res NOT LIKE 'ERR 23505%' THEN RAISE EXCEPTION 'FAIL the same slug was used by two workspaces (saw %)', v_res; END IF;
  FOREACH k IN ARRAY ARRAY['AB', 'Has Spaces', 'UPPERCASE-abc23', '-leading-hyphen-abc', 'trailing-hyphen-abc-', 'x/y/z-path-abc23', 'a''b-quote-abc23'] LOOP
    v_res := pg_temp.svc(format($q$INSERT INTO compliance_public_forms (account_id, type_key, slug) VALUES (%L, 'withdrawal', %L)$q$, acctA, k));
    IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL the slug % was accepted (saw %)', k, v_res; END IF;
  END LOOP;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_public_forms (account_id, type_key, slug, max_amount) VALUES (%L, 'withdrawal', 'withdraw-funds-abc23456', 0)$q$, acctA));
  v_res := v_res || pg_temp.svc(format($q$INSERT INTO compliance_public_forms (account_id, type_key, slug, banks) VALUES (%L, 'withdrawal', 'withdraw-funds-abc23457', '"Maybank"')$q$, acctA));
  v_res := v_res || pg_temp.svc(format($q$INSERT INTO compliance_public_forms (account_id, type_key, slug, banks) VALUES (%L, 'withdrawal', 'withdraw-funds-abc23458', '[]')$q$, acctA));
  v_res := v_res || pg_temp.svc(format($q$INSERT INTO compliance_public_forms (account_id, type_key, slug, notice) VALUES (%L, 'withdrawal', 'withdraw-funds-abc23459', '[1]')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23514%ERR 23514%ERR 23514%ERR 23514%' THEN RAISE EXCEPTION 'FAIL a bad amount, bank list or notice was accepted: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_public_forms (account_id, type_key, slug, max_amount, banks, notice) VALUES (%L, 'withdrawal', 'withdraw-funds-abc23460', 5000.50, '["Maybank","CIMB Bank"]', '{"en":"Read this"}')$q$, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a valid withdrawal form was refused: %', v_res; END IF;

  -- ------------------------------------------------------------
  -- 8. The emailed codes
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_email_codes (account_id, form_id, email_hash, code_hash, expires_at) VALUES (%L, %L, %L, %L, now() + interval '15 minutes')$q$, acctA, fA, repeat('a', 64), repeat('b', 64)));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not store a code: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_email_codes (account_id, form_id, email_hash, code_hash, expires_at) VALUES (%L, %L, %L, %L, now())$q$, acctB, fA, repeat('a', 64), repeat('b', 64)));
  IF v_res NOT LIKE 'ERR 23503%' THEN RAISE EXCEPTION 'FAIL a code was stored for a form of another workspace (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_email_codes (account_id, form_id, email_hash, code_hash, expires_at) VALUES (%L, %L, 'short', 'short', now())$q$, acctA, fA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a code with no real hashes was stored (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$UPDATE compliance_email_codes SET attempts = 21 WHERE form_id = %L$q$, fA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL the attempts were not capped (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$UPDATE compliance_email_codes SET attempts = attempts + 1, consumed_at = now() WHERE form_id = %L$q$, fA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the service role could not count a try: %', v_res; END IF;

  -- ------------------------------------------------------------
  -- 9. The notices
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_notices (id, account_id, request_id, kind, key, audience) VALUES (%L, %L, %L, 'received', 'once', 'customer')$q$, nA, acctA, r1));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not claim a notice: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_notices (account_id, request_id, kind, key, audience) VALUES (%L, %L, 'received', 'once', 'customer')$q$, acctA, r1));
  IF v_res NOT LIKE 'ERR 23505%' THEN RAISE EXCEPTION 'FAIL the same notice was claimed twice (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_notices (account_id, request_id, kind, key, audience) VALUES (%L, %L, 'received', 'another', 'customer')$q$, acctA, r1));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a different key was not a different notice: %', v_res; END IF;
  FOREACH k IN ARRAY ARRAY[
    $s$kind = 'chat'$s$, $s$audience = 'everyone'$s$, $s$status = 'delivered'$s$, $s$language = 'fr'$s$, $s$key = ''$s$, $s$recipients = -1$s$
  ] LOOP
    v_res := pg_temp.svc(format($q$UPDATE compliance_notices SET %s WHERE id = %L$q$, k, nA));
    IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a notice accepted a bad value (%): %', k, v_res; END IF;
  END LOOP;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_notices (account_id, request_id, kind, key, audience) VALUES (%L, %L, 'received', 'other-ws', 'customer')$q$, acctB, r1));
  IF v_res NOT LIKE 'ERR 23503%' THEN RAISE EXCEPTION 'FAIL a notice was tied to a case of another workspace (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$UPDATE compliance_notices SET status = 'failed', detail = 'mailbox_reconnect' WHERE id = %L$q$, nA));
  v_res := v_res || pg_temp.svc(format($q$UPDATE compliance_notices SET status = 'claimed', detail = NULL, claimed_at = now() WHERE id = %L AND status = 'failed'$q$, nA));
  IF v_res <> 'OKOK' THEN RAISE EXCEPTION 'FAIL the service role could not settle and take over a claim: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$DELETE FROM compliance_notices WHERE id = %L$q$, nA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a notice of a case under retention was deleted (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 10. The exports log
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_exports (account_id, actor, filters, row_count, truncated) VALUES (%L, %L, '{"from":null,"to":null,"type":"closure"}', 4, false)$q$, acctA, uAd));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not log an export: %', v_res; END IF;
  FOREACH k IN ARRAY ARRAY[$s$UPDATE compliance_exports SET row_count = 0$s$, $s$DELETE FROM compliance_exports$s$, $s$TRUNCATE compliance_exports$s$] LOOP
    v_res := pg_temp.svc(k);
    IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the exports log could be changed by the service role: % -> %', k, v_res; END IF;
    BEGIN
      EXECUTE k;
      RAISE EXCEPTION 'FAIL the table owner could change the exports log: %', k;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_exports (account_id, actor, kind, row_count) VALUES (%L, %L, 'pdf', 1)$q$, acctA, uAd));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an unknown export kind was logged (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_exports (account_id, actor, row_count) VALUES (%L, %L, -1)$q$, acctA, uAd));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a negative row count was logged (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 11. The intake fields on the standard types
  -- ------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f WHERE t.account_id = a.id AND t.key = 'closure' AND f ->> 'key' = 'declaration' AND f ->> 'type' = 'acknowledge' AND (f ->> 'required') = 'false')) THEN
    RAISE EXCEPTION 'FAIL a workspace has a closure type with no optional declaration field';
  END IF;
  FOREACH k IN ARRAY ARRAY['declaration', 'reason_kind', 'proof'] LOOP
    IF EXISTS (SELECT 1 FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f WHERE t.account_id = a.id AND t.key = 'withdrawal' AND f ->> 'key' = k)) THEN
      RAISE EXCEPTION 'FAIL a workspace has a withdrawal type with no % field', k;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM compliance_request_types t WHERE t.key = 'closure' AND (SELECT count(*) FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'declaration') <> 1)
     OR EXISTS (SELECT 1 FROM compliance_request_types t WHERE t.key = 'withdrawal' AND (SELECT count(*) FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' IN ('declaration', 'reason_kind', 'proof')) <> 3) THEN
    RAISE EXCEPTION 'FAIL a field was added more than once';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f, jsonb_array_elements(f -> 'options') o
                  WHERE t.account_id = acctB AND t.key = 'withdrawal' AND f ->> 'key' = 'reason_kind' AND o ->> 'value' = 'over_topup' AND o -> 'label' ? 'ms' AND o -> 'label' ? 'zh' AND o -> 'label' ? 'ko') THEN
    RAISE EXCEPTION 'FAIL a workspace made after the migration has no reason_kind choice in four languages';
  END IF;
  -- the three bank answers are still the only sensitive fields of a closure (the declaration is not one)
  IF (SELECT count(*) FROM compliance_request_types, jsonb_array_elements(fields) f WHERE account_id = acctA AND key = 'closure' AND (f ->> 'sensitive') = 'true') <> 3 THEN
    RAISE EXCEPTION 'FAIL the closure type should still mark exactly the three bank fields sensitive';
  END IF;
  UPDATE compliance_request_types
     SET fields = (SELECT jsonb_agg(CASE WHEN f ->> 'key' = 'declaration' THEN jsonb_set(f, '{label,en}', '"Edited by an administrator"') ELSE f END) FROM jsonb_array_elements(fields) f)
   WHERE account_id = acctA AND key = 'closure';
  PERFORM public.compliance_intake_fields(acctA);
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f WHERE t.account_id = acctA AND t.key = 'closure' AND f ->> 'key' = 'declaration' AND f #>> '{label,en}' = 'Edited by an administrator') THEN
    RAISE EXCEPTION 'FAIL running the intake function again overwrote an administrator''s edit';
  END IF;
  UPDATE compliance_request_types
     SET fields = (SELECT jsonb_agg(f) FROM jsonb_array_elements(fields) f WHERE f ->> 'key' <> 'declaration')
   WHERE account_id = acctA AND key = 'closure';
  PERFORM public.compliance_intake_fields(acctA);
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f WHERE t.account_id = acctA AND t.key = 'closure' AND f ->> 'key' = 'declaration') THEN
    RAISE EXCEPTION 'FAIL a closure type that lost the declaration did not get it back';
  END IF;

  -- ------------------------------------------------------------
  -- 12. compliance_transition: 183's rules, and the rejection's category and the customer's words
  -- ------------------------------------------------------------
  -- r1 (form case, open again): identity check by the officer, hand-over, then the Head
  PERFORM public.compliance_transition(r1, 'officer_review', uAd, 'Called back the registered number', '{"method":"call_back","outcome":"pass"}');
  PERFORM public.compliance_transition(r1, 'awaiting_signoff', uAd, 'Looks wrong', '{"recommendation":"reject"}');
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'rejected', %L, 'No', '{"reason_category":"identity_failed","customer_reason":"x"}')::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 42501%maker_checker%' THEN RAISE EXCEPTION 'FAIL the maker-checker rule was lost: the person who did the identity check rejected (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'rejected', %L, 'No', '{"reason_category":"identity_failed"}')::text$q$, r1, uG));
  IF v_res NOT LIKE 'ERR 42501%approve%' THEN RAISE EXCEPTION 'FAIL an agent without compliance.approve rejected (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'rejected', %L, 'No', '{"reason_category":"because"}')::text$q$, r1, uA));
  IF v_res NOT LIKE 'ERR 22023%bad_category%' THEN RAISE EXCEPTION 'FAIL a category that is not one was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'rejected', %L, 'No', jsonb_build_object('reason_category', 'other', 'customer_reason', repeat('x', 1001)))::text$q$, r1, uA));
  IF v_res NOT LIKE 'ERR 22023%note_too_long%' THEN RAISE EXCEPTION 'FAIL a customer reason over 1000 characters was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'rejected', %L)::text$q$, r1, uA));
  IF v_res NOT LIKE 'ERR 22023%note_required%' THEN RAISE EXCEPTION 'FAIL a rejection without the internal note was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'rejected', %L, 'Could not verify the holder', '{"reason_category":"identity_failed","customer_reason":"We could not match your details to the account."}')::text$q$, r1, uA));
  IF v_res NOT LIKE '%"to": "rejected"%' THEN RAISE EXCEPTION 'FAIL the Head could not reject with a category and the customer''s words: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r1 AND status = 'rejected' AND outcome_reason = 'Could not verify the holder'
                   AND signoff ->> 'decision' = 'rejected' AND signoff ->> 'by' = uA::text AND signoff ->> 'reason' = 'Could not verify the holder'
                   AND signoff ->> 'reason_category' = 'identity_failed' AND signoff ->> 'customer_reason' = 'We could not match your details to the account.') THEN
    RAISE EXCEPTION 'FAIL the rejection did not keep the category and the customer''s words apart from the internal note: %', (SELECT signoff FROM compliance_requests WHERE id = r1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'signoff' AND detail ->> 'decision' = 'rejected' AND detail ->> 'category' = 'identity_failed') THEN
    RAISE EXCEPTION 'FAIL the sign-off event does not name the category';
  END IF;
  IF EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind IN ('signoff', 'status') AND detail::text LIKE '%match your details%') THEN
    RAISE EXCEPTION 'FAIL the customer''s words were copied into the trail';
  END IF;
  -- a rejection without them is accepted by the database (the route and the screen require them): old callers cannot fail
  PERFORM public.compliance_transition(r4, 'officer_review', uAd, NULL, '{"method":"video_call","outcome":"pass"}');
  PERFORM public.compliance_transition(r4, 'awaiting_signoff', uAd, 'Not eligible', '{"recommendation":"reject"}');
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'rejected', %L, 'Not the account holder')::text$q$, r4, uA));
  IF v_res NOT LIKE '%"to": "rejected"%' THEN RAISE EXCEPTION 'FAIL a rejection without the new fields was refused: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r4 AND signoff ->> 'reason' = 'Not the account holder' AND (signoff -> 'reason_category') = 'null'::jsonb AND (signoff -> 'customer_reason') = 'null'::jsonb) THEN
    RAISE EXCEPTION 'FAIL a rejection without the new fields stored something odd: %', (SELECT signoff FROM compliance_requests WHERE id = r4);
  END IF;
  -- the category belongs to a rejection only
  PERFORM public.compliance_transition(r3, 'officer_review', uAd, NULL, '{"method":"in_person","outcome":"pass"}');
  PERFORM public.compliance_transition(r3, 'awaiting_signoff', uAd, 'Fine', '{"recommendation":"approve"}');
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'approved', %L, 'ok', '{"reason_category":"duplicate","customer_reason":"ignored"}')::text$q$, r3, uA));
  IF v_res NOT LIKE '%"to": "approved"%' THEN RAISE EXCEPTION 'FAIL the Head could not approve: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r3 AND signoff ->> 'decision' = 'approved' AND (signoff -> 'reason_category') = 'null'::jsonb AND (signoff -> 'customer_reason') = 'null'::jsonb) THEN
    RAISE EXCEPTION 'FAIL an approval kept a rejection''s category: %', (SELECT signoff FROM compliance_requests WHERE id = r3);
  END IF;
  -- the transition table is 183's, unchanged
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'received', %L)::text$q$, r3, uAd));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an approved case moved back to received (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_transition(%L, 'closed', %L, 'x')::text$q$, r3, uAd));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an approved case was closed without being executed (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 13. Functions and tables: nothing for a browser role
  -- ------------------------------------------------------------
  FOREACH k IN ARRAY ARRAY['compliance_intake_fields(uuid)', 'compliance_transition(uuid,text,uuid,text,jsonb)', 'compliance_accounts_seed()', 'compliance_exports_no_change()'] LOOP
    IF has_function_privilege('anon', k, 'EXECUTE') OR has_function_privilege('authenticated', k, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL a browser role can call %', k;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'compliance_intake_fields(uuid)', 'EXECUTE') OR NOT has_function_privilege('service_role', 'compliance_transition(uuid,text,uuid,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the service role cannot call the Part B functions';
  END IF;
  FOREACH k IN ARRAY ARRAY['compliance_intake_fields', 'compliance_transition', 'compliance_accounts_seed'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = k AND p.prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')) THEN
      RAISE EXCEPTION 'FAIL % is security definer without a pinned search_path', k;
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['compliance_public_forms', 'compliance_email_codes', 'compliance_notices', 'compliance_exports'] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = ('public.' || k)::regclass) THEN
      RAISE EXCEPTION 'FAIL row level security is off on %', k;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || k, 'SELECT') OR has_table_privilege('authenticated', 'public.' || k, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || k, 'UPDATE') OR has_table_privilege('authenticated', 'public.' || k, 'DELETE')
       OR has_table_privilege('anon', 'public.' || k, 'SELECT') OR has_table_privilege('anon', 'public.' || k, 'INSERT') THEN
      RAISE EXCEPTION 'FAIL a browser role holds a privilege on %', k;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = k) THEN
      RAISE EXCEPTION 'FAIL % has a policy: the server is the only reader', k;
    END IF;
    v_res := pg_temp.run(uA, format('SELECT count(*)::text FROM %I', k));
    IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner of a workspace could read % from the browser (saw %)', k, v_res; END IF;
    v_res := pg_temp.run(NULL, format('SELECT count(*)::text FROM %I', k), 'anon');
    IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the signed-out role could read % (saw %)', k, v_res; END IF;
  END LOOP;
  -- the policies on the case follow menu.compliance only
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('compliance_requests', 'compliance_request_events', 'compliance_request_checklist', 'compliance_request_files') AND qual ILIKE '%created_by%') THEN
    RAISE EXCEPTION 'FAIL a policy on the case still refers to the person who raised it';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: compliance.raise; the signoff notification type; the notice event kind; the case''s language and verified email; one open form request per type per email (and no more); the raiser reads nothing through the browser; the public forms (two types, random slugs, limits); the emailed codes (hashes, attempts, scoped); the notices (once-only claims, retention); the append-only exports log; the intake fields on every workspace (edits survive); compliance_transition keeps 183''s rules and stores a rejection''s category and the customer''s words; no browser role reaches any new function or table';
END
$verify$;
