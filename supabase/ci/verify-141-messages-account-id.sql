-- Verify migration 141. Self-contained (builds its own workspaces), so it runs against an
-- empty database as well as production. Concatenate 141's migration text in front when the
-- database does not have it yet, then run it. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA uuid := gen_random_uuid();
  uB uuid := gen_random_uuid();
  acctA uuid;
  acctB uuid;
  contactA uuid;
  contactA2 uuid;
  convA uuid;
  convA2 uuid;
  msg uuid;
  v_acct uuid;
  v_n int;
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
  INSERT INTO contacts (account_id, user_id, phone) VALUES (acctA, uA, '+60100000141') RETURNING id INTO contactA;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (acctA, uA, contactA) RETURNING id INTO convA;
  INSERT INTO contacts (account_id, user_id, phone) VALUES (acctA, uA, '+60100000142') RETURNING id INTO contactA2;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (acctA, uA, contactA2) RETURNING id INTO convA2;

  -- 1. A writer that supplies nothing gets the conversation's workspace.
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type)
  VALUES (convA, 'agent', 'text', 'hello', 'whatsapp') RETURNING id, account_id INTO msg, v_acct;
  IF v_acct IS DISTINCT FROM acctA THEN RAISE EXCEPTION 'FAIL account_id not set from the conversation (got %)', v_acct; END IF;

  -- 2. A writer cannot name a different workspace.
  INSERT INTO messages (conversation_id, account_id, sender_type, content_type, content_text, channel_type)
  VALUES (convA, acctB, 'agent', 'text', 'spoof', 'whatsapp') RETURNING account_id INTO v_acct;
  IF v_acct IS DISTINCT FROM acctA THEN RAISE EXCEPTION 'FAIL a supplied account_id was trusted (got %)', v_acct; END IF;

  -- 3. Moving a message to another conversation keeps it consistent.
  UPDATE messages SET conversation_id = convA2 WHERE id = msg;
  SELECT account_id INTO v_acct FROM messages WHERE id = msg;
  IF v_acct IS DISTINCT FROM acctA THEN RAISE EXCEPTION 'FAIL account_id wrong after moving conversation'; END IF;

  -- 4. Nothing is left without a workspace, and every row agrees with its conversation.
  SELECT count(*) INTO v_n FROM messages WHERE account_id IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL % message(s) have no account_id', v_n; END IF;
  SELECT count(*) INTO v_n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.account_id <> c.account_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL % message(s) disagree with their conversation', v_n; END IF;

  -- 5. The column is mandatory.
  IF (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'account_id') <> 'NO' THEN
    RAISE EXCEPTION 'FAIL messages.account_id is nullable';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: messages.account_id is filled from the conversation on insert and on move, cannot be spoofed, and is non-null and consistent for every row';
END
$verify$;
