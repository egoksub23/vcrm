-- ============================================================
-- 065_conversation_session_log
--
-- klink.cloud parity, scoped from docs.klink.cloud/how-to-use/chat/
-- inbound-chat-handling and docs.klink.cloud/settings/dispositions-and-
-- wrap-up (reviewed Sep 19, 2026): agents must leave a closure note when
-- closing a conversation, and every conversation gets a persistent,
-- readable timeline ("session log" / "case log" in the product owner's
-- terms) of what happened on it — assigned, reassigned, priority
-- changed, closed, reopened.
--
-- Two write paths, matched to what each event needs:
--   - assigned/team_assigned/priority_changed: no free text, must fire
--     from every code path that can change the column (UI, automation
--     steps, routing RPCs) -> SECURITY DEFINER trigger, mirrors
--     notify_conversation_assigned (migration 027).
--   - closed/reopened: carry a human-authored note, and only ever
--     originate from a small, known set of call sites (the UI's Close
--     action, the close_conversation automation step) -> explicit RPCs
--     so "a note is required to close" is enforced server-side, not
--     just in a dialog that a direct API call could skip.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'assigned', 'unassigned', 'team_assigned', 'team_unassigned',
    'priority_changed', 'closed', 'reopened'
  )),
  -- NULL = an automation/system action, not a signed-in teammate.
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  note TEXT,
  -- e.g. {"agent_id": "..."} or {"from": "normal", "to": "urgent"} —
  -- lets the timeline render specifics without a column per event type.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The whole point of a closure note is that it's actually captured —
  -- a 'closed' row with no note is a bug, not a valid state.
  CONSTRAINT conversation_events_close_requires_note
    CHECK (event_type <> 'closed' OR (note IS NOT NULL AND length(trim(note)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation_created
  ON conversation_events(conversation_id, created_at);

ALTER TABLE conversation_events ENABLE ROW LEVEL SECURITY;

-- Same "join through conversations" shape as messages' own RLS
-- (migration 017) rather than a denormalized account_id column —
-- avoids any risk of a client forging a mismatched account_id.
DROP POLICY IF EXISTS conversation_events_select ON conversation_events;
CREATE POLICY conversation_events_select ON conversation_events FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = conversation_events.conversation_id AND is_account_member(c.account_id)
  )
);
-- No client INSERT/UPDATE/DELETE policy — rows are written exclusively
-- by the trigger below and the close/reopen RPCs (both SECURITY
-- DEFINER), keeping the log immutable and tamper-proof from the client.

-- ============================================================
-- TRIGGER — auto-log assignment/priority events on any UPDATE path
-- ============================================================
CREATE OR REPLACE FUNCTION log_conversation_field_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    INSERT INTO conversation_events (conversation_id, event_type, actor_user_id, metadata)
    VALUES (
      NEW.id,
      CASE WHEN NEW.assigned_agent_id IS NULL THEN 'unassigned' ELSE 'assigned' END,
      auth.uid(),
      jsonb_build_object('agent_id', NEW.assigned_agent_id)
    );
  END IF;

  IF NEW.assigned_team_id IS DISTINCT FROM OLD.assigned_team_id THEN
    INSERT INTO conversation_events (conversation_id, event_type, actor_user_id, metadata)
    VALUES (
      NEW.id,
      CASE WHEN NEW.assigned_team_id IS NULL THEN 'team_unassigned' ELSE 'team_assigned' END,
      auth.uid(),
      jsonb_build_object('team_id', NEW.assigned_team_id)
    );
  END IF;

  IF NEW.priority IS DISTINCT FROM OLD.priority THEN
    INSERT INTO conversation_events (conversation_id, event_type, actor_user_id, metadata)
    VALUES (
      NEW.id, 'priority_changed', auth.uid(),
      jsonb_build_object('from', OLD.priority, 'to', NEW.priority)
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log conversation event(s) for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION log_conversation_field_events() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_conversation_field_events ON conversations;
CREATE TRIGGER on_conversation_field_events
  AFTER UPDATE OF assigned_agent_id, assigned_team_id, priority ON conversations
  FOR EACH ROW EXECUTE FUNCTION log_conversation_field_events();

-- ============================================================
-- RPCs — close (note required) / reopen (note optional)
-- ============================================================
-- Membership is only checked when called with a real user session
-- (auth.uid() IS NOT NULL) — same conditional pattern
-- notify_conversation_assigned/notify_ticket_assigned already use.
-- The automations engine calls this via the service-role client (no
-- user JWT, auth.uid() IS NULL) for its close_conversation step, same
-- as pick_round_robin_agent/pick_team_round_robin_member already do;
-- that path is trusted because only trusted server code holds the
-- service-role key, not because membership doesn't matter.
CREATE OR REPLACE FUNCTION close_conversation_with_note(p_conversation_id UUID, p_note TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT account_id INTO v_account_id FROM conversations WHERE id = p_conversation_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Conversation % not found', p_conversation_id;
  END IF;
  IF auth.uid() IS NOT NULL AND NOT is_account_member(v_account_id, 'agent') THEN
    RAISE EXCEPTION 'Not a member of account %', v_account_id;
  END IF;
  IF p_note IS NULL OR length(trim(p_note)) = 0 THEN
    RAISE EXCEPTION 'A closure note is required to close a conversation';
  END IF;

  UPDATE conversations SET status = 'closed', closed_at = NOW() WHERE id = p_conversation_id;

  INSERT INTO conversation_events (conversation_id, event_type, actor_user_id, note)
  VALUES (p_conversation_id, 'closed', auth.uid(), p_note);
END;
$$;

ALTER FUNCTION close_conversation_with_note(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION close_conversation_with_note(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_conversation_with_note(UUID, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION reopen_conversation(p_conversation_id UUID, p_note TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT account_id INTO v_account_id FROM conversations WHERE id = p_conversation_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Conversation % not found', p_conversation_id;
  END IF;
  IF auth.uid() IS NOT NULL AND NOT is_account_member(v_account_id, 'agent') THEN
    RAISE EXCEPTION 'Not a member of account %', v_account_id;
  END IF;

  UPDATE conversations SET status = 'open', closed_at = NULL WHERE id = p_conversation_id;

  INSERT INTO conversation_events (conversation_id, event_type, actor_user_id, note)
  VALUES (p_conversation_id, 'reopened', auth.uid(), NULLIF(trim(p_note), ''));
END;
$$;

ALTER FUNCTION reopen_conversation(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION reopen_conversation(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reopen_conversation(UUID, TEXT) TO authenticated, service_role;

-- ============================================================
-- ENABLE REALTIME
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'conversation_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE conversation_events;
  END IF;
END $$;
