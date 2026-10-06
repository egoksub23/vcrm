-- ============================================================
-- 167_sign_countersign.sql
--
-- Doc Sign phase 2, work package 15: a Halo user who is a signer on a document (a "countersigner",
-- sign_signers.internal_user_id, migration 157) is told inside Halo when it becomes their turn.
--
--   notifications.type                 widened with sign_your_turn (rebuilt from the live constraint, so no
--                                      type another migration added can be dropped: the same pattern as 159)
--   notify_sign_your_turn()            AFTER UPDATE OF status on sign_signers: one notification for the Halo
--                                      user when their row moves from pending to sent, which is exactly the
--                                      moment their step is invited (sign_invite_step), at the send for the
--                                      first step and when the earlier step finishes for a later one. Only
--                                      for a person who is still a member of the document's workspace, and
--                                      never able to stop the invitation itself.
--
-- Everything else of this work package (the "Awaiting my signature" list, opening the signer page with the
-- identity of the Halo login, the "Needs attention" list) is application code over what already exists.
--
-- Idempotent.
-- ============================================================

DO $$
DECLARE
  v_def   TEXT;
  v_types TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';

  -- The live definition is either ANY ('{a,b}'::text[]) or ANY (ARRAY['a'::text, 'b'::text]); read both.
  IF v_def ~ '\{[^}]*\}' THEN
    v_types := string_to_array(substring(v_def FROM '\{([^}]*)\}'), ',');
  ELSE
    SELECT COALESCE(array_agg(DISTINCT m[1]), ARRAY[]::text[])
      INTO v_types
      FROM regexp_matches(COALESCE(v_def, ''), '''([^'']+)''::text', 'g') AS m;
  END IF;
  v_types := (SELECT array_agg(DISTINCT replace(x, '"', '') ORDER BY replace(x, '"', ''))
                FROM unnest(v_types || ARRAY['sign_your_turn']) AS x);

  IF EXISTS (SELECT 1 FROM public.notifications n WHERE n.type IS NOT NULL AND NOT (n.type = ANY (v_types))) THEN
    RAISE EXCEPTION 'notifications_type_check rebuild would drop a type in use: %', v_def;
  END IF;

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

CREATE OR REPLACE FUNCTION public.notify_sign_your_turn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title TEXT;
  v_ref   TEXT;
BEGIN
  IF NEW.internal_user_id IS NULL OR OLD.status IS DISTINCT FROM 'pending' OR NEW.status IS DISTINCT FROM 'sent' THEN
    RETURN NEW;
  END IF;
  -- a Halo user of this workspace only: a user id from anywhere else never gets a notification about it
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = NEW.internal_user_id AND account_id = NEW.account_id) THEN
    RETURN NEW;
  END IF;
  SELECT d.title, COALESCE(d.reference, d.title) INTO v_title, v_ref
    FROM public.sign_documents d WHERE d.id = NEW.document_id AND d.account_id = NEW.account_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.notifications (account_id, user_id, type, title, body, sign_document_id)
  VALUES (NEW.account_id, NEW.internal_user_id, 'sign_your_turn', left('Your signature is needed: ' || v_ref, 200), left(v_title, 200), NEW.document_id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- a notification must never undo or block the invitation of the step
  RAISE WARNING 'Could not create the Doc Sign turn notification for signer %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.notify_sign_your_turn() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_sign_your_turn() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sign_your_turn_notify ON public.sign_signers;
CREATE TRIGGER trg_sign_your_turn_notify
  AFTER UPDATE OF status ON public.sign_signers
  FOR EACH ROW EXECUTE FUNCTION public.notify_sign_your_turn();

NOTIFY pgrst, 'reload schema';
