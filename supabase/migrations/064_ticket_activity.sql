-- ============================================================
-- 064_ticket_activity
--
-- Fills a real gap found auditing Ticketing (migration 063) against
-- klink.cloud's assign/transfer UX (docs.klink.cloud/how-to-use/tickets/
-- assign-transfer-ticket, reviewed Sep 19, 2026): assignment today is a
-- plain field overwrite on `tickets` with no trace of who held it before,
-- and no record of status/priority/category changes over time. An agent
-- opening a ticket has no way to see its history.
--
-- Reuses the same shape as everything else in this codebase's audit-trail
-- precedent-free areas: one append-only table, a SECURITY DEFINER trigger
-- that diffs OLD vs NEW and inserts a row per changed field, wrapped in
-- EXCEPTION WHEN OTHERS so a logging failure can never block the actual
-- update (same guard notify_ticket_assigned/notify_conversation_assigned
-- already use). `from_value`/`to_value` are stored as plain text — agent
-- and team ids are resolved to names client-side from the roster the
-- ticket detail sheet already fetches (profiles/teams), so this table
-- never needs to denormalize a name that could go stale.
-- ============================================================

CREATE TABLE IF NOT EXISTS ticket_activity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'status_changed', 'priority_changed', 'category_changed',
    'assigned_agent_changed', 'assigned_team_changed'
  )),
  from_value TEXT,
  to_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_activity_ticket_created
  ON ticket_activity(ticket_id, created_at);

ALTER TABLE ticket_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_activity_select ON ticket_activity;
CREATE POLICY ticket_activity_select ON ticket_activity
  FOR SELECT USING (is_account_member(account_id));
-- No client INSERT policy — rows are only ever written by the
-- SECURITY DEFINER trigger below, same as notifications.

-- ============================================================
-- TRIGGER — log ticket creation
-- ============================================================
CREATE OR REPLACE FUNCTION log_ticket_created()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, to_value)
  VALUES (NEW.id, NEW.account_id, COALESCE(NEW.created_by, auth.uid()), 'created', NEW.status);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log ticket creation for ticket %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION log_ticket_created() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_created_activity ON tickets;
CREATE TRIGGER on_ticket_created_activity
  AFTER INSERT ON tickets
  FOR EACH ROW EXECUTE FUNCTION log_ticket_created();

-- ============================================================
-- TRIGGER — log field changes (status/priority/category/assignment)
-- ============================================================
CREATE OR REPLACE FUNCTION log_ticket_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log ticket activity for ticket %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION log_ticket_activity() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_activity ON tickets;
CREATE TRIGGER on_ticket_activity
  AFTER UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION log_ticket_activity();

-- ============================================================
-- ENABLE REALTIME — live activity timeline in the ticket detail panel
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'ticket_activity'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE ticket_activity;
  END IF;
END $$;
