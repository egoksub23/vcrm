-- ============================================================
-- 054_widget_verified_identity
--
-- Widget Identity Passing roadmap item, two halves:
--
--   1. Verified-user identity passing — an in-app/WebView embed that
--      already knows its signed-in user (phone, optionally a wallet ID
--      and email) can hand that to the widget at init instead of
--      making a stranger type their phone number again. Needs
--      somewhere to put a wallet ID, which nothing in the schema had —
--      `contacts.wallet_id` is purely informational/display data
--      passed through from a trusted host app; it is NOT a matching
--      key (phone stays the sole identity key everywhere else in the
--      app, and this doesn't change that).
--
--   2. Self-service identity linking — a plain web visitor who starts
--      anonymous (no phone offered) can later identify themselves
--      (typed phone, or an async host-app identify() call after the
--      widget already mounted) and get their guest session's history
--      folded into their real contact record instead of starting a
--      second, disconnected thread.
--
-- `merge_widget_guest_contact` does the folding for case 2. It mirrors
-- migration 048's conversation-merge DO block almost exactly — same
-- table list, same repoint-then-delete shape — generalized into a
-- callable, transactional function instead of a one-time script,
-- because this needs to run at arbitrary request time (a guest can
-- self-identify minutes or days after their first anonymous message),
-- not once during a migration window. Every FK that actually points at
-- `contacts.id` is handled (grepped every migration, same audit
-- discipline as 048): `conversations` (CASCADE, merged conversation-by-
-- conversation the same way 048 merges duplicates), `contact_tags` /
-- `contact_custom_values` (CASCADE, own UNIQUE constraints — merged via
-- INSERT...ON CONFLICT DO NOTHING, not a blind repoint), `contact_notes`
-- (CASCADE, no uniqueness — plain repoint), `deals` / `broadcast_recipients`
-- (ON DELETE SET NULL since migration 004 — repointed explicitly anyway
-- so history doesn't silently orphan). `widget_visitors.contact_id` is
-- repointed by the caller (the API route already has the visitor id in
-- hand there), not inside this function.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS wallet_id TEXT;

CREATE OR REPLACE FUNCTION merge_widget_guest_contact(
  p_account_id UUID,
  p_guest_contact_id UUID,
  p_target_contact_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_conv_id UUID;
  v_guest_conv RECORD;
BEGIN
  IF p_guest_contact_id = p_target_contact_id THEN
    SELECT id INTO v_target_conv_id FROM conversations
      WHERE account_id = p_account_id AND contact_id = p_target_contact_id
      ORDER BY created_at ASC LIMIT 1;
    RETURN v_target_conv_id;
  END IF;

  SELECT id INTO v_target_conv_id FROM conversations
    WHERE account_id = p_account_id AND contact_id = p_target_contact_id
    ORDER BY created_at ASC LIMIT 1;

  IF v_target_conv_id IS NULL THEN
    -- Target has no conversation yet — nothing to merge into, so just
    -- repoint the guest's own conversation(s) onto the target contact.
    UPDATE conversations SET contact_id = p_target_contact_id, updated_at = NOW()
      WHERE account_id = p_account_id AND contact_id = p_guest_contact_id;

    SELECT id INTO v_target_conv_id FROM conversations
      WHERE account_id = p_account_id AND contact_id = p_target_contact_id
      ORDER BY created_at ASC LIMIT 1;
  ELSE
    FOR v_guest_conv IN
      SELECT id FROM conversations
      WHERE account_id = p_account_id AND contact_id = p_guest_contact_id
    LOOP
      CONTINUE WHEN v_guest_conv.id = v_target_conv_id;

      UPDATE messages SET conversation_id = v_target_conv_id WHERE conversation_id = v_guest_conv.id;
      UPDATE message_reactions SET conversation_id = v_target_conv_id WHERE conversation_id = v_guest_conv.id;
      UPDATE flow_runs SET conversation_id = v_target_conv_id WHERE conversation_id = v_guest_conv.id;
      UPDATE notifications SET conversation_id = v_target_conv_id WHERE conversation_id = v_guest_conv.id;
      UPDATE ai_usage_log SET conversation_id = v_target_conv_id WHERE conversation_id = v_guest_conv.id;
      UPDATE deals SET conversation_id = v_target_conv_id WHERE conversation_id = v_guest_conv.id;

      INSERT INTO conversation_labels (conversation_id, tag_id, applied_by, applied_at)
      SELECT v_target_conv_id, tag_id, applied_by, applied_at
      FROM conversation_labels
      WHERE conversation_id = v_guest_conv.id
      ON CONFLICT (conversation_id, tag_id) DO NOTHING;

      -- Recompute the target's rollup fields from the now-merged
      -- message set (messages were already repointed above).
      UPDATE conversations c
      SET
        unread_count = COALESCE(c.unread_count, 0)
          + COALESCE((SELECT unread_count FROM conversations WHERE id = v_guest_conv.id), 0),
        last_message_text = m.content_text,
        last_message_at = m.created_at,
        last_channel_type = m.channel_type,
        updated_at = NOW()
      FROM (
        SELECT content_text, created_at, channel_type
        FROM messages
        WHERE conversation_id = v_target_conv_id
        ORDER BY created_at DESC
        LIMIT 1
      ) m
      WHERE c.id = v_target_conv_id;

      -- Cascades the now-empty guest conversation's message_reactions /
      -- conversation_labels rows — already moved above, nothing lost.
      DELETE FROM conversations WHERE id = v_guest_conv.id;
    END LOOP;
  END IF;

  -- Contact-level rows.
  UPDATE deals SET contact_id = p_target_contact_id WHERE contact_id = p_guest_contact_id;
  UPDATE broadcast_recipients SET contact_id = p_target_contact_id WHERE contact_id = p_guest_contact_id;
  UPDATE contact_notes SET contact_id = p_target_contact_id WHERE contact_id = p_guest_contact_id;

  INSERT INTO contact_tags (contact_id, tag_id, created_at)
  SELECT p_target_contact_id, tag_id, created_at
  FROM contact_tags
  WHERE contact_id = p_guest_contact_id
  ON CONFLICT (contact_id, tag_id) DO NOTHING;

  INSERT INTO contact_custom_values (contact_id, custom_field_id, value, created_at)
  SELECT p_target_contact_id, custom_field_id, value, created_at
  FROM contact_custom_values
  WHERE contact_id = p_guest_contact_id
  ON CONFLICT (contact_id, custom_field_id) DO NOTHING;

  -- Cascades whatever's left on the guest contact (contact_tags /
  -- contact_custom_values / contact_notes / conversations / widget_visitors
  -- rows not already moved above — should be none, this is a safety net).
  DELETE FROM contacts WHERE id = p_guest_contact_id AND account_id = p_account_id;

  RETURN v_target_conv_id;
END;
$$;

ALTER FUNCTION merge_widget_guest_contact(UUID, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION merge_widget_guest_contact(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION merge_widget_guest_contact(UUID, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION merge_widget_guest_contact(UUID, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION merge_widget_guest_contact(UUID, UUID, UUID) TO service_role;
