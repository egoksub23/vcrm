-- ============================================================
-- Sembang P4: "Create a real Ticket from a Sembang task."
--
-- The one deliberate exception to Sembang's "zero FK into
-- conversations/messages/tickets" rule (see the requirements doc) —
-- explicitly scoped, one column, one direction only.
--
-- sembang_tasks.ticket_id is nullable and write-once: a client can set
-- it from NULL to a real ticket id (after creating that ticket through
-- the normal Tickets flow), but can never change it again once set, and
-- the referenced ticket must belong to the same account. This is
-- enforced by extending the existing sembang_tasks_guard() trigger
-- (migration 099), not a new RLS policy — the existing
-- sembang_tasks_update policy already lets any channel member edit a
-- task's other fields, and linking a ticket is no more sensitive than
-- that.
--
-- Tickets.contact_id stays NOT NULL (unchanged, on purpose — see the
-- requirements doc's decision record): a Sembang task has no customer
-- contact, so the app prompts the person for one at "Create Ticket"
-- time, reusing the existing create-ticket-dialog contact picker. No
-- schema change needed on the tickets side at all.
-- ============================================================

ALTER TABLE public.sembang_tasks
  ADD COLUMN IF NOT EXISTS ticket_id UUID REFERENCES public.tickets(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.sembang_tasks_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sembang_task_immutable_column_changed';
  END IF;
  -- ticket_id: write-once (NULL -> a real ticket), never reassignable
  -- afterward, and only to a ticket in the same account (the
  -- cross-account hygiene check this codebase now applies by habit to
  -- every new cross-table reference).
  IF NEW.ticket_id IS DISTINCT FROM OLD.ticket_id THEN
    IF OLD.ticket_id IS NOT NULL THEN
      RAISE EXCEPTION 'sembang_task_ticket_id_immutable_once_set';
    END IF;
    IF NEW.ticket_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.tickets t WHERE t.id = NEW.ticket_id AND t.account_id = NEW.account_id
    ) THEN
      RAISE EXCEPTION 'sembang_task_ticket_id_cross_account_or_missing';
    END IF;
  END IF;
  -- completed_at/completed_by follow status, so a client can't fake
  -- "done since last week" or credit someone else with completing it.
  IF NEW.status = 'done' AND OLD.status <> 'done' THEN
    NEW.completed_at := now();
    NEW.completed_by := auth.uid();
  ELSIF NEW.status = 'open' AND OLD.status <> 'open' THEN
    NEW.completed_at := NULL;
    NEW.completed_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sembang_tasks_guard() OWNER TO postgres;
