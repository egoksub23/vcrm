-- ============================================================
-- 135_fair_background_jobs.sql
--
-- Background jobs that are fair between workspaces, safe to overlap or
-- crash, and that leave a suspended workspace alone. Audit item A1.
--
-- Before: every sweep took "the oldest N rows across everyone", so one
-- busy workspace could starve the rest; the automations drain claimed rows
-- as 'running' with no lease (a crash stranded them for ever); and
-- nothing looked at whether a workspace was suspended (migration 132).
--
-- This migration:
--   * account_is_active(): the one place that answers "may background
--     work run for this workspace".
--   * automation_claim_pending() / automation_release_pending(): a
--     round-robin, leased claim. Each workspace gets a fair share of every
--     batch; a row whose lease expired is failed visibly rather than run
--     again (its steps may have partly run, and a customer message must
--     not be sent twice).
--   * conversation_sla_candidates(): the breached-conversation scan moves
--     into the database (breach test, suspension, per-workspace cap),
--     replacing "load every waiting conversation and loop".
--   * sla_sweep, incident_escalation_sweep, jira_claim_jobs: same logic as
--     before, now picking round-robin across workspaces and skipping
--     suspended ones.
--   * cron_heartbeats + cron_heartbeat() + platform_cron_status(): every
--     job records when it last ran, so a job that silently stopped (a
--     missing crontab line) shows up in the operator console.
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Is background work allowed for this workspace?
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_is_active(p_account UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.account_platform ap
     WHERE ap.account_id = p_account AND ap.status = 'suspended'
  );
$$;
ALTER FUNCTION public.account_is_active(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_is_active(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_is_active(UUID) TO service_role;

-- ------------------------------------------------------------
-- 2. Automations "wait" steps: fair, leased claim
-- ------------------------------------------------------------
ALTER TABLE public.automation_pending_executions
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.automation_claim_pending(
  p_limit         INTEGER DEFAULT 50,
  p_per_account   INTEGER DEFAULT 10,
  p_lease_seconds INTEGER DEFAULT 600
)
RETURNS SETOF public.automation_pending_executions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  p_limit := GREATEST(1, LEAST(COALESCE(p_limit, 50), 500));
  p_per_account := GREATEST(1, LEAST(COALESCE(p_per_account, 10), p_limit));

  -- A row still 'running' after its lease (or, for rows claimed before
  -- leases existed, long past its run time) is not run again: its steps
  -- may have partly run. It is marked failed so it is visible, and the
  -- log it belongs to records why.
  WITH expired AS (
    UPDATE public.automation_pending_executions e
       SET status = 'failed'
     WHERE e.status = 'running'
       AND ((e.locked_until IS NOT NULL AND e.locked_until < now())
         OR (e.locked_until IS NULL AND e.run_at < now() - interval '1 hour'))
    RETURNING e.log_id
  )
  UPDATE public.automation_logs l
     SET status = 'failed',
         error_message = COALESCE(l.error_message, 'A delayed step did not finish and was not retried')
   WHERE l.id IN (SELECT log_id FROM expired WHERE log_id IS NOT NULL)
     AND l.status <> 'failed';

  RETURN QUERY
  WITH due AS (
    SELECT e.id, e.run_at,
           row_number() OVER (PARTITION BY e.account_id ORDER BY e.run_at, e.id) AS rn
      FROM public.automation_pending_executions e
     WHERE e.status = 'pending'
       AND e.run_at <= now()
       AND public.account_is_active(e.account_id)
  ), fair AS (
    SELECT d.id FROM due d
     WHERE d.rn <= p_per_account
     ORDER BY d.rn, d.run_at, d.id
     LIMIT p_limit
  ), picked AS (
    SELECT e.id FROM public.automation_pending_executions e
     WHERE e.id IN (SELECT id FROM fair) AND e.status = 'pending'
       FOR UPDATE SKIP LOCKED
  )
  UPDATE public.automation_pending_executions e
     SET status = 'running',
         locked_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 600), 30))
    FROM picked
   WHERE e.id = picked.id
  RETURNING e.*;
