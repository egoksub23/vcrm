-- ============================================================
-- 063_tickets
--
-- Support-ticket tracking, requested after reviewing klink.cloud's
-- ticketing UX (docs.klink.cloud/how-to-use/tickets) as a nice-to-have
-- add-on to raise alongside respond.io parity. Deliberately reuses as
-- much existing machinery as possible rather than inventing a parallel
-- stack:
--   - Assignment (agent + team), priority, and status all mirror
--     `conversations`' own columns/CHECK shapes exactly (migrations
--     001, 043, 047) so the existing assignment-routing mental model
--     (and, later, the same RPCs) transfers directly.
--   - Comments + @mentions reuse the exact pattern `messages.mentions`
--     established in migration 045 (a JSONB array of user_ids feeding
--     a notification trigger), just on a dedicated `ticket_comments`
--     table instead of overloading `messages`.
--   - Notifications reuse the existing `notifications` table (migration
--     027) rather than a parallel ticket-notification table — widened
--     with two new `type` values and a `ticket_id` FK, same shape as
--     migration 045 widened it for 'mention'.
--
-- Scope note (v1): ticket `category` is a fixed CHECK list, not
-- klink.cloud's per-account custom ticket-form builder. A configurable
-- form is real, separate scope — flagged as a P1 follow-up in the
-- roadmap artifact, not silently dropped.
-- ============================================================

