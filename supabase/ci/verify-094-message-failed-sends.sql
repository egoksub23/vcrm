-- Verify migration 094. Concatenate the migration text in front of this file (the DB does
-- not have 094 yet), then run it. It ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $$
DECLARE
  v_conv     uuid;
  v_contact  uuid;
  v_visitor  uuid;
  v_seen     bigint;
  v_failed   bigint;
  v_id1      uuid;
  v_id2      uuid;
BEGIN
  -- 1. The column is there.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'send_payload'
  ) THEN
    RAISE EXCEPTION 'FAIL messages.send_payload missing';
  END IF;

  -- 2. The visitor policy names the failed exclusion.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'messages'
       AND policyname = 'messages_widget_visitor_select'
       AND qual ILIKE '%failed%'
  ) THEN
    RAISE EXCEPTION 'FAIL messages_widget_visitor_select does not exclude failed rows';
  END IF;

  -- 3. Two failed rows with NULL message_id in one conversation do not collide
  --    on the unique (conversation_id, message_id) index; the reason columns and
  --    send_payload are writable.
  SELECT c.id, c.contact_id INTO v_conv, v_contact
    FROM conversations c JOIN widget_visitors wv ON wv.contact_id = c.contact_id LIMIT 1;
  IF v_conv IS NULL THEN
    SELECT c.id, c.contact_id INTO v_conv, v_contact FROM conversations c LIMIT 1;
  END IF;
  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK-OK: column and policy present (no conversation to test with)';
  END IF;

  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type,
                        message_id, status, error_code, error_title, error_details, send_payload)
  VALUES (v_conv, 'agent', 'template', 'hello', 'whatsapp',
          NULL, 'failed', 131030, 'Recipient phone number not in allowed list', 'details',
          '{"template_language":"en_US","template_params":["a"]}'::jsonb)
  RETURNING id INTO v_id1;
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type,
                        message_id, status, error_code, error_title)
  VALUES (v_conv, 'agent', 'text', 'again', 'whatsapp', NULL, 'failed', 190, 'expired')
  RETURNING id INTO v_id2;

  -- 4. A web-widget visitor of that contact (if there is one) does not see failed rows.
  SELECT wv.id INTO v_visitor FROM widget_visitors wv WHERE wv.contact_id = v_contact LIMIT 1;
  IF v_visitor IS NOT NULL THEN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_visitor, 'role', 'authenticated', 'is_anonymous', true)::text, true);
    SELECT count(*) INTO v_failed FROM messages WHERE status = 'failed';
    SELECT count(*) INTO v_seen   FROM messages;
    RESET ROLE;
    IF v_failed <> 0 THEN
      RAISE EXCEPTION 'FAIL the widget visitor can read % failed rows', v_failed;
    END IF;
    RAISE EXCEPTION 'ROLLBACK-OK: 2 failed rows insert (NULL ids), visitor sees % messages and 0 failed', v_seen;
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: column, policy, and two failed rows with NULL message_id inserted (no widget visitor to test the read path)';
END $$;
