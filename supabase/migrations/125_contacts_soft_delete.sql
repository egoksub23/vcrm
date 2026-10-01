-- ============================================================
-- 125_contacts_soft_delete
--
-- Deleting a contact today hard-deletes it, and `tickets.contact_id`
-- is ON DELETE CASCADE (063_tickets.sql) — so deleting a contact
-- silently destroys its tickets, and every comment on them, two
-- cascade hops deep. Merging two contacts is worse: merge_contacts()
-- (059) never moves tickets.contact_id to the surviving contact, so a
-- merge orphans the secondary's tickets and the function's own final
-- DELETE then destroys them via the same cascade.
--
-- Fix: give `contacts` the same soft-delete pattern 082_audit_trail
-- already built for tags/snippets/knowledge articles — a
-- deleted_at/deleted_by pair plus a BEFORE DELETE trigger that
-- converts a real DELETE into an UPDATE. Once nothing is ever really
-- deleted, every ON DELETE CASCADE off `contacts` simply never fires
-- for a normal delete — tickets, ticket comments, conversations and
-- conversation-internal comments (messages.is_internal) all survive
-- untouched, with no FK changes needed at all.
--
-- Unlike 082's three entities, contacts get no 90-day cutoff (business
-- records, not disposable settings) and their own list/restore RPCs
-- rather than folding into audit_removed_items/restore_removed_item,
-- so the Contacts page can show "deleted" inline rather than sending
-- an admin to Settings > Audit log.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Columns + index
-- ------------------------------------------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_deleted_at
  ON public.contacts (account_id, deleted_at) WHERE deleted_at IS NOT NULL;

-- A soft-deleted contact's phone number must free up for reuse.
DROP INDEX IF EXISTS public.idx_contacts_account_phone_normalized;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_phone_normalized
  ON public.contacts (account_id, phone_normalized)
  WHERE phone_normalized <> '' AND deleted_at IS NULL;

-- ------------------------------------------------------------
-- 2. Soft delete — add a 'contact' branch to the existing generic
--    trigger function rather than writing a second one.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_soft_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind     TEXT := TG_ARGV[0];
  v_contacts INTEGER := 0;
  v_convs    INTEGER := 0;
BEGIN
  IF pg_trigger_depth() > 1
     OR COALESCE(current_setting('vircle.hard_delete', true), '') = 'on'
     OR OLD.deleted_at IS NOT NULL THEN
    RETURN OLD;
  END IF;

  PERFORM set_config('vircle.soft_delete', 'on', true);

  IF v_kind = 'tag' THEN
    WITH d AS (DELETE FROM contact_tags WHERE tag_id = OLD.id RETURNING 1)
      SELECT count(*) INTO v_contacts FROM d;
    WITH d AS (DELETE FROM conversation_labels WHERE tag_id = OLD.id RETURNING 1)
      SELECT count(*) INTO v_convs FROM d;
    DELETE FROM auto_label_rules WHERE tag_id = OLD.id;
    PERFORM set_config('vircle.audit_extra',
      jsonb_build_object('contacts_untagged', v_contacts,
                         'conversations_unlabelled', v_convs)::text, true);
    UPDATE tags SET deleted_at = now(), deleted_by = auth.uid() WHERE id = OLD.id;
  ELSIF v_kind = 'snippet' THEN
    UPDATE quick_replies SET deleted_at = now(), deleted_by = auth.uid() WHERE id = OLD.id;
  ELSIF v_kind = 'article' THEN
    PERFORM set_config('vircle.audit_root', OLD.id::text, true);
    UPDATE ai_knowledge_documents
       SET deleted_at = now(), deleted_by = auth.uid()
     WHERE id = OLD.id;
    UPDATE ai_knowledge_documents
       SET deleted_at = now(), deleted_by = auth.uid()
     WHERE translation_of = OLD.id AND deleted_at IS NULL;
  ELSIF v_kind = 'contact' THEN
    UPDATE contacts SET deleted_at = now(), deleted_by = auth.uid() WHERE id = OLD.id;
  END IF;

  PERFORM set_config('vircle.soft_delete', 'off', true);
  PERFORM set_config('vircle.audit_extra', '', true);
  PERFORM set_config('vircle.audit_root', '', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS audit_soft_delete ON public.contacts;
CREATE TRIGGER audit_soft_delete
  BEFORE DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.audit_soft_delete('contact');

-- Hide soft-deleted contacts from every ordinary read — every existing
-- read site (contacts list, ticket/deal contact pickers, broadcast
-- audience count, CSV dedupe, dashboard, reports, public API v1,
-- export) picks this up automatically, no code changes needed there.
DROP POLICY IF EXISTS contacts_select ON public.contacts;
CREATE POLICY contacts_select ON public.contacts
  FOR SELECT USING (is_account_member(account_id) AND deleted_at IS NULL);

-- ------------------------------------------------------------
-- 3. merge_contacts(): move tickets to the surviving contact too.
--    The function's own final DELETE now becomes a soft delete once
--    the trigger above exists — the losing contact becomes a
--    recoverable tombstone instead of vanishing, no further change
--    needed for that part.
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

  -- New: tickets used to be silently destroyed by the final DELETE's
  -- cascade. Move them to the surviving contact like everything else.
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

  DELETE FROM contacts WHERE id = p_secondary_contact_id;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.merge_contacts(UUID, UUID, UUID) TO service_role;

-- ------------------------------------------------------------
-- 4. List + restore deleted contacts. RLS hides them, so both are
--    SECURITY DEFINER and gate on contacts.edit (the same capability
--    delete already requires) — no new capability key.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_deleted_contacts(p_limit integer DEFAULT 200)
RETURNS TABLE (
  id              uuid,
  name            text,
  phone           text,
  email           text,
  company         text,
  created_at      timestamptz,
  deleted_at      timestamptz,
  deleted_by      uuid,
  deleted_by_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct UUID;
BEGIN
  SELECT p.account_id INTO v_acct FROM profiles p WHERE p.user_id = auth.uid();
  IF v_acct IS NULL OR NOT has_capability(v_acct, 'contacts.edit') THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.phone, c.email, c.company, c.created_at,
         c.deleted_at, c.deleted_by,
         COALESCE(NULLIF(btrim(pr.full_name), ''), pr.email)
    FROM contacts c
    LEFT JOIN profiles pr ON pr.user_id = c.deleted_by
   WHERE c.account_id = v_acct AND c.deleted_at IS NOT NULL
   ORDER BY c.deleted_at DESC
   LIMIT GREATEST(LEAST(p_limit, 500), 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_contact(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct    UUID;
  v_deleted TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, deleted_at INTO v_acct, v_deleted FROM contacts WHERE id = p_id;
  IF v_acct IS NULL OR v_deleted IS NULL
     OR NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = auth.uid() AND account_id = v_acct) THEN
    RAISE EXCEPTION 'That contact is not deleted' USING ERRCODE = 'P0002';
  END IF;
  IF NOT has_capability(v_acct, 'contacts.edit') THEN
    RAISE EXCEPTION 'This action requires the ''contacts.edit'' permission' USING ERRCODE = '42501';
  END IF;

  BEGIN
    UPDATE contacts SET deleted_at = NULL, deleted_by = NULL WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    -- Another contact has claimed this phone number since the delete.
    RAISE EXCEPTION 'phone_conflict' USING ERRCODE = '23505';
  END;

  RETURN jsonb_build_object('restored', true);
END;
$$;

REVOKE ALL ON FUNCTION public.list_deleted_contacts(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_contact(uuid)           FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_deleted_contacts(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_contact(uuid)          TO authenticated;

NOTIFY pgrst, 'reload schema';
