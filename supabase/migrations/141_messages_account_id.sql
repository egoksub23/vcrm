-- ============================================================
-- 141: messages carry their workspace (plan item B1).
--
-- Live updates (Supabase Realtime) can only filter on a column of the changed
-- row, and `messages` had no workspace column: its subscription had no filter,
-- so every new message anywhere was checked against every connected browser of
-- every customer. With `account_id` the app subscribes per workspace.
--
-- The value is always taken from the conversation by a BEFORE trigger, so no
-- writer (webhooks, sends, flows, automations, the public API) has to supply it
-- and none can supply a different one. Row security on messages is unchanged
-- (it still goes through the conversation).
--
-- Backfill is one statement: fine at today's size. On a large database run it in
-- batches (WHERE account_id IS NULL ... LIMIT) before the NOT NULL step.
-- ============================================================

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS account_id UUID;

UPDATE public.messages m
SET account_id = c.account_id
FROM public.conversations c
WHERE c.id = m.conversation_id AND m.account_id IS NULL;

CREATE OR REPLACE FUNCTION public.messages_set_account_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Overwrite, never trust: the conversation is the source of truth.
  SELECT account_id INTO NEW.account_id FROM public.conversations WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.messages_set_account_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.messages_set_account_id() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_set_account_id ON public.messages;
CREATE TRIGGER messages_set_account_id
  BEFORE INSERT OR UPDATE OF conversation_id ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_set_account_id();

ALTER TABLE public.messages ALTER COLUMN account_id SET NOT NULL;
