-- Verify migration 160 (Doc Sign forms). Self-contained; run against an empty database or production with
-- 157's to 160's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();
  acctA  uuid;
  d1     uuid;
  tpl    uuid;
  ver    uuid;
  s1     uuid;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  PERFORM public.sign_ensure_defaults(acctA);

  -- both columns exist and are empty by default
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sign_template_versions' AND column_name = 'form') THEN
    RAISE EXCEPTION 'FAIL sign_template_versions.form is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sign_documents' AND column_name = 'form_snapshot') THEN
    RAISE EXCEPTION 'FAIL sign_documents.form_snapshot is missing';
  END IF;

  -- a form must be an object
  INSERT INTO sign_templates (account_id, name, created_by) VALUES (acctA, 'T', uA) RETURNING id INTO tpl;
  BEGIN
    INSERT INTO sign_template_versions (account_id, template_id, version_no, source_path, source_sha256, page_count, form)
    VALUES (acctA, tpl, 1, 'p', repeat('a', 64), 1, '[1,2]'::jsonb);
    RAISE EXCEPTION 'FAIL a form that is an array was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO sign_template_versions (account_id, template_id, version_no, source_path, source_sha256, page_count, form)
  VALUES (acctA, tpl, 1, 'p', repeat('a', 64), 1, '{"version":1,"parts":[],"fields":[]}'::jsonb) RETURNING id INTO ver;

  -- a draft can carry and change its form; once sent it is frozen
  INSERT INTO sign_documents (account_id, title, created_by, form_snapshot) VALUES (acctA, 'Form doc', uA, '{"version":1,"parts":[],"fields":[]}'::jsonb) RETURNING id INTO d1;
  UPDATE sign_documents SET form_snapshot = '{"version":1,"parts":[{"key":"p"}],"fields":[]}'::jsonb WHERE id = d1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email) VALUES (acctA, d1, 'merchant', 'Ali', 'ali@example.invalid') RETURNING id INTO s1;
  PERFORM public.sign_send_document(d1, 'p', repeat('a', 64), 1, now() + interval '14 days', uA);
  BEGIN
    UPDATE sign_documents SET form_snapshot = '{"version":1,"parts":[],"fields":[]}'::jsonb WHERE id = d1;
    RAISE EXCEPTION 'FAIL the form of a sent document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- the expiry can still be extended on a sent document, and the earlier frozen content still holds
  UPDATE sign_documents SET expires_at = expires_at + interval '7 days' WHERE id = d1;
  BEGIN
    UPDATE sign_documents SET title = 'Other' WHERE id = d1;
    RAISE EXCEPTION 'FAIL the title of a sent document was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  RAISE EXCEPTION 'ROLLBACK-OK: forms are stored on template versions and documents as objects, a draft may change its form, a sent document cannot, and its expiry can still be extended';
END
$verify$;
