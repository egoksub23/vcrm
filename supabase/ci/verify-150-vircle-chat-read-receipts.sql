-- Verify migration 150. Self-contained (builds its own workspace), so it runs against an
-- empty database as well as production. Concatenate 147's and 150's migration text in front
-- when the database does not have them yet, then run it. Ends in a deliberate error so nothing
-- is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA    uuid := gen_random_uuid();
  acctA uuid;
  contA uuid;
  convA uuid;
  v_n   int;
  v_def text;
  v_ix  text;
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  INSERT INTO contacts (account_id, user_id, name, phone, wallet_id) VALUES (acctA, uA, 'Aisha', '+60100000150', 'W150') RETURNING id INTO contA;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (acctA, uA, contA) RETURNING id INTO convA;

  -- 1. The new column: nullable timestamptz, empty for every new message.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'read_receipt_sent_at'
      AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'FAIL messages.read_receipt_sent_at is missing or has the wrong type';
  END IF;

  -- 2. The read-tick function: still SECURITY DEFINER, now names vircle_chat, clients cannot call it.
  SELECT pg_get_functiondef('public.widget_customer_messages_read()'::regprocedure) INTO v_def;
  IF v_def NOT LIKE '%SECURITY DEFINER%' THEN RAISE EXCEPTION 'FAIL widget_customer_messages_read is not SECURITY DEFINER'; END IF;
  IF v_def NOT LIKE '%vircle_chat%' OR v_def NOT LIKE '%web_widget%' THEN
    RAISE EXCEPTION 'FAIL widget_customer_messages_read does not cover both web_widget and vircle_chat';
  END IF;
  IF has_function_privilege('anon', 'public.widget_customer_messages_read()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.widget_customer_messages_read()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL clients can execute widget_customer_messages_read';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.widget_customer_messages_read()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL service_role cannot execute widget_customer_messages_read';
  END IF;

  -- 3. The trigger is in place and fires on unread_count only.
  SELECT pg_get_triggerdef(t.oid) INTO v_def
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.conversations'::regclass AND t.tgname = 'conversations_widget_read_ticks' AND NOT t.tgisinternal;
  IF v_def IS NULL THEN RAISE EXCEPTION 'FAIL the read-tick trigger is missing on conversations'; END IF;
  IF v_def NOT LIKE '%UPDATE OF unread_count%' THEN RAISE EXCEPTION 'FAIL the read-tick trigger has an unexpected definition: %', v_def; END IF;

  -- 4. Behaviour: an agent opening the conversation (unread_count to 0) reads the customer's
  --    Vircle Chat and web widget messages, and nothing else.
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, status, message_id)
  VALUES (convA, 'customer', 'text',  'vircle 1',      'vircle_chat', 'sent',      'm_150_1'),
         (convA, 'customer', 'image', 'vircle 2',      'vircle_chat', 'delivered', 'm_150_2'),
         (convA, 'agent',    'text',  'agent reply',   'vircle_chat', 'sent',      'm_150_3'),
         (convA, 'customer', 'text',  'widget one',    'web_widget',  'sent',      NULL),
         (convA, 'customer', 'text',  'whatsapp one',  'whatsapp',    'sent',      'wamid.150');

  UPDATE conversations SET unread_count = 3 WHERE id = convA;
  SELECT count(*) INTO v_n FROM messages WHERE conversation_id = convA AND status = 'read';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL messages went read before the agent opened the chat: %', v_n; END IF;

  UPDATE conversations SET unread_count = 0 WHERE id = convA;
  SELECT count(*) INTO v_n FROM messages
   WHERE conversation_id = convA AND sender_type = 'customer' AND channel_type = 'vircle_chat' AND status = 'read';
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL expected both Vircle Chat customer messages read, got %', v_n; END IF;
  SELECT count(*) INTO v_n FROM messages
   WHERE conversation_id = convA AND sender_type = 'customer' AND channel_type = 'web_widget' AND status = 'read';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL the web widget customer message should still go read, got %', v_n; END IF;
  SELECT count(*) INTO v_n FROM messages WHERE conversation_id = convA AND status = 'read';
  IF v_n <> 3 THEN RAISE EXCEPTION 'FAIL something other than the customer web widget / Vircle Chat messages went read (% read)', v_n; END IF;
  IF (SELECT status FROM messages WHERE conversation_id = convA AND message_id = 'm_150_3') <> 'sent' THEN
    RAISE EXCEPTION 'FAIL the agent''s own message was changed';
  END IF;
  IF (SELECT status FROM messages WHERE conversation_id = convA AND message_id = 'wamid.150') <> 'sent' THEN
    RAISE EXCEPTION 'FAIL a WhatsApp message was changed';
  END IF;

  -- 5. Nothing is marked as reported yet; the pending lookup finds exactly the two Vircle Chat messages,
  --    and stops finding one once it is marked.
  SELECT count(*) INTO v_n FROM messages WHERE conversation_id = convA AND read_receipt_sent_at IS NOT NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL a message started out as already reported (%)', v_n; END IF;
  SELECT count(*) INTO v_n FROM messages
   WHERE conversation_id = convA AND channel_type = 'vircle_chat' AND sender_type = 'customer'
     AND status = 'read' AND read_receipt_sent_at IS NULL;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL the pending lookup should find 2 messages, found %', v_n; END IF;
  UPDATE messages SET read_receipt_sent_at = now() WHERE conversation_id = convA AND message_id = 'm_150_1';
  SELECT count(*) INTO v_n FROM messages
   WHERE conversation_id = convA AND channel_type = 'vircle_chat' AND sender_type = 'customer'
     AND status = 'read' AND read_receipt_sent_at IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL the pending lookup should find 1 message after one was reported, found %', v_n; END IF;

  -- 6. The partial index is there and is partial on the pending rows.
  SELECT indexdef INTO v_ix FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'messages' AND indexname = 'messages_vircle_read_receipt_pending_idx';
  IF v_ix IS NULL THEN RAISE EXCEPTION 'FAIL the pending-receipts index is missing'; END IF;
  IF v_ix NOT LIKE '%read_receipt_sent_at IS NULL%' OR v_ix NOT LIKE '%vircle_chat%' THEN
    RAISE EXCEPTION 'FAIL the pending-receipts index is not partial on the pending rows: %', v_ix;
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: opening a conversation reads the customer''s Vircle Chat and web widget messages (and nothing else), read_receipt_sent_at starts empty and drops a message out of the pending lookup once set, the pending index is partial, and the function stays SECURITY DEFINER with no client execute grant';
END
$verify$;
