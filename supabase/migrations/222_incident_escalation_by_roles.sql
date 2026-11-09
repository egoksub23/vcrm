-- Migration 222: escalation notices go through Roles and Rules.
--
-- Until now, when an incident was escalated (the Escalate now button, or the timed sweep) the people told came from a separate list of names, kept apart
-- from Roles (incident_escalation_recipients, migrations 116/122). With no list they were every Admin and Owner. Nobody could see or change that list from
-- the Rules screen, so a person could get an escalation email with no rule explaining why.
--
-- Now a school can write a rule for the moment of escalation: "When an incident is escalated, tell the Principal". The rule names a role, and the role's
-- members (with their away dates and backups) are told, like every other notice, and it shows in the incident's message log.
--   * New rule trigger 'escalated'.
--   * For a school with at least one enabled 'escalated' rule, escalating still raises the level and records the event, but the old name list is not
--     told as well (nobody is told twice). Every other school keeps today's behaviour exactly.
--   * The timed sweep also returns the incidents it escalated, so the rules for them can run.
-- Same bodies as migrations 122 (manual) and 211 (sweep) with those changes. Run on the Halo PostgreSQL after 221. Idempotent.

-- 1. The new trigger.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.incident_rules'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%''raised''%' AND pg_get_constraintdef(oid) ILIKE '%''closed''%'
  LOOP
    EXECUTE format('ALTER TABLE public.incident_rules DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.incident_rules DROP CONSTRAINT IF EXISTS incident_rules_trigger_check;
ALTER TABLE public.incident_rules ADD CONSTRAINT incident_rules_trigger_check
  CHECK (trigger IN ('raised', 'unacknowledged', 'step_overdue', 'unresolved', 'escalated', 'closed'));

-- 2. Does this school tell people about an escalation through its rules?
CREATE OR REPLACE FUNCTION public.incident_escalation_by_rules(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.incident_rules r WHERE r.account_id = p_account_id AND r.enabled AND r.trigger = 'escalated');
$$;

-- 3. The Escalate now button.
CREATE OR REPLACE FUNCTION public.incident_escalate_manual(p_incident_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row incidents%ROWTYPE;
  v_new_level INTEGER;
  v_recipient UUID;
  v_key TEXT;
  v_notified INTEGER := 0;
  v_notified_detail JSONB := '[]'::jsonb;
BEGIN
  SELECT * INTO v_row FROM incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incident not found' USING ERRCODE = '22023';
  END IF;
  IF NOT has_capability(v_row.account_id, 'incidents.manage') THEN
    RAISE EXCEPTION 'This action requires the incidents.manage capability' USING ERRCODE = '42501';
  END IF;
  IF v_row.escalation_level >= 3 THEN
    RAISE EXCEPTION 'Incident is already at the highest escalation level' USING ERRCODE = '22023';
  END IF;

  v_new_level := v_row.escalation_level + 1;

  UPDATE incidents
     SET escalation_level = v_new_level,
         escalation_level_entered_at = NOW()
   WHERE id = v_row.id;

  INSERT INTO incident_escalation_events (incident_id, account_id, from_level, to_level, reason, triggered_by)
  VALUES (v_row.id, v_row.account_id, v_row.escalation_level, v_new_level, 'manual', auth.uid());

  v_key := 'INC-' || to_char(v_row.created_at, 'YYYY') || '-' || v_row.incident_number;

  -- A school with an 'escalated' rule tells people through its roles (the app runs those rules next); the old name list is left out.
  IF NOT public.incident_escalation_by_rules(v_row.account_id) THEN
    FOR v_recipient IN SELECT * FROM incident_escalation_recipient_ids(v_row.account_id, v_new_level) LOOP
      INSERT INTO notifications (account_id, user_id, type, incident_id, actor_user_id, title, body)
      VALUES (
        v_row.account_id, v_recipient, 'incident_escalated', v_row.id, auth.uid(),
        'Incident escalated to level ' || v_new_level,
        v_key || ' (' || v_row.severity || ') — ' || v_row.title || ' was manually escalated to level ' || v_new_level
      );
      v_notified := v_notified + 1;
      v_notified_detail := v_notified_detail || jsonb_build_object(
        'user_id', v_recipient, 'account_id', v_row.account_id, 'incident_id', v_row.id,
        'key', v_key, 'severity', v_row.severity, 'title', v_row.title, 'level', v_new_level
      );
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'escalation_level', v_new_level, 'notifications', v_notified, 'notified', v_notified_detail
  );
END;
$$;

-- 4. The timed sweep.
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
  v_escalated_detail JSONB := '[]'::jsonb;
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
           AND NOT EXISTS (
             SELECT 1 FROM public.incident_rules r
              WHERE r.account_id = y.account_id AND r.enabled AND r.trigger = 'unacknowledged'
           )
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
    v_escalated_detail := v_escalated_detail || jsonb_build_object('incident_id', v_row.id, 'account_id', v_row.account_id, 'level', v_new_level);
    v_key := 'INC-' || to_char(v_row.created_at, 'YYYY') || '-' || v_row.incident_number;

    IF NOT public.incident_escalation_by_rules(v_row.account_id) THEN
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
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'escalated', v_escalated, 'notifications', v_notified, 'notified', v_notified_detail, 'escalated_incidents', v_escalated_detail
  );
END;
$$;
REVOKE ALL ON FUNCTION public.incident_escalation_sweep(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.incident_escalation_sweep(INTEGER) TO service_role;

NOTIFY pgrst, 'reload schema';
