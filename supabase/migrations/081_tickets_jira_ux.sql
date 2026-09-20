-- ============================================================
-- 081_tickets_jira_ux
--
-- Jira-style ticket management. The Tickets screen grows a board and a
-- dense list, a full issue view, labels, due dates, watchers, links between
-- tickets and attachments. This migration is the data side of that:
--
--   - accounts.ticket_key_prefix: tickets are shown as VIR-12. Display only;
--     ticket_number (migration 063) is still the stored number.
--   - tickets: `in_progress` status, due_date, labels[], board_rank.
--   - ticket_watchers: creator and assignee are watchers automatically, and
--     watchers get a notification on assignment, status change and comment.
--   - ticket_links, ticket_attachments, ticket_saved_filters.
--   - ticket_comments: edited_at, and the author may edit / delete own.
--   - ticket_activity: due date, labels, summary, description, link and
--     attachment events.
--
-- RLS mirrors the tickets tiers (migration 063): read = member, write =
-- agent. `tickets.work` stays app-enforced, as migration 079 decided; no
-- new capability keys.
--
-- Constraint names in the live schema (looked up before writing this):
--   tickets_status_check, notifications_type_check,
--   ticket_activity_event_type_check.
-- They are still dropped by lookup, not by name, like migration 066: an
-- IF EXISTS on a wrong name would silently keep the narrow CHECK.
-- ============================================================

-- ============================================================
-- 1. Ticket key prefix (VIR-12)
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS ticket_key_prefix TEXT NOT NULL DEFAULT 'VIR';

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_ticket_key_prefix_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_ticket_key_prefix_check
  CHECK (ticket_key_prefix ~ '^[A-Z][A-Z0-9]{1,5}$');

-- ============================================================
-- 2. Ticket status: add in_progress (Open, In progress, Pending, ...)
-- ============================================================
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'tickets'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE tickets DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
  CHECK (status IN ('open', 'in_progress', 'pending', 'resolved', 'closed'));

-- ============================================================
-- 3. Labels: normalised, at most 10 per ticket, 30 chars each
-- ============================================================
CREATE OR REPLACE FUNCTION ticket_labels_are_valid(p_labels TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(cardinality(p_labels), 0) <= 10
    AND NOT EXISTS (
      SELECT 1 FROM unnest(p_labels) AS l
      WHERE l IS NULL
         OR l = ''
         OR char_length(l) > 30
         OR l <> lower(btrim(l))
    );
$$;

-- ============================================================
-- 4. Board rank: dragging a card within a column persists here.
--    Higher rank is nearer the top; the default is the creation time in
--    epoch seconds so existing tickets keep "newest first".
--
--    A reorder must not count as an edit, so the updated_at trigger is
--    replaced by one that leaves updated_at alone when board_rank is the
--    only thing that changed. It goes in before the backfill below, which
--    would otherwise stamp every ticket as just updated.
-- ============================================================
CREATE OR REPLACE FUNCTION set_ticket_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.board_rank IS DISTINCT FROM OLD.board_rank
     AND (to_jsonb(NEW) - 'board_rank' - 'updated_at')
         = (to_jsonb(OLD) - 'board_rank' - 'updated_at') THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_updated_at ON tickets;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_ticket_updated_at();

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS labels TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'board_rank'
  ) THEN
    ALTER TABLE tickets
      ADD COLUMN board_rank DOUBLE PRECISION NOT NULL DEFAULT extract(epoch FROM clock_timestamp());
    -- First run only: seed from created_at so existing rows sort newest first.
    UPDATE tickets SET board_rank = extract(epoch FROM created_at);
  END IF;
END $$;

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_labels_valid;
ALTER TABLE tickets ADD CONSTRAINT tickets_labels_valid
  CHECK (ticket_labels_are_valid(labels));

CREATE INDEX IF NOT EXISTS idx_tickets_account_status_rank
  ON tickets(account_id, status, board_rank);
