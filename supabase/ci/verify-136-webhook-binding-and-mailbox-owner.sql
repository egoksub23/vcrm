-- Verify migration 136. Self-contained (builds its own workspaces), so it runs against an
-- empty database as well as production. Concatenate 136's migration text in front when the
-- database does not have it yet, then run it. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();
  uB     uuid := gen_random_uuid();
  acctA  uuid;
  acctB  uuid;
  v_n    int;
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;

  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;

  -- 1. The per-workspace app secret column exists and defaults to none.
  INSERT INTO whatsapp_config (account_id, user_id, phone_number_id, waba_id, access_token)
  VALUES (acctA, uA, 'verify-136-pn-a', 'verify-136-waba-a', 'ciphertext');
  IF (SELECT app_secret_enc FROM whatsapp_config WHERE account_id = acctA) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL app_secret_enc should default to NULL';
  END IF;
  UPDATE whatsapp_config SET app_secret_enc = 'enc-secret' WHERE account_id = acctA;
  IF (SELECT app_secret_enc FROM whatsapp_config WHERE account_id = acctA) <> 'enc-secret' THEN
    RAISE EXCEPTION 'FAIL app_secret_enc could not be stored';
  END IF;

  -- 2. A Gmail address belongs to one workspace, whatever its capitalisation.
  INSERT INTO gmail_config (account_id, connected_by_user_id, email_address, access_token, access_token_expires_at, refresh_token, pubsub_verify_token)
  VALUES (acctA, uA, 'Shared.Box@example.invalid', 'x', now(), 'x', 'verify-136-token-a');
  BEGIN
    INSERT INTO gmail_config (account_id, connected_by_user_id, email_address, access_token, access_token_expires_at, refresh_token, pubsub_verify_token)
    VALUES (acctB, uB, 'shared.box@EXAMPLE.invalid', 'x', now(), 'x', 'verify-136-token-b');
    RAISE EXCEPTION 'FAIL a second workspace connected the same Gmail address';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 3. A Microsoft 365 mailbox belongs to one workspace.
  INSERT INTO email_config (account_id, connected_by_user_id, mailbox_user_id, mailbox_address, access_token, access_token_expires_at, refresh_token, client_state)
  VALUES (acctA, uA, 'verify-136-graph-id', 'one@example.invalid', 'x', now(), 'x', 'x');
  BEGIN
    INSERT INTO email_config (account_id, connected_by_user_id, mailbox_user_id, mailbox_address, access_token, access_token_expires_at, refresh_token, client_state)
    VALUES (acctB, uB, 'verify-136-graph-id', 'one@example.invalid', 'x', now(), 'x', 'x');
    RAISE EXCEPTION 'FAIL a second workspace connected the same Microsoft 365 mailbox';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 4. Different mailboxes are unaffected.
  INSERT INTO gmail_config (account_id, connected_by_user_id, email_address, access_token, access_token_expires_at, refresh_token, pubsub_verify_token)
  VALUES (acctB, uB, 'other.box@example.invalid', 'x', now(), 'x', 'verify-136-token-b2');
  SELECT count(*) INTO v_n FROM gmail_config WHERE account_id IN (acctA, acctB);
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL expected 2 distinct Gmail rows, got %', v_n; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: whatsapp_config.app_secret_enc stores a per-workspace secret; a Gmail address (any case) and a Microsoft 365 mailbox can each belong to one workspace only; distinct mailboxes are unaffected';
END
$verify$;
