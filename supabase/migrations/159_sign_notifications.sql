-- ============================================================
-- 159_sign_notifications.sql
--
-- Doc Sign, work package 6: tell the sender inside Halo when a document they sent has finished
-- (completed, declined or expired), as well as by email (the emails already go out from the app).
--
--   notifications.sign_document_id     the document a notification is about
--   notifications.type                 widened with sign_completed, sign_declined, sign_expired
--                                      (rebuilt from the live constraint, so no type another migration
--                                      added can be dropped: the same pattern as 084, 116 and 126)
--   notify_sign_document_finished()    AFTER UPDATE OF status on sign_documents: one notification for
--                                      the person who created the document, only on the move into one of
--                                      the three states, and never able to stop the status change itself
--
-- It also adds sign_documents and sign_signers to the realtime publication, so the documents list
-- refreshes by itself when a signer finishes. Realtime applies row level security with the listener's own
-- sign-in, so a person only hears about documents they may read.
--
-- Idempotent.
-- ============================================================

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS sign_document_id UUID REFERENCES public.sign_documents(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS notifications_sign_document_idx ON public.notifications (sign_document_id) WHERE sign_document_id IS NOT NULL;

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
                FROM unnest(v_types || ARRAY['sign_completed', 'sign_declined', 'sign_expired']) AS x);

  IF EXISTS (SELECT 1 FROM public.notifications n WHERE n.type IS NOT NULL AND NOT (n.type = ANY (v_types))) THEN
    RAISE EXCEPTION 'notifications_type_check rebuild would drop a type in use: %', v_def;
  END IF;

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

CREATE OR REPLACE FUNCTION public.notify_sign_document_finished()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type  TEXT;
  v_title TEXT;
  v_ref   TEXT;
BEGIN
  IF NEW.created_by IS NULL OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  v_type := CASE NEW.status
    WHEN 'completed' THEN 'sign_completed'
    WHEN 'declined'  THEN 'sign_declined'
    WHEN 'expired'   THEN 'sign_expired'
    ELSE NULL
  END;
  IF v_type IS NULL THEN
    RETURN NEW;
  END IF;
  -- still a member of the workspace?
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = NEW.created_by AND account_id = NEW.account_id) THEN
    RETURN NEW;
  END IF;
  v_ref := COALESCE(NEW.reference, NEW.title);
  v_title := CASE v_type
    WHEN 'sign_completed' THEN 'Signed by everyone: ' || v_ref
    WHEN 'sign_declined'  THEN 'Declined: ' || v_ref
    ELSE 'Expired: ' || v_ref
  END;
  INSERT INTO public.notifications (account_id, user_id, type, title, body, sign_document_id)
  VALUES (NEW.account_id, NEW.created_by, v_type, left(v_title, 200), left(NEW.title, 200), NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- a notification must never undo or block the document's own state change
  RAISE WARNING 'Could not create the Doc Sign notification for document %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.notify_sign_document_finished() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_sign_document_finished() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sign_document_finished_notify ON public.sign_documents;
CREATE TRIGGER trg_sign_document_finished_notify
  AFTER UPDATE OF status ON public.sign_documents
  FOR EACH ROW EXECUTE FUNCTION public.notify_sign_document_finished();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sign_documents') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.sign_documents;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sign_signers') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.sign_signers;
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
