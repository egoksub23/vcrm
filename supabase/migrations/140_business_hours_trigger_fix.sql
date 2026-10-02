-- ============================================================
-- 140: fix the business-hours trigger that broke editing an SLA schedule.
--
-- Migration 122's on_business_hours_write_incidents() is attached to BOTH
-- business_hours_schedules (AFTER UPDATE) and business_hours_holidays (AFTER
-- INSERT/UPDATE/DELETE) and read the schedule's id with
--   COALESCE(NEW.id, NEW.schedule_id, OLD.id, OLD.schedule_id)
-- PL/pgSQL resolves record fields when it plans the statement, so on the
-- schedules table `NEW.schedule_id` (a column only holidays have) raised
--   42703: record "new" has no field "schedule_id"
-- and any UPDATE of a schedule (rename, change hours, make it the default: the
-- SLA settings PATCH) failed. Holiday changes only worked because the table has
-- both columns.
--
-- The function now decides by which table fired it, in separate statements so
-- the other table's column is never planned. A holiday moved to another schedule
-- recomputes both. Behaviour for incidents is unchanged: every escalation policy
-- that uses the affected schedule has its open incidents' timers recomputed.
-- ============================================================

CREATE OR REPLACE FUNCTION public.on_business_hours_write_incidents()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_schedule_ids UUID[];
BEGIN
  IF TG_TABLE_NAME = 'business_hours_schedules' THEN
    v_schedule_ids := ARRAY[NEW.id];
  ELSIF TG_OP = 'DELETE' THEN
    v_schedule_ids := ARRAY[OLD.schedule_id];
  ELSIF TG_OP = 'INSERT' THEN
    v_schedule_ids := ARRAY[NEW.schedule_id];
  ELSE
    v_schedule_ids := ARRAY[OLD.schedule_id, NEW.schedule_id];
  END IF;

  FOR r IN
    SELECT DISTINCT account_id, severity
    FROM public.incident_escalation_policies
    WHERE schedule_id = ANY (v_schedule_ids)
  LOOP
    PERFORM public.incident_recompute_open_escalations(r.account_id, r.severity);
  END LOOP;

  -- AFTER trigger: the return value is ignored.
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.on_business_hours_write_incidents() OWNER TO postgres;
