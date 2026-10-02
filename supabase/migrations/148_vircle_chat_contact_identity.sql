-- ============================================================
-- 148_vircle_chat_contact_identity.sql
--
-- Vircle Chat identifies a person by their Vircle wallet id, vouched for by the
-- gateway. Two things the contact table needed for that:
--
--   1. An index on (account_id, wallet_id), so finding the contact for an
--      incoming message does not scan the workspace's contacts. Not unique: the
--      web widget has been writing wallet ids to contacts since migration 054,
--      so duplicates may exist; the app looks the oldest one up.
--   2. merge_contacts() (migration 142's definition, two lines added) carries the
--      wallet id to the surviving contact and clears it from the merged-away
--      record. Before this a merged-away record kept its wallet id and could
--      capture the person's next message.
--
-- Idempotent.
-- ============================================================

CREATE INDEX IF NOT EXISTS contacts_account_wallet_idx
  ON public.contacts (account_id, wallet_id)
  WHERE wallet_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.merge_contacts(
  p_account_id UUID,
  p_primary_contact_id UUID,
  p_secondary_contact_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_primary_conv UUID;
  v_secondary_conv RECORD;
BEGIN
  IF p_primary_contact_id = p_secondary_contact_id THEN
    RAISE EXCEPTION 'Cannot merge a contact into itself';
  END IF;

  -- Lock both rows (id order) before looking at deleted_at, so a delete
  -- running at the same moment either finishes first (and we refuse) or waits.
  PERFORM 1 FROM contacts
    WHERE id IN (p_primary_contact_id, p_secondary_contact_id)
      AND account_id = p_account_id
    ORDER BY id
    FOR UPDATE;

  PERFORM 1 FROM contacts
    WHERE id = p_primary_contact_id AND account_id = p_account_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Primary contact % not found in account %', p_primary_contact_id, p_account_id;
  END IF;

  PERFORM 1 FROM contacts
    WHERE id = p_secondary_contact_id AND account_id = p_account_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Secondary contact % not found in account %', p_secondary_contact_id, p_account_id;
  END IF;

  SELECT id INTO v_primary_conv FROM conversations
    WHERE contact_id = p_primary_contact_id
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT 1;

  FOR v_secondary_conv IN
    SELECT id FROM conversations WHERE contact_id = p_secondary_contact_id
  LOOP
    IF v_primary_conv IS NULL THEN
      UPDATE conversations SET contact_id = p_primary_contact_id, updated_at = NOW()
        WHERE id = v_secondary_conv.id;
      v_primary_conv := v_secondary_conv.id;
    ELSE
      UPDATE messages SET conversation_id = v_primary_conv WHERE conversation_id = v_secondary_conv.id;
      UPDATE message_reactions SET conversation_id = v_primary_conv WHERE conversation_id = v_secondary_conv.id;
      UPDATE flow_runs SET conversation_id = v_primary_conv WHERE conversation_id = v_secondary_conv.id;
      UPDATE notifications SET conversation_id = v_primary_conv WHERE conversation_id = v_secondary_conv.id;
      UPDATE ai_usage_log SET conversation_id = v_primary_conv WHERE conversation_id = v_secondary_conv.id;
      UPDATE deals SET conversation_id = v_primary_conv WHERE conversation_id = v_secondary_conv.id;

      INSERT INTO conversation_labels (conversation_id, tag_id, applied_by, applied_at)
        SELECT v_primary_conv, tag_id, applied_by, applied_at
        FROM conversation_labels WHERE conversation_id = v_secondary_conv.id
        ON CONFLICT (conversation_id, tag_id) DO NOTHING;

      UPDATE conversations c SET
        unread_count = COALESCE(c.unread_count, 0)
          + COALESCE((SELECT unread_count FROM conversations WHERE id = v_secondary_conv.id), 0),
        last_message_text = m.content_text,
        last_message_at = m.created_at,
        last_channel_type = m.channel_type,
        updated_at = NOW()
      FROM (
        SELECT content_text, created_at, channel_type FROM messages
        WHERE conversation_id = v_primary_conv
        ORDER BY created_at DESC LIMIT 1
      ) m
      WHERE c.id = v_primary_conv;

      DELETE FROM conversations WHERE id = v_secondary_conv.id;
    END IF;
  END LOOP;

  UPDATE deals SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;
  UPDATE broadcast_recipients SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;
  UPDATE automation_logs SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;
  UPDATE automation_pending_executions SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;
  UPDATE flow_runs SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;
  UPDATE notifications SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;
  UPDATE widget_visitors SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;

  UPDATE tickets SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;

  UPDATE contact_notes SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;

  INSERT INTO contact_tags (contact_id, tag_id, created_at)
    SELECT p_primary_contact_id, tag_id, created_at
    FROM contact_tags WHERE contact_id = p_secondary_contact_id
    ON CONFLICT (contact_id, tag_id) DO NOTHING;

  INSERT INTO contact_custom_values (contact_id, custom_field_id, value, created_at)
    SELECT p_primary_contact_id, custom_field_id, value, created_at
    FROM contact_custom_values WHERE contact_id = p_secondary_contact_id
    ON CONFLICT (contact_id, custom_field_id) DO NOTHING;

  UPDATE contacts p SET
    wa_user_id = COALESCE(p.wa_user_id, s.wa_user_id),
    wa_parent_user_id = COALESCE(p.wa_parent_user_id, s.wa_parent_user_id),
    wa_username = COALESCE(p.wa_username, s.wa_username),
    widget_visitor_id = COALESCE(p.widget_visitor_id, s.widget_visitor_id),
    messenger_psid = COALESCE(p.messenger_psid, s.messenger_psid),
    instagram_igsid = COALESCE(p.instagram_igsid, s.instagram_igsid),
    email = COALESCE(NULLIF(p.email, ''), s.email),
    name = COALESCE(NULLIF(p.name, ''), s.name),
    company = COALESCE(NULLIF(p.company, ''), s.company),
    avatar_url = COALESCE(p.avatar_url, s.avatar_url),
    wallet_id = COALESCE(p.wallet_id, s.wallet_id),
    updated_at = NOW()
  FROM contacts s
  WHERE p.id = p_primary_contact_id AND s.id = p_secondary_contact_id;

  -- The merged-away record must not keep matching its wallet id: it moved to the primary above.
  UPDATE contacts SET wallet_id = NULL WHERE id = p_secondary_contact_id;

  -- A soft delete (125); the trigger above removes the secondary's
  -- merge suggestions and pending widget verification codes with it.
  DELETE FROM contacts WHERE id = p_secondary_contact_id;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.merge_contacts(UUID, UUID, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