CREATE INDEX IF NOT EXISTS idx_tickets_account_updated
  ON tickets(account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_labels ON tickets USING GIN (labels);
CREATE INDEX IF NOT EXISTS idx_tickets_due_date ON tickets(account_id, due_date) WHERE due_date IS NOT NULL;

-- Label suggestions for the combobox: every label in use in the caller's
-- account, most used first. SECURITY INVOKER, so RLS on tickets scopes it.
CREATE OR REPLACE FUNCTION ticket_label_suggestions()
RETURNS TABLE (label TEXT, uses BIGINT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT l AS label, count(*) AS uses
  FROM tickets t, unnest(t.labels) AS l
  GROUP BY l
  ORDER BY count(*) DESC, l
  LIMIT 300;
$$;

REVOKE ALL ON FUNCTION ticket_label_suggestions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ticket_label_suggestions() TO authenticated;

-- ============================================================
-- 5. ticket_comments: edited_at, author may edit / delete own
-- ============================================================
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

DROP POLICY IF EXISTS ticket_comments_update ON ticket_comments;
DROP POLICY IF EXISTS ticket_comments_delete ON ticket_comments;
CREATE POLICY ticket_comments_update ON ticket_comments FOR UPDATE
  USING (author_id = auth.uid() AND is_account_member(account_id, 'agent'))
  WITH CHECK (author_id = auth.uid() AND is_account_member(account_id, 'agent'));
CREATE POLICY ticket_comments_delete ON ticket_comments FOR DELETE
  USING (author_id = auth.uid() AND is_account_member(account_id, 'agent'));

CREATE OR REPLACE FUNCTION set_ticket_comment_edited_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.edited_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_ticket_comment_edited ON ticket_comments;
CREATE TRIGGER on_ticket_comment_edited BEFORE UPDATE ON ticket_comments
  FOR EACH ROW EXECUTE FUNCTION set_ticket_comment_edited_at();

-- ============================================================
-- 6. ticket_watchers
-- ============================================================
CREATE TABLE IF NOT EXISTS ticket_watchers (
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticket_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_watchers_user ON ticket_watchers(user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_watchers_account ON ticket_watchers(account_id);

ALTER TABLE ticket_watchers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_watchers_select ON ticket_watchers;
DROP POLICY IF EXISTS ticket_watchers_insert ON ticket_watchers;
DROP POLICY IF EXISTS ticket_watchers_delete ON ticket_watchers;
CREATE POLICY ticket_watchers_select ON ticket_watchers
  FOR SELECT USING (is_account_member(account_id));
-- Watching is personal: an agent adds / removes only their own row. The
-- creator / assignee rows come from the trigger below, which bypasses RLS.
CREATE POLICY ticket_watchers_insert ON ticket_watchers
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent') AND user_id = auth.uid());
CREATE POLICY ticket_watchers_delete ON ticket_watchers
  FOR DELETE USING (is_account_member(account_id, 'agent') AND user_id = auth.uid());

-- Creator and assignee watch automatically (same SECURITY DEFINER +
-- EXCEPTION guard style as migration 064: never blocks the real write).
CREATE OR REPLACE FUNCTION add_ticket_auto_watchers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID;
BEGIN
  FOR v_user IN
    SELECT DISTINCT u FROM unnest(ARRAY[
      COALESCE(NEW.created_by, auth.uid()),
      NEW.assigned_agent_id
    ]) AS u
    WHERE u IS NOT NULL
  LOOP
    -- Only people in this account can watch (assigned_agent_id is an untyped
    -- UUID, see migration 063).
    IF EXISTS (SELECT 1 FROM profiles WHERE user_id = v_user AND account_id = NEW.account_id) THEN
      INSERT INTO ticket_watchers (ticket_id, user_id, account_id)
      VALUES (NEW.id, v_user, NEW.account_id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to add auto-watchers for ticket %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION add_ticket_auto_watchers() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_auto_watchers ON tickets;
CREATE TRIGGER on_ticket_auto_watchers
  AFTER INSERT OR UPDATE OF assigned_agent_id ON tickets
  FOR EACH ROW EXECUTE FUNCTION add_ticket_auto_watchers();

-- Existing tickets: their creator and assignee become watchers too.
INSERT INTO ticket_watchers (ticket_id, user_id, account_id)
SELECT DISTINCT t.id, w.user_id, t.account_id
FROM tickets t
CROSS JOIN LATERAL (VALUES (t.created_by), (t.assigned_agent_id)) AS w(user_id)
WHERE w.user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = w.user_id AND p.account_id = t.account_id)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 7. Notifications for watchers
-- ============================================================
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'notifications'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%type%'
  LOOP
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned', 'mention', 'ticket_assigned', 'ticket_mention', 'ai_budget',
    'ticket_updated', 'ticket_comment'
  ));

-- Status change / reassignment: every watcher except the person who did it.
-- The new assignee already gets `ticket_assigned` (migration 063), so they
-- are skipped for the assignment message to avoid two notifications.
CREATE OR REPLACE FUNCTION notify_ticket_watchers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
  v_actor_name TEXT;
  v_actor TEXT;
  v_watcher UUID;
BEGIN
  SELECT a.ticket_key_prefix || '-' || NEW.ticket_number INTO v_key
  FROM accounts a WHERE a.id = NEW.account_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM profiles WHERE user_id = auth.uid();
  END IF;
  v_actor := COALESCE(v_actor_name, 'Someone');

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    FOR v_watcher IN
      SELECT user_id FROM ticket_watchers
      WHERE ticket_id = NEW.id AND user_id IS DISTINCT FROM auth.uid()
    LOOP
      INSERT INTO notifications (
        account_id, user_id, type, ticket_id, contact_id, actor_user_id, title, body
      ) VALUES (
        NEW.account_id, v_watcher, 'ticket_updated', NEW.id, NEW.contact_id, auth.uid(),
        'Ticket status changed',
        v_actor || ' moved ' || v_key || ' to ' || initcap(replace(NEW.status, '_', ' '))
          || ' — ' || NEW.subject
      );
    END LOOP;
  END IF;

  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    FOR v_watcher IN
      SELECT user_id FROM ticket_watchers
      WHERE ticket_id = NEW.id
        AND user_id IS DISTINCT FROM auth.uid()
        AND user_id IS DISTINCT FROM NEW.assigned_agent_id
    LOOP
      INSERT INTO notifications (
        account_id, user_id, type, ticket_id, contact_id, actor_user_id, title, body
      ) VALUES (
        NEW.account_id, v_watcher, 'ticket_updated', NEW.id, NEW.contact_id, auth.uid(),
        'Ticket reassigned',
        v_actor || CASE WHEN NEW.assigned_agent_id IS NULL
                        THEN ' unassigned ' ELSE ' reassigned ' END
          || v_key || ' — ' || NEW.subject
      );
    END LOOP;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to notify watchers of ticket %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_ticket_watchers() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_watchers_notify ON tickets;
CREATE TRIGGER on_ticket_watchers_notify
  AFTER UPDATE OF status, assigned_agent_id ON tickets
  FOR EACH ROW EXECUTE FUNCTION notify_ticket_watchers();

-- New comment: watchers except the author. Someone @mentioned already gets
-- `ticket_mention` (migration 063), so they are skipped here.
CREATE OR REPLACE FUNCTION notify_ticket_comment_watchers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket tickets%ROWTYPE;
  v_key TEXT;
  v_actor_name TEXT;
  v_watcher UUID;
BEGIN
  SELECT * INTO v_ticket FROM tickets WHERE id = NEW.ticket_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT a.ticket_key_prefix || '-' || v_ticket.ticket_number INTO v_key
  FROM accounts a WHERE a.id = v_ticket.account_id;

  SELECT full_name INTO v_actor_name
  FROM profiles WHERE user_id = COALESCE(NEW.author_id, auth.uid());

  FOR v_watcher IN
    SELECT user_id FROM ticket_watchers
    WHERE ticket_id = NEW.ticket_id
      AND user_id IS DISTINCT FROM NEW.author_id
      AND user_id IS DISTINCT FROM auth.uid()
      AND NOT (COALESCE(NEW.mentions, '[]'::jsonb) @> to_jsonb(user_id::text))
  LOOP
    INSERT INTO notifications (
      account_id, user_id, type, ticket_id, contact_id, actor_user_id, title, body
    ) VALUES (
      v_ticket.account_id, v_watcher, 'ticket_comment', NEW.ticket_id, v_ticket.contact_id,
      COALESCE(NEW.author_id, auth.uid()),
      'New comment on a ticket',
      COALESCE(v_actor_name, 'Someone') || ' commented on ' || v_key || ' — ' || v_ticket.subject
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to notify watchers of comment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_ticket_comment_watchers() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_comment_watchers ON ticket_comments;
CREATE TRIGGER on_ticket_comment_watchers
  AFTER INSERT ON ticket_comments
  FOR EACH ROW EXECUTE FUNCTION notify_ticket_comment_watchers();

-- ============================================================
-- 8. ticket_links
-- ============================================================
CREATE TABLE IF NOT EXISTS ticket_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  from_ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  to_ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL CHECK (link_type IN ('blocks', 'relates', 'duplicates')),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (from_ticket_id, to_ticket_id, link_type),
  CHECK (from_ticket_id <> to_ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_links_from ON ticket_links(from_ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_links_to ON ticket_links(to_ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_links_account ON ticket_links(account_id);

ALTER TABLE ticket_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_links_select ON ticket_links;
DROP POLICY IF EXISTS ticket_links_insert ON ticket_links;
DROP POLICY IF EXISTS ticket_links_delete ON ticket_links;
CREATE POLICY ticket_links_select ON ticket_links
  FOR SELECT USING (is_account_member(account_id));
-- Both tickets must belong to the account the link is filed under.
CREATE POLICY ticket_links_insert ON ticket_links
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent')
    AND (SELECT count(*) FROM tickets t
         WHERE t.id IN (from_ticket_id, to_ticket_id) AND t.account_id = ticket_links.account_id) = 2
  );
CREATE POLICY ticket_links_delete ON ticket_links
  FOR DELETE USING (is_account_member(account_id, 'agent'));

-- ============================================================
-- 9. ticket_attachments (files live in the chat-media bucket, under
--    account-<id>/tickets/; the bucket itself is not touched here)
-- ============================================================
CREATE TABLE IF NOT EXISTS ticket_attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  url TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket
  ON ticket_attachments(ticket_id, created_at);

ALTER TABLE ticket_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_attachments_select ON ticket_attachments;
DROP POLICY IF EXISTS ticket_attachments_insert ON ticket_attachments;
DROP POLICY IF EXISTS ticket_attachments_delete ON ticket_attachments;
CREATE POLICY ticket_attachments_select ON ticket_attachments
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY ticket_attachments_insert ON ticket_attachments
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent')
    AND uploaded_by = auth.uid()
    AND EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_id AND t.account_id = ticket_attachments.account_id)
  );
-- Delete your own upload (an admin may remove any).
CREATE POLICY ticket_attachments_delete ON ticket_attachments
  FOR DELETE USING (
    is_account_member(account_id, 'agent')
    AND (uploaded_by = auth.uid() OR is_account_member(account_id, 'admin'))
  );

-- ============================================================
-- 10. ticket_saved_filters (own rows, plus rows shared with the account)
-- ============================================================
CREATE TABLE IF NOT EXISTS ticket_saved_filters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_shared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_saved_filters_account_user
  ON ticket_saved_filters(account_id, user_id);

ALTER TABLE ticket_saved_filters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_saved_filters_select ON ticket_saved_filters;
DROP POLICY IF EXISTS ticket_saved_filters_insert ON ticket_saved_filters;
DROP POLICY IF EXISTS ticket_saved_filters_update ON ticket_saved_filters;
DROP POLICY IF EXISTS ticket_saved_filters_delete ON ticket_saved_filters;
CREATE POLICY ticket_saved_filters_select ON ticket_saved_filters
  FOR SELECT USING (is_account_member(account_id) AND (user_id = auth.uid() OR is_shared));
CREATE POLICY ticket_saved_filters_insert ON ticket_saved_filters
  FOR INSERT WITH CHECK (is_account_member(account_id) AND user_id = auth.uid());
CREATE POLICY ticket_saved_filters_update ON ticket_saved_filters
  FOR UPDATE USING (is_account_member(account_id) AND user_id = auth.uid())
  WITH CHECK (is_account_member(account_id) AND user_id = auth.uid());
CREATE POLICY ticket_saved_filters_delete ON ticket_saved_filters
  FOR DELETE USING (is_account_member(account_id) AND user_id = auth.uid());

-- ============================================================
-- 11. Activity log: more events
-- ============================================================
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'ticket_activity'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%event_type%'
  LOOP
    EXECUTE format('ALTER TABLE ticket_activity DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE ticket_activity ADD CONSTRAINT ticket_activity_event_type_check
  CHECK (event_type IN (
    'created', 'status_changed', 'priority_changed', 'category_changed',
    'assigned_agent_changed', 'assigned_team_changed', 'custom_field_changed',
    'due_date_changed', 'labels_changed', 'summary_changed', 'description_changed',
    'link_added', 'link_removed', 'attachment_added'
  ));

-- Migration 066's function plus the new fields. Labels are logged as a
-- comma-joined list, the description as an event with no values.
CREATE OR REPLACE FUNCTION log_ticket_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'status_changed', OLD.status, NEW.status);
  END IF;

  IF NEW.priority IS DISTINCT FROM OLD.priority THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'priority_changed', OLD.priority, NEW.priority);
  END IF;

  IF NEW.category IS DISTINCT FROM OLD.category THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'category_changed', OLD.category, NEW.category);
  END IF;

  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (
      NEW.id, NEW.account_id, auth.uid(), 'assigned_agent_changed',
      OLD.assigned_agent_id::text, NEW.assigned_agent_id::text
    );
  END IF;

  IF NEW.assigned_team_id IS DISTINCT FROM OLD.assigned_team_id THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (
      NEW.id, NEW.account_id, auth.uid(), 'assigned_team_changed',
      OLD.assigned_team_id::text, NEW.assigned_team_id::text
    );
  END IF;

  IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (
      NEW.id, NEW.account_id, auth.uid(), 'due_date_changed',
      OLD.due_date::text, NEW.due_date::text
    );
  END IF;

  IF NEW.labels IS DISTINCT FROM OLD.labels THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (
      NEW.id, NEW.account_id, auth.uid(), 'labels_changed',
      NULLIF(array_to_string(OLD.labels, ','), ''), NULLIF(array_to_string(NEW.labels, ','), '')
    );
  END IF;

  IF NEW.subject IS DISTINCT FROM OLD.subject THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'summary_changed', OLD.subject, NEW.subject);
  END IF;

  IF NEW.description IS DISTINCT FROM OLD.description THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'description_changed');
  END IF;

  -- One row per changed custom field (keys are definition ids).
  IF NEW.custom_fields IS DISTINCT FROM OLD.custom_fields THEN
    FOR v_key IN
      SELECT k FROM (
        SELECT jsonb_object_keys(COALESCE(OLD.custom_fields, '{}'::jsonb)) AS k
        UNION
        SELECT jsonb_object_keys(COALESCE(NEW.custom_fields, '{}'::jsonb))
      ) keys
    LOOP
      IF (OLD.custom_fields -> v_key) IS DISTINCT FROM (NEW.custom_fields -> v_key) THEN
        INSERT INTO ticket_activity (
          ticket_id, account_id, actor_id, event_type, field_id, from_value, to_value
        ) VALUES (
          NEW.id, NEW.account_id, auth.uid(), 'custom_field_changed',
          CASE WHEN v_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN v_key::uuid END,
          OLD.custom_fields ->> v_key, NEW.custom_fields ->> v_key
        );
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log ticket activity for ticket %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION log_ticket_activity() OWNER TO postgres;
-- Trigger on_ticket_activity (migration 064) already points at this
-- function by name, so CREATE OR REPLACE is enough.

