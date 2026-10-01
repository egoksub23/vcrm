-- ============================================================
-- 129_ticket_first_response_from_chat
--
-- The last of the Tickets roadmap's open items: "First-response timer
-- ignores chat replies." ticket_sla_first_response() (086) only stamps
-- tickets.sla_first_response_at from a ticket_comments INSERT (a person
-- writing on the ticket's own collaboration thread) — an agent's reply sent
-- through the ticket's LINKED CONVERSATION (WhatsApp, Web Widget, Messenger,
-- Instagram, email) inserts into `messages`, not `ticket_comments`, so it
-- never reached that trigger. Flagged twice in the build log and never
-- fixed either time.
--
-- Mirrors 086's own trigger shape exactly (same guarded, idempotent
-- "UPDATE ... WHERE sla_first_response_at IS NULL" — only the FIRST
-- qualifying write anywhere ever stamps it, ticket_comments or messages,
-- whichever happens first): a message with `sender_type = 'agent'` (a bot/
-- automation send is `sender_type = 'bot'`, deliberately excluded, same as
-- 086 excluding a comment with no author_id) that actually went out (not
-- `status = 'failed'`, so a failed attempt never starts the clock) stamps
-- every open ticket linked to that conversation.
--
-- Depends on: 001 (messages), 063 (tickets.conversation_id), 086 (the
-- sla_first_response_at column + BEFORE trigger that recomputes state from
-- it — a plain UPDATE here already fires that trigger, nothing new needed).
-- Idempotent — safe to run more than once.
-- ============================================================

CREATE OR REPLACE FUNCTION public.ticket_sla_first_response_from_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_type <> 'agent' OR NEW.status = 'failed' OR NEW.conversation_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE tickets
     SET sla_first_response_at = NEW.created_at
   WHERE conversation_id = NEW.conversation_id
     AND sla_first_response_at IS NULL;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ticket_sla_first_response_from_message failed for message %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.ticket_sla_first_response_from_message() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ticket_sla_first_response_from_message() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS ticket_sla_first_response_from_message ON public.messages;
CREATE TRIGGER ticket_sla_first_response_from_message
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.ticket_sla_first_response_from_message();

NOTIFY pgrst, 'reload schema';