-- ---- Sequential per-account ticket numbers ------------------------
-- Human-readable ticket numbers (#1, #2, ...) restart at 1 per
-- account, mirroring how e.g. GitHub issue numbers are repo-scoped.
-- Needs an atomic counter — `COUNT(*) + 1` races under concurrent
-- creation.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS ticket_seq INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION next_ticket_number(p_account_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next INTEGER;
BEGIN
  IF NOT is_account_member(p_account_id, 'agent') THEN
    RAISE EXCEPTION 'Not a member of account %', p_account_id;
  END IF;

  UPDATE accounts SET ticket_seq = ticket_seq + 1
  WHERE id = p_account_id
  RETURNING ticket_seq INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Account % not found', p_account_id;
  END IF;

  RETURN v_next;
END;
$$;

ALTER FUNCTION next_ticket_number(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION next_ticket_number(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_ticket_number(UUID) TO authenticated;

-- ---- tickets --------------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ticket_number INTEGER NOT NULL,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Raised from a chat? Points back at it so the ticket panel can
  -- deep-link into the originating conversation. Nullable — a ticket
  -- can also be raised straight from the Contact profile with no
  -- conversation involved, matching klink.cloud's "+ New Ticket" flow.
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('general', 'billing', 'technical', 'feature_request', 'bug', 'account', 'other')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  -- Same four-value scale as conversations.priority (migration 047) —
  -- one mental model for "how urgent" across the whole app.
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  -- Deliberately a plain UUID with no FK, exactly like
  -- conversations.assigned_agent_id (migration 001) — it points at
  -- auth.users indirectly via profiles.user_id, which the rest of the
  -- app already treats as untyped-FK.
  assigned_agent_id UUID,
  assigned_team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, ticket_number)
);

CREATE INDEX IF NOT EXISTS idx_tickets_account_status ON tickets(account_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_account_created ON tickets(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_contact_id ON tickets(contact_id);
CREATE INDEX IF NOT EXISTS idx_tickets_conversation_id ON tickets(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_agent_id ON tickets(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_team_id ON tickets(assigned_team_id);

DROP TRIGGER IF EXISTS set_updated_at ON tickets;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tickets_select ON tickets;
DROP POLICY IF EXISTS tickets_insert ON tickets;
DROP POLICY IF EXISTS tickets_update ON tickets;
DROP POLICY IF EXISTS tickets_delete ON tickets;
CREATE POLICY tickets_select ON tickets FOR SELECT USING (is_account_member(account_id));
CREATE POLICY tickets_insert ON tickets FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY tickets_update ON tickets FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY tickets_delete ON tickets FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ---- ticket_comments --------------------------------------------------
-- A ticket's collaboration thread — "You can mention / comment to your
-- team members on the tickets" per klink.cloud. Kept as its own table
-- rather than folded into `messages` (unlike internal conversation
-- comments, migration 045) since a ticket isn't a conversation and may
-- not have one at all.
CREATE TABLE IF NOT EXISTS ticket_comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  -- JSONB array of mentioned user_ids — same shape as
  -- messages.mentions (migration 045), feeding the mirrored mention
  -- trigger below.
  mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket_created
  ON ticket_comments(ticket_id, created_at);

ALTER TABLE ticket_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_comments_select ON ticket_comments;
DROP POLICY IF EXISTS ticket_comments_insert ON ticket_comments;
CREATE POLICY ticket_comments_select ON ticket_comments FOR SELECT USING (is_account_member(account_id));
CREATE POLICY ticket_comments_insert ON ticket_comments FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

-- ============================================================
-- notifications — widen for ticket_assigned / ticket_mention
-- ============================================================
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'mention', 'ticket_assigned', 'ticket_mention'));

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS ticket_id UUID REFERENCES tickets(id) ON DELETE CASCADE;

-- ============================================================
-- TRIGGER — notify on ticket assignment (mirrors
-- notify_conversation_assigned, migration 027)
-- ============================================================
CREATE OR REPLACE FUNCTION notify_ticket_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, ticket_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'ticket_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    'New ticket assigned',
    COALESCE(v_actor_name, 'Someone') || ' assigned you ticket #' || NEW.ticket_number
      || ' — ' || NEW.subject
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create ticket assignment notification for ticket %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_ticket_assigned() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_assigned ON tickets;
CREATE TRIGGER on_ticket_assigned
  AFTER INSERT OR UPDATE OF assigned_agent_id ON tickets
  FOR EACH ROW EXECUTE FUNCTION notify_ticket_assigned();

-- ============================================================
-- TRIGGER — notify each mentioned teammate on a ticket comment
-- (mirrors notify_message_mentions, migration 045)
-- ============================================================
CREATE OR REPLACE FUNCTION notify_ticket_comment_mentions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_ticket_number INTEGER;
  v_ticket_subject TEXT;
  v_actor_name TEXT;
  v_mentioned_id UUID;
BEGIN
  IF NEW.mentions IS NULL OR jsonb_array_length(NEW.mentions) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT account_id, ticket_number, subject
    INTO v_account_id, v_ticket_number, v_ticket_subject
  FROM tickets WHERE id = NEW.ticket_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  FOR v_mentioned_id IN
    SELECT DISTINCT (elem.value#>>'{}')::UUID
    FROM jsonb_array_elements(NEW.mentions) AS elem(value)
  LOOP
    IF v_mentioned_id IS NULL OR v_mentioned_id = NEW.author_id THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE user_id = v_mentioned_id AND account_id = v_account_id
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO notifications (
      account_id, user_id, type, ticket_id,
      actor_user_id, title, body
    ) VALUES (
      v_account_id,
      v_mentioned_id,
      'ticket_mention',
      NEW.ticket_id,
      auth.uid(),
      'You were mentioned',
      COALESCE(v_actor_name, 'Someone') || ' mentioned you in a comment on ticket #'
        || v_ticket_number || ' — ' || v_ticket_subject
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create mention notification(s) for ticket comment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_ticket_comment_mentions() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_comment_mentions ON ticket_comments;
CREATE TRIGGER on_ticket_comment_mentions
  AFTER INSERT ON ticket_comments
  FOR EACH ROW EXECUTE FUNCTION notify_ticket_comment_mentions();

-- ============================================================
-- ENABLE REALTIME — live ticket list + detail panel updates
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'tickets'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE tickets;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'ticket_comments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ticket_comments;
  END IF;
END $$;
