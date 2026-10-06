-- ============================================================
-- 162_sign_bulk.sql
--
-- Doc Sign, work package 17: bulk send. A sender chooses a template and a list of people (a CSV or a set of
-- contacts) and the server sends one document to each, in the background, so closing the browser loses nothing.
--
--   sign_bulk_jobs   one row per batch: the template, who started it, the options every document shares
--                    (message, language, expiry, channel, who receives which role), and the totals.
--   sign_bulk_rows   one row per person: what was in the file for them, and what became of it (a document,
--                    or the reason there is none). A lease (claimed_until) stops two runs sharing a row.
--
-- Everything about a batch is written by the server with the service role. A person with menu.sign reads;
-- nobody writes these tables from the browser (no insert, update or delete policy and no privilege).
--
--   sign_bulk_create     the job and all its rows in one transaction (at most 500 rows, 3 active jobs per workspace)
--   sign_bulk_claim      a fair, leased claim of pending rows across workspaces (the pattern of 135)
--   sign_bulk_release    give claimed rows back when the run ran out of time
--   sign_bulk_stop       cancel a job, or fail what has not started (the monthly limit was reached)
--   sign_bulk_settle     recount a job's totals and close it when nothing is left to do
--
-- A row that already has a document is never created twice, and a sent row is final: the guard trigger refuses
-- to change its input, its state or its document. Both tables carry account_id with a cascade, so the
-- workspace export (153) finds them by itself and deleting a workspace removes them. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sign_bulk_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Kept as a plain id (the template may be deleted later) with its name as it was when the batch started.
  template_id    UUID REFERENCES public.sign_templates(id) ON DELETE SET NULL,
  template_name  TEXT NOT NULL CHECK (length(btrim(template_name)) BETWEEN 1 AND 200),
  created_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  source         TEXT NOT NULL DEFAULT 'csv' CHECK (source IN ('csv', 'contacts')),
  file_name      TEXT CHECK (file_name IS NULL OR length(file_name) <= 200),
  total_rows     INTEGER NOT NULL CHECK (total_rows BETWEEN 1 AND 500),
  sent_count     INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  failed_count   INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  skipped_count  INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  -- message, locale, channel, expiry_days, code_required, sign_in_order, reminder_days, category_id,
  -- title, person_role and the fixed signers of the other roles.
  options        JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object' AND length(options::text) <= 40000),
  error_code     TEXT CHECK (error_code IS NULL OR length(error_code) <= 60),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_bulk_jobs_id_account UNIQUE (id, account_id)
);
CREATE INDEX IF NOT EXISTS sign_bulk_jobs_list_idx ON public.sign_bulk_jobs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sign_bulk_jobs_active_idx ON public.sign_bulk_jobs (status, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS public.sign_bulk_rows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  job_id        UUID NOT NULL,
  row_no        INTEGER NOT NULL CHECK (row_no BETWEEN 1 AND 500),
  -- What the file said for this person: name, email, phone, contactId, merge values. Never changes.
  input         JSONB NOT NULL CHECK (jsonb_typeof(input) = 'object' AND length(input::text) <= 20000),
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed', 'skipped')),
  -- Kept as a plain id: a draft that was deleted afterwards must not stop its row from existing.
  document_id   UUID REFERENCES public.sign_documents(id) ON DELETE SET NULL,
  error_code    TEXT CHECK (error_code IS NULL OR length(error_code) <= 60),
  error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 500),
  -- The lease: a run that claims the row holds it until this time. A row whose lease passed is claimable again.
  claimed_until TIMESTAMPTZ,
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_bulk_rows_job_row UNIQUE (job_id, row_no),
  CONSTRAINT sign_bulk_rows_job_fk FOREIGN KEY (job_id, account_id)
    REFERENCES public.sign_bulk_jobs (id, account_id) ON DELETE CASCADE
);
-- The claim reads pending rows that are not leased; the progress screen reads one job's rows in order.
CREATE INDEX IF NOT EXISTS sign_bulk_rows_claim_idx ON public.sign_bulk_rows (account_id, job_id, row_no) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS sign_bulk_rows_document_idx ON public.sign_bulk_rows (document_id) WHERE document_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Row level security: members with menu.sign read; the server writes
-- ------------------------------------------------------------
ALTER TABLE public.sign_bulk_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_bulk_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sign_bulk_jobs_select ON public.sign_bulk_jobs;
CREATE POLICY sign_bulk_jobs_select ON public.sign_bulk_jobs
  FOR SELECT USING (has_capability(account_id, 'menu.sign'));
