-- Verify migration 191 (add-on roles: one base role plus any number of add-on roles that only add permissions).
-- Self-contained; run against an empty database or production with 191's migration text concatenated in front when it is not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: (1) the four resolution functions (has_capability, capabilities_for_current_user, capability_account_ids, compliance_user_can) AGREE on every
-- permission for an owner, an admin, an agent with an add-on and a viewer with one; (2) an add-on adds and never removes; (3) it cannot lift a person above
-- what their base tier allows (a viewer stays out of a write permission); (4) nobody gives or puts in an add-on a permission they do not hold; (5) who may make,
-- edit, delete and give add-ons (roles.manage, members.change-role, admin rank, target below the caller, never the owner, never oneself, only this workspace's);
-- (6) the tables are read by members of the workspace only and written by nobody but the functions; (7) deleting an add-on and leaving the workspace take it
-- away; (8) an invitation carries add-ons, refuses another workspace's and one the inviter cannot give, and accepting gives them; (9) the audit trail; (10) the
-- internal functions are closed to the API roles and the public ones to the signed-out role.
DO $verify$
DECLARE
  uOwner uuid := gen_random_uuid();   -- owner of A
  uAd    uuid := gen_random_uuid();   -- admin of A
  uAd2   uuid := gen_random_uuid();   -- a second admin of A
  uG     uuid := gen_random_uuid();   -- an agent of A
  uG2    uuid := gen_random_uuid();   -- a second agent of A
  uV     uuid := gen_random_uuid();   -- a viewer of A
  uB     uuid := gen_random_uuid();   -- owner of workspace B
  uNew   uuid := gen_random_uuid();   -- a new person, accepts an invitation
  acctA  uuid;
  acctB  uuid;
  acctN  uuid;
  ad1    uuid;                        -- "KYC reviewer"
  ad2    uuid;                        -- "Compliance"
  adB    uuid;                        -- an add-on of workspace B
  v_res  text;
  v_n    int;
  v_bad  text;
  v_arr  text;
  k      text;
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
    (uOwner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-'  || uOwner || '@example.invalid', '{"full_name":"Owner"}', now()),
    (uAd,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ad-' || uAd    || '@example.invalid', '{"full_name":"Admin"}', now()),
    (uAd2,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a2-' || uAd2   || '@example.invalid', '{"full_name":"Admin Two"}', now()),
    (uG,     '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g-'  || uG     || '@example.invalid', '{"full_name":"Agent"}', now()),
    (uG2,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'g2-' || uG2    || '@example.invalid', '{"full_name":"Agent Two"}', now()),
    (uV,     '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'v-'  || uV     || '@example.invalid', '{"full_name":"Viewer"}', now()),
    (uB,     '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-'  || uB     || '@example.invalid', '{"full_name":"Owner B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uOwner;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  UPDATE profiles SET account_id = acctA, account_role = 'admin'  WHERE user_id IN (uAd, uAd2);
  UPDATE profiles SET account_id = acctA, account_role = 'agent'  WHERE user_id IN (uG, uG2);
  UPDATE profiles SET account_id = acctA, account_role = 'viewer' WHERE user_id = uV;

  -- ------------------------------------------------------------
  -- 1. Before any add-on: an agent does not hold kyc.decide (Owner and Admin by default)
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'kyc.decide')::text$q$, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL an agent holds kyc.decide before any add-on (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT has_capability(%L, 'kyc.decide')::text$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL an admin does not hold kyc.decide (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 2. Making an add-on: roles.manage, a real name, known permissions, only ones the caller holds
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uAd, format($q$SELECT public.create_addon_role(%L, '  KYC reviewer ', 'Looks at ID checks', ARRAY['menu.kyc','kyc.view','kyc.decide','kyc.view'])::text$q$, acctA));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL an admin could not make an add-on role: %', v_res; END IF;
  ad1 := v_res::uuid;
  IF (SELECT name FROM account_addon_roles WHERE id = ad1) <> 'KYC reviewer' THEN RAISE EXCEPTION 'FAIL the name was not trimmed'; END IF;
  IF (SELECT count(*) FROM account_addon_role_capabilities WHERE addon_role_id = ad1) <> 3 THEN RAISE EXCEPTION 'FAIL a repeated permission was stored twice or one is missing'; END IF;
  v_res := pg_temp.run(uG, format($q$SELECT public.create_addon_role(%L, 'Nope', NULL, ARRAY['menu.kyc'])::text$q$, acctA));
  IF v_res NOT LIKE 'ERR 42501%roles.manage%' THEN RAISE EXCEPTION 'FAIL an agent made an add-on role (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.create_addon_role(%L, 'x', NULL, ARRAY['not.a.capability'])::text$q$, acctA));
  IF v_res NOT LIKE 'ERR 22023%Unknown capability%' THEN RAISE EXCEPTION 'FAIL an unknown permission was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.create_addon_role(%L, '   ', NULL, ARRAY[]::text[])::text$q$, acctA));
  IF v_res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL a blank name was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.create_addon_role(%L, 'kyc REVIEWER', NULL, ARRAY[]::text[])::text$q$, acctA));
  IF v_res NOT LIKE 'ERR 23505%' THEN RAISE EXCEPTION 'FAIL a second add-on with the same name (any case) was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.create_addon_role(%L, 'Elsewhere', NULL, ARRAY[]::text[])::text$q$, acctB));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an admin made an add-on role in another workspace (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 3. The tables: members of the workspace read, nobody writes directly, another workspace sees nothing
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uG, $q$SELECT count(*)::text FROM account_addon_roles$q$);
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL a member does not see the workspace''s add-on role (saw %)', v_res; END IF;
  v_res := pg_temp.run(uG, $q$SELECT count(*)::text FROM account_addon_role_capabilities$q$);
  IF v_res <> '3' THEN RAISE EXCEPTION 'FAIL a member does not see the add-on''s permissions (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, $q$SELECT count(*)::text FROM account_addon_roles WHERE name = 'KYC reviewer'$q$);
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL another workspace sees this workspace''s add-on role (saw %)', v_res; END IF;
  FOREACH k IN ARRAY ARRAY['account_addon_roles', 'account_addon_role_capabilities', 'member_addon_roles'] LOOP
    v_res := pg_temp.run(uAd, format($q$INSERT INTO %I SELECT * FROM %I WHERE false$q$, k, k));
    IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a signed-in person can write % directly (saw %)', k, v_res; END IF;
    v_res := pg_temp.run(NULL, format($q$SELECT count(*)::text FROM %I$q$, k), 'anon');
    IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the signed-out role can read % (saw %)', k, v_res; END IF;
  END LOOP;

  -- ------------------------------------------------------------
  -- 4. Giving it: members.change-role, admin rank, a target below the caller, never the owner, never oneself, only this workspace's roles
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uAd, format($q$SELECT public.set_member_addon_roles(%L, ARRAY[%L]::uuid[])::text$q$, uG, ad1));
  IF v_res LIKE 'ERR%' OR (v_res::jsonb ->> 'added') <> '1' THEN RAISE EXCEPTION 'FAIL an admin could not give an agent an add-on role: %', v_res; END IF;
  v_res := pg_temp.run(uG, format($q$SELECT public.set_member_addon_roles(%L, ARRAY[%L]::uuid[])::text$q$, uG2, ad1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent gave an add-on role (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.set_member_addon_roles(%L, ARRAY[%L]::uuid[])::text$q$, uAd2, ad1));
  IF v_res NOT LIKE 'ERR 42501%below your own%' THEN RAISE EXCEPTION 'FAIL an admin changed another admin (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.set_member_addon_roles(%L, ARRAY[%L]::uuid[])::text$q$, uOwner, ad1));
  IF v_res NOT LIKE 'ERR 22023%owner%' THEN RAISE EXCEPTION 'FAIL an add-on role was given to the owner (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.set_member_addon_roles(%L, ARRAY[%L]::uuid[])::text$q$, uAd, ad1));
  IF v_res NOT LIKE 'ERR 22023%own roles%' THEN RAISE EXCEPTION 'FAIL a person gave themselves an add-on role (saw %)', v_res; END IF;
  adB := pg_temp.run(uB, format($q$SELECT public.create_addon_role(%L, 'B role', NULL, ARRAY['menu.kyc'])::text$q$, acctB))::uuid;
  v_res := pg_temp.run(uAd, format($q$SELECT public.set_member_addon_roles(%L, ARRAY[%L]::uuid[])::text$q$, uG2, adB));
  IF v_res NOT LIKE 'ERR 22023%Role not found%' THEN RAISE EXCEPTION 'FAIL another workspace''s add-on role was given (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.set_member_addon_roles(%L, ARRAY[gen_random_uuid()]::uuid[])::text$q$, uG2));
  IF v_res NOT LIKE 'ERR 22023%Role not found%' THEN RAISE EXCEPTION 'FAIL an unknown add-on role was given (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.set_member_addon_roles(%L, ARRAY[%L]::uuid[])::text$q$, uV, ad1));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL a viewer could not be given an add-on role at all: %', v_res; END IF;

  -- ------------------------------------------------------------
  -- 5. It adds: the agent now holds kyc.decide, everywhere it is asked; it adds nothing else; the viewer's floor holds
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'kyc.decide')::text$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the add-on did not give the agent kyc.decide (saw %)', v_res; END IF;
  v_res := pg_temp.run(uG, format($q$SELECT (%L = ANY (capability_account_ids('kyc.decide')))::text$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL capability_account_ids (the row-level policies) does not see the add-on (saw %)', v_res; END IF;
  v_res := pg_temp.run(uG, format($q$SELECT ('kyc.decide' = ANY (capabilities_for_current_user(%L)))::text$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL capabilities_for_current_user (the app) does not list the add-on''s permission (saw %)', v_res; END IF;
  IF NOT public.compliance_user_can(acctA, uG, 'kyc.decide') THEN RAISE EXCEPTION 'FAIL compliance_user_can does not see the add-on'; END IF;
  v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'roles.manage')::text$q$, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL an add-on gave a permission it does not contain (saw %)', v_res; END IF;
  -- the viewer was given the same add-on but a Viewer never holds a write permission
  v_res := pg_temp.run(uV, format($q$SELECT has_capability(%L, 'kyc.decide')::text$q$, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL an add-on lifted a viewer to a write permission (saw %)', v_res; END IF;
  v_res := pg_temp.run(uV, format($q$SELECT (%L = ANY (capability_account_ids('kyc.decide')))::text$q$, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL capability_account_ids lifted a viewer (saw %)', v_res; END IF;
  -- the owner is unchanged
  v_res := pg_temp.run(uOwner, format($q$SELECT has_capability(%L, 'kyc.decide')::text$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the owner lost a permission (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 6. ONE meaning everywhere: for every permission and every kind of person the four functions agree
  -- ------------------------------------------------------------
  FOREACH v_res IN ARRAY ARRAY[uOwner::text, uAd::text, uG::text, uV::text] LOOP
    v_bad := pg_temp.run(v_res::uuid, format($q$
      SELECT coalesce(string_agg(c.capability, ',' ORDER BY c.capability), '')
        FROM capability_catalogue c
       WHERE has_capability(%L, c.capability) IS DISTINCT FROM (c.capability = ANY (capabilities_for_current_user(%L)))
          OR has_capability(%L, c.capability) IS DISTINCT FROM (%L = ANY (capability_account_ids(c.capability)))$q$, acctA, acctA, acctA, acctA));
    IF v_bad <> '' THEN RAISE EXCEPTION 'FAIL has_capability, capabilities_for_current_user and capability_account_ids disagree for % on: %', v_res, v_bad; END IF;
    v_arr := pg_temp.run(v_res::uuid, format($q$SELECT array_to_string(capabilities_for_current_user(%L), ',')$q$, acctA));
    SELECT coalesce(string_agg(c.capability, ',' ORDER BY c.capability), '') INTO v_bad
      FROM capability_catalogue c WHERE public.compliance_user_can(acctA, v_res::uuid, c.capability);
    IF v_arr <> v_bad THEN RAISE EXCEPTION 'FAIL compliance_user_can disagrees with the app''s list for %', v_res; END IF;
  END LOOP;

  -- ------------------------------------------------------------
  -- 7. Nobody gives or puts in more than they hold
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uOwner, format($q$SELECT public.set_role_capabilities(%L, 'admin'::account_role_enum, '{"kyc.decide": false, "kyc.reveal": false}'::jsonb)::text$q$, acctA));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL could not switch kyc.decide and kyc.reveal off for the admin role: %', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.create_addon_role(%L, 'More', NULL, ARRAY['kyc.decide'])::text$q$, acctA));
  IF v_res NOT LIKE 'ERR 42501%do not hold it yourself%' THEN RAISE EXCEPTION 'FAIL an admin put a permission they lack into an add-on (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.set_member_addon_roles(%L, ARRAY[%L]::uuid[])::text$q$, uG2, ad1));
  IF v_res NOT LIKE 'ERR 42501%which you do not hold yourself%' THEN RAISE EXCEPTION 'FAIL an admin gave an add-on that holds a permission they lack (saw %)', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.update_addon_role(%L, NULL, NULL, ARRAY['menu.kyc','kyc.view','kyc.decide','kyc.reveal'])::text$q$, ad1));
  IF v_res NOT LIKE 'ERR 42501%do not hold it yourself%' THEN RAISE EXCEPTION 'FAIL an admin added a permission they lack to an add-on (saw %)', v_res; END IF;
  -- taking an add-on away needs no permission
  v_res := pg_temp.run(uAd, format($q$SELECT public.set_member_addon_roles(%L, ARRAY[]::uuid[])::text$q$, uG));
  IF v_res LIKE 'ERR%' OR (v_res::jsonb ->> 'removed') <> '1' THEN RAISE EXCEPTION 'FAIL an admin could not take an add-on away: %', v_res; END IF;
  v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'kyc.decide')::text$q$, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL taking the add-on away did not take its permission away (saw %)', v_res; END IF;
  PERFORM pg_temp.run(uOwner, format($q$SELECT public.set_role_capabilities(%L, 'admin'::account_role_enum, '{"kyc.decide": null, "kyc.reveal": null}'::jsonb)::text$q$, acctA));

  -- ------------------------------------------------------------
  -- 8. Editing and deleting; another add-on for Compliance
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uAd, format($q$SELECT public.update_addon_role(%L, 'KYC checker', 'Reviews ID checks', ARRAY['menu.kyc','kyc.view','kyc.decide','kyc.reveal'])::text$q$, ad1));
  IF v_res LIKE 'ERR%' OR (v_res::jsonb ->> 'added') <> '1' THEN RAISE EXCEPTION 'FAIL an admin could not edit an add-on role: %', v_res; END IF;
  IF (SELECT name FROM account_addon_roles WHERE id = ad1) <> 'KYC checker' OR NOT EXISTS (SELECT 1 FROM account_addon_role_capabilities WHERE addon_role_id = ad1 AND capability = 'kyc.reveal') THEN
    RAISE EXCEPTION 'FAIL the edit was not stored';
  END IF;
  v_res := pg_temp.run(uG, format($q$SELECT public.update_addon_role(%L, 'Hacked', NULL, NULL)::text$q$, ad1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent edited an add-on role (saw %)', v_res; END IF;
  v_res := pg_temp.run(uB, format($q$SELECT public.update_addon_role(%L, 'Hacked', NULL, NULL)::text$q$, ad1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL another workspace edited this workspace''s add-on role (saw %)', v_res; END IF;
  ad2 := pg_temp.run(uAd, format($q$SELECT public.create_addon_role(%L, 'Compliance', NULL, ARRAY['menu.compliance','compliance.review'])::text$q$, acctA))::uuid;
  PERFORM pg_temp.run(uAd, format($q$SELECT public.set_member_addon_roles(%L, ARRAY[%L, %L]::uuid[])::text$q$, uG, ad1, ad2));
  v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'compliance.review')::text$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL a second add-on role did not add its permission (saw %)', v_res; END IF;
  v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'kyc.decide')::text$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL two add-on roles did not add up (the first one stopped working: %)', v_res; END IF;
  IF NOT public.compliance_user_can(acctA, uG, 'compliance.review') THEN RAISE EXCEPTION 'FAIL Compliance does not count the add-on holder'; END IF;
  IF NOT (uG = ANY (public.compliance_holders(acctA, 'compliance.review'))) THEN RAISE EXCEPTION 'FAIL compliance_holders leaves the add-on holder out'; END IF;
  v_res := pg_temp.run(uAd, format($q$SELECT public.delete_addon_role(%L)::text$q$, ad2));
  IF v_res LIKE 'ERR%' OR (v_res::jsonb ->> 'members') <> '1' THEN RAISE EXCEPTION 'FAIL deleting an add-on role: %', v_res; END IF;
  v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'compliance.review')::text$q$, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL a deleted add-on role still gives its permission (saw %)', v_res; END IF;
  IF EXISTS (SELECT 1 FROM member_addon_roles WHERE addon_role_id = ad2) OR EXISTS (SELECT 1 FROM account_addon_role_capabilities WHERE addon_role_id = ad2) THEN
    RAISE EXCEPTION 'FAIL a deleted add-on role left rows behind';
  END IF;
  v_res := pg_temp.run(uG, format($q$SELECT public.delete_addon_role(%L)::text$q$, ad1));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL an agent deleted an add-on role (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 9. Leaving the workspace takes the add-on roles away
  -- ------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM member_addon_roles WHERE user_id = uG AND account_id = acctA) THEN RAISE EXCEPTION 'FAIL the agent has no add-on role left to lose (the test proves nothing)'; END IF;
  UPDATE profiles SET account_id = acctB, account_role = 'agent' WHERE user_id = uG;
  IF EXISTS (SELECT 1 FROM member_addon_roles WHERE user_id = uG) THEN RAISE EXCEPTION 'FAIL a member who left the workspace kept its add-on roles'; END IF;
  UPDATE profiles SET account_id = acctA, account_role = 'agent' WHERE user_id = uG;
  v_res := pg_temp.run(uG, format($q$SELECT has_capability(%L, 'kyc.decide')::text$q$, acctA));
  IF v_res <> 'false' THEN RAISE EXCEPTION 'FAIL coming back to a workspace brought the add-on roles back (saw %)', v_res; END IF;

  -- ------------------------------------------------------------
  -- 10. An invitation carries add-on roles; accepting gives them
  -- ------------------------------------------------------------
  v_res := pg_temp.run(uAd, format($q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at, addon_role_ids)
                                      VALUES (%L, 'verify-191-ok', 'agent', %L, now() + interval '7 days', ARRAY[%L]::uuid[])$q$, acctA, uAd, ad1));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL an admin could not invite with an add-on role: %', v_res; END IF;
  v_res := pg_temp.run(uAd, format($q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at, addon_role_ids)
                                      VALUES (%L, 'verify-191-foreign', 'agent', %L, now() + interval '7 days', ARRAY[%L]::uuid[])$q$, acctA, uAd, adB));
  IF v_res NOT LIKE 'ERR 22023%Role not found%' THEN RAISE EXCEPTION 'FAIL an invitation carried another workspace''s add-on role (saw %)', v_res; END IF;
  PERFORM pg_temp.run(uOwner, format($q$SELECT public.set_role_capabilities(%L, 'admin'::account_role_enum, '{"kyc.decide": false}'::jsonb)::text$q$, acctA));
  v_res := pg_temp.run(uAd, format($q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at, addon_role_ids)
                                      VALUES (%L, 'verify-191-escalate', 'agent', %L, now() + interval '7 days', ARRAY[%L]::uuid[])$q$, acctA, uAd, ad1));
  IF v_res NOT LIKE 'ERR 42501%which you do not hold yourself%' THEN RAISE EXCEPTION 'FAIL an invitation carried an add-on role the inviter cannot give (saw %)', v_res; END IF;
  PERFORM pg_temp.run(uOwner, format($q$SELECT public.set_role_capabilities(%L, 'admin'::account_role_enum, '{"kyc.decide": null}'::jsonb)::text$q$, acctA));

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uNew, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'n-' || uNew || '@example.invalid', '{"full_name":"New"}', now());
  SELECT account_id INTO acctN FROM profiles WHERE user_id = uNew;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uNew, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', uNew::text, true);
  PERFORM public.redeem_invitation('verify-191-ok');
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF NOT EXISTS (SELECT 1 FROM member_addon_roles WHERE user_id = uNew AND addon_role_id = ad1 AND account_id = acctA AND assigned_by = uAd) THEN
    RAISE EXCEPTION 'FAIL accepting the invitation did not give its add-on role';
  END IF;
  v_res := pg_temp.run(uNew, format($q$SELECT has_capability(%L, 'kyc.decide')::text$q$, acctA));
  IF v_res <> 'true' THEN RAISE EXCEPTION 'FAIL the new member does not hold the add-on''s permission (saw %)', v_res; END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE id = acctN) THEN RAISE EXCEPTION 'FAIL the new member''s empty personal workspace is still there (190)'; END IF;

  -- ------------------------------------------------------------
  -- 11. The audit trail names what was done, and who by
  -- ------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_type = 'role' AND action = 'created' AND entity_label = 'KYC reviewer') THEN RAISE EXCEPTION 'FAIL making an add-on role is not in the audit trail'; END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_type = 'role' AND action = 'capability_changed' AND entity_id = ad1) THEN RAISE EXCEPTION 'FAIL changing an add-on role''s permissions is not in the audit trail'; END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_type = 'member' AND action = 'role_changed' AND entity_id = uG) THEN RAISE EXCEPTION 'FAIL giving an add-on role is not in the audit trail'; END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE account_id = acctA AND entity_type = 'role' AND action = 'deleted' AND entity_id = ad2) THEN RAISE EXCEPTION 'FAIL deleting an add-on role is not in the audit trail'; END IF;

  -- ------------------------------------------------------------
  -- 12. Privileges
  -- ------------------------------------------------------------
  FOREACH k IN ARRAY ARRAY['public.addon_grants_capability(uuid, uuid, text)', 'public.person_has_capability(uuid, uuid, text)', 'public.member_addon_roles_cleanup()', 'public.enforce_invitation_addons()'] LOOP
    IF has_function_privilege('anon', k, 'EXECUTE') OR has_function_privilege('authenticated', k, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL a browser role can call %', k; END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['public.create_addon_role(uuid, text, text, text[])', 'public.update_addon_role(uuid, text, text, text[])', 'public.delete_addon_role(uuid)', 'public.set_member_addon_roles(uuid, uuid[])'] LOOP
    IF has_function_privilege('anon', k, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL the signed-out role can call %', k; END IF;
    IF NOT has_function_privilege('authenticated', k, 'EXECUTE') THEN RAISE EXCEPTION 'FAIL a signed-in person cannot call %', k; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = k::regprocedure AND prosecdef AND proconfig @> ARRAY['search_path=public']) THEN RAISE EXCEPTION 'FAIL % is not security definer with a pinned search_path', k; END IF;
  END LOOP;

  RAISE EXCEPTION 'ROLLBACK-OK: add-on roles are made, edited and deleted only with roles.manage and only with permissions the caller holds; given only by an admin to a member below them (never the owner, never oneself, only this workspace''s); they ADD and never remove, on top of the base role; a viewer is never lifted to a write permission; has_capability, the app''s list, the row-level policies'' capability_account_ids and Compliance''s function agree on every permission for an owner, an admin, an agent with add-ons and a viewer; deleting one, taking one away and leaving the workspace remove its permissions; an invitation carries them, refuses another workspace''s and ones the inviter cannot give, and accepting gives them; every change is in the audit trail; the internal functions are closed to the API roles and the public ones to the signed-out role';
END
$verify$;
