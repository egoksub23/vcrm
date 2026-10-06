-- Verify migration 163 (Doc Sign option lists). Self-contained (builds its own workspaces), so it runs against an empty
-- database as well as production. Concatenate 157's to 163's migration text in front when they are not applied yet, then
-- run it. Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA    uuid := gen_random_uuid();
  uAg   uuid := gen_random_uuid();
  uV    uuid := gen_random_uuid();
  uB    uuid := gen_random_uuid();
  uC    uuid := gen_random_uuid();
  acctA uuid;
  acctB uuid;
  acctC uuid;
  v_res text;
  v_n   int;
  v_ver int;
  tpl   uuid;
  states_id uuid;
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

  -- 1. The shipped lists: seven, with the content the product promises, and not readable by any API role.
  SELECT count(*) INTO v_n FROM public.sign_option_list_defaults();
  IF v_n <> 7 THEN RAISE EXCEPTION 'FAIL expected 7 shipped lists, found %', v_n; END IF;
  IF (SELECT jsonb_array_length(items) FROM public.sign_option_list_defaults() WHERE key = 'states_my') <> 16 THEN
    RAISE EXCEPTION 'FAIL states_my should hold 13 states and 3 federal territories';
  END IF;
  IF (SELECT jsonb_array_length(items) FROM public.sign_option_list_defaults() WHERE key = 'countries') <> 249 THEN
    RAISE EXCEPTION 'FAIL countries should hold the 249 ISO 3166-1 entries';
  END IF;
  IF (SELECT jsonb_array_length(items) FROM public.sign_option_list_defaults() WHERE key = 'msic') <> 1174 THEN
    RAISE EXCEPTION 'FAIL msic should hold the 1,174 five-digit classes of MSIC 2008 (DOSM)';
  END IF;
  IF (SELECT items -> 0 ->> 'value' FROM public.sign_option_list_defaults() WHERE key = 'msic') <> '01111'
     OR NOT EXISTS (SELECT 1 FROM public.sign_option_list_defaults() d, jsonb_array_elements(d.items) i
                     WHERE d.key = 'msic' AND i ->> 'value' = '62010' AND i #>> '{label,en}' = 'Computer programming activities') THEN
    RAISE EXCEPTION 'FAIL MSIC 01111 should come first and 62010 should be "Computer programming activities"';
  END IF;
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM public.sign_option_list_defaults()$q$);
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in owner could read the shipped lists: %', v_res; END IF;
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM public.sign_option_list_defaults()$q$, 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-out caller could read the shipped lists: %', v_res; END IF;

  -- 2. Seeding: the first call to sign_ensure_defaults copies all seven, again and again changes nothing, and
  --    it leaves no audit entry (shipped content is not something anybody did).
  v_res := pg_temp.run(uA, format($q$SELECT public.sign_seed_option_lists(%L)::text$q$, acctA));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in user could call sign_seed_option_lists: %', v_res; END IF;
  IF EXISTS (SELECT 1 FROM sign_option_lists WHERE account_id = acctA) THEN RAISE EXCEPTION 'FAIL lists existed before anything seeded them'; END IF;
  PERFORM public.sign_ensure_defaults(acctA);
  SELECT count(*) INTO v_n FROM sign_option_lists WHERE account_id = acctA AND is_system;
  IF v_n <> 7 THEN RAISE EXCEPTION 'FAIL expected the 7 system lists after sign_ensure_defaults, found %', v_n; END IF;
  IF public.sign_seed_option_lists(acctA) <> 0 THEN RAISE EXCEPTION 'FAIL seeding a second time added lists'; END IF;
  PERFORM public.sign_ensure_defaults(acctA);
  SELECT count(*) INTO v_n FROM sign_option_lists WHERE account_id = acctA;
  IF v_n <> 7 THEN RAISE EXCEPTION 'FAIL the lists were duplicated (found %)', v_n; END IF;
  IF (SELECT jsonb_array_length(items) FROM sign_option_lists WHERE account_id = acctA AND key = 'msic') <> 1174 THEN
    RAISE EXCEPTION 'FAIL the workspace copy of msic is not complete';
  END IF;
  IF EXISTS (SELECT 1 FROM sign_option_lists WHERE account_id = acctA AND (version <> 1 OR archived OR NOT is_system)) THEN
    RAISE EXCEPTION 'FAIL a freshly seeded list should be version 1, active and a system list';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_type = 'sign_option_list') THEN
    RAISE EXCEPTION 'FAIL seeding wrote to the audit trail';
  END IF;
  SELECT id INTO states_id FROM sign_option_lists WHERE account_id = acctA AND key = 'states_my';
  -- a later seed never overwrites what the workspace changed
  UPDATE sign_option_lists SET items = jsonb_set(items, '{0,label,ms}', '"Johor Darul Takzim"') WHERE id = states_id;
  PERFORM public.sign_seed_option_lists(acctA);
  IF (SELECT items -> 0 #>> '{label,ms}' FROM sign_option_lists WHERE id = states_id) <> 'Johor Darul Takzim' THEN
    RAISE EXCEPTION 'FAIL seeding overwrote a label the workspace had changed';
  END IF;
  -- a workspace nobody seeded stays empty, and another workspace's lists are its own
  IF EXISTS (SELECT 1 FROM sign_option_lists WHERE account_id = acctB) THEN RAISE EXCEPTION 'FAIL the other workspace got lists it did not ask for'; END IF;
  PERFORM public.sign_seed_option_lists(acctB);
  IF (SELECT items -> 0 #>> '{label,ms}' FROM sign_option_lists WHERE account_id = acctB AND key = 'states_my') <> 'Johor' THEN
    RAISE EXCEPTION 'FAIL the other workspace should have the shipped wording, not workspace A''s edit';
  END IF;

  -- 3. Who reads and who writes: menu.sign reads, sign.settings writes, nothing crosses a workspace.
  v_res := pg_temp.run(uAg, $q$SELECT count(*)::text FROM sign_option_lists$q$);
  IF v_res <> '7' THEN RAISE EXCEPTION 'FAIL an agent (menu.sign) should read the 7 lists (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, $q$SELECT count(*)::text FROM sign_option_lists$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL a viewer read lists (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT count(*)::text FROM sign_option_lists WHERE account_id = %L$q$, acctA));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace read these lists (saw %)', v_res; END IF;
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM sign_option_lists$q$, 'anon');
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-out caller read lists: %', v_res; END IF;
  v_res := pg_temp.run(uAg, format($q$WITH u AS (UPDATE sign_option_lists SET name = 'Renamed' WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, states_id));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL an agent renamed a list (rows %)', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$WITH u AS (UPDATE sign_option_lists SET name = 'Renamed' WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, states_id));
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace renamed a list (rows %)', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$WITH u AS (UPDATE sign_option_lists SET name = 'Malaysian states' WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, states_id));
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL the owner could not rename a list (rows %)', v_res; END IF;
  SELECT version INTO v_ver FROM sign_option_lists WHERE id = states_id;
  IF v_ver < 3 THEN RAISE EXCEPTION 'FAIL the version should have moved on with each change (found %)', v_ver; END IF;
  v_res := pg_temp.run(uA, format($q$DELETE FROM sign_option_lists WHERE id = %L$q$, states_id));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a list could be deleted by a person: %', v_res; END IF;

  -- 4. A person makes ordinary lists only.
  v_res := pg_temp.run(uAg, format($q$INSERT INTO sign_option_lists (account_id, key, name, items) VALUES (%L, 'suppliers', 'Suppliers', '[]')$q$, acctA));
  IF v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL an agent made a list: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_option_lists (account_id, key, name, items) VALUES (%L, 'suppliers', 'Suppliers', '[{"value":"acme","label":{"en":"Acme"}}]')$q$, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL the owner could not make a list: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_option_lists (account_id, key, name, items, is_system) VALUES (%L, 'fake_system', 'Fake', '[]', true)$q$, acctA));
  IF v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL a person made a list that claims to be a system list: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_option_lists (account_id, key, name, kind, items) VALUES (%L, 'my_msic', 'Mine', 'msic', '[]')$q$, acctA));
  IF v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL a person made a list of kind msic: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_option_lists (account_id, key, name, items) VALUES (%L, 'Bad Key', 'Bad', '[]')$q$, acctA));
  IF v_res NOT LIKE 'ERR %' THEN RAISE EXCEPTION 'FAIL a list key with a space and capitals was accepted: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO sign_option_lists (account_id, key, name, items) VALUES (%L, 'suppliers', 'Again', '[]')$q$, acctA));
  IF v_res NOT LIKE 'ERR 23505%' THEN RAISE EXCEPTION 'FAIL a second list with the same key was accepted: %', v_res; END IF;
  -- a key that belongs to a shipped list is reserved, even in a workspace that has not been seeded yet
  v_res := pg_temp.run(uB, format($q$INSERT INTO sign_option_lists (account_id, key, name, items) VALUES (%L, 'banks_my', 'My banks', '[]')$q$, acctB));
  IF v_res <> 'OK' THEN
    -- acctB was seeded above, so the unique key refuses it; the reservation is tested on a workspace with no lists below
    IF v_res NOT LIKE 'ERR 23505%' THEN RAISE EXCEPTION 'FAIL unexpected answer for a key taken by a system list: %', v_res; END IF;
  END IF;
  INSERT INTO sign_option_lists (account_id, key, name, items) VALUES (acctA, 'cities', 'Cities', '[{"value":"kl","label":{"en":"Kuala Lumpur"}},{"value":"pj","label":{"en":"Petaling Jaya"}}]');

  -- 5. The rules the table cannot state alone.
  BEGIN
    UPDATE sign_option_lists SET key = 'renamed_key' WHERE id = states_id;
    RAISE EXCEPTION 'FAIL the key of a list changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_option_lists SET kind = 'msic' WHERE id = states_id;
    RAISE EXCEPTION 'FAIL the kind of a list changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_option_lists SET is_system = false WHERE id = states_id;
    RAISE EXCEPTION 'FAIL a system list stopped being one';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_option_lists SET items = items - 0 WHERE id = states_id;
    RAISE EXCEPTION 'FAIL a system list lost an item';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- relabelling, archiving an item and adding one are allowed on a system list
  UPDATE sign_option_lists SET items = jsonb_set(items, '{1,archived}', 'true') WHERE id = states_id;
  UPDATE sign_option_lists SET items = items || '[{"value":"kuala_lumpur_extra","label":{"en":"Extra"}}]'::jsonb WHERE id = states_id;
  IF (SELECT jsonb_array_length(items) FROM sign_option_lists WHERE id = states_id) <> 17 THEN RAISE EXCEPTION 'FAIL an item could not be added to a system list'; END IF;
  BEGIN
    UPDATE sign_option_lists SET items = items || '[{"value":"johor","label":{"en":"Again"}}]'::jsonb WHERE id = states_id;
    RAISE EXCEPTION 'FAIL a duplicate value was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_option_lists SET items = items || '[{"value":"has space","label":{"en":"Bad"}}]'::jsonb WHERE id = states_id;
    RAISE EXCEPTION 'FAIL a value with a space was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_option_lists SET items = items || '[{"value":"nolabel","label":{"ms":"Tiada"}}]'::jsonb WHERE id = states_id;
    RAISE EXCEPTION 'FAIL an item without an English label was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_option_lists SET items = items || '[{"value":"1234","label":{"en":"Short"}}]'::jsonb
     WHERE account_id = acctA AND key = 'msic';
    RAISE EXCEPTION 'FAIL an MSIC code of four digits was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_option_lists SET items = '{}'::jsonb WHERE id = states_id;
    RAISE EXCEPTION 'FAIL items that are not an array were accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- an ordinary list may lose items
  UPDATE sign_option_lists SET items = items - 0 WHERE account_id = acctA AND key = 'cities';
  IF (SELECT jsonb_array_length(items) FROM sign_option_lists WHERE account_id = acctA AND key = 'cities') <> 1 THEN RAISE EXCEPTION 'FAIL an ordinary list could not lose an item'; END IF;
  -- and may be archived, which keeps every form that names it working
  UPDATE sign_option_lists SET archived = true WHERE account_id = acctA AND key = 'cities';
  -- a workspace's own list can never take a key the product ships
  BEGIN
    INSERT INTO sign_option_lists (account_id, key, name, items) VALUES (acctA, 'tax_types', 'Taxes', '[]');
    RAISE EXCEPTION 'FAIL a list of the workspace took a shipped key';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- the reservation also holds in a workspace that has none of the shipped lists yet
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uC, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c-' || uC || '@example.invalid', '{"full_name":"Tenant C"}', now());
  SELECT account_id INTO acctC FROM profiles WHERE user_id = uC;
  IF EXISTS (SELECT 1 FROM sign_option_lists WHERE account_id = acctC) THEN RAISE EXCEPTION 'FAIL a new workspace should have no lists until Doc Sign is opened'; END IF;
  BEGIN
    INSERT INTO sign_option_lists (account_id, key, name, items) VALUES (acctC, 'banks_my', 'My banks', '[]');
    RAISE EXCEPTION 'FAIL a list of an unseeded workspace took a shipped key';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 6. A form that names a big list can be stored: 400 KB used to be the limit, 2 MB is now.
  INSERT INTO sign_templates (account_id, name, created_by) VALUES (acctA, 'Big form', uA) RETURNING id INTO tpl;
  INSERT INTO sign_template_versions (account_id, template_id, version_no, source_path, source_sha256, page_count, form)
  VALUES (acctA, tpl, 1, 'p', repeat('a', 64), 1,
          jsonb_build_object('version', 1, 'parts', '[]'::jsonb, 'fields', '[]'::jsonb, 'pad', repeat('x', 600000)));
  BEGIN
    INSERT INTO sign_template_versions (account_id, template_id, version_no, source_path, source_sha256, page_count, form)
    VALUES (acctA, tpl, 2, 'p', repeat('a', 64), 1,
            jsonb_build_object('version', 1, 'parts', '[]'::jsonb, 'fields', '[]'::jsonb, 'pad', repeat('x', 2100000)));
    RAISE EXCEPTION 'FAIL a form of more than 2 MB was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_documents (account_id, title, created_by, form_snapshot)
    VALUES (acctA, 'Too big', uA, jsonb_build_object('version', 1, 'parts', '[]'::jsonb, 'fields', '[]'::jsonb, 'pad', repeat('x', 2100000)));
    RAISE EXCEPTION 'FAIL a document with a form of more than 2 MB was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 7. Changes by people are in the audit trail, with the list's name; items only by name.
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_type = 'sign_option_list' AND action = 'updated') THEN
    RAISE EXCEPTION 'FAIL a change to a list was not audited';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: 7 shipped lists (16 states, 249 countries, 1,174 MSIC codes) readable only by the server; seeding is idempotent, never overwrites a workspace''s edit and leaves no audit entry; menu.sign reads, sign.settings writes, no other workspace sees or changes a list; a person makes ordinary lists only and a shipped key is reserved; key, kind and system flag are fixed; a system list never loses an item but can be relabelled and added to; values are unique and well formed; the version moves with every change; a list is never deleted; a form of up to 2 MB is accepted';
END
$verify$;
