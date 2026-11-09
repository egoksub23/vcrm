-- Migration 223: findings, file removal and "nobody could be told" in the incident record.
--
-- 1. The incident's activity trail records two more things: the root cause being written or changed ('root_cause_changed', by the existing trigger) and a
--    file being deleted ('file_deleted', written by the app when someone deletes evidence).
-- 2. "Nobody acknowledged" now also catches an incident where no notice asking for acknowledgement ever went out (for example the role it was meant for
--    has nobody in it, or the person has no email address). Until now such an incident never started the timer and so never escalated. The wait is
--    counted from when it was raised. Test incidents are left out.
-- Same bodies as migrations 116 (trigger) and 209 (sweep function) with those changes. Run on the Halo PostgreSQL after 222. Idempotent.

-- 1. More kinds of activity.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.incident_activity'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%event_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.incident_activity DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.incident_activity ADD CONSTRAINT incident_activity_event_type_check
  CHECK (event_type IN ('created', 'status_changed', 'severity_changed', 'type_changed', 'lead_changed', 'escalated', 'closed', 'root_cause_changed', 'file_deleted'));

CREATE OR REPLACE FUNCTION public.log_incident_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'status_changed', OLD.status, NEW.status);
    IF NEW.status = 'closed' THEN
      INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, to_value)
      VALUES (NEW.id, NEW.account_id, auth.uid(), 'closed', NEW.status);
    END IF;
  END IF;

  IF NEW.severity IS DISTINCT FROM OLD.severity THEN
    INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'severity_changed', OLD.severity, NEW.severity);
  END IF;

  IF NEW.incident_type IS DISTINCT FROM OLD.incident_type THEN
    INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'type_changed', OLD.incident_type, NEW.incident_type);
  END IF;

  IF NEW.incident_lead_id IS DISTINCT FROM OLD.incident_lead_id THEN
    INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (
      NEW.id, NEW.account_id, auth.uid(), 'lead_changed',
      OLD.incident_lead_id::text, NEW.incident_lead_id::text
    );
  END IF;

  IF NEW.root_cause IS DISTINCT FROM OLD.root_cause THEN
    INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'root_cause_changed', left(COALESCE(NEW.root_cause, ''), 500));
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log incident activity for incident %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
-- (No OWNER change: this database has no "postgres" role, and the function keeps the owner it is created with.)

-- 2. Incidents nobody has acknowledged: the first notice that asked for acknowledgement went out at or before p_before, or none ever did and the
-- incident itself is that old.
CREATE OR REPLACE FUNCTION public.incident_unacknowledged(p_account_id UUID, p_before TIMESTAMPTZ, p_limit INTEGER DEFAULT 100)
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
     AND COALESCE(s.first_ask_at, i.created_at) <= p_before
   ORDER BY COALESCE(s.first_ask_at, i.created_at)
   LIMIT GREATEST(p_limit, 1);
$$;
REVOKE ALL ON FUNCTION public.incident_unacknowledged(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.incident_unacknowledged(UUID, TIMESTAMPTZ, INTEGER) TO service_role;

NOTIFY pgrst, 'reload schema';
