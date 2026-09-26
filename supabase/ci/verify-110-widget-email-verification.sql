-- ============================================================
-- Verification for migration 110 (widget_verification_codes,
-- widget_reply_notifications).
--
-- Migrations 001-109 are confirmed applied to production, so this
-- only needs its own draft in front:
--   cat supabase/migrations/110_widget_email_verification.sql \
--       supabase/ci/verify-110-widget-email-verification.sql > /tmp/all.sql
--   supabase db query --linked -f /tmp/all.sql
--
-- One DO block ending RAISE EXCEPTION 'ROLLBACK-OK: ...' — nothing is
-- ever committed. Same pg_temp.run(user, sql, role) helper as every
-- prior verify script this session.
-- ============================================================

DO $verify$
DECLARE
  admin_a UUID := gen_random_uuid();
  acct_a  UUID;
  cfg_id  UUID;
  v_contact_id UUID;
  conv_id UUID;
  res     TEXT;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      IF u IS NULL THEN
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
      ELSE
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', u, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.jwt.claim.sub', u::text, true);
      END IF;
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
    END;
    $b$;
  $f$;

  -- 1. Columns exist.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'widget_verification_codes'
       AND column_name = 'widget_visitor_id'
  ) THEN
    RAISE EXCEPTION 'FAIL: widget_verification_codes missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'widget_reply_notifications'
       AND column_name = 'conversation_id'
  ) THEN
    RAISE EXCEPTION 'FAIL: widget_reply_notifications missing';
  END IF;

  -- 2. Set up an account, a widget config, a contact and a conversation
  --    to attach rows to.
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at)
  VALUES (admin_a, 'admin-110@example.com', 'x', NOW());
  SELECT account_id INTO acct_a FROM profiles WHERE user_id = admin_a;
  IF acct_a IS NULL THEN RAISE EXCEPTION 'FAIL: admin has no account'; END IF;

  INSERT INTO web_widget_config (account_id, user_id, widget_token, name, welcome_message, primary_color, position)
  VALUES (acct_a, admin_a, 'wt_verify110_' || acct_a::text, 'Support', 'Hi', '#000000', 'right')
  RETURNING id INTO cfg_id;

  INSERT INTO contacts (account_id, user_id, phone, name, email)
  VALUES (acct_a, admin_a, '60123980112', 'Real Customer', 'real-110@example.com')
  RETURNING id INTO v_contact_id;

  INSERT INTO conversations (account_id, user_id, contact_id)
  VALUES (acct_a, admin_a, v_contact_id)
  RETURNING id INTO conv_id;

  -- 3. service-role (admin client) can insert/read/delete
  --    widget_verification_codes — this is the path the widget's own
  --    API routes use (via the service-role key, not RLS).
  INSERT INTO widget_verification_codes
    (widget_visitor_id, account_id, widget_config_id, contact_id, destination_email, code_hash, expires_at)
  VALUES (gen_random_uuid(), acct_a, cfg_id, v_contact_id, 'real-110@example.com', 'hash', NOW() + INTERVAL '10 minutes');
  IF (SELECT COUNT(*) FROM widget_verification_codes WHERE account_id = acct_a) <> 1 THEN
    RAISE EXCEPTION 'FAIL: service-role insert into widget_verification_codes did not take';
  END IF;

  INSERT INTO widget_reply_notifications (conversation_id, account_id)
  VALUES (conv_id, acct_a);
  IF (SELECT COUNT(*) FROM widget_reply_notifications WHERE conversation_id = conv_id) <> 1 THEN
    RAISE EXCEPTION 'FAIL: service-role insert into widget_reply_notifications did not take';
  END IF;

  -- 4. RLS: an ordinary authenticated session (even the account's own
  --    admin) can read NEITHER table — no CREATE POLICY exists on
  --    either, by design (service-role only).
  res := pg_temp.run(admin_a, format(
    'SELECT COUNT(*)::text FROM widget_verification_codes WHERE account_id = %L', acct_a
  ));
  IF res <> '0' THEN
    RAISE EXCEPTION 'FAIL: an authenticated session could read widget_verification_codes (got %)', res;
  END IF;

  res := pg_temp.run(admin_a, format(
    'SELECT COUNT(*)::text FROM widget_reply_notifications WHERE conversation_id = %L', conv_id
  ));
  IF res <> '0' THEN
    RAISE EXCEPTION 'FAIL: an authenticated session could read widget_reply_notifications (got %)', res;
  END IF;

  -- 5. Anon (no session at all) is blocked too.
  res := pg_temp.run(NULL, format(
    'SELECT COUNT(*)::text FROM widget_verification_codes WHERE account_id = %L', acct_a
  ), 'anon');
  IF res <> '0' THEN
    RAISE EXCEPTION 'FAIL: anon could read widget_verification_codes (got %)', res;
  END IF;

  -- 6. Cascade: deleting the contact removes its verification-code row
  --    (ON DELETE CASCADE on v_contact_id) without needing app cleanup.
  DELETE FROM contacts WHERE id = v_contact_id;
  IF (SELECT COUNT(*) FROM widget_verification_codes WHERE contact_id = v_contact_id) <> 0 THEN
    RAISE EXCEPTION 'FAIL: widget_verification_codes row survived its contact being deleted';
  END IF;
  -- The conversation itself has no FK to contacts.id ON DELETE CASCADE
  -- change here (unrelated to 110); widget_reply_notifications cascades
  -- off conversations directly, so deleting the conversation removes it.
  DELETE FROM conversations WHERE id = conv_id;
  IF (SELECT COUNT(*) FROM widget_reply_notifications WHERE conversation_id = conv_id) <> 0 THEN
    RAISE EXCEPTION 'FAIL: widget_reply_notifications row survived its conversation being deleted';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: migration 110 verified (tables present, service-role write/read works, RLS blocks authenticated and anon, cascades clean up)';
END;
$verify$;
