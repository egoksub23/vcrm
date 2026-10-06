-- ============================================================
-- 173_sign_bulk_notice.sql
--
-- Doc Sign phase 2, work package 17 follow-up: the person who started a bulk batch (migration 162) is told inside
-- Halo when it has finished, so they need not keep the progress screen open.
--
--   notifications.type                 widened with sign_bulk_done (rebuilt from the live constraint, so no type
--                                      another migration added can be dropped: the same pattern as 159 and 167)
--   notify_sign_bulk_done()            AFTER UPDATE OF status on sign_bulk_jobs: one notification for the person who
--                                      started the batch, only on the move into done or failed (a batch the person
--                                      cancelled themselves is not announced to them), only while they are still a
--                                      member of the workspace, and never able to stop the batch from closing.
--
-- A batch has no document, so the notification carries no sign_document_id: like the certificate notice it is opened by
-- its type (the notifications screen sends it to the batches list). The counts in the text are counted from the rows at
-- that moment, because a batch that is failed early is closed before its counters are refreshed.
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
                FROM unnest(v_types || ARRAY['sign_bulk_done']) AS x);

  IF EXISTS (SELECT 1 FROM public.notifications n WHERE n.type IS NOT NULL AND NOT (n.type = ANY (v_types))) THEN
    RAISE EXCEPTION 'notifications_type_check rebuild would drop a type in use: %', v_def;
  END IF;

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

CREATE OR REPLACE FUNCTION public.notify_sign_bulk_done()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sent    INTEGER;
  v_failed  INTEGER;
  v_skipped INTEGER;
  v_title   TEXT;
BEGIN
  IF NEW.created_by IS NULL OR NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status NOT IN ('done', 'failed') THEN
    RETURN NEW;
  END IF;
  -- still a member of the workspace?
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = NEW.created_by AND account_id = NEW.account_id) THEN
    RETURN NEW;
  END IF;
  SELECT count(*) FILTER (WHERE r.state = 'sent'),
         count(*) FILTER (WHERE r.state = 'failed'),
         count(*) FILTER (WHERE r.state = 'skipped')
    INTO v_sent, v_failed, v_skipped
    FROM public.sign_bulk_rows r
   WHERE r.job_id = NEW.id AND r.account_id = NEW.account_id;
  v_title := CASE NEW.status
    WHEN 'done' THEN 'Batch finished: ' || NEW.template_name
    ELSE 'Batch stopped: ' || NEW.template_name
  END;
  INSERT INTO public.notifications (account_id, user_id, type, title, body)
  VALUES (NEW.account_id, NEW.created_by, 'sign_bulk_done', left(v_title, 200),
          format('%s sent, %s failed, %s skipped', v_sent, v_failed, v_skipped));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- a notification must never undo or block the closing of the batch
  RAISE WARNING 'Could not create the Doc Sign batch notification for job %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.notify_sign_bulk_done() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_sign_bulk_done() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sign_bulk_done_notify ON public.sign_bulk_jobs;
CREATE TRIGGER trg_sign_bulk_done_notify
  AFTER UPDATE OF status ON public.sign_bulk_jobs
  FOR EACH ROW EXECUTE FUNCTION public.notify_sign_bulk_done();

NOTIFY pgrst, 'reload schema';
