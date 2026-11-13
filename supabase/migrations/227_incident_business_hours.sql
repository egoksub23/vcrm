-- Migration 227: business hours for the timed rules.
--
-- A school can pick one of its business-hours schedules (the same ones ticket SLAs use: working days, hours, time zone and holidays). When it does, the waits
-- on timed rules count only inside those hours: "nobody acknowledged within 30 minutes" raised at 16:50 on a Friday is not due until Monday morning, not on
-- Friday at 17:20. This covers the three timed rules (nobody acknowledged, a required step overdue, still open). Required-step deadlines themselves are
-- still counted in elapsed hours.
-- The three sweep functions get two optional arguments (the schedule and the wait in seconds). With no schedule they behave exactly as before.
-- Run on the Halo PostgreSQL after 226. Idempotent.

ALTER TABLE public.incident_settings ADD COLUMN IF NOT EXISTS business_hours_schedule_id UUID REFERENCES public.business_hours_schedules(id) ON DELETE SET NULL;

-- The old three-argument versions go, so a call with named arguments cannot match two functions.
DROP FUNCTION IF EXISTS public.incident_unacknowledged(UUID, TIMESTAMPTZ, INTEGER);
DROP FUNCTION IF EXISTS public.incident_overdue_steps(UUID, TIMESTAMPTZ, INTEGER);
DROP FUNCTION IF EXISTS public.incident_unresolved(UUID, TIMESTAMPTZ, INTEGER);

-- Incidents nobody has acknowledged: the first notice that asked for acknowledgement went out (or, if none ever did, the incident was raised) long enough ago.
CREATE OR REPLACE FUNCTION public.incident_unacknowledged(
  p_account_id UUID, p_before TIMESTAMPTZ, p_limit INTEGER DEFAULT 100, p_schedule UUID DEFAULT NULL, p_wait_seconds BIGINT DEFAULT 0
)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id
    FROM public.incidents i
    LEFT JOIN public.incident_ack_state s ON s.incident_id = i.id
   WHERE i.account_id = p_account_id
     AND i.status = 'reported'
     AND NOT i.is_test
     AND i.created_at > now() - interval '60 days'
     AND NOT COALESCE(s.acknowledged, FALSE)
     AND CASE
           WHEN p_schedule IS NULL THEN COALESCE(s.first_ask_at, i.created_at) <= p_before
           ELSE public.sla_add_business_seconds(p_schedule, COALESCE(s.first_ask_at, i.created_at), p_wait_seconds) <= now()
         END
   ORDER BY COALESCE(s.first_ask_at, i.created_at)
   LIMIT GREATEST(p_limit, 1);
$$;

-- Open required steps that are overdue by the wait, on incidents that are still open.
CREATE OR REPLACE FUNCTION public.incident_overdue_steps(
  p_account_id UUID, p_before TIMESTAMPTZ, p_limit INTEGER DEFAULT 100, p_schedule UUID DEFAULT NULL, p_wait_seconds BIGINT DEFAULT 0
)
RETURNS TABLE (obligation_id UUID, incident_id UUID, party TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.incident_id, o.party
    FROM public.incident_obligations o
    JOIN public.incidents i ON i.id = o.incident_id
   WHERE o.account_id = p_account_id
     AND o.status = 'open'
     AND o.due_at IS NOT NULL
     AND CASE
           WHEN p_schedule IS NULL THEN o.due_at <= p_before
           ELSE public.sla_add_business_seconds(p_schedule, o.due_at, p_wait_seconds) <= now()
         END
     AND i.status <> 'closed'
     AND i.created_at > now() - interval '180 days'
   ORDER BY o.due_at
   LIMIT GREATEST(p_limit, 1);
$$;

-- Incidents still open that were raised long enough ago: the "resolve by" timer.
CREATE OR REPLACE FUNCTION public.incident_unresolved(
  p_account_id UUID, p_before TIMESTAMPTZ, p_limit INTEGER DEFAULT 100, p_schedule UUID DEFAULT NULL, p_wait_seconds BIGINT DEFAULT 0
)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id
    FROM public.incidents i
   WHERE i.account_id = p_account_id
     AND i.status <> 'closed'
     AND CASE
           WHEN p_schedule IS NULL THEN i.created_at <= p_before
           ELSE public.sla_add_business_seconds(p_schedule, i.created_at, p_wait_seconds) <= now()
         END
     AND i.created_at > now() - interval '365 days'
     AND NOT i.is_test
   ORDER BY i.created_at
   LIMIT GREATEST(p_limit, 1);
$$;

REVOKE ALL ON FUNCTION public.incident_unacknowledged(UUID, TIMESTAMPTZ, INTEGER, UUID, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.incident_overdue_steps(UUID, TIMESTAMPTZ, INTEGER, UUID, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.incident_unresolved(UUID, TIMESTAMPTZ, INTEGER, UUID, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.incident_unacknowledged(UUID, TIMESTAMPTZ, INTEGER, UUID, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.incident_overdue_steps(UUID, TIMESTAMPTZ, INTEGER, UUID, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.incident_unresolved(UUID, TIMESTAMPTZ, INTEGER, UUID, BIGINT) TO service_role;

NOTIFY pgrst, 'reload schema';
