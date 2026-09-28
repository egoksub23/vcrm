-- ============================================================
-- 117_incident_escalation_email_hook.sql
--
-- incident_escalation_sweep() (migration 116) already inserts the
-- in-app notification rows and picks recipients; Postgres cannot make
-- the HTTP call Resend needs, so this widens its jsonb return with a
-- `notified` array (user_id/account_id/incident_id/key/severity/title/
-- level per recipient) that GET /api/incidents/escalation-cron reads
-- to send the matching email, best-effort, after the sweep commits.
-- Same shape addition to incident_escalate_manual() for the manual
-- "Escalate now" action.
--
-- Idempotent — safe to run more than once.
-- ============================================================

CREATE OR REPLACE FUNCTION public.incident_escalation_sweep(p_limit INTEGER DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_threshold INTEGER;
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
    WHERE i.status = 'reported'
      AND i.escalation_level < 3
    ORDER BY i.escalation_level_entered_at
    LIMIT GREATEST(LEAST(p_limit, 500), 0)
    FOR UPDATE SKIP LOCKED
  LOOP
    v_threshold := COALESCE(
      (SELECT CASE WHEN v_row.escalation_level = 1 THEN level_1_minutes ELSE level_2_minutes END
         FROM incident_escalation_policies
        WHERE account_id = v_row.account_id AND severity = v_row.severity),
      incident_escalation_default_minutes(v_row.severity, v_row.escalation_level)
    );

    IF NOW() - v_row.escalation_level_entered_at <= make_interval(mins => v_threshold) THEN
      CONTINUE;
    END IF;

    v_new_level := v_row.escalation_level + 1;

    UPDATE incidents
       SET escalation_level = v_new_level,
           escalation_level_entered_at = NOW()
     WHERE id = v_row.id;

    INSERT INTO incident_escalation_events (incident_id, account_id, from_level, to_level, reason)
    VALUES (v_row.id, v_row.account_id, v_row.escalation_level, v_new_level, 'auto_timeout');

    v_escalated := v_escalated + 1;

    v_key := 'INC-' || to_char(v_row.created_at, 'YYYY') || '-' || v_row.incident_number;

    FOR v_recipient IN
      SELECT p.user_id FROM profiles p
       WHERE p.account_id = v_row.account_id
         AND p.account_role = (CASE WHEN v_new_level = 2 THEN 'admin' ELSE 'owner' END)::account_role_enum
    LOOP
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

  FOR v_recipient IN
    SELECT p.user_id FROM profiles p
     WHERE p.account_id = v_row.account_id
       AND p.account_role = (CASE WHEN v_new_level = 2 THEN 'admin' ELSE 'owner' END)::account_role_enum
  LOOP
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

  RETURN jsonb_build_object(
    'escalation_level', v_new_level, 'notifications', v_notified, 'notified', v_notified_detail
  );
END;
$$;
