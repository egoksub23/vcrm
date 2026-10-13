-- Verify migration 185 (Compliance requests linked to the chat: the personal closure form link, the link card message, Account change).
-- Self-contained; run against an empty database or production with the text of 183, 184 and 185 in front when they are not applied yet (182 before 183).
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Written against the REAL schema: contacts need a phone, tickets a ticket_number, contact_id and subject, conversations a user_id and contact_id,
-- messages a conversation_id and sender_type, and nothing here deletes a contact (production soft-deletes them with a trigger) or a conversation.
--
-- Proves: (1) the timeline accepts form_link and form_submitted and still refuses an unknown kind; a compliance_form notification is accepted and an unknown
-- type still is not; messages accept content_type 'link_card' and still refuse an unknown one; (2) the standard phone_change type became Account change
-- (what_changes first with exactly three options and never a parent's name, the phone, email and child-name pairs asked by choice), on every workspace
-- including one made later, without overwriting an administrator's edit and with a lost field coming back; (3) compliance_form_links: row level security on,
-- no browser write, no browser read of the token hash, readable by a holder of menu.compliance only and only in its own workspace, written only by the
-- functions; (4) minting: needs a person who may raise / review / approve, closure only, only before the sign-off, refuses after a form came back, refuses
-- a conversation of another workspace and a bad hash, replaces the previous link in the same transaction, never two active links, never the same token
-- twice; (5) sent: delivered stamps the time and remembers the message, a resend is told apart, a failed delivery is recorded with a named reason and
-- sets no time, a message of another workspace is not remembered, a link that cannot be used refuses; (6) opened: once, no actor, not after expiry;
-- (7) revoking: only the active one, once, by the permitted; (8) apply, THE atomic claim: updates the existing case (name, the email typed, answers merged,
-- protected answers replaced, language), keeps the phone the case had, leaves the identity check not done and the status alone, writes one form_submitted
-- event, marks the link used so a second apply fails and changes nothing, refuses a revoked, an expired and a replaced link, a bad email, and a case that
-- moved on to sign-off, and after it no new link can be minted; (9) retention: a link row is not deletable under retention, even by the service role, and
-- a deleted message empties message_id without error; (10) no browser role reaches any new function and each pins its search_path.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();  -- owner of workspace A
  uAd     uuid := gen_random_uuid();  -- admin of A (the officer: holds compliance.raise, review and menu.compliance by default)
  uG      uuid := gen_random_uuid();  -- an agent of A (the raiser: holds compliance.raise only when granted)
  uV      uuid := gen_random_uuid();  -- a viewer of A
  uB      uuid := gen_random_uuid();  -- owner of workspace B
  acctA   uuid;
  acctB   uuid;
  cA      uuid := gen_random_uuid();
  cB      uuid := gen_random_uuid();
  cvA     uuid := gen_random_uuid();
  cvB     uuid := gen_random_uuid();
  r1      uuid := gen_random_uuid();  -- a closure case with a conversation: the main walk
  r2      uuid := gen_random_uuid();  -- a withdrawal (cannot be sent a closure form)
  r3      uuid := gen_random_uuid();  -- a closure that moves on to sign-off before the form comes back
  r4      uuid := gen_random_uuid();  -- a closure of workspace B
  l1      uuid := gen_random_uuid();
  l2      uuid := gen_random_uuid();
  l3      uuid := gen_random_uuid();
  l4      uuid := gen_random_uuid();
  l5      uuid := gen_random_uuid();
  l6      uuid := gen_random_uuid();
  l7      uuid := gen_random_uuid();
  h1      text := md5(random()::text) || md5(random()::text);
  h2      text := md5(random()::text) || md5(random()::text);
  h3      text := md5(random()::text) || md5(random()::text);
  h4      text := md5(random()::text) || md5(random()::text);
  h5      text := md5(random()::text) || md5(random()::text);
  h6      text := md5(random()::text) || md5(random()::text);
  h7      text := md5(random()::text) || md5(random()::text);
  m1      uuid;
  mB      uuid;
  v_res   text;
  v_json  jsonb;
  v_before jsonb;
  v_after  jsonb;
  v_n     int;
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

  INSERT INTO contacts (id, account_id, phone) VALUES (cA, acctA, '+60100000185'), (cB, acctB, '+60100000186');
  INSERT INTO conversations (id, user_id, account_id, contact_id) VALUES (cvA, uA, acctA, cA), (cvB, uB, acctB, cB);

  -- ------------------------------------------------------------
  -- 1. Event kinds, notification type, message content type
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, channel, customer_name, customer_email, customer_phone, created_by, conversation_id, contact_id, data)
                                 VALUES (%L, %L, 'closure', 'inbox', 'whatsapp', 'Parent One', NULL, '+60123456881', %L, %L, %L, '{"reason":"Moving abroad"}')$q$, r1, acctA, uG, cvA, cA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not create the closure case: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_events (account_id, request_id, kind, detail) VALUES (%L, %L, 'form_link', '{"action":"minted"}')$q$, acctA, r1));
  v_res := v_res || pg_temp.svc(format($q$INSERT INTO compliance_request_events (account_id, request_id, kind, detail) VALUES (%L, %L, 'form_submitted', '{}')$q$, acctA, r1));
  IF v_res <> 'OKOK' THEN RAISE EXCEPTION 'FAIL the timeline refused form_link or form_submitted: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_events (account_id, request_id, kind) VALUES (%L, %L, 'form_opened')$q$, acctA, r1));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an unknown event kind was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_request_events (account_id, request_id, kind) VALUES (%L, %L, 'notice')$q$, acctA, r1));
  IF v_res <> 'OK' THEN RAISE EXCEPTION '184''s notice kind was lost: %', v_res; END IF;

  v_res := pg_temp.svc(format($q$INSERT INTO notifications (account_id, user_id, type, title, body) VALUES (%L, %L, 'compliance_form', 'x', 'y')$q$, acctA, uA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL a compliance_form notification was refused: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO notifications (account_id, user_id, type, title, body) VALUES (%L, %L, 'compliance_signoff', 'x', 'y')$q$, acctA, uA));
  v_res := v_res || pg_temp.svc(format($q$INSERT INTO notifications (account_id, user_id, type, title, body) VALUES (%L, %L, 'compliance_clock', 'x', 'y')$q$, acctA, uA));
  IF v_res <> 'OKOK' THEN RAISE EXCEPTION 'FAIL 183''s or 184''s notification type was lost: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO notifications (account_id, user_id, type, title, body) VALUES (%L, %L, 'not_a_type', 'x', 'y')$q$, acctA, uA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an unknown notification type was accepted (saw %)', v_res; END IF;

  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, send_payload)
  VALUES (cvA, 'agent', 'link_card', 'Account closure form', 'whatsapp', '{"link_card":{"link_id":"x","title":"Account closure form"}}') RETURNING id INTO m1;
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type) VALUES (cvB, 'agent', 'link_card', 'Account closure form', 'whatsapp') RETURNING id INTO mB;
  FOREACH k IN ARRAY ARRAY['text', 'template', 'interactive', 'image', 'document', 'audio', 'video', 'location'] LOOP
    v_res := pg_temp.svc(format($q$INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type) VALUES (%L, 'agent', %L, 'x', 'whatsapp')$q$, cvA, k));
    IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the content type % was lost when link_card was added: %', k, v_res; END IF;
  END LOOP;
  v_res := pg_temp.svc(format($q$INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type) VALUES (%L, 'agent', 'carousel', 'x', 'whatsapp')$q$, cvA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL an unknown content type was accepted (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 2. Account change (the phone_change type)
  -- ------------------------------------------------------------
  -- every workspace has the required what_changes first and none still has the words 183 seeded (a workspace whose administrator chose other words is left alone)
  IF EXISTS (SELECT 1 FROM compliance_request_types t WHERE t.key = 'phone_change' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'what_changes' AND (f ->> 'required') = 'true' AND f ->> 'type' = 'choice')) THEN
    RAISE EXCEPTION 'FAIL a workspace''s account change type has no required what_changes choice';
  END IF;
  IF EXISTS (SELECT 1 FROM compliance_request_types t WHERE t.key = 'phone_change' AND t.label = 'Phone number change'
                AND t.label_l10n = jsonb_build_object('ms', 'Pertukaran nombor telefon', 'zh', '更改手机号码', 'ko', '전화번호 변경')) THEN
    RAISE EXCEPTION 'FAIL a workspace still has the old phone number change label';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types t WHERE t.account_id = acctA AND t.key = 'phone_change' AND t.label = 'Account change' AND t.label_l10n ? 'ms' AND t.label_l10n ? 'zh' AND t.label_l10n ? 'ko')
     OR NOT EXISTS (SELECT 1 FROM compliance_request_types t WHERE t.account_id = acctA AND t.key = 'phone_change' AND t.fields -> 0 ->> 'key' = 'what_changes') THEN
    RAISE EXCEPTION 'FAIL a workspace made after the migration has the wrong label, or what_changes is not first';
  END IF;
  SELECT array_agg(o ->> 'value' ORDER BY ord) INTO k FROM (SELECT 1) x, compliance_request_types t, jsonb_array_elements(t.fields -> 0 -> 'options') WITH ORDINALITY AS e(o, ord) WHERE t.account_id = acctA AND t.key = 'phone_change';
  IF k IS NULL OR k <> '{parent_phone,parent_email,child_name}' THEN RAISE EXCEPTION 'FAIL what_changes should offer parent phone, parent email and child name only (saw %)', k; END IF;
  IF EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields -> 0 -> 'options') o WHERE t.key = 'phone_change' AND (o ->> 'value') ~* 'name' AND (o ->> 'value') <> 'child_name') THEN
    RAISE EXCEPTION 'FAIL a parent''s name is offered as something that can change';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields -> 0 -> 'options') o WHERE t.account_id = acctB AND t.key = 'phone_change' AND o ->> 'value' = 'child_name' AND o -> 'label' ? 'ms' AND o -> 'label' ? 'zh' AND o -> 'label' ? 'ko') THEN
    RAISE EXCEPTION 'FAIL a workspace made after the migration has no child_name choice in four languages';
  END IF;
  FOREACH k IN ARRAY ARRAY['current_phone', 'new_phone', 'current_email', 'new_email', 'child_current_name', 'child_new_name'] LOOP
    IF NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f
                    WHERE t.account_id = acctA AND t.key = 'phone_change' AND f ->> 'key' = k AND (f ->> 'required') = 'true' AND f #>> '{showIf,field}' = 'what_changes' AND jsonb_array_length(f #> '{showIf,in}') = 1) THEN
      RAISE EXCEPTION 'FAIL the account change type has no required, conditional field %', k;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f WHERE t.account_id = acctA AND t.key = 'phone_change' AND f ->> 'key' = 'child_new_name' AND f #>> '{showIf,in,0}' = 'child_name')
     OR NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f WHERE t.account_id = acctA AND t.key = 'phone_change' AND f ->> 'key' = 'new_email' AND f #>> '{showIf,in,0}' = 'parent_email')
     OR NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f WHERE t.account_id = acctA AND t.key = 'phone_change' AND f ->> 'key' = 'new_phone' AND f #>> '{showIf,in,0}' = 'parent_phone') THEN
    RAISE EXCEPTION 'FAIL a field is asked for the wrong choice';
  END IF;
  IF (SELECT count(*) FROM compliance_request_types t, jsonb_array_elements(t.fields) f WHERE t.account_id = acctA AND t.key = 'phone_change') <> 7 THEN
    RAISE EXCEPTION 'FAIL the account change type should have 7 fields (a field was added twice or lost)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.checklist) c WHERE t.account_id = acctA AND t.key = 'phone_change' AND c ->> 'key' = 'update_phone' AND c #>> '{label,en}' = 'Make the change in the back office') THEN
    RAISE EXCEPTION 'FAIL the operations step still talks only about a phone number';
  END IF;
  -- idempotent, an administrator's edit survives, a lost field comes back
  SELECT fields INTO v_before FROM compliance_request_types WHERE account_id = acctA AND key = 'phone_change';
  PERFORM public.compliance_account_change_fields(acctA);
  SELECT fields INTO v_after FROM compliance_request_types WHERE account_id = acctA AND key = 'phone_change';
  IF v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'FAIL running the account change function again changed the fields'; END IF;
  UPDATE compliance_request_types SET label = 'My own words', fields = (SELECT jsonb_agg(CASE WHEN f ->> 'key' = 'what_changes' THEN jsonb_set(f, '{label,en}', '"Edited by an administrator"') ELSE f END ORDER BY ord)
                                                                          FROM jsonb_array_elements(fields) WITH ORDINALITY AS e(f, ord))
   WHERE account_id = acctA AND key = 'phone_change';
  PERFORM public.compliance_account_change_fields(acctA);
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types t WHERE t.account_id = acctA AND t.key = 'phone_change' AND t.label = 'My own words' AND t.fields -> 0 #>> '{label,en}' = 'Edited by an administrator') THEN
    RAISE EXCEPTION 'FAIL running the account change function again overwrote an administrator''s edit';
  END IF;
  UPDATE compliance_request_types SET fields = (SELECT jsonb_agg(f ORDER BY ord) FROM jsonb_array_elements(fields) WITH ORDINALITY AS e(f, ord) WHERE f ->> 'key' <> 'new_email')
   WHERE account_id = acctA AND key = 'phone_change';
  PERFORM public.compliance_account_change_fields(acctA);
  IF NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f WHERE t.account_id = acctA AND t.key = 'phone_change' AND f ->> 'key' = 'new_email') THEN
    RAISE EXCEPTION 'FAIL a type that lost new_email did not get it back';
  END IF;
  -- a type that still has 183''s two phone fields without the condition gets it (a workspace as it was before this migration)
  UPDATE compliance_request_types SET fields = (SELECT jsonb_agg(f - 'showIf' ORDER BY ord) FROM jsonb_array_elements(fields) WITH ORDINALITY AS e(f, ord) WHERE f ->> 'key' NOT IN ('what_changes', 'current_email', 'new_email', 'child_current_name', 'child_new_name'))
   WHERE account_id = acctB AND key = 'phone_change';
  PERFORM public.compliance_account_change_fields(acctB);
  IF (SELECT count(*) FROM compliance_request_types t, jsonb_array_elements(t.fields) f WHERE t.account_id = acctB AND t.key = 'phone_change') <> 7
     OR NOT EXISTS (SELECT 1 FROM compliance_request_types t, jsonb_array_elements(t.fields) f WHERE t.account_id = acctB AND t.key = 'phone_change' AND f ->> 'key' = 'current_phone' AND f #>> '{showIf,in,0}' = 'parent_phone') THEN
    RAISE EXCEPTION 'FAIL a type as 183 left it was not brought up to date';
  END IF;

  -- ------------------------------------------------------------
  -- 3. The table: privileges and who reads it
  -- ------------------------------------------------------------
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.compliance_form_links'::regclass) THEN RAISE EXCEPTION 'FAIL row level security is off on compliance_form_links'; END IF;
  IF has_table_privilege('authenticated', 'public.compliance_form_links', 'INSERT') OR has_table_privilege('authenticated', 'public.compliance_form_links', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.compliance_form_links', 'DELETE') OR has_table_privilege('anon', 'public.compliance_form_links', 'SELECT')
     OR has_table_privilege('anon', 'public.compliance_form_links', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL a browser role holds a write privilege on compliance_form_links (or the signed-out role a read)';
  END IF;
  IF has_column_privilege('authenticated', 'public.compliance_form_links', 'token_hash', 'SELECT') THEN RAISE EXCEPTION 'FAIL the browser can read the token hash'; END IF;
  IF NOT has_column_privilege('authenticated', 'public.compliance_form_links', 'sent_at', 'SELECT') THEN RAISE EXCEPTION 'FAIL the browser cannot read the state of a link'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'compliance_form_links' AND cmd = 'SELECT' AND qual ILIKE '%menu.compliance%')
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'compliance_form_links' AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'FAIL compliance_form_links should have exactly one policy: read for menu.compliance';
  END IF;

  -- ------------------------------------------------------------
  -- 4. Minting
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_form_links (id, account_id, request_id, token_hash, expires_at) VALUES (%L, %L, %L, %L, now() + interval '14 days')$q$, gen_random_uuid(), acctA, r1, h7));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the service role inserted a link directly, outside compliance_mint_form_link (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp')::text$q$, r1, uAd, l1, h1, cvA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in user called the mint function (saw %)', v_res; END IF;
  -- a viewer and an agent without compliance.raise cannot mint; the admin (who holds review) can
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp')::text$q$, r1, uV, l1, h1, cvA));
  IF v_res NOT LIKE 'ERR 42501%raise%' THEN RAISE EXCEPTION 'FAIL a viewer minted a link (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp')::text$q$, r1, uG, l1, h1, cvA));
  IF v_res NOT LIKE 'ERR 42501%raise%' THEN RAISE EXCEPTION 'FAIL an agent without compliance.raise minted a link (saw %)', v_res; END IF;
  INSERT INTO role_capability_defaults (role, capability) VALUES ('agent', 'compliance.raise') ON CONFLICT DO NOTHING;
  -- bad input
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, 'not-a-hash', %L, 'whatsapp')::text$q$, r1, uG, l1, cvA));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL a token hash that is not a hash was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp')::text$q$, r1, uG, l1, h1, cvB));
  IF v_res NOT LIKE 'ERR 23514%other_workspace%' THEN RAISE EXCEPTION 'FAIL a conversation of another workspace was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'WhatsApp!')::text$q$, r1, uG, l1, h1, cvA));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a channel that is not a name was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp')::text$q$, gen_random_uuid(), uG, l1, h1, cvA));
  IF v_res NOT LIKE 'ERR P0002%request_not_found%' THEN RAISE EXCEPTION 'FAIL a request that does not exist was accepted (saw %)', v_res; END IF;
  -- only a closure
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name) VALUES (%L, %L, 'withdrawal', 'staff', 'W')$q$, r2, acctA));
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, NULL, 'email')::text$q$, r2, uG, l1, h1));
  IF v_res NOT LIKE 'ERR 23514%form_link_not_allowed%' THEN RAISE EXCEPTION 'FAIL a closure form was minted for a withdrawal (saw %)', v_res; END IF;

  -- the first link
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp', 'ms')::text$q$, r1, uG, l1, h1, cvA));
  IF v_res NOT LIKE '%"id": "' || l1 || '"%' THEN RAISE EXCEPTION 'FAIL the agent holding compliance.raise could not mint: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l1 AND request_id = r1 AND account_id = acctA AND token_hash = h1 AND conversation_id = cvA AND channel = 'whatsapp' AND locale = 'ms'
                    AND created_by = uG AND expires_at > now() + interval '13 days' AND expires_at < now() + interval '15 days'
                    AND sent_at IS NULL AND opened_at IS NULL AND submitted_at IS NULL AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL the new link is not as expected: %', (SELECT to_jsonb(l) - 'token_hash' FROM compliance_form_links l WHERE id = l1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'form_link' AND actor = uG AND detail ->> 'action' = 'minted' AND detail ->> 'link' = l1::text AND detail ->> 'channel' = 'whatsapp') THEN
    RAISE EXCEPTION 'FAIL minting wrote no form_link event';
  END IF;
  IF EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND detail::text LIKE '%' || h1 || '%') THEN RAISE EXCEPTION 'FAIL the token hash is in the timeline'; END IF;
  -- the same token twice is refused; a second link replaces the first in the same transaction
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp')::text$q$, r1, uG, l2, h1, cvA));
  IF v_res NOT LIKE 'ERR 23505%' THEN RAISE EXCEPTION 'FAIL the same token hash was stored twice (saw %)', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l1 AND revoked_at IS NULL) THEN RAISE EXCEPTION 'FAIL a refused mint disturbed the existing link'; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp', 'en', 7)::text$q$, r1, uAd, l2, h2, cvA));
  IF v_res NOT LIKE '%"replaced": ["' || l1 || '"]%' THEN RAISE EXCEPTION 'FAIL the second link did not replace the first: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l1 AND revoked_at IS NOT NULL AND revoked_reason = 'replaced' AND revoked_by = uAd)
     OR (SELECT count(*) FROM compliance_form_links WHERE request_id = r1 AND revoked_at IS NULL AND submitted_at IS NULL) <> 1
     OR NOT EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l2 AND revoked_at IS NULL AND expires_at < now() + interval '8 days' AND expires_at > now() + interval '6 days') THEN
    RAISE EXCEPTION 'FAIL there is not exactly one active link, or the days were not honoured';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'form_link' AND detail ->> 'action' = 'revoked' AND detail ->> 'reason' = 'replaced' AND detail ->> 'link' = l1::text) THEN
    RAISE EXCEPTION 'FAIL replacing a link wrote no revoked event';
  END IF;
  -- two active links for one case can never stand (the index), even through the function's own door
  BEGIN
    PERFORM set_config('vircle.compliance_fn', 'on', true);
    INSERT INTO compliance_form_links (id, account_id, request_id, token_hash, expires_at) VALUES (gen_random_uuid(), acctA, r1, md5('x') || md5('y'), now() + interval '2 days');
    PERFORM set_config('vircle.compliance_fn', 'off', true);
    RAISE EXCEPTION 'FAIL a second active link for one case was accepted';
  EXCEPTION WHEN unique_violation THEN
    PERFORM set_config('vircle.compliance_fn', 'off', true);
  END;
  -- days are clamped to 1..30
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp', 'en', 400)::text$q$, r1, uAd, l3, h3, cvA));
  IF NOT EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l3 AND expires_at < now() + interval '31 days' AND expires_at > now() + interval '29 days') THEN RAISE EXCEPTION 'FAIL 400 days was not clamped to 30 (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 5. Sent
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$SELECT public.compliance_form_link_sent(%L, %L, %L, true)::text$q$, l3, uV, m1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a viewer recorded a send (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_form_link_sent(%L, %L, %L, false, false, 'window_expired')::text$q$, l3, uG, NULL));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL a failed delivery could not be recorded: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l3 AND sent_at IS NULL AND message_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'form_link' AND detail ->> 'action' = 'not_sent' AND detail ->> 'reason' = 'window_expired' AND detail ->> 'link' = l3::text) THEN
    RAISE EXCEPTION 'FAIL a delivery that did not happen stamped a time, or was not recorded with its reason';
  END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_form_link_sent(%L, %L, %L, false, false, 'because I said so')$q$, l3, uG, m1));
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'form_link' AND detail ->> 'action' = 'not_sent' AND detail -> 'reason' = 'null'::jsonb) THEN
    RAISE EXCEPTION 'FAIL a reason outside the named ones was stored';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l3 AND message_id = m1 AND sent_at IS NULL) THEN RAISE EXCEPTION 'FAIL the failed message was not remembered'; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_form_link_sent(%L, %L, %L, true, false)$q$, l3, uG, mB));
  IF NOT EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l3 AND sent_at IS NOT NULL AND message_id = m1) THEN
    RAISE EXCEPTION 'FAIL a message of another workspace replaced the remembered one, or the time was not stamped';
  END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_form_link_sent(%L, %L, %L, true, true)$q$, l3, uAd, m1));
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'form_link' AND detail ->> 'action' = 'sent' AND detail ->> 'link' = l3::text)
     OR NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'form_link' AND detail ->> 'action' = 'resent' AND detail ->> 'link' = l3::text) THEN
    RAISE EXCEPTION 'FAIL a send and a resend are not told apart in the timeline';
  END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_form_link_sent(%L, %L, %L, true)$q$, l2, uAd, m1));
  IF v_res NOT LIKE 'ERR 23514%form_link_not_allowed%' THEN RAISE EXCEPTION 'FAIL a send was recorded for a link that was replaced (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_form_link_sent(%L, %L, %L, true)$q$, gen_random_uuid(), uAd, m1));
  IF v_res NOT LIKE 'ERR P0002%' THEN RAISE EXCEPTION 'FAIL a send was recorded for a link that does not exist (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 6. Opened
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$SELECT public.compliance_form_link_opened(%L)::text$q$, l3));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL opening an active link did not answer true (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_form_link_opened(%L)::text$q$, l3));
  SELECT count(*) INTO v_n FROM compliance_request_events WHERE request_id = r1 AND kind = 'form_link' AND detail ->> 'action' = 'opened';
  IF v_res <> 'true' OR v_n <> 1 OR NOT EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l3 AND opened_at IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'form_link' AND detail ->> 'action' = 'opened' AND actor IS NULL) THEN
    RAISE EXCEPTION 'FAIL opening twice wrote % events (want 1, with no actor)', v_n;
  END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_form_link_opened(%L)::text$q$, l1));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL a replaced link counted as opened (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_form_link_opened(%L)::text$q$, gen_random_uuid()));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL a link that does not exist counted as opened (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 7. Revoking
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$SELECT public.compliance_revoke_form_link(%L, %L)::text$q$, r1, uV));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a viewer revoked a link (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_revoke_form_link(%L, %L)::text$q$, r1, uG));
  IF v_res <> l3::text THEN RAISE EXCEPTION 'FAIL revoking did not return the active link (saw %)', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l3 AND revoked_at IS NOT NULL AND revoked_reason = 'revoked' AND revoked_by = uG)
     OR NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'form_link' AND detail ->> 'action' = 'revoked' AND detail ->> 'reason' = 'revoked' AND actor = uG) THEN
    RAISE EXCEPTION 'FAIL revoking did not record who and why';
  END IF;
  v_res := pg_temp.svc(format($q$SELECT coalesce(public.compliance_revoke_form_link(%L, %L)::text, 'none')$q$, r1, uG));
  IF v_res <> 'none' THEN RAISE EXCEPTION 'FAIL there was a second link to revoke (saw %)', v_res; END IF;
  -- the table cannot be changed by hand: not the service role, not the owner, however the change is made (a revoked link is final)
  v_res := pg_temp.svc(format($q$UPDATE compliance_form_links SET revoked_at = NULL, revoked_reason = NULL WHERE id = %L$q$, l3));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the service role un-revoked a link by hand (saw %)', v_res; END IF;
  BEGIN
    PERFORM set_config('vircle.compliance_fn', 'on', true);
    UPDATE compliance_form_links SET revoked_at = NULL, revoked_reason = NULL WHERE id = l3;
    PERFORM set_config('vircle.compliance_fn', 'off', true);
    RAISE EXCEPTION 'FAIL a revoked link was brought back to life';
  EXCEPTION WHEN check_violation THEN
    PERFORM set_config('vircle.compliance_fn', 'off', true);
  END;
  v_res := pg_temp.svc(format($q$UPDATE compliance_form_links SET token_hash = %L WHERE id = %L$q$, h7, l3));
  IF v_res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL the token hash could be changed by hand (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 8. Apply: the atomic claim
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp', 'en')::text$q$, r1, uG, l4, h4, cvA));
  IF v_res NOT LIKE '%"id": "' || l4 || '"%' THEN RAISE EXCEPTION 'FAIL could not mint the link to apply: %', v_res; END IF;
  -- a bad email, a name that is not one, a language that is not one
  v_res := pg_temp.svc(format($q$SELECT public.compliance_apply_form_link(%L, 'Siti Aminah', 'not an email', NULL, '{"confirm_closure":true}', NULL)::text$q$, l4));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL a bad email was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_apply_form_link(%L, '   ', 'siti@example.test', NULL, '{}', NULL)::text$q$, l4));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL a blank name was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_apply_form_link(%L, 'Siti Aminah', 'siti@example.test', NULL, '{}', NULL, 'fr')::text$q$, l4));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL a language that is not one was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_apply_form_link(%L, 'Siti Aminah', 'siti@example.test', NULL, '[1]', NULL)::text$q$, l4));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL answers that are not an object were accepted (saw %)', v_res; END IF;
  IF EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l4 AND submitted_at IS NOT NULL) THEN RAISE EXCEPTION 'FAIL a refused submission used the link up'; END IF;
  -- a signed-in user cannot call it
  v_res := pg_temp.run(uAd, format($q$SELECT public.compliance_apply_form_link(%L, 'Siti Aminah', 'siti@example.test', NULL, '{}', NULL)::text$q$, l4));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in user called the apply function (saw %)', v_res; END IF;
  -- the replaced, the revoked and the unknown link
  v_res := pg_temp.svc(format($q$SELECT public.compliance_apply_form_link(%L, 'Siti Aminah', 'siti@example.test', NULL, '{}', NULL)::text$q$, l3));
  v_res := v_res || pg_temp.svc(format($q$SELECT public.compliance_apply_form_link(%L, 'Siti Aminah', 'siti@example.test', NULL, '{}', NULL)::text$q$, l2));
  v_res := v_res || pg_temp.svc(format($q$SELECT public.compliance_apply_form_link(%L, 'Siti Aminah', 'siti@example.test', NULL, '{}', NULL)::text$q$, gen_random_uuid()));
  IF v_res NOT LIKE 'ERR 23514%form_link_invalid%ERR 23514%form_link_invalid%ERR 23514%form_link_invalid%' THEN RAISE EXCEPTION 'FAIL a revoked, replaced or unknown link was accepted: %', v_res; END IF;
  -- an expired one (the dates are fixed, so the guard is switched off for this one change, as the table's owner)
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp', 'en')::text$q$, r1, uG, l5, h5, cvA));
  ALTER TABLE compliance_form_links DISABLE TRIGGER compliance_form_links_guard;
  UPDATE compliance_form_links SET created_at = now() - interval '20 days', expires_at = now() - interval '6 days' WHERE id = l5;
  ALTER TABLE compliance_form_links ENABLE TRIGGER compliance_form_links_guard;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_apply_form_link(%L, 'Siti Aminah', 'siti@example.test', NULL, '{}', NULL)::text$q$, l5));
  IF v_res NOT LIKE 'ERR 23514%form_link_invalid%' THEN RAISE EXCEPTION 'FAIL an expired link was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_form_link_opened(%L)::text$q$, l5));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL an expired link counted as opened (saw %)', v_res; END IF;
  -- l5 expired but still the "active" one for the case (nothing revoked it): minting a new link replaces it, which also proves an expired link does not block a resend
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp', 'en')::text$q$, r1, uG, l6, h6, cvA));
  IF v_res NOT LIKE '%"replaced": ["' || l5 || '"%' OR NOT EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l4 AND revoked_reason = 'replaced') THEN RAISE EXCEPTION 'FAIL minting did not replace the expired and the earlier active links: %', v_res; END IF;
  -- l6 is the active one; l4 was replaced, so it can no longer be applied
  v_res := pg_temp.svc(format($q$SELECT public.compliance_apply_form_link(%L, 'Siti Aminah', 'siti@example.test', NULL, '{}', NULL)::text$q$, l4));
  IF v_res NOT LIKE 'ERR 23514%form_link_invalid%' THEN RAISE EXCEPTION 'FAIL a replaced link was accepted (saw %)', v_res; END IF;

  -- the real submission on l6
  SELECT to_jsonb(r) - 'updated_at' INTO v_before FROM compliance_requests r WHERE id = r1;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_apply_form_link(%L, 'Siti Aminah binti Yusof', 'siti@example.test', '+60999999999',
                                     '{"confirm_closure":true,"children_finished_school":true,"allowances_cancelled":true,"declaration":true}', 'ENCRYPTED-BANK-ANSWERS', 'ms')::text$q$, l6));
  IF v_res NOT LIKE '%"request_id": "' || r1 || '"%' OR v_res NOT LIKE '%"reference": "CMP-%' OR v_res NOT LIKE '%"created_by": "' || uG || '"%' OR v_res NOT LIKE '%"conversation_id": "' || cvA || '"%' THEN
    RAISE EXCEPTION 'FAIL the submission did not answer with the case, its reference, who sent the link and the conversation: %', v_res;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE id = r1 AND customer_name = 'Siti Aminah binti Yusof' AND customer_email = 'siti@example.test' AND customer_phone = '+60123456881'
                    AND data ->> 'reason' = 'Moving abroad' AND data ->> 'declaration' = 'true' AND data ->> 'confirm_closure' = 'true' AND data_enc = 'ENCRYPTED-BANK-ANSWERS'
                    AND customer_locale = 'ms' AND status = 'received' AND identity_check = '{}'::jsonb AND source = 'inbox' AND created_by = uG AND email_verified_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL the case was not updated as expected: %', (SELECT to_jsonb(r) - 'data_enc' FROM compliance_requests r WHERE id = r1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l6 AND submitted_at IS NOT NULL) THEN RAISE EXCEPTION 'FAIL the link was not marked used'; END IF;
  SELECT count(*) INTO v_n FROM compliance_request_events WHERE request_id = r1 AND kind = 'form_submitted';
  -- one from step 1 (a hand-made row) plus the real one
  IF v_n <> 2 OR NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'form_submitted' AND actor IS NULL AND detail ->> 'link' = l6::text) THEN
    RAISE EXCEPTION 'FAIL the submission wrote % form_submitted events (want the real one, with no actor, naming only the link)', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND (detail::text LIKE '%ENCRYPTED%' OR detail::text LIKE '%siti@example%' OR detail::text LIKE '%Siti Aminah%')) THEN
    RAISE EXCEPTION 'FAIL what the parent typed is in the trail';
  END IF;
  -- a double submit: the second finds the link used and changes nothing
  SELECT to_jsonb(r) - 'updated_at' INTO v_after FROM compliance_requests r WHERE id = r1;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_apply_form_link(%L, 'Someone Else', 'other@example.test', NULL, '{"reason":"changed"}', 'OTHER', 'zh')::text$q$, l6));
  IF v_res NOT LIKE 'ERR 23514%form_link_invalid%' THEN RAISE EXCEPTION 'FAIL a second submission on the same link was accepted (saw %)', v_res; END IF;
  IF (SELECT to_jsonb(r) - 'updated_at' FROM compliance_requests r WHERE id = r1) IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'FAIL a second submission changed the case'; END IF;
  SELECT count(*) INTO v_n FROM compliance_request_events WHERE request_id = r1 AND kind = 'form_submitted';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL a second submission wrote another event'; END IF;
  -- after a form came back: no new link, nothing to revoke, the used link stays used
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp')::text$q$, r1, uAd, l7, h7, cvA));
  IF v_res NOT LIKE 'ERR 23514%form_link_submitted%' THEN RAISE EXCEPTION 'FAIL a new link was minted after the form came back (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT coalesce(public.compliance_revoke_form_link(%L, %L)::text, 'none')$q$, r1, uAd));
  IF v_res <> 'none' THEN RAISE EXCEPTION 'FAIL a link was revoked after the form came back (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$UPDATE compliance_form_links SET submitted_at = NULL WHERE id = %L$q$, l6));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a used link was reopened by hand (saw %)', v_res; END IF;

  -- a case that has moved on to sign-off cannot take a form (the link stays unused)
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, channel, customer_name, created_by, conversation_id) VALUES (%L, %L, 'closure', 'inbox', 'whatsapp', 'Third', %L, %L)$q$, r3, acctA, uG, cvA));
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp')::text$q$, r3, uG, gen_random_uuid(), md5('r3a') || md5('r3b'), cvA));
  SELECT id INTO l7 FROM compliance_form_links WHERE request_id = r3;
  PERFORM set_config('vircle.compliance_fn', 'on', true);
  UPDATE compliance_requests SET status = 'awaiting_signoff' WHERE id = r3;
  PERFORM set_config('vircle.compliance_fn', 'off', true);
  v_res := pg_temp.svc(format($q$SELECT public.compliance_apply_form_link(%L, 'Siti', 'siti3@example.test', NULL, '{"confirm_closure":true}', NULL)::text$q$, l7));
  IF v_res NOT LIKE 'ERR 23514%form_link_invalid%' THEN RAISE EXCEPTION 'FAIL a form was applied to a case already with the Head of Compliance (saw %)', v_res; END IF;
  IF EXISTS (SELECT 1 FROM compliance_form_links WHERE id = l7 AND submitted_at IS NOT NULL) OR EXISTS (SELECT 1 FROM compliance_requests WHERE id = r3 AND customer_email IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL a refused submission changed the link or the case';
  END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, %L, 'whatsapp')::text$q$, r3, uG, gen_random_uuid(), md5('r3c') || md5('r3d'), cvA));
  IF v_res NOT LIKE 'ERR 23514%form_link_not_allowed%' THEN RAISE EXCEPTION 'FAIL a link was minted for a case with the Head of Compliance (saw %)', v_res; END IF;

  -- another workspace cannot send a link for this case, and its owner reads none of workspace A's links
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name) VALUES (%L, %L, 'closure', 'staff', 'B Parent')$q$, r4, acctB));
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, NULL, 'email')::text$q$, r4, uG, gen_random_uuid(), md5('b1') || md5('b2')));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent of workspace A minted a link for a case of workspace B (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_mint_form_link(%L, %L, %L, %L, NULL, 'email')::text$q$, r4, uB, gen_random_uuid(), md5('b3') || md5('b4')));
  IF v_res NOT LIKE '%"id":%' AND v_res NOT LIKE '%"id": %' THEN RAISE EXCEPTION 'FAIL the owner of workspace B could not mint for their own case: %', v_res; END IF;

  -- who reads the rows through the browser
  v_res := pg_temp.run(uAd, 'SELECT count(*)::text FROM compliance_form_links');
  IF v_res::int < 6 THEN RAISE EXCEPTION 'FAIL a holder of menu.compliance cannot read the links (saw %)', v_res; END IF;
  v_res := pg_temp.run(uG, 'SELECT count(*)::text FROM compliance_form_links');
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL an agent without menu.compliance read links (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, 'SELECT count(*)::text FROM compliance_form_links');
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer read links (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, 'SELECT count(*)::text FROM compliance_form_links');
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL the owner of B should see exactly B''s link (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, 'SELECT token_hash FROM compliance_form_links LIMIT 1');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the token hash was readable through the browser (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$UPDATE compliance_form_links SET sent_at = now() WHERE id = %L$q$, l6));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in user wrote a link (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 9. Retention, and a deleted message
  -- ------------------------------------------------------------
  v_res := pg_temp.svc(format($q$DELETE FROM compliance_form_links WHERE id = %L$q$, l6));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a link of a case under retention was deleted by the service role (saw %)', v_res; END IF;
  v_res := pg_temp.svc('TRUNCATE compliance_form_links');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the links were truncated (saw %)', v_res; END IF;
  BEGIN
    DELETE FROM compliance_form_links WHERE id = l6;
    RAISE EXCEPTION 'FAIL the table owner deleted a link of a case under retention';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- the message a link remembers can be deleted (the Pending delete panel does): the column is emptied and nothing else changes
  SELECT count(*) INTO v_n FROM compliance_form_links WHERE message_id = m1;
  IF v_n < 1 THEN RAISE EXCEPTION 'FAIL no link remembers the message (the walk above should have)'; END IF;
  DELETE FROM messages WHERE id = m1;
  IF EXISTS (SELECT 1 FROM compliance_form_links WHERE message_id = m1) OR (SELECT count(*) FROM compliance_form_links WHERE request_id = r1) <> 6 THEN
    RAISE EXCEPTION 'FAIL deleting the message did not empty message_id cleanly';
  END IF;

  -- ------------------------------------------------------------
  -- 10. Functions: nothing for a browser role, search_path pinned
  -- ------------------------------------------------------------
  FOREACH k IN ARRAY ARRAY[
    'compliance_mint_form_link(uuid,uuid,uuid,text,uuid,text,text,integer)', 'compliance_form_link_sent(uuid,uuid,uuid,boolean,boolean,text)',
    'compliance_revoke_form_link(uuid,uuid)', 'compliance_form_link_opened(uuid)', 'compliance_apply_form_link(uuid,text,text,text,jsonb,text,text)',
    'compliance_account_change_fields(uuid)', 'compliance_form_links_guard()', 'compliance_accounts_seed()'
  ] LOOP
    IF has_function_privilege('anon', k, 'EXECUTE') OR has_function_privilege('authenticated', k, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL a browser role can call %', k;
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY[
    'compliance_mint_form_link(uuid,uuid,uuid,text,uuid,text,text,integer)', 'compliance_form_link_sent(uuid,uuid,uuid,boolean,boolean,text)',
    'compliance_revoke_form_link(uuid,uuid)', 'compliance_form_link_opened(uuid)', 'compliance_apply_form_link(uuid,text,text,text,jsonb,text,text)', 'compliance_account_change_fields(uuid)'
  ] LOOP
    IF NOT has_function_privilege('service_role', k, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL the service role cannot call %', k; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = k::regprocedure AND (NOT p.prosecdef OR NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%'))) THEN
      RAISE EXCEPTION 'FAIL % is not a security definer function with a pinned search_path', k;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'ROLLBACK-OK: link_card messages and the new timeline kinds and notification type are accepted (and the old ones kept, unknown ones refused); the account change type on every workspace (what changes first, three choices and never a parent''s name, conditional pairs, edits survive); the links table (RLS, no browser write, no token hash for the browser, one policy for menu.compliance, written only by the functions); minting (permitted people, closure only, before sign-off, replacing the previous link, one active link, clamped days, no repeat token); sent / not sent with named reasons; opened once; revoking; the atomic apply (existing case updated, phone kept, identity check not done, used once, refuses revoked / replaced / expired / bad input / a case past review, no answers in the trail); retention; no browser role reaches any new function';
END
$verify$;