END;
$$;
ALTER FUNCTION public.automation_claim_pending(INTEGER, INTEGER, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_claim_pending(INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_claim_pending(INTEGER, INTEGER, INTEGER) TO service_role;

-- Give claimed-but-unstarted rows back (the run ran out of time budget).
CREATE OR REPLACE FUNCTION public.automation_release_pending(p_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  UPDATE public.automation_pending_executions
     SET status = 'pending', locked_until = NULL
   WHERE id = ANY (COALESCE(p_ids, ARRAY[]::uuid[])) AND status = 'running';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
ALTER FUNCTION public.automation_release_pending(UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_release_pending(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_release_pending(UUID[]) TO service_role;

-- ------------------------------------------------------------
-- 3. Conversation SLA: the breached-conversation scan, in the database
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.conversation_sla_candidates(
  p_limit       INTEGER DEFAULT 500,
  p_per_account INTEGER DEFAULT 100
)
RETURNS TABLE (
  id                       UUID,
  account_id               UUID,
  contact_id               UUID,
  assigned_agent_id        UUID,
  last_customer_message_at TIMESTAMPTZ,
  sla_minutes              INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT q.id, q.account_id, q.contact_id, q.assigned_agent_id, q.last_customer_message_at, q.sla_minutes
    FROM (
      SELECT c.id, c.account_id, c.contact_id, c.assigned_agent_id, c.last_customer_message_at,
             a.sla_response_minutes AS sla_minutes,
             row_number() OVER (PARTITION BY c.account_id ORDER BY c.last_customer_message_at, c.id) AS rn
        FROM public.conversations c
        JOIN public.accounts a ON a.id = c.account_id
       WHERE c.awaiting_response = true
         AND c.sla_notified_at IS NULL
         AND c.status <> 'closed'
         AND c.last_customer_message_at IS NOT NULL
         AND c.last_customer_message_at <= now() - make_interval(mins => a.sla_response_minutes)
         AND public.account_is_active(c.account_id)
    ) q
   WHERE q.rn <= GREATEST(1, LEAST(COALESCE(p_per_account, 100), 1000))
   ORDER BY q.rn, q.last_customer_message_at, q.id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
$$;
ALTER FUNCTION public.conversation_sla_candidates(INTEGER, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.conversation_sla_candidates(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_sla_candidates(INTEGER, INTEGER) TO service_role;

-- ------------------------------------------------------------
-- 4. Ticket SLA sweep (086): same behaviour, fair and skipping suspended
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sla_sweep(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now      TIMESTAMPTZ := now();
  v_breached INTEGER := 0;
  v_notified INTEGER := 0;
  v_tickets  INTEGER := 0;
  r          RECORD;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN p_limit := 200; END IF;
  IF p_limit > 1000 THEN p_limit := 1000; END IF;
  PERFORM set_config('vircle.sla_internal', 'on', true);

  -- 1. breach marking (round-robin across workspaces)
  UPDATE tickets t
     SET sla_first_response_state = CASE
           WHEN t.sla_first_response_state = 'running' AND t.sla_first_response_due_at < v_now
           THEN 'breached' ELSE t.sla_first_response_state END,
         sla_resolution_state = CASE
           WHEN t.sla_resolution_state = 'running' AND t.sla_resolution_due_at < v_now
           THEN 'breached' ELSE t.sla_resolution_state END,
         sla_evaluated_at = v_now
   WHERE t.id IN (
     SELECT x.id FROM tickets x
      WHERE x.id IN (
        SELECT q.id FROM (
          SELECT y.id, row_number() OVER (PARTITION BY y.account_id ORDER BY y.id) AS rn
            FROM tickets y
           WHERE y.status IN ('open', 'in_progress', 'pending')
             AND ((y.sla_first_response_state = 'running' AND y.sla_first_response_due_at < v_now)
               OR (y.sla_resolution_state = 'running' AND y.sla_resolution_due_at < v_now))
             AND public.account_is_active(y.account_id)
        ) q ORDER BY q.rn, q.id LIMIT p_limit)
      FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_breached = ROW_COUNT;

  -- 2. notifications, once per ticket, target and kind
  FOR r IN
    SELECT x.id
      FROM tickets x
     WHERE x.id IN (
       SELECT q.id FROM (
         SELECT y.id, row_number() OVER (PARTITION BY y.account_id ORDER BY y.id) AS rn
           FROM tickets y
          WHERE y.status IN ('open', 'in_progress', 'pending')
            AND ((y.sla_first_response_state = 'breached' AND y.sla_fr_breach_notified_at IS NULL)
              OR (y.sla_resolution_state = 'breached' AND y.sla_res_breach_notified_at IS NULL)
              OR (y.sla_first_response_state = 'running' AND y.sla_first_response_risk_at <= v_now
                  AND y.sla_fr_risk_notified_at IS NULL)
              OR (y.sla_resolution_state = 'running' AND y.sla_resolution_risk_at <= v_now
                  AND y.sla_res_risk_notified_at IS NULL))
            AND public.account_is_active(y.account_id)
       ) q ORDER BY q.rn, q.id LIMIT p_limit)
     FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      v_tickets := v_tickets + 1;
      -- first response
      IF EXISTS (SELECT 1 FROM tickets WHERE id = r.id
                  AND sla_first_response_state = 'breached' AND sla_fr_breach_notified_at IS NULL) THEN
        v_notified := v_notified + sla_notify_ticket(r.id, 'first_response', 'breached');
        UPDATE tickets SET sla_fr_breach_notified_at = v_now,
                           sla_fr_risk_notified_at = COALESCE(sla_fr_risk_notified_at, v_now)
         WHERE id = r.id;
      ELSIF EXISTS (SELECT 1 FROM tickets WHERE id = r.id
                     AND sla_first_response_state = 'running' AND sla_first_response_risk_at <= v_now
                     AND sla_fr_risk_notified_at IS NULL) THEN
        v_notified := v_notified + sla_notify_ticket(r.id, 'first_response', 'at_risk');
        UPDATE tickets SET sla_fr_risk_notified_at = v_now WHERE id = r.id;
      END IF;
      -- resolution
      IF EXISTS (SELECT 1 FROM tickets WHERE id = r.id
                  AND sla_resolution_state = 'breached' AND sla_res_breach_notified_at IS NULL) THEN
        v_notified := v_notified + sla_notify_ticket(r.id, 'resolution', 'breached');
        UPDATE tickets SET sla_res_breach_notified_at = v_now,
                           sla_res_risk_notified_at = COALESCE(sla_res_risk_notified_at, v_now)
         WHERE id = r.id;
      ELSIF EXISTS (SELECT 1 FROM tickets WHERE id = r.id
                     AND sla_resolution_state = 'running' AND sla_resolution_risk_at <= v_now
                     AND sla_res_risk_notified_at IS NULL) THEN
        v_notified := v_notified + sla_notify_ticket(r.id, 'resolution', 'at_risk');
        UPDATE tickets SET sla_res_risk_notified_at = v_now WHERE id = r.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'sla_sweep: ticket % skipped: %', r.id, SQLERRM;
    END;
  END LOOP;

  PERFORM set_config('vircle.sla_internal', '', true);
  RETURN jsonb_build_object('breached', v_breached, 'tickets_notified', v_tickets, 'notifications', v_notified);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vircle.sla_internal', '', true);
  RAISE;
END;
$$;
REVOKE ALL ON FUNCTION public.sla_sweep(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sla_sweep(integer) TO service_role;

-- ------------------------------------------------------------
-- 5. Incident escalation sweep (122): fair and skipping suspended
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.incident_escalation_sweep(p_limit INTEGER DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_new_level INTEGER;
  v_escalated INTEGER := 0;
  v_notified INTEGER := 0;
  v_recipient UUID;
  v_key TEXT;
  v_notified_detail JSONB := '[]'::jsonb;
BEGIN
  FOR v_row IN
    SELECT i.*
    FROM incidents i
    WHERE i.id IN (
      SELECT q.id FROM (
        SELECT y.id, y.next_escalation_due_at,
               row_number() OVER (PARTITION BY y.account_id ORDER BY y.next_escalation_due_at, y.id) AS rn
          FROM incidents y
         WHERE y.status = 'reported'
           AND y.escalation_level < 3
           AND y.next_escalation_due_at IS NOT NULL
           AND y.next_escalation_due_at < NOW()
           AND public.account_is_active(y.account_id)
      ) q
      ORDER BY q.rn, q.next_escalation_due_at, q.id
      LIMIT GREATEST(LEAST(p_limit, 500), 0)
    )
    FOR UPDATE SKIP LOCKED
  LOOP
    v_new_level := v_row.escalation_level + 1;

    UPDATE incidents
       SET escalation_level = v_new_level,
           escalation_level_entered_at = NOW()
     WHERE id = v_row.id;

    INSERT INTO incident_escalation_events (incident_id, account_id, from_level, to_level, reason)
    VALUES (v_row.id, v_row.account_id, v_row.escalation_level, v_new_level, 'auto_timeout');

    v_escalated := v_escalated + 1;
    v_key := 'INC-' || to_char(v_row.created_at, 'YYYY') || '-' || v_row.incident_number;

    FOR v_recipient IN SELECT * FROM incident_escalation_recipient_ids(v_row.account_id, v_new_level) LOOP
      INSERT INTO notifications (account_id, user_id, type, incident_id, title, body)
      VALUES (
        v_row.account_id, v_recipient, 'incident_escalated', v_row.id,
        'Incident escalated to level ' || v_new_level,
        v_key || ' (' || v_row.severity || ') — ' || v_row.title
          || ' has been unacknowledged and was escalated to level ' || v_new_level
      );
      v_notified := v_notified + 1;
      v_notified_detail := v_notified_detail || jsonb_build_object(
        'user_id', v_recipient, 'account_id', v_row.account_id, 'incident_id', v_row.id,
        'key', v_key, 'severity', v_row.severity, 'title', v_row.title, 'level', v_new_level
      );
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'escalated', v_escalated, 'notifications', v_notified, 'notified', v_notified_detail
  );
END;
$$;
REVOKE ALL ON FUNCTION public.incident_escalation_sweep(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.incident_escalation_sweep(INTEGER) TO service_role;

-- ------------------------------------------------------------
-- 6. Jira job claim (085): fair and skipping suspended
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jira_claim_jobs(
  p_limit         integer,
  p_worker        text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS SETOF public.jira_sync_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE jira_sync_jobs
     SET status = 'dead', finished_at = now(),
         last_error = COALESCE(last_error, 'lease expired after the last attempt')
   WHERE status = 'running' AND locked_until < now() AND attempts >= max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT j.id, j.next_try_at, j.created_at,
           row_number() OVER (PARTITION BY j.account_id ORDER BY j.next_try_at, j.created_at) AS rn
      FROM jira_sync_jobs j
     WHERE ((j.status = 'pending' AND j.next_try_at <= now())
         OR (j.status = 'running' AND j.locked_until < now()))
       AND public.account_is_active(j.account_id)
  ), fair AS (
    SELECT d.id FROM due d
     ORDER BY d.rn, d.next_try_at, d.created_at
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 10), 50))
  ), picked AS (
    SELECT j.id FROM jira_sync_jobs j
     WHERE j.id IN (SELECT id FROM fair)
       AND ((j.status = 'pending' AND j.next_try_at <= now())
         OR (j.status = 'running' AND j.locked_until < now()))
       FOR UPDATE SKIP LOCKED
  )
  UPDATE jira_sync_jobs j
     SET status = 'running',
         attempts = j.attempts + 1,
         locked_by = p_worker,
         locked_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 120), 10)),
         updated_at = now()
    FROM picked
   WHERE j.id = picked.id
  RETURNING j.*;
END;
$$;
REVOKE ALL ON FUNCTION public.jira_claim_jobs(integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jira_claim_jobs(integer, text, integer) TO service_role;

-- ------------------------------------------------------------
-- 7. Heartbeats: when did each job last run?
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cron_heartbeats (
  job              TEXT PRIMARY KEY,
  expected_seconds INTEGER NOT NULL CHECK (expected_seconds > 0),
  last_run_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_duration_ms INTEGER,
  last_status      TEXT NOT NULL DEFAULT 'ok' CHECK (last_status IN ('ok', 'error')),
  last_result      JSONB,
  last_ok_at       TIMESTAMPTZ,
  runs             BIGINT NOT NULL DEFAULT 1
);
ALTER TABLE public.cron_heartbeats ENABLE ROW LEVEL SECURITY;
-- No policies: written by the jobs (service role), read through platform_cron_status().

CREATE OR REPLACE FUNCTION public.cron_heartbeat(
  p_job              TEXT,
  p_expected_seconds INTEGER,
  p_duration_ms      INTEGER,
  p_status           TEXT,
  p_result           JSONB DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('ok', 'error') THEN
    RAISE EXCEPTION 'status must be ok or error' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.cron_heartbeats AS h
    (job, expected_seconds, last_run_at, last_duration_ms, last_status, last_result, last_ok_at)
  VALUES (p_job, GREATEST(p_expected_seconds, 1), NOW(), p_duration_ms, p_status, p_result,
          CASE WHEN p_status = 'ok' THEN NOW() END)
  ON CONFLICT (job) DO UPDATE
     SET expected_seconds = EXCLUDED.expected_seconds,
         last_run_at      = NOW(),
         last_duration_ms = EXCLUDED.last_duration_ms,
         last_status      = EXCLUDED.last_status,
         last_result      = EXCLUDED.last_result,
         last_ok_at       = CASE WHEN EXCLUDED.last_status = 'ok' THEN NOW() ELSE h.last_ok_at END,
         runs             = h.runs + 1;
END;
$$;
ALTER FUNCTION public.cron_heartbeat(TEXT, INTEGER, INTEGER, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cron_heartbeat(TEXT, INTEGER, INTEGER, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_heartbeat(TEXT, INTEGER, INTEGER, TEXT, JSONB) TO service_role;

-- The operator view. A job is "late" once it has not run for three
-- intervals (or has never been seen, which the console shows from its
-- own list of expected jobs).
CREATE OR REPLACE FUNCTION public.platform_cron_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.platform_require_admin();
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'job', h.job,
             'expected_seconds', h.expected_seconds,
             'last_run_at', h.last_run_at,
             'last_ok_at', h.last_ok_at,
             'last_status', h.last_status,
             'last_duration_ms', h.last_duration_ms,
             'last_result', h.last_result,
             'late', h.last_run_at < NOW() - make_interval(secs => h.expected_seconds * 3)
           ) ORDER BY h.job)
      FROM public.cron_heartbeats h
  ), '[]'::jsonb);
END;
$$;
ALTER FUNCTION public.platform_cron_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_cron_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_cron_status() TO authenticated, service_role;
