-- Migration 211: escalation by role chains replaces the fixed level sweep for schools that use rules.
--
-- Until now an unacknowledged incident moved up a level on a fixed timer and told every Admin (level 2) and the Owner (level 3). Schools that switch on a
-- "nobody acknowledged" rule (migration 209) now escalate through the rules engine instead: the rule names the role to tell and the wait. For those
-- schools this function skips the incident, so nobody is told twice. Every other school keeps the old behaviour exactly as it was.
-- Same body as migration 135, with one extra condition. Run on the Halo PostgreSQL after 210. Idempotent.

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

-- Keep the escalation event log complete when the rules engine moves an incident up a level (it writes a row, as the sweep does).
ALTER TABLE public.incident_escalation_events DROP CONSTRAINT IF EXISTS incident_escalation_events_reason_check;
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.incident_escalation_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%reason%'
  LOOP
    EXECUTE format('ALTER TABLE public.incident_escalation_events DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.incident_escalation_events ADD CONSTRAINT incident_escalation_events_reason_check
  CHECK (reason IN ('auto_timeout', 'manual', 'rule'));

NOTIFY pgrst, 'reload schema';
