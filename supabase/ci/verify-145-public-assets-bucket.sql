-- Verify migration 145. Self-contained; concatenate 145's migration text in front when the
-- database does not have it yet. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA    uuid := gen_random_uuid();
  uB    uuid := gen_random_uuid();
  acctA uuid;
  acctB uuid;
  v_res text;
  v_n   int;
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
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;

  -- 1. The bucket exists, is public, and has the same ceiling as chat-media.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'public-assets' AND public AND file_size_limit = 16777216) THEN
    RAISE EXCEPTION 'FAIL public-assets should exist as a public 16 MB bucket';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'public-assets' AND 'text/html' = ANY (allowed_mime_types)) THEN
    RAISE EXCEPTION 'FAIL a public bucket must not accept text/html';
  END IF;

  -- 2. A member writes inside their own workspace folder, not another workspace's.
  v_res := pg_temp.run(uA, format($q$INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('public-assets', 'account-%s/kb/a.png', %L)$q$, acctA, uA));
  IF v_res <> 'OK' THEN RAISE EXCEPTION 'FAIL member should write own folder: %', v_res; END IF;
  v_res := pg_temp.run(uA, format($q$INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('public-assets', 'account-%s/kb/x.png', %L)$q$, acctB, uA));
  IF v_res NOT LIKE 'ERR 42501%' AND v_res NOT LIKE 'ERR %row-level security%' THEN
    RAISE EXCEPTION 'FAIL member must not write another workspace folder: %', v_res;
  END IF;

  -- 3. Listing: a member sees their own folder only; signed-out callers see nothing.
  EXECUTE format($q$INSERT INTO storage.objects (bucket_id, name) VALUES ('public-assets', 'account-%s/kb/b.png')$q$, acctB);
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM storage.objects WHERE bucket_id = 'public-assets'$q$);
  IF v_res <> '1' THEN RAISE EXCEPTION 'FAIL member should list only their own folder (saw %)', v_res; END IF;
  v_res := pg_temp.run(uA, 'SELECT 1', 'anon');
  v_res := pg_temp.run(uA, $q$SELECT count(*)::text FROM storage.objects WHERE bucket_id = 'public-assets'$q$, 'anon');
  IF v_res <> '0' THEN RAISE EXCEPTION 'FAIL signed-out callers must not list public-assets (saw %)', v_res; END IF;

  -- 4. Update and delete are scoped to the workspace folder too. (Storage refuses a direct
  --    DELETE from SQL, so the rule is checked on the policy text rather than by deleting.)
  FOR v_res IN SELECT unnest(ARRAY['Members can update public assets', 'Members can delete public assets']) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = v_res
        AND qual LIKE '%public-assets%' AND qual LIKE '%storage.foldername%'
    ) THEN
      RAISE EXCEPTION 'FAIL policy % should be scoped to the workspace folder', v_res;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'ROLLBACK-OK: public-assets bucket and its workspace-scoped policies behave';
END
$verify$;
