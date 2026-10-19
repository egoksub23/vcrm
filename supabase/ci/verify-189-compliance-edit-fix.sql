-- Verify migration 189 (an edit to a compliance request: the customer's details and the answers can be saved).
-- Self-contained; run against an empty database or production with 183's and 189's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Why this exists: migration 183's verify script edited only the assignee, the links and the request date, so nothing ever saved a customer detail or an
-- answer, and `v_changed := v_changed || 'customer_email'` (an array || an untyped literal, read as an array literal) failed with 22P02 on production.
--
-- Proves: each editable key saves ALONE and the answer names exactly what changed; every key together; a value cleared with null; each change is an
-- event naming the field and never the value; a viewer, an unknown key and a closed case are still refused; the function is still closed to the API
-- roles and still pins its search_path.
DO $verify$
DECLARE
  uAd   uuid := gen_random_uuid();
  uV    uuid := gen_random_uuid();
  acctA uuid;
  r1    uuid := gen_random_uuid();
  r2    uuid := gen_random_uuid();
  v_res text;
  v_row compliance_requests%ROWTYPE;
  k     text;
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
    (uAd, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ad-' || uAd || '@example.invalid', '{"full_name":"Admin"}', now()),
    (uV,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'v-'  || uV  || '@example.invalid', '{"full_name":"Viewer"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uAd;
  UPDATE profiles SET account_id = acctA, account_role = 'viewer' WHERE user_id = uV;

  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name, customer_email, customer_phone, channel)
                                 VALUES (%L, %L, 'closure', 'staff', 'Before', 'before@example.test', '+60123456789', 'email')$q$, r1, acctA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL could not create the case: %', v_res; END IF;

  -- each key saves on its own, and the answer names exactly what changed
  FOREACH k IN ARRAY ARRAY['customer_name', 'customer_email', 'customer_phone', 'channel'] LOOP
    v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, jsonb_build_object(%L, %L))::text$q$, r1, uAd, k,
      CASE k WHEN 'customer_name' THEN 'After Name' WHEN 'customer_email' THEN 'after@example.test' WHEN 'customer_phone' THEN '+60127776666' ELSE 'after-channel' END));
    IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL saving % was refused: %', k, v_res; END IF;
    IF (v_res::jsonb -> 'changed') <> to_jsonb(ARRAY[k]) THEN RAISE EXCEPTION 'FAIL saving % reported % as changed', k, v_res::jsonb -> 'changed'; END IF;
  END LOOP;
  SELECT * INTO v_row FROM compliance_requests WHERE id = r1;
  IF v_row.customer_name <> 'After Name' OR v_row.customer_email <> 'after@example.test'
     OR v_row.customer_phone <> '+60127776666' OR v_row.channel <> 'after-channel' THEN
    RAISE EXCEPTION 'FAIL a saved customer detail is not in the row';
  END IF;

  -- the answers (data) and the sealed answers (data_enc, reported as sensitive_data)
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, '{"data": {"reason": "moving abroad"}}')::text$q$, r1, uAd));
  IF v_res LIKE 'ERR%' OR (v_res::jsonb -> 'changed') <> '["data"]'::jsonb THEN RAISE EXCEPTION 'FAIL saving the answers: %', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, jsonb_build_object('data_enc', 'sealed-value'))::text$q$, r1, uAd));
  IF v_res LIKE 'ERR%' OR (v_res::jsonb -> 'changed') <> '["sensitive_data"]'::jsonb THEN RAISE EXCEPTION 'FAIL saving the sealed answers: %', v_res; END IF;
  IF (SELECT data ->> 'reason' FROM compliance_requests WHERE id = r1) <> 'moving abroad' THEN RAISE EXCEPTION 'FAIL the saved answer is not in the row'; END IF;

  -- everything at once, in the order the form sends it, with an e-mail cleared by null
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L,
      jsonb_build_object('customer_name', 'All Together', 'customer_email', NULL, 'customer_phone', '+60129998888', 'channel', 'whatsapp', 'assigned_to', %L))::text$q$, r1, uAd, uAd));
  IF v_res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL saving every detail together: %', v_res; END IF;
  IF NOT ((v_res::jsonb -> 'changed') @> '["customer_name", "customer_email", "customer_phone", "channel"]'::jsonb) THEN RAISE EXCEPTION 'FAIL the answer did not name every change: %', v_res; END IF;
  SELECT * INTO v_row FROM compliance_requests WHERE id = r1;
  IF v_row.customer_email IS NOT NULL OR v_row.customer_name <> 'All Together' OR v_row.channel <> 'whatsapp' THEN RAISE EXCEPTION 'FAIL the combined save is not in the row'; END IF;

  -- the events name the fields and never carry a personal value
  IF NOT EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND kind = 'edited' AND detail -> 'fields' ? 'customer_email') THEN
    RAISE EXCEPTION 'FAIL the e-mail edit was not logged as an event';
  END IF;
  IF EXISTS (SELECT 1 FROM compliance_request_events WHERE request_id = r1 AND (detail::text LIKE '%After Name%' OR detail::text LIKE '%after@example.test%' OR detail::text LIKE '%+60127776666%' OR detail::text LIKE '%before@example.test%' OR detail::text LIKE '%moving abroad%' OR detail::text LIKE '%sealed-value%')) THEN
    RAISE EXCEPTION 'FAIL an edit event carries a value';
  END IF;

  -- what is still refused
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, '{"customer_email": "x@example.test"}')::text$q$, r1, uV));
  IF v_res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL a viewer edited a customer detail (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, '{"status": "approved"}')::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 22023%unknown_field%' THEN RAISE EXCEPTION 'FAIL an unknown key was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, '[]')::text$q$, r1, uAd));
  IF v_res NOT LIKE 'ERR 22023%bad_patch%' THEN RAISE EXCEPTION 'FAIL a patch that is not an object was accepted (saw %)', v_res; END IF;
  v_res := pg_temp.svc(format($q$INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name) VALUES (%L, %L, 'closure', 'staff', 'Closed one')$q$, r2, acctA));
  PERFORM set_config('vircle.compliance_fn', 'on', true);
  UPDATE compliance_requests SET status = 'closed', closed_at = now() WHERE id = r2;
  PERFORM set_config('vircle.compliance_fn', 'off', true);
  v_res := pg_temp.svc(format($q$SELECT public.compliance_update_request(%L, %L, '{"customer_name": "Reopened?"}')::text$q$, r2, uAd));
  IF v_res NOT LIKE 'ERR 23514%closed%' THEN RAISE EXCEPTION 'FAIL a closed case was edited (saw %)', v_res; END IF;

  -- privileges are as 183 left them
  FOREACH k IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(k, 'public.compliance_update_request(uuid, uuid, jsonb)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL % can call compliance_update_request', k; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.compliance_update_request(uuid, uuid, jsonb)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL the service role cannot call compliance_update_request'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.compliance_update_request(uuid, uuid, jsonb)'::regprocedure AND prosecdef AND proconfig @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'FAIL the function is not security definer with a pinned search_path';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: every editable key saves on its own and the answer names exactly it (name, e-mail, phone, channel, the answers, the sealed answers), all together with an e-mail cleared by null, each change is an event with the field and no value, a viewer, an unknown key, a non-object patch and a closed case are still refused, and the function is still closed to the API roles with its search_path pinned';
END
$verify$;
