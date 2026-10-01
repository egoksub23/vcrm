-- Verify migration 129. Run against a database that already has 128 applied
-- (production does). Concatenate 129's migration text in front of this file,
-- then run it. It ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
--
-- Picks a ticket that already has no first response recorded, rather than
-- resetting one — ticket_sla_state() (086) treats a plain UPDATE of
-- sla_first_response_at from here as untrusted and silently reverts it
-- (pg_trigger_depth() = 0, not nested inside another trigger the way this
-- migration's own trigger legitimately is), so forcing a reset would not
-- reliably clear it anyway.
DO $$
DECLARE
  v_ticket   uuid;
  v_conv     uuid;
  v_stamp    timestamptz;
BEGIN
  SELECT t.id, t.conversation_id INTO v_ticket, v_conv
    FROM tickets t
   WHERE t.conversation_id IS NOT NULL
     AND t.sla_first_response_at IS NULL
   ORDER BY t.created_at DESC
   LIMIT 1;
  IF v_ticket IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK-OK: no ticket with a linked conversation and no first response yet to test against';
  END IF;

  -- 1. A customer message never stamps it.
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, status)
  VALUES (v_conv, 'customer', 'text', 'hi', 'whatsapp', 'delivered');
  IF (SELECT sla_first_response_at FROM tickets WHERE id = v_ticket) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a customer message stamped first response';
  END IF;

  -- 2. A bot (automation) message never stamps it.
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, status)
  VALUES (v_conv, 'bot', 'text', 'auto reply', 'whatsapp', 'sent');
  IF (SELECT sla_first_response_at FROM tickets WHERE id = v_ticket) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a bot message stamped first response';
  END IF;

  -- 3. A failed agent send never stamps it.
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, status, error_title)
  VALUES (v_conv, 'agent', 'text', 'reply attempt', 'whatsapp', 'failed', 'Recipient not reachable');
  IF (SELECT sla_first_response_at FROM tickets WHERE id = v_ticket) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a failed agent send stamped first response';
  END IF;

  -- 4. A real agent reply DOES stamp it, to that message's created_at.
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, status, created_at)
  VALUES (v_conv, 'agent', 'text', 'real reply', 'whatsapp', 'sent', '2026-01-01T00:00:00Z');
  SELECT sla_first_response_at INTO v_stamp FROM tickets WHERE id = v_ticket;
  IF v_stamp IS DISTINCT FROM '2026-01-01T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'FAIL first agent reply did not stamp sla_first_response_at correctly, got %', v_stamp;
  END IF;

  -- 5. A second agent reply never overwrites the first stamp.
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, status, created_at)
  VALUES (v_conv, 'agent', 'text', 'second reply', 'whatsapp', 'sent', now());
  IF (SELECT sla_first_response_at FROM tickets WHERE id = v_ticket) IS DISTINCT FROM '2026-01-01T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'FAIL a second agent reply overwrote the first-response stamp';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: customer/bot/failed messages never stamp first response; a real agent reply stamps it once and only once';
END $$;
