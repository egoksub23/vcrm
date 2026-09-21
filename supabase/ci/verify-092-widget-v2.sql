-- Run together with the migration (concatenate the two files; run the
-- migration twice ahead of this to prove it is idempotent). Ends in a
-- deliberate error so nothing is kept.
DO $$
DECLARE
  v_account uuid;
  v_owner   uuid;
  v_a       uuid;
  v_b       uuid;
  v_guest   uuid;
  v_conv    uuid;
  v_conv2   uuid;
  v_cfg     uuid;
  v_n       integer;
  v_status  text;
BEGIN
  SELECT id, owner_user_id INTO v_account, v_owner FROM accounts WHERE owner_user_id IS NOT NULL LIMIT 1;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'FAIL no account to test against';
  END IF;

  -- ---- 1. columns, defaults, constraints ------------------------------
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'web_widget_config'
     AND column_name IN ('verification_mode', 'identity_secret_enc', 'identity_secret_last4', 'identity_secret_rotated_at');
  IF v_n <> 4 THEN RAISE EXCEPTION 'FAIL web_widget_config columns: %', v_n; END IF;

  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'widget_visitors'
     AND column_name IN ('identity_level', 'identity_source', 'identity_verified_at');
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL widget_visitors columns: %', v_n; END IF;

  -- An existing config row (or a new one) defaults to verification_mode 'none'.
  SELECT id INTO v_cfg FROM web_widget_config WHERE account_id = v_account;
  IF v_cfg IS NULL THEN
    INSERT INTO web_widget_config (account_id, user_id, widget_token)
    VALUES (v_account, v_owner, 'wt_verify_' || gen_random_uuid()::text)
    RETURNING id INTO v_cfg;
  END IF;
  SELECT verification_mode INTO v_status FROM web_widget_config WHERE id = v_cfg;
  IF v_status <> 'none' THEN RAISE EXCEPTION 'FAIL verification_mode default: %', v_status; END IF;

  BEGIN
    UPDATE web_widget_config SET verification_mode = 'sms_code' WHERE id = v_cfg;
    RAISE EXCEPTION 'FAIL verification_mode accepted an unknown value';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE web_widget_config SET verification_mode = 'email_code' WHERE id = v_cfg;
  UPDATE web_widget_config SET verification_mode = 'whatsapp_code' WHERE id = v_cfg;
  UPDATE web_widget_config SET verification_mode = 'none' WHERE id = v_cfg;

  -- ---- 2. audit: the secret column is named, never valued --------------
  UPDATE web_widget_config
     SET identity_secret_enc = 'SECRET-CIPHERTEXT-SHOULD-NOT-APPEAR',
         identity_secret_last4 = 'abcd', identity_secret_rotated_at = now()
   WHERE id = v_cfg;
  SELECT count(*) INTO v_n FROM audit_log
   WHERE account_id = v_account AND entity_type = 'channel_config'
     AND summary::text LIKE '%identity_secret_enc%';
  IF v_n < 1 THEN
    RAISE EXCEPTION 'FAIL audit did not record that the identity secret changed';
  END IF;
  SELECT count(*) INTO v_n FROM audit_log
   WHERE account_id = v_account AND summary::text LIKE '%SECRET-CIPHERTEXT%';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'FAIL audit leaked the secret value';
  END IF;

  -- ---- 3. contacts + merge suggestions ---------------------------------
  INSERT INTO contacts (account_id, user_id, phone, name, email)
    VALUES (v_account, v_owner, '60111000001', 'Verify A', 'verify-a@example.com') RETURNING id INTO v_a;
  INSERT INTO contacts (account_id, user_id, phone, name, email)
    VALUES (v_account, v_owner, '60111000002', 'Verify B', 'Verify-B@Example.com') RETURNING id INTO v_b;

  -- lower(email) lookup uses the new index and is case-insensitive.
  SELECT count(*) INTO v_n FROM contacts
   WHERE account_id = v_account AND lower(email) = 'verify-b@example.com';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL lower(email) lookup returned %', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_contacts_account_email_lower') THEN
    RAISE EXCEPTION 'FAIL email index missing';
  END IF;

  INSERT INTO contact_merge_suggestions (account_id, contact_a_id, contact_b_id) VALUES (v_account, v_a, v_b);
  BEGIN
    -- The reversed pair is the same pair.
    INSERT INTO contact_merge_suggestions (account_id, contact_a_id, contact_b_id) VALUES (v_account, v_b, v_a);
    RAISE EXCEPTION 'FAIL the reversed pair was accepted as a second suggestion';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO contact_merge_suggestions (account_id, contact_a_id, contact_b_id) VALUES (v_account, v_a, v_a);
    RAISE EXCEPTION 'FAIL a contact was suggested as a duplicate of itself';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE contact_merge_suggestions SET status = 'archived' WHERE contact_a_id = v_a;
    RAISE EXCEPTION 'FAIL unknown suggestion status accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contact_merge_suggestions'::regclass) THEN
    RAISE EXCEPTION 'FAIL RLS is off on contact_merge_suggestions';
  END IF;
  IF has_table_privilege('authenticated', 'public.contact_merge_suggestions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.contact_merge_suggestions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.contact_merge_suggestions', 'DELETE')
     OR has_table_privilege('anon', 'public.contact_merge_suggestions', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL clients can write contact_merge_suggestions';
  END IF;

  -- merge_contacts (the function the suggestion's Merge calls) still folds B
  -- into A and the suggestion row goes with B.
  PERFORM merge_contacts(v_account, v_a, v_b);
  IF EXISTS (SELECT 1 FROM contact_merge_suggestions WHERE contact_a_id = v_a OR contact_b_id = v_a) THEN
    RAISE EXCEPTION 'FAIL the suggestion survived the merge of its contact';
  END IF;

  -- ---- 4. enquiries -----------------------------------------------------
  INSERT INTO widget_enquiries (account_id, contact_id, role, message, consent_at)
    VALUES (v_account, v_a, 'parent', 'hello', now());
  BEGIN
    INSERT INTO widget_enquiries (account_id, contact_id, role, message, consent_at)
      VALUES (v_account, v_a, 'student', 'hello', now());
    RAISE EXCEPTION 'FAIL unknown enquiry role accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF has_table_privilege('authenticated', 'public.widget_enquiries', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL clients can write widget_enquiries';
  END IF;

  -- ---- 5. widget_visitors defaults + constraint -------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'widget_visitors_identity_level_check')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'widget_visitors_identity_source_check') THEN
    RAISE EXCEPTION 'FAIL identity check constraints missing';
  END IF;

  -- ---- 6. messages statuses + read ticks --------------------------------
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (v_account, v_owner, v_a) RETURNING id INTO v_conv;
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, status)
    VALUES (v_conv, 'customer', 'text', 'widget 1', 'web_widget', 'sent'),
           (v_conv, 'customer', 'image', 'widget 2', 'web_widget', 'delivered'),
           (v_conv, 'agent',    'text', 'agent reply', 'web_widget', 'sent'),
           (v_conv, 'customer', 'text', 'whatsapp one', 'whatsapp', 'sent');

  -- Raising the count does nothing; only an agent reading (to 0) flips ticks.
  UPDATE conversations SET unread_count = 3 WHERE id = v_conv;
  SELECT count(*) INTO v_n FROM messages WHERE conversation_id = v_conv AND status = 'read';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL messages went read before the agent opened the chat: %', v_n; END IF;

  UPDATE conversations SET unread_count = 0 WHERE id = v_conv;
  SELECT count(*) INTO v_n FROM messages
   WHERE conversation_id = v_conv AND sender_type = 'customer' AND channel_type = 'web_widget' AND status = 'read';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL expected both widget customer messages read, got %', v_n; END IF;
  SELECT status INTO v_status FROM messages WHERE conversation_id = v_conv AND sender_type = 'agent';
  IF v_status <> 'sent' THEN RAISE EXCEPTION 'FAIL an agent message must not be touched, is %', v_status; END IF;
  SELECT status INTO v_status FROM messages WHERE conversation_id = v_conv AND channel_type = 'whatsapp';
  IF v_status <> 'sent' THEN RAISE EXCEPTION 'FAIL a WhatsApp message must not be touched, is %', v_status; END IF;

  -- delivered/read statuses are all accepted by the messages constraint.
  UPDATE messages SET status = 'delivered' WHERE conversation_id = v_conv AND sender_type = 'agent';
  UPDATE messages SET status = 'read'      WHERE conversation_id = v_conv AND sender_type = 'agent';

  -- ---- 7. the guest merge still works -----------------------------------
  INSERT INTO contacts (account_id, user_id, phone, name)
    VALUES (v_account, v_owner, '', 'Website visitor') RETURNING id INTO v_guest;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (v_account, v_owner, v_guest) RETURNING id INTO v_conv2;
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, status)
    VALUES (v_conv2, 'customer', 'text', 'from the guest', 'web_widget', 'sent');
  PERFORM merge_widget_guest_contact(v_account, v_guest, v_a);
  IF EXISTS (SELECT 1 FROM contacts WHERE id = v_guest) THEN
    RAISE EXCEPTION 'FAIL the guest contact survived the merge';
  END IF;
  SELECT count(*) INTO v_n FROM messages WHERE conversation_id = v_conv AND content_text = 'from the guest';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL the guest message did not move to the target conversation'; END IF;

  -- ---- 8. the trigger function is not callable by clients ---------------
  IF has_function_privilege('anon', 'public.widget_customer_messages_read()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.widget_customer_messages_read()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL clients can execute widget_customer_messages_read';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: widget v2 schema, suggestions, enquiries, read ticks, audit, guest merge';
END $$;