-- A link shows on both tickets. Each side stores its own point of view in
-- from_value (blocks / blocked_by / relates / duplicates / duplicated_by)
-- and the other ticket's id in to_value.
CREATE OR REPLACE FUNCTION log_ticket_link_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r ticket_links%ROWTYPE;
  v_event TEXT;
  v_inverse TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    r := NEW;
    v_event := 'link_added';
  ELSE
    r := OLD;
    v_event := 'link_removed';
  END IF;

  v_inverse := CASE r.link_type
    WHEN 'blocks' THEN 'blocked_by'
    WHEN 'duplicates' THEN 'duplicated_by'
    ELSE r.link_type
  END;

  -- When a ticket is deleted its links cascade; skip the side that is gone.
  IF EXISTS (SELECT 1 FROM tickets WHERE id = r.from_ticket_id) THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (r.from_ticket_id, r.account_id, COALESCE(auth.uid(), r.created_by), v_event,
            r.link_type, r.to_ticket_id::text);
  END IF;
  IF EXISTS (SELECT 1 FROM tickets WHERE id = r.to_ticket_id) THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (r.to_ticket_id, r.account_id, COALESCE(auth.uid(), r.created_by), v_event,
            v_inverse, r.from_ticket_id::text);
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log ticket link change %: %', r.id, SQLERRM;
  RETURN NULL;
END;
$$;

ALTER FUNCTION log_ticket_link_change() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_link_change ON ticket_links;
CREATE TRIGGER on_ticket_link_change
  AFTER INSERT OR DELETE ON ticket_links
  FOR EACH ROW EXECUTE FUNCTION log_ticket_link_change();

CREATE OR REPLACE FUNCTION log_ticket_attachment_added()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, to_value)
  VALUES (NEW.ticket_id, NEW.account_id, COALESCE(NEW.uploaded_by, auth.uid()), 'attachment_added', NEW.filename);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log attachment for ticket %: %', NEW.ticket_id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION log_ticket_attachment_added() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_attachment_added ON ticket_attachments;
CREATE TRIGGER on_ticket_attachment_added
  AFTER INSERT ON ticket_attachments
  FOR EACH ROW EXECUTE FUNCTION log_ticket_attachment_added();

-- ============================================================
-- 12. Realtime: watchers / links / attachments while a ticket is open
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_watchers', 'ticket_links', 'ticket_attachments'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
    END IF;
  END LOOP;
END $$;
