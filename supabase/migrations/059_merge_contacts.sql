-- ============================================================
-- 059_merge_contacts
--
-- Two contacts can turn out to be the same person discovered late —
-- e.g. an agent working an Email/Gmail conversation learns the
-- customer's phone number and updates the contact's phone field, and
-- that phone number already belongs to a separate WhatsApp-origin
-- contact. This function folds the "secondary" contact entirely into
-- the "primary" one: every conversation (and its messages, reactions,
-- labels, flow runs, deals, notifications), every deal/broadcast
-- history row, every tag/note/custom-field value, and every
-- channel-identity column (wa_user_id, messenger_psid,
-- instagram_igsid, widget_visitor_id, email) the secondary carries
-- that the primary doesn't already have — then deletes the secondary
-- contact. Called from POST /api/contacts/merge after the agent
-- explicitly confirms (never automatic).
--
-- The per-conversation merge loop mirrors migration 048's
-- (account_id, contact_id)-scoped merge exactly — same tables, same
-- ON CONFLICT handling — just parameterized to one explicit pair
-- instead of scanning for every duplicate group.
-- ============================================================

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

  PERFORM 1 FROM contacts
    WHERE id = p_primary_contact_id AND account_id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Primary contact % not found in account %', p_primary_contact_id, p_account_id;
  END IF;

  PERFORM 1 FROM contacts
    WHERE id = p_secondary_contact_id AND account_id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Secondary contact % not found in account %', p_secondary_contact_id, p_account_id;
  END IF;

  -- Primary's own conversation, if it has one yet (post-048, at most
  -- one per contact — but don't assume, just take the most recent).
  SELECT id INTO v_primary_conv FROM conversations
    WHERE contact_id = p_primary_contact_id
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT 1;

  FOR v_secondary_conv IN
    SELECT id FROM conversations WHERE contact_id = p_secondary_contact_id
  LOOP
    IF v_primary_conv IS NULL THEN
      -- Primary has no thread yet — just adopt secondary's outright.
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

      -- Cascades the now-empty secondary's conversation_labels /
      -- messages / message_reactions / notifications rows — already
      -- moved above, so nothing is lost.
      DELETE FROM conversations WHERE id = v_secondary_conv.id;
    END IF;
  END LOOP;

  -- Everything else keyed directly on contact_id (not via a
  -- conversation) — repoint to the primary so history survives the
  -- secondary's deletion instead of going NULL.
  UPDATE deals SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;
  UPDATE broadcast_recipients SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;
  UPDATE automation_logs SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;
  UPDATE automation_pending_executions SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;
  UPDATE flow_runs SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;
  UPDATE notifications SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;
  -- widget_visitors.contact_id is NOT NULL + ON DELETE CASCADE — must
  -- repoint before the DELETE below, or a widget visitor's anonymous
  -- session (and its RLS access to its own history) is destroyed.
  UPDATE widget_visitors SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;

  -- Notes carry over unconditionally (no uniqueness to worry about).
  UPDATE contact_notes SET contact_id = p_primary_contact_id WHERE contact_id = p_secondary_contact_id;

  -- Tags/custom values: keep the primary's own row on conflict,
  -- adopt the secondary's where the primary doesn't have one.
  INSERT INTO contact_tags (contact_id, tag_id, created_at)
    SELECT p_primary_contact_id, tag_id, created_at
    FROM contact_tags WHERE contact_id = p_secondary_contact_id
    ON CONFLICT (contact_id, tag_id) DO NOTHING;

  INSERT INTO contact_custom_values (contact_id, custom_field_id, value, created_at)
    SELECT p_primary_contact_id, custom_field_id, value, created_at
    FROM contact_custom_values WHERE contact_id = p_secondary_contact_id
    ON CONFLICT (contact_id, custom_field_id) DO NOTHING;

  -- Cross-link channel identities onto the surviving contact — the
  -- actual point of the merge. The primary keeps whatever it already
  -- has; it only inherits a column from the secondary where its own
  -- is empty. No conflict window: these columns are unique per
  -- account while set, and the secondary row is deleted at the end of
  -- this same transaction, freeing its values before anything else
  -- could race to claim them.
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
    updated_at = NOW()
  FROM contacts s
  WHERE p.id = p_primary_contact_id AND s.id = p_secondary_contact_id;

  DELETE FROM contacts WHERE id = p_secondary_contact_id;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.merge_contacts(UUID, UUID, UUID) TO service_role;
