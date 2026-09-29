-- ============================================================
-- Incident escalation v2 — business-day-aware timers and
-- per-account-configurable escalation recipients. Both deliberately
-- out-of-scope items from the original plan (116), now built together
-- since both rewrite incident_escalation_sweep()/incident_escalate_manual().
--
-- Part 1 — business-day-aware timers: mirrors ticket SLA's own pattern
-- (086) exactly — a precomputed due TIMESTAMPTZ column, restamped by
-- trigger whenever the inputs change, so the sweep stays a flat
-- `due_at < now()` scan instead of walking business hours on every
-- cron tick. Reuses sla_add_business_seconds()/business_hours_schedules
-- as-is — no second business-hours system.
--
-- Part 2 — configurable recipients: incident_escalation_sweep() and
-- incident_escalate_manual() both picked level-2/3 recipients by a
-- literal `account_role = 'admin'/'owner'` match. This silently
-- excludes a Compliance Officer custom role (base_role='agent' +
-- incidents.manage capability) from ever being notified at level 2/3,
-- even though notify_incident_raised() (level 1) already correctly
-- falls through to capability holders. Fixed here: a new
-- incident_escalation_recipients override table, falling back — when
-- empty — to admin/owner UNION incidents.manage capability holders
-- (fixing the bug), not just literal role match.
-- ============================================================

-- ------------------------------------------------------------
-- 1. incident_escalation_policies: business-hours schedule link.
-- ------------------------------------------------------------
ALTER TABLE public.incident_escalation_policies
  ADD COLUMN IF NOT EXISTS schedule_id UUID REFERENCES public.business_hours_schedules(id) ON DELETE RESTRICT;

-- ------------------------------------------------------------
-- 2. incidents: precomputed "when does the current level time out."
-- ------------------------------------------------------------
ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS next_escalation_due_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_incidents_escalation_due
  ON public.incidents (next_escalation_due_at)
  WHERE status = 'reported' AND escalation_level < 3;

CREATE OR REPLACE FUNCTION public.incident_next_escalation_due(
  p_account_id UUID, p_severity TEXT, p_level INTEGER, p_from TIMESTAMPTZ
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_schedule UUID;
  v_minutes  INTEGER;
BEGIN
  SELECT schedule_id,
         CASE WHEN p_level = 1 THEN level_1_minutes ELSE level_2_minutes END
    INTO v_schedule, v_minutes
    FROM incident_escalation_policies
   WHERE account_id = p_account_id AND severity = p_severity;

  IF v_minutes IS NULL THEN
    v_minutes := incident_escalation_default_minutes(p_severity, p_level);
    v_schedule := NULL; -- no policy row -> no schedule override either -> 24/7 fallback
  END IF;

  RETURN public.sla_add_business_seconds(v_schedule, p_from, v_minutes::bigint * 60);
END;
$$;

CREATE OR REPLACE FUNCTION public.incident_stamp_escalation_due()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'reported' AND NEW.escalation_level < 3 THEN
    NEW.next_escalation_due_at := public.incident_next_escalation_due(
      NEW.account_id, NEW.severity, NEW.escalation_level, NEW.escalation_level_entered_at);
  ELSE
    NEW.next_escalation_due_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_incident_stamp_escalation_due ON public.incidents;
CREATE TRIGGER on_incident_stamp_escalation_due
  BEFORE INSERT OR UPDATE OF escalation_level, escalation_level_entered_at, severity, status ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.incident_stamp_escalation_due();

-- Backfill existing open incidents so the sweep has a due timestamp to scan
-- immediately after this migration, rather than waiting for their next
-- level/severity/status change.
UPDATE public.incidents
   SET next_escalation_due_at = public.incident_next_escalation_due(account_id, severity, escalation_level, escalation_level_entered_at)
 WHERE status = 'reported' AND escalation_level < 3;

-- ------------------------------------------------------------
-- 3. Policy/schedule edits ripple to every open incident under them.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.incident_recompute_open_escalations(p_account_id UUID, p_severity TEXT DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INTEGER;
BEGIN
  UPDATE public.incidents i
     SET next_escalation_due_at = public.incident_next_escalation_due(
           i.account_id, i.severity, i.escalation_level, i.escalation_level_entered_at)
   WHERE i.account_id = p_account_id AND i.status = 'reported' AND i.escalation_level < 3
     AND (p_severity IS NULL OR i.severity = p_severity);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
ALTER FUNCTION public.incident_recompute_open_escalations(UUID, TEXT) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.on_incident_escalation_policy_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.incident_recompute_open_escalations(NEW.account_id, NEW.severity);
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.on_incident_escalation_policy_write() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_incident_escalation_policy_write ON public.incident_escalation_policies;
CREATE TRIGGER on_incident_escalation_policy_write
  AFTER INSERT OR UPDATE ON public.incident_escalation_policies
  FOR EACH ROW EXECUTE FUNCTION public.on_incident_escalation_policy_write();

CREATE OR REPLACE FUNCTION public.on_incident_escalation_policy_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.incident_recompute_open_escalations(OLD.account_id, OLD.severity);
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.on_incident_escalation_policy_delete() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_incident_escalation_policy_delete ON public.incident_escalation_policies;
CREATE TRIGGER on_incident_escalation_policy_delete
  AFTER DELETE ON public.incident_escalation_policies
  FOR EACH ROW EXECUTE FUNCTION public.on_incident_escalation_policy_delete();

-- A business-hours schedule/holiday edit ripples to every incident policy
-- that references that schedule.
CREATE OR REPLACE FUNCTION public.on_business_hours_write_incidents()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_schedule_id UUID;
BEGIN
  v_schedule_id := COALESCE(NEW.id, NEW.schedule_id, OLD.id, OLD.schedule_id);
  FOR r IN SELECT account_id, severity FROM public.incident_escalation_policies WHERE schedule_id = v_schedule_id LOOP
    PERFORM public.incident_recompute_open_escalations(r.account_id, r.severity);
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END;
$$;
ALTER FUNCTION public.on_business_hours_write_incidents() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_bh_schedule_write_incidents ON public.business_hours_schedules;
CREATE TRIGGER on_bh_schedule_write_incidents
  AFTER UPDATE ON public.business_hours_schedules
  FOR EACH ROW EXECUTE FUNCTION public.on_business_hours_write_incidents();

DROP TRIGGER IF EXISTS on_bh_holiday_write_incidents ON public.business_hours_holidays;
CREATE TRIGGER on_bh_holiday_write_incidents
  AFTER INSERT OR UPDATE OR DELETE ON public.business_hours_holidays
  FOR EACH ROW EXECUTE FUNCTION public.on_business_hours_write_incidents();

-- ------------------------------------------------------------
-- 4. incident_escalation_recipients — per-account, per-level override.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_escalation_recipients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  level INTEGER NOT NULL CHECK (level IN (2, 3)),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, level, user_id)
);
CREATE INDEX IF NOT EXISTS idx_incident_escalation_recipients_account_level
  ON public.incident_escalation_recipients (account_id, level);

