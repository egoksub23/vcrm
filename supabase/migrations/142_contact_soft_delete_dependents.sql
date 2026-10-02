-- ============================================================
-- 142_contact_soft_delete_dependents
--
-- Since 125 a DELETE FROM contacts is turned into a soft delete (the row
-- stays, deleted_at is set), so no ON DELETE CASCADE off `contacts` fires
-- any more. Two tables relied on that cascade to forget a contact:
--
--   * contact_merge_suggestions — a "possible duplicate" pair. After a merge
--     (merge_contacts soft-deletes the folded contact) or a plain delete, the
--     pending suggestion stayed. merge_contacts() never looked at deleted_at,
--     so a stale suggestion id could "merge" into a tombstone.
--   * widget_verification_codes — a pending email code for a widget visitor.
--     It survived until it expired, and POST /api/widget/verify-code did not
--     check the contact, so a visitor could still verify against a deleted
--     contact.
--
-- Fix, at the one place every soft delete passes through:
--   1. An AFTER UPDATE trigger on contacts that, when deleted_at goes from
--      NULL to set, removes both tables' rows for that contact. It fires for
--      the DELETE-turned-UPDATE of audit_soft_delete (nested, trigger depth 2),
--      for merge_contacts' final DELETE, and for anything that sets deleted_at
--      directly. A real hard delete (vircle.hard_delete) still cascades.
--      SECURITY DEFINER because widget_verification_codes has no client
--      policy and contact_merge_suggestions has no client DELETE policy, while
--      the person deleting a contact is an ordinary signed-in user.
--   2. merge_contacts() refuses a soft-deleted contact on either side, and
--      locks both rows (in id order, so two opposite merges cannot deadlock)
--      so a concurrent delete cannot slip in between the check and the merge.
--   3. A one-off clean-up of rows already orphaned this way.
--
-- A restored contact (restore_contact) does not get its suggestions back; the
-- widget re-suggests the pair if the situation recurs.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Forget a contact's dependents when it is soft-deleted
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.contact_soft_delete_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM contact_merge_suggestions
   WHERE contact_a_id = NEW.id OR contact_b_id = NEW.id;
  DELETE FROM widget_verification_codes
   WHERE contact_id = NEW.id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.contact_soft_delete_cleanup() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS contact_soft_delete_cleanup ON public.contacts;
CREATE TRIGGER contact_soft_delete_cleanup
  AFTER UPDATE OF deleted_at ON public.contacts
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.contact_soft_delete_cleanup();

-- ------------------------------------------------------------
-- 2. merge_contacts(): refuse a deleted contact. Otherwise identical to 125.
-- ------------------------------------------------------------
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
    updated_at = NOW()
  FROM contacts s
  WHERE p.id = p_primary_contact_id AND s.id = p_secondary_contact_id;

  -- A soft delete (125); the trigger above removes the secondary's
  -- merge suggestions and pending widget verification codes with it.
  DELETE FROM contacts WHERE id = p_secondary_contact_id;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.merge_contacts(UUID, UUID, UUID) TO service_role;

-- ------------------------------------------------------------
-- 3. Clean up what the missing cascade has already left behind
-- ------------------------------------------------------------
DELETE FROM public.contact_merge_suggestions s
 WHERE EXISTS (SELECT 1 FROM public.contacts c
                WHERE c.deleted_at IS NOT NULL
                  AND c.id IN (s.contact_a_id, s.contact_b_id));

DELETE FROM public.widget_verification_codes w
 WHERE EXISTS (SELECT 1 FROM public.contacts c
                WHERE c.id = w.contact_id AND c.deleted_at IS NOT NULL);

NOTIFY pgrst, 'reload schema';