DROP POLICY IF EXISTS sign_bulk_rows_select ON public.sign_bulk_rows;
CREATE POLICY sign_bulk_rows_select ON public.sign_bulk_rows
  FOR SELECT USING (has_capability(account_id, 'menu.sign'));

REVOKE ALL ON public.sign_bulk_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sign_bulk_rows FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sign_bulk_jobs TO authenticated;
GRANT SELECT ON public.sign_bulk_rows TO authenticated;
GRANT ALL ON public.sign_bulk_jobs TO service_role;
GRANT ALL ON public.sign_bulk_rows TO service_role;

-- ------------------------------------------------------------
-- 3. updated_at and audit
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON public.sign_bulk_jobs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.sign_bulk_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.sign_bulk_rows;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.sign_bulk_rows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A batch is audited as a whole (who started it, and how it ended). Each document it makes has its own
-- history in sign_events. The rows are not audited one by one: they carry people's addresses.
DROP TRIGGER IF EXISTS audit_row_change ON public.sign_bulk_jobs;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_bulk_jobs
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'sign_bulk_job', 'template_name', 'status,total_rows', 'options', '', 'created_by');

-- ------------------------------------------------------------
-- 4. Integrity: what a batch recorded cannot be rewritten
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_bulk_jobs_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.template_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.sign_templates t WHERE t.id = NEW.template_id AND t.account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'sign_bulk_template_not_in_workspace' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     -- (cleared to NULL when the person's login is deleted)
     OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
     OR NEW.total_rows IS DISTINCT FROM OLD.total_rows
     OR NEW.options IS DISTINCT FROM OLD.options
     OR NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'sign_bulk_job_is_fixed' USING ERRCODE = '23514',
      DETAIL = 'A batch keeps the template, options and list it started with.';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_ok := CASE OLD.status
      WHEN 'queued'  THEN NEW.status IN ('running', 'done', 'failed', 'cancelled')
      WHEN 'running' THEN NEW.status IN ('done', 'failed', 'cancelled')
      ELSE FALSE
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'invalid_sign_bulk_status_move' USING ERRCODE = '23514',
        DETAIL = format('%s -> %s', OLD.status, NEW.status);
    END IF;
    IF NEW.status IN ('done', 'failed', 'cancelled') THEN
      NEW.finished_at := COALESCE(NEW.finished_at, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_bulk_jobs_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_bulk_jobs_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_bulk_jobs_guard ON public.sign_bulk_jobs;
CREATE TRIGGER sign_bulk_jobs_guard
  BEFORE INSERT OR UPDATE ON public.sign_bulk_jobs
  FOR EACH ROW EXECUTE FUNCTION public.sign_bulk_jobs_guard();

CREATE OR REPLACE FUNCTION public.sign_bulk_rows_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.document_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.sign_documents d WHERE d.id = NEW.document_id AND d.account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'sign_bulk_document_not_in_workspace' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.row_no IS DISTINCT FROM OLD.row_no OR NEW.input IS DISTINCT FROM OLD.input THEN
    RAISE EXCEPTION 'sign_bulk_row_is_fixed' USING ERRCODE = '23514',
      DETAIL = 'A row keeps what the file said for it.';
  END IF;

  -- sent, failed and skipped are final
  IF OLD.state <> 'pending' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'sign_bulk_row_is_final' USING ERRCODE = '23514', DETAIL = format('%s -> %s', OLD.state, NEW.state);
  END IF;
  -- a document, once recorded, is never replaced by another (it may only disappear with a deleted draft)
  IF OLD.document_id IS NOT NULL AND NEW.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN
    RAISE EXCEPTION 'sign_bulk_row_document_is_fixed' USING ERRCODE = '23514';
  END IF;
  IF NEW.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id
     AND NOT EXISTS (SELECT 1 FROM public.sign_documents d WHERE d.id = NEW.document_id AND d.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'sign_bulk_document_not_in_workspace' USING ERRCODE = '23514';
  END IF;
  IF NEW.state <> 'pending' AND OLD.state = 'pending' THEN
    NEW.claimed_until := NULL;
    NEW.processed_at := COALESCE(NEW.processed_at, now());
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_bulk_rows_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_bulk_rows_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_bulk_rows_guard ON public.sign_bulk_rows;
CREATE TRIGGER sign_bulk_rows_guard
  BEFORE INSERT OR UPDATE ON public.sign_bulk_rows
  FOR EACH ROW EXECUTE FUNCTION public.sign_bulk_rows_guard();

-- ------------------------------------------------------------
-- 5. Create a batch: the job and every row, or nothing
--    p_rows: [{ "row_no": 1, "input": {...}, "state": "pending"|"skipped", "error_code": "...", "error_message": "..." }]
--    A row that was found invalid at the preview is recorded as skipped, so the result shows every line of the file.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_bulk_create(
  p_account       UUID,
  p_template      UUID,
  p_template_name TEXT,
  p_user          UUID,
  p_source        TEXT,
  p_file_name     TEXT,
  p_options       JSONB,
  p_rows          JSONB
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job     UUID;
  v_n       INTEGER;
  v_pending INTEGER;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'sign_bulk_rows_required' USING ERRCODE = '22023';
  END IF;
  v_n := jsonb_array_length(p_rows);
  IF v_n < 1 OR v_n > 500 THEN
    RAISE EXCEPTION 'sign_bulk_row_count' USING ERRCODE = '22023';
  END IF;
  -- Serialise creation per workspace so two requests cannot both pass the limit below.
  PERFORM pg_advisory_xact_lock(hashtextextended('sign_bulk_create:' || p_account::text, 0));
  IF (SELECT count(*) FROM public.sign_bulk_jobs j WHERE j.account_id = p_account AND j.status IN ('queued', 'running')) >= 3 THEN
    RAISE EXCEPTION 'too_many_bulk_jobs' USING ERRCODE = '53400';
  END IF;

  INSERT INTO public.sign_bulk_jobs (account_id, template_id, template_name, created_by, source, file_name, total_rows, options)
  VALUES (p_account, p_template, left(p_template_name, 200), p_user, COALESCE(NULLIF(p_source, ''), 'csv'), left(p_file_name, 200), v_n, COALESCE(p_options, '{}'::jsonb))
  RETURNING id INTO v_job;

  INSERT INTO public.sign_bulk_rows (account_id, job_id, row_no, input, state, error_code, error_message)
  SELECT p_account, v_job, (e ->> 'row_no')::int, COALESCE(e -> 'input', '{}'::jsonb),
         CASE WHEN e ->> 'state' = 'skipped' THEN 'skipped' ELSE 'pending' END,
         CASE WHEN e ->> 'state' = 'skipped' THEN left(e ->> 'error_code', 60) END,
         CASE WHEN e ->> 'state' = 'skipped' THEN left(e ->> 'error_message', 500) END
    FROM jsonb_array_elements(p_rows) AS e;

  SELECT count(*) INTO v_pending FROM public.sign_bulk_rows r WHERE r.job_id = v_job AND r.state = 'pending';
  IF v_pending = 0 THEN
    PERFORM public.sign_bulk_settle(ARRAY[v_job]);
  ELSE
    UPDATE public.sign_bulk_jobs SET skipped_count = v_n - v_pending WHERE id = v_job;
  END IF;
  RETURN v_job;
END;
$$;
ALTER FUNCTION public.sign_bulk_create(UUID, UUID, TEXT, UUID, TEXT, TEXT, JSONB, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_bulk_create(UUID, UUID, TEXT, UUID, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_bulk_create(UUID, UUID, TEXT, UUID, TEXT, TEXT, JSONB, JSONB) TO service_role;

-- ------------------------------------------------------------
-- 6. Recount and close
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_bulk_settle(p_jobs UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  UPDATE public.sign_bulk_jobs j
     SET sent_count    = c.sent,
         failed_count  = c.failed,
         skipped_count = c.skipped,
         status        = CASE WHEN j.status IN ('queued', 'running') AND c.pending = 0 THEN 'done' ELSE j.status END
    FROM (
      SELECT x.id,
             (SELECT count(*) FROM public.sign_bulk_rows r WHERE r.job_id = x.id AND r.state = 'sent')::int    AS sent,
             (SELECT count(*) FROM public.sign_bulk_rows r WHERE r.job_id = x.id AND r.state = 'failed')::int  AS failed,
             (SELECT count(*) FROM public.sign_bulk_rows r WHERE r.job_id = x.id AND r.state = 'skipped')::int AS skipped,
             (SELECT count(*) FROM public.sign_bulk_rows r WHERE r.job_id = x.id AND r.state = 'pending')::int AS pending
        FROM public.sign_bulk_jobs x
       WHERE x.id = ANY (COALESCE(p_jobs, ARRAY[]::uuid[]))
    ) c
   WHERE j.id = c.id
     AND ((j.sent_count, j.failed_count, j.skipped_count) IS DISTINCT FROM (c.sent, c.failed, c.skipped)
          OR (j.status IN ('queued', 'running') AND c.pending = 0));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
ALTER FUNCTION public.sign_bulk_settle(UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_bulk_settle(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_bulk_settle(UUID[]) TO service_role;

-- ------------------------------------------------------------
-- 7. Claim: fair across workspaces, under a lease
--    Each workspace gets a share of every batch (round robin over its oldest rows), and suspended
--    workspaces are left alone. Rows already held (lease not passed) are never handed out; a row whose
--    lease passed comes back. A row that was claimed several times without finishing, and has no sent
--    document, is failed rather than tried for ever. Rows of a job that is no longer queued or running
--    are not claimed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_bulk_claim(
  p_limit         INTEGER DEFAULT 20,
  p_per_account   INTEGER DEFAULT 5,
  p_lease_seconds INTEGER DEFAULT 300,
  p_max_attempts  INTEGER DEFAULT 3
)
RETURNS SETOF public.sign_bulk_rows
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  p_limit := GREATEST(1, LEAST(COALESCE(p_limit, 20), 200));
  p_per_account := GREATEST(1, LEAST(COALESCE(p_per_account, 5), p_limit));
  p_max_attempts := GREATEST(1, COALESCE(p_max_attempts, 3));

  -- Tried too often without finishing. A row whose document was already sent is left for the app to record as sent.
  UPDATE public.sign_bulk_rows r
     SET state = 'failed', error_code = 'gave_up',
         error_message = 'This row did not finish after several tries. Check the document, then send it by hand if needed.'
   WHERE r.state = 'pending' AND r.attempts >= p_max_attempts
     AND r.claimed_until IS NOT NULL AND r.claimed_until < now()
     AND NOT EXISTS (SELECT 1 FROM public.sign_documents d WHERE d.id = r.document_id AND d.status <> 'draft');

  -- A batch with nothing left to do (its last rows gave up, or were settled) is closed here, so it never lingers as running.
  PERFORM public.sign_bulk_settle(ARRAY(
    SELECT j.id FROM public.sign_bulk_jobs j
     WHERE j.status IN ('queued', 'running')
       AND NOT EXISTS (SELECT 1 FROM public.sign_bulk_rows r WHERE r.job_id = j.id AND r.state = 'pending')));

  RETURN QUERY
  WITH due AS (
    SELECT r.id, j.created_at AS job_at, r.row_no,
           row_number() OVER (PARTITION BY r.account_id ORDER BY j.created_at, r.row_no) AS rn
      FROM public.sign_bulk_rows r
      JOIN public.sign_bulk_jobs j ON j.id = r.job_id AND j.account_id = r.account_id
     WHERE r.state = 'pending'
       AND (r.claimed_until IS NULL OR r.claimed_until < now())
       AND j.status IN ('queued', 'running')
       AND public.account_is_active(r.account_id)
  ), fair AS (
    SELECT d.id FROM due d
     WHERE d.rn <= p_per_account
     ORDER BY d.rn, d.job_at, d.row_no
     LIMIT p_limit
  ), picked AS (
    SELECT r.id FROM public.sign_bulk_rows r
     WHERE r.id IN (SELECT id FROM fair)
       AND r.state = 'pending'
       AND (r.claimed_until IS NULL OR r.claimed_until < now())
       FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.sign_bulk_rows r
       SET claimed_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 30)),
           attempts = r.attempts + 1
      FROM picked
     WHERE r.id = picked.id
    RETURNING r.*
  ), started AS (
    UPDATE public.sign_bulk_jobs j
       SET status = 'running', started_at = COALESCE(j.started_at, now())
     WHERE j.id IN (SELECT c.job_id FROM claimed c) AND j.status = 'queued'
    RETURNING j.id
  )
  SELECT c.* FROM claimed c;
END;
$$;
ALTER FUNCTION public.sign_bulk_claim(INTEGER, INTEGER, INTEGER, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_bulk_claim(INTEGER, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_bulk_claim(INTEGER, INTEGER, INTEGER, INTEGER) TO service_role;

-- Give claimed-but-unstarted rows back (the run ran out of time budget): not a try that counts.
CREATE OR REPLACE FUNCTION public.sign_bulk_release(p_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  UPDATE public.sign_bulk_rows
     SET claimed_until = NULL, attempts = GREATEST(attempts - 1, 0)
   WHERE id = ANY (COALESCE(p_ids, ARRAY[]::uuid[])) AND state = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
ALTER FUNCTION public.sign_bulk_release(UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_bulk_release(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_bulk_release(UUID[]) TO service_role;

-- ------------------------------------------------------------
-- 8. Stop: cancel a job, or fail/skip what has not started
--    Only rows nobody is working on (no lease, or the lease passed) are touched; a document being sent
--    right now finishes. p_job_status NULL leaves the job's own status alone (the job then closes by
--    itself once nothing is pending). Returns how many rows were changed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_bulk_stop(
  p_account    UUID,
  p_job        UUID,
  p_job_status TEXT,
  p_row_state  TEXT,
  p_code       TEXT,
  p_message    TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  IF p_row_state NOT IN ('failed', 'skipped') THEN
    RAISE EXCEPTION 'sign_bulk_bad_row_state' USING ERRCODE = '22023';
  END IF;
  IF p_job_status IS NOT NULL AND p_job_status NOT IN ('failed', 'cancelled') THEN
    RAISE EXCEPTION 'sign_bulk_bad_job_status' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sign_bulk_jobs j WHERE j.id = p_job AND j.account_id = p_account) THEN
    RAISE EXCEPTION 'sign_bulk_job_not_found' USING ERRCODE = '22023';
  END IF;

  UPDATE public.sign_bulk_rows r
     SET state = p_row_state, error_code = left(p_code, 60), error_message = left(p_message, 500)
   WHERE r.job_id = p_job AND r.account_id = p_account AND r.state = 'pending'
     AND (r.claimed_until IS NULL OR r.claimed_until < now());
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF p_job_status IS NOT NULL THEN
    UPDATE public.sign_bulk_jobs
       SET status = p_job_status, error_code = left(p_code, 60)
     WHERE id = p_job AND account_id = p_account AND status IN ('queued', 'running');
  END IF;
  PERFORM public.sign_bulk_settle(ARRAY[p_job]);
  RETURN v_n;
END;
$$;
ALTER FUNCTION public.sign_bulk_stop(UUID, UUID, TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_bulk_stop(UUID, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_bulk_stop(UUID, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