ALTER TABLE public.incident_escalation_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incident_escalation_recipients_select ON public.incident_escalation_recipients;
CREATE POLICY incident_escalation_recipients_select ON public.incident_escalation_recipients FOR SELECT USING (
  is_account_member(account_id)
);

DROP POLICY IF EXISTS incident_escalation_recipients_insert ON public.incident_escalation_recipients;
CREATE POLICY incident_escalation_recipients_insert ON public.incident_escalation_recipients FOR INSERT WITH CHECK (
  has_capability(account_id, 'incidents.manage') AND added_by = auth.uid()
);

DROP POLICY IF EXISTS incident_escalation_recipients_delete ON public.incident_escalation_recipients;
CREATE POLICY incident_escalation_recipients_delete ON public.incident_escalation_recipients FOR DELETE USING (
  has_capability(account_id, 'incidents.manage')
);

-- Recipient resolver: explicit overrides for (account, level) if any exist;
-- otherwise admin/owner UNION incidents.manage capability holders (this
-- UNION branch is what fixes the Compliance-Officer omission bug — mirrors
-- notify_incident_raised()'s own capability-based fallback at level 1).
CREATE OR REPLACE FUNCTION public.incident_escalation_recipient_ids(p_account_id UUID, p_level INTEGER)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT user_id FROM public.incident_escalation_recipients
   WHERE account_id = p_account_id AND level = p_level
  UNION
  SELECT p.user_id FROM public.profiles p
   WHERE p.account_id = p_account_id
     AND NOT EXISTS (
       SELECT 1 FROM public.incident_escalation_recipients r
        WHERE r.account_id = p_account_id AND r.level = p_level
     )
     AND (
       p.account_role IN ('admin', 'owner')
       OR (
         p.custom_role_id IS NOT NULL
         AND public.effective_custom_role_capability(p.custom_role_id, 'incidents.manage')
       )
       OR (
         p.custom_role_id IS NULL
         AND public.effective_capability(p.account_id, p.account_role, 'incidents.manage')
       )
     );
$$;
ALTER FUNCTION public.incident_escalation_recipient_ids(UUID, INTEGER) OWNER TO postgres;

-- ------------------------------------------------------------
-- 5. incident_escalation_sweep() — flat due-column scan + resolver call.
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
    WHERE i.status = 'reported'
      AND i.escalation_level < 3
      AND i.next_escalation_due_at IS NOT NULL
      AND i.next_escalation_due_at < NOW()
    ORDER BY i.next_escalation_due_at
    LIMIT GREATEST(LEAST(p_limit, 500), 0)
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

-- ------------------------------------------------------------
-- 6. incident_escalate_manual() — same resolver call (due column is
-- restamped automatically by the trigger since this still sets
-- escalation_level_entered_at = NOW()).
-- ------------------------------------------------------------
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

  RETURN jsonb_build_object(
    'escalation_level', v_new_level, 'notifications', v_notified, 'notified', v_notified_detail
  );
END;
$$;
