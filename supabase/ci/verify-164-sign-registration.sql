-- Verify migration 164 (Doc Sign registration forms). Self-contained (builds its own workspaces), so it runs
-- against an empty database as well as production. Concatenate 157's to 164's migration text in front when
-- the database does not have them yet, then run it. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();
  uAg    uuid := gen_random_uuid();
  uV     uuid := gen_random_uuid();
  uB     uuid := gen_random_uuid();
  acctA  uuid;
  acctB  uuid;
  tplA   uuid;
  tplB   uuid;
  tagA   uuid;
  tagB   uuid;
  docA   uuid;
  f1     uuid;
  fB     uuid;
  r1     uuid;
  v_res  text;
  v_n    int;
  v_slug text := 'merchant-7k2m9x4q';
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
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
    (uAg, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ag-' || uAg || '@example.invalid', '{"full_name":"Agent"}', now()),
    (uV,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'v-'  || uV  || '@example.invalid', '{"full_name":"Viewer"}', now()),
    (uB,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'  || uB  || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  UPDATE profiles SET account_id = acctA, account_role = 'agent'  WHERE user_id = uAg;
  UPDATE profiles SET account_id = acctA, account_role = 'viewer' WHERE user_id = uV;

  INSERT INTO sign_templates (account_id, name, created_by) VALUES (acctA, 'Merchant Application', uA) RETURNING id INTO tplA;
  INSERT INTO sign_templates (account_id, name, created_by) VALUES (acctB, 'Other tenant template', uB) RETURNING id INTO tplB;
  INSERT INTO tags (account_id, user_id, name) VALUES (acctA, uA, 'Merchant applicant') RETURNING id INTO tagA;
  INSERT INTO tags (account_id, user_id, name) VALUES (acctB, uB, 'Other tenant tag') RETURNING id INTO tagB;

  -- 1. Both tables exist, row level security is on, and the API roles have exactly the grants the policies expect.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sign_registration_forms'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sign_registrations'::regclass) THEN
    RAISE EXCEPTION 'FAIL row level security is off on a registration table';
  END IF;
  IF has_table_privilege('anon', 'public.sign_registration_forms', 'SELECT') OR has_table_privilege('anon', 'public.sign_registrations', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL a signed-out caller can read a registration table';
  END IF;
  IF has_table_privilege('authenticated', 'public.sign_registrations', 'INSERT')
     OR has_table_privilege('authenticated', 'public.sign_registrations', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.sign_registrations', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL a signed-in user can write submissions (the server alone does)';
  END IF;
  IF has_table_privilege('authenticated', 'public.sign_registration_forms', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL a signed-in user can delete a form (it is switched off, never deleted)';
  END IF;

  -- 2. A slug is 6 to 40 characters of a-z, 0-9 and hyphens, starting and ending with a letter or digit.
  FOREACH v_res IN ARRAY ARRAY['ab12', 'abcde', 'Kedai-ABC123', 'has space123', '-abcdef12', 'abcdef12-', repeat('a', 41), 'under_score1', 'kedai.runcit1'] LOOP
    BEGIN
      INSERT INTO sign_registration_forms (account_id, slug, name) VALUES (acctA, v_res, 'x');
      RAISE EXCEPTION 'FAIL the slug % was accepted', v_res;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  FOREACH v_res IN ARRAY ARRAY['abcdef', repeat('a', 40), 'a-b-c-d-e-f'] LOOP
    INSERT INTO sign_registration_forms (account_id, slug, name) VALUES (acctB, v_res, 'edge slug');
  END LOOP;
  DELETE FROM sign_registration_forms WHERE account_id = acctB;

  -- 3. Defaults: switched off, mode sign, 100 a day, name + email + company required and phone optional.
  INSERT INTO sign_registration_forms (account_id, slug, name, created_by, template_id, applicant_role_key, contact_tag_id)
  VALUES (acctA, v_slug, 'Merchant sign-up', uA, tplA, 'merchant', tagA) RETURNING id INTO f1;
  IF (SELECT active FROM sign_registration_forms WHERE id = f1) IS NOT FALSE THEN RAISE EXCEPTION 'FAIL a new form should start switched off'; END IF;
  IF (SELECT mode FROM sign_registration_forms WHERE id = f1) <> 'sign' OR (SELECT daily_cap FROM sign_registration_forms WHERE id = f1) <> 100
     OR NOT (SELECT send_document FROM sign_registration_forms WHERE id = f1) THEN
    RAISE EXCEPTION 'FAIL form defaults are not mode sign, 100 a day, send the document';
  END IF;
  IF (SELECT fields FROM sign_registration_forms WHERE id = f1) <>
     '{"full_name": "required", "email": "required", "phone": "optional", "company": "required"}'::jsonb THEN
    RAISE EXCEPTION 'FAIL the default details asked are wrong: %', (SELECT fields FROM sign_registration_forms WHERE id = f1);
  END IF;

  -- 4. A slug is unique across every workspace.
  BEGIN
    INSERT INTO sign_registration_forms (account_id, slug, name) VALUES (acctB, v_slug, 'Copycat');
    RAISE EXCEPTION 'FAIL the same slug was accepted in another workspace';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO sign_registration_forms (account_id, slug, name, template_id) VALUES (acctB, 'other-tenant-4n8p2w', 'Other form', tplB) RETURNING id INTO fB;

  -- 5. The values the page relies on are checked.
  -- (169 adds mode 'form', and holds it to a template of that mode: an unknown mode is what is refused here)
  BEGIN UPDATE sign_registration_forms SET mode = 'survey' WHERE id = f1; RAISE EXCEPTION 'FAIL an unknown mode was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET daily_cap = 0 WHERE id = f1; RAISE EXCEPTION 'FAIL a daily cap of 0 was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET daily_cap = 5001 WHERE id = f1; RAISE EXCEPTION 'FAIL a daily cap of 5001 was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET default_locale = 'fr' WHERE id = f1; RAISE EXCEPTION 'FAIL language fr was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET fields = '{"full_name":"required","email":"optional"}'::jsonb WHERE id = f1; RAISE EXCEPTION 'FAIL an optional email was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET fields = '[]'::jsonb WHERE id = f1; RAISE EXCEPTION 'FAIL fields as an array was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET fields = '{"email":"required","fax":"required"}'::jsonb WHERE id = f1; RAISE EXCEPTION 'FAIL an unknown detail was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET fields = '{"email":"required","phone":"maybe"}'::jsonb WHERE id = f1; RAISE EXCEPTION 'FAIL an unknown level was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET signers_other = '{"a":1}'::jsonb WHERE id = f1; RAISE EXCEPTION 'FAIL signers_other as an object was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET consent_text = '{"fr":"x"}'::jsonb WHERE id = f1; RAISE EXCEPTION 'FAIL wording in language fr was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET consent_text = '{"en":5}'::jsonb WHERE id = f1; RAISE EXCEPTION 'FAIL wording that is not text was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE sign_registration_forms SET success_message = '[]'::jsonb WHERE id = f1; RAISE EXCEPTION 'FAIL a success message as an array was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE sign_registration_forms
     SET fields = '{"full_name":"required","email":"required","phone":"off","company":"optional"}'::jsonb,
         consent_text = '{"en":"We keep your details to start your registration.","ms":"Kami menyimpan butiran anda."}'::jsonb,
         success_message = '{"en":"Check your email."}'::jsonb,
         signers_other = '[{"role_key":"director","name":"Siti","email":"siti@example.invalid","channel":"email"}]'::jsonb
   WHERE id = f1;

  -- 6. A form only points at its own workspace's template and tag, even for the server.
  BEGIN
    UPDATE sign_registration_forms SET template_id = tplB WHERE id = f1;
    RAISE EXCEPTION 'FAIL a form pointed at another workspace''s template';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_registration_forms SET contact_tag_id = tagB WHERE id = f1;
    RAISE EXCEPTION 'FAIL a form pointed at another workspace''s tag';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_registration_forms SET account_id = acctB WHERE id = f1;
    RAISE EXCEPTION 'FAIL a form moved to another workspace';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 7. People: whoever holds sign.settings manages forms; an agent reads only; a viewer and another workspace see nothing.
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_registration_forms (account_id, slug, name, created_by) VALUES (%L, 'owner-made-5t9c3z', 'Owner made', %L)$q$, acctA, uA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the owner could not create a form: %', v_res; END IF;
  v_res := pg_temp.run(uAg, format($q$INSERT INTO sign_registration_forms (account_id, slug, name, created_by) VALUES (%L, 'agent-made-6u2d4y', 'Agent made', %L)$q$, acctA, uAg));
  IF v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL an agent created a form'; END IF;
  v_res := pg_temp.run(uAg, format($q$UPDATE sign_registration_forms SET name = 'Hijacked' WHERE id = %L$q$, f1));
  IF (SELECT name FROM sign_registration_forms WHERE id = f1) <> 'Merchant sign-up' THEN RAISE EXCEPTION 'FAIL an agent renamed a form'; END IF;
  v_res := pg_temp.run(uA, format($q$UPDATE sign_registration_forms SET name = 'Merchant sign-up (2026)', active = true WHERE id = %L$q$, f1));
  IF v_res <> 'OK' OR (SELECT name FROM sign_registration_forms WHERE id = f1) <> 'Merchant sign-up (2026)' OR NOT (SELECT active FROM sign_registration_forms WHERE id = f1) THEN
    RAISE EXCEPTION 'FAIL the owner could not change and switch on a form: %', v_res;
  END IF;
  v_res := pg_temp.run(uA, format($q$UPDATE sign_registration_forms SET account_id = %L WHERE id = %L$q$, acctB, f1));
  IF v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL the owner moved a form to another workspace'; END IF;
  v_res := pg_temp.run(uA, format($q$DELETE FROM sign_registration_forms WHERE id = %L$q$, f1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner could delete a form: %', v_res; END IF;
  v_res := pg_temp.run(uAg, $q$SELECT count(*)::text FROM sign_registration_forms$q$);
  IF v_res <> '2' THEN RAISE EXCEPTION 'FAIL an agent should read the 2 forms of the workspace (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, $q$SELECT count(*)::text FROM sign_registration_forms$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer read forms (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, $q$SELECT count(*)::text FROM sign_registration_forms$q$);
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL the other workspace should see only its own form (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT count(*)::text FROM sign_registration_forms WHERE id = %L$q$, f1));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace read this workspace''s form'; END IF;

  -- 8. Submissions: written by the server only, read by whoever reads Doc Sign.
  INSERT INTO sign_registrations (account_id, form_id, status, reason, email_hash, ip_hash, user_agent, locale, consent_version)
  VALUES (acctA, f1, 'accepted', NULL, repeat('a', 64), repeat('b', 64), 'Mozilla/5.0', 'ms', 'default-v1-ms') RETURNING id INTO r1;
  INSERT INTO sign_registrations (account_id, form_id, status, reason) VALUES (acctA, f1, 'rejected_spam', 'honeypot');
  INSERT INTO sign_registrations (account_id, form_id, status, reason) VALUES (acctA, f1, 'rejected_cap', 'daily_cap');
  INSERT INTO sign_registrations (account_id, form_id, status, reason) VALUES (acctA, f1, 'failed', 'sign_limit_reached');
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_registrations (account_id, form_id, status) VALUES (%L, %L, 'accepted')$q$, acctA, f1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner wrote a submission from the browser: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$UPDATE sign_registrations SET status = 'failed' WHERE id = %L$q$, r1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the owner changed a submission from the browser: %', v_res; END IF;
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM sign_registrations$q$);
  IF v_res <> '4' THEN RAISE EXCEPTION 'FAIL the owner should read the 4 submissions (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAg, $q$SELECT count(*)::text FROM sign_registrations$q$);
  IF v_res <> '4' THEN RAISE EXCEPTION 'FAIL an agent should read the 4 submissions (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, $q$SELECT count(*)::text FROM sign_registrations$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer read submissions (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, $q$SELECT count(*)::text FROM sign_registrations$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace read submissions (saw %)', v_res; END IF;
  BEGIN INSERT INTO sign_registrations (account_id, form_id, status) VALUES (acctA, f1, 'maybe'); RAISE EXCEPTION 'FAIL an unknown status was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO sign_registrations (account_id, form_id, status, email_hash) VALUES (acctA, f1, 'accepted', 'someone@example.invalid'); RAISE EXCEPTION 'FAIL a raw email was accepted as a hash'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO sign_registrations (account_id, form_id, status, ip_hash) VALUES (acctA, f1, 'accepted', '203.0.113.9'); RAISE EXCEPTION 'FAIL a raw address was accepted as a hash'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO sign_registrations (account_id, form_id, status, reason) VALUES (acctA, f1, 'failed', repeat('x', 61)); RAISE EXCEPTION 'FAIL a reason over 60 characters was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  -- a submission cannot be filed against another workspace's form
  BEGIN INSERT INTO sign_registrations (account_id, form_id, status) VALUES (acctB, f1, 'accepted'); RAISE EXCEPTION 'FAIL a submission crossed workspaces'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;

  -- 8b. The counts the Settings list shows are made in the database: last 30 days, "today" is the last 24 hours and counts
  --     only acceptances that started something, a claim still being handled is not an outcome, and RLS decides who sees what.
  INSERT INTO sign_registrations (account_id, form_id, status, reason, created_at) VALUES (acctA, f1, 'failed', 'in_progress', now());
  INSERT INTO sign_registrations (account_id, form_id, status, reason, created_at) VALUES (acctA, f1, 'accepted', 'duplicate', now());
  INSERT INTO sign_registrations (account_id, form_id, status, reason, created_at) VALUES (acctA, f1, 'accepted', NULL, now() - interval '40 days');
  SELECT count(*) INTO v_n FROM public.sign_registration_counts(acctA, now() - interval '30 days', now() - interval '1 day')
   WHERE form_id = f1 AND accepted = 2 AND rejected_spam = 1 AND rejected_cap = 1 AND failed = 1 AND today = 1;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FAIL the counts are wrong: %', (SELECT row_to_json(c)::text FROM public.sign_registration_counts(acctA, now() - interval '30 days', now() - interval '1 day') c WHERE c.form_id = f1);
  END IF;
  v_res := pg_temp.run(uAg, format($q$SELECT count(*)::text FROM public.sign_registration_counts(%L, now() - interval '30 days', now() - interval '1 day')$q$, acctA));
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL an agent should be counted the one form with submissions (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, format($q$SELECT count(*)::text FROM public.sign_registration_counts(%L, now() - interval '30 days', now() - interval '1 day')$q$, acctA));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer was counted submissions (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT count(*)::text FROM public.sign_registration_counts(%L, now() - interval '30 days', now() - interval '1 day')$q$, acctA));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace was counted this workspace''s submissions (saw %)', v_res; END IF;
  IF has_function_privilege('anon', 'public.sign_registration_counts(uuid, timestamptz, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL a signed-out caller can call the counts';
  END IF;

  -- 9. Removing what a form points at never blocks and never deletes the form or its submissions.
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Registration draft', uA) RETURNING id INTO docA;
  UPDATE sign_registrations SET document_id = docA WHERE id = r1;
  DELETE FROM sign_documents WHERE id = docA;
  IF (SELECT document_id FROM sign_registrations WHERE id = r1) IS NOT NULL THEN RAISE EXCEPTION 'FAIL a deleted draft is still linked from its submission'; END IF;
  DELETE FROM sign_templates WHERE id = tplA;
  IF (SELECT template_id FROM sign_registration_forms WHERE id = f1) IS NOT NULL THEN RAISE EXCEPTION 'FAIL a deleted template is still on the form'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sign_registration_forms WHERE id = f1) THEN RAISE EXCEPTION 'FAIL deleting the template removed the form'; END IF;
  SELECT count(*) INTO v_n FROM sign_registrations WHERE form_id = f1;
  IF v_n <> 7 THEN RAISE EXCEPTION 'FAIL expected the 7 submissions to survive, found %', v_n; END IF;

  -- 10. The audit log records who made or changed a form, without the slug, the wording or the people.
  SELECT count(*) INTO v_n FROM audit_log WHERE account_id = acctA AND entity_type = 'sign_settings' AND entity_id = f1;
  IF v_n < 2 THEN RAISE EXCEPTION 'FAIL expected the creation and the change of the form in the audit log, found %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_id = f1
              AND (coalesce(summary::text, '') LIKE '%' || v_slug || '%' OR coalesce(summary::text, '') LIKE '%Check your email%' OR coalesce(summary::text, '') LIKE '%siti@example.invalid%')) THEN
    RAISE EXCEPTION 'FAIL the audit log holds the slug, the wording or an email address';
  END IF;

  -- 11. Deleting the workspace removes both tables' rows with everything else (the pattern of 157 and 153).
  PERFORM set_config('vircle.hard_delete', 'on', true);
  PERFORM set_config('vircle.purge_account', acctA::text, true);
  DELETE FROM ticket_sla_policies WHERE account_id = acctA;
  DELETE FROM incident_escalation_policies WHERE account_id = acctA;
  DELETE FROM deals WHERE account_id = acctA;
  DELETE FROM accounts WHERE id = acctA;
  SELECT count(*) INTO v_n FROM sign_registration_forms WHERE account_id = acctA;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL forms survived the purge'; END IF;
  SELECT count(*) INTO v_n FROM sign_registrations WHERE account_id = acctA;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL submissions survived the purge'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sign_registration_forms WHERE id = fB) THEN RAISE EXCEPTION 'FAIL the other workspace lost its form'; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: forms have a unique url-safe slug of 6 to 40 characters, start switched off in mode sign with a daily cap and the default details asked; the email is always required and the JSON shapes are enforced even for the server; a form only points at its own workspace''s template and tag; sign.settings manages forms, an agent reads, a viewer and another workspace see nothing, nobody deletes; submissions are written by the server alone, hold only keyed hashes and short codes, and cannot cross workspaces; removing a template or a draft leaves the form and its submissions; the counts are made in the database and follow row level security; the audit log records changes without the slug, wording or addresses; a workspace purge removes both tables';
END
$verify$;
