-- Verify migration 127. Concatenate the migration text in front of this file (the DB does
-- not have 127 yet), then run it. It ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $$
DECLARE
  v_conv       uuid;
  v_stale_id   uuid;
  v_fresh_id   uuid;
  v_recovered  integer;
  v_stale_status text;
  v_fresh_status text;
  v_default_failed boolean;
BEGIN
  -- 1. Columns exist with the right shape.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'conversations'
       AND column_name = 'last_message_failed' AND data_type = 'boolean'
  ) THEN
    RAISE EXCEPTION 'FAIL conversations.last_message_failed missing or wrong type';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'messages'
       AND column_name = 'sending_locked_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'FAIL messages.sending_locked_at missing or wrong type';
  END IF;

  -- 2. A brand-new conversation row defaults last_message_failed to false.
  SELECT c.id INTO v_conv FROM conversations c LIMIT 1;
  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK-OK: columns present (no conversation to test sweep with)';
  END IF;
  SELECT last_message_failed INTO v_default_failed FROM conversations WHERE id = v_conv;
  IF v_default_failed IS NULL THEN
    RAISE EXCEPTION 'FAIL last_message_failed is NULL, expected a boolean default';
  END IF;

  -- 3. sweep_stuck_sending_messages flips a stale 'sending' row to 'failed' and
  --    leaves a fresh one (locked just now) alone.
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type,
                        message_id, status, sending_locked_at)
  VALUES (v_conv, 'agent', 'text', 'stuck for 20 min', 'whatsapp', NULL, 'sending', now() - interval '20 minutes')
  RETURNING id INTO v_stale_id;

  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type,
                        message_id, status, sending_locked_at)
  VALUES (v_conv, 'agent', 'text', 'just started sending', 'whatsapp', NULL, 'sending', now())
  RETURNING id INTO v_fresh_id;

  SELECT recovered INTO v_recovered FROM sweep_stuck_sending_messages(10);
  IF v_recovered IS NULL OR v_recovered < 1 THEN
    RAISE EXCEPTION 'FAIL sweep reported % recovered, expected >= 1', v_recovered;
  END IF;

  SELECT status INTO v_stale_status FROM messages WHERE id = v_stale_id;
  SELECT status INTO v_fresh_status FROM messages WHERE id = v_fresh_id;

  IF v_stale_status <> 'failed' THEN
    RAISE EXCEPTION 'FAIL stale sending row was not flipped to failed, got %', v_stale_status;
  END IF;
  IF v_fresh_status <> 'sending' THEN
    RAISE EXCEPTION 'FAIL fresh sending row was incorrectly touched, got %', v_fresh_status;
  END IF;

  -- 4. Running it again is a no-op for already-recovered rows (idempotent sweep).
  SELECT recovered INTO v_recovered FROM sweep_stuck_sending_messages(10);
  IF EXISTS (SELECT 1 FROM messages WHERE id = v_stale_id AND sending_locked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL sending_locked_at was not cleared on the recovered row';
  END IF;

  -- 5. Only service_role can execute the sweep function.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
     WHERE routine_schema = 'public' AND routine_name = 'sweep_stuck_sending_messages'
       AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION 'FAIL sweep_stuck_sending_messages is callable by anon/authenticated/PUBLIC';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: columns present, sweep recovered the stale row (% ), left the fresh row alone, cleared its lock, and stayed service_role-only', v_recovered;
END $$;
