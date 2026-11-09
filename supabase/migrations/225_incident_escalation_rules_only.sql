-- Migration 225: escalation tells people only through Roles and Rules. The separate list of names is retired.
--
-- Until now there were two ways an escalation told people: a rule for the moment of escalation (migration 222), and an older separate list of names per level
-- (incident_escalation_recipients, or every Admin and Owner when the list was empty). Two systems meant a person could be told for a reason no rule showed.
--
-- This migration:
--   1. brings the old list across: each person on it becomes a contact (if they have an email), the people for level 2 and level 3 become two roles
--      (escalation_level_2, escalation_level_3), and a rule for each level tells that role, so the same people are told as before;
--   2. for a school with no old list, adds the two escalation rules telling the Principal (level 3 also tells the incident lead);
--   3. leaves a school that already wrote its own escalation rule exactly as it is;
--   4. makes Escalate now and the timed sweep raise the level and record it, and nothing else (the app then runs the rules for that level);
--   5. drops the helper functions of the old list. The table incident_escalation_recipients is kept, unused, so nothing is lost; it can be dropped later.
-- Run on the Halo PostgreSQL after 224. Idempotent.

-- 1a. A contact for each person on the old list who has an email and is not yet a contact.
INSERT INTO public.incident_contacts (account_id, user_id, name, kind, emails, phones, preferred_channels)
SELECT DISTINCT ON (r.account_id, r.user_id) r.account_id, r.user_id, COALESCE(NULLIF(btrim(p.full_name), ''), btrim(p.email)), 'staff', ARRAY[btrim(p.email)], ARRAY[]::text[], ARRAY['email']::text[]
  FROM public.incident_escalation_recipients r
  JOIN public.profiles p ON p.user_id = r.user_id AND p.account_id = r.account_id
 WHERE p.email IS NOT NULL AND btrim(p.email) <> ''
   AND NOT EXISTS (SELECT 1 FROM public.incident_contacts c WHERE c.account_id = r.account_id AND c.user_id = r.user_id)
ON CONFLICT DO NOTHING;

-- 1b. A role for each level that had people.
INSERT INTO public.incident_roles (account_id, key, name, description, kind, sort_order)
SELECT DISTINCT r.account_id, 'escalation_level_' || r.level, jsonb_build_object('en', 'Escalation level ' || r.level),
       'People who were told when an incident reached this level (brought across from the old settings).', 'fixed', 400 + r.level
  FROM public.incident_escalation_recipients r
 WHERE EXISTS (SELECT 1 FROM public.incident_contacts c WHERE c.account_id = r.account_id AND c.user_id = r.user_id)
ON CONFLICT (account_id, key) DO NOTHING;

-- 1c. The people in those roles.
INSERT INTO public.incident_role_members (account_id, role_id, contact_id, position)
SELECT r.account_id, ro.id, c.id, (row_number() OVER (PARTITION BY r.account_id, r.level ORDER BY r.user_id))::INTEGER - 1
  FROM public.incident_escalation_recipients r
  JOIN public.incident_roles ro ON ro.account_id = r.account_id AND ro.key = 'escalation_level_' || r.level
  JOIN public.incident_contacts c ON c.account_id = r.account_id AND c.user_id = r.user_id
ON CONFLICT (role_id, contact_id) DO NOTHING;

-- 1d. A rule for each such level, unless the school already wrote its own escalation rule.
INSERT INTO public.incident_rules (account_id, recipe_key, name, trigger, wait_minutes, conditions, actions, enabled, position)
SELECT x.account_id, 'escalated_' || x.level, 'Level ' || x.level || ': tell the people who were told before', 'escalated', NULL,
       jsonb_build_object('level', x.level),
       jsonb_build_array(jsonb_build_object('type', 'notify', 'role_key', 'escalation_level_' || x.level, 'ask_ack', TRUE)),
       TRUE, 100 + x.level
  FROM (SELECT DISTINCT account_id, level FROM public.incident_escalation_recipients) x
 WHERE EXISTS (SELECT 1 FROM public.incident_roles ro WHERE ro.account_id = x.account_id AND ro.key = 'escalation_level_' || x.level)
   AND NOT EXISTS (SELECT 1 FROM public.incident_rules e WHERE e.account_id = x.account_id AND e.trigger = 'escalated')
ON CONFLICT (account_id, recipe_key) WHERE recipe_key IS NOT NULL DO NOTHING;

-- 2. A school that uses incident roles but had no old list: the Principal at level 2; the Principal and the incident lead at the top.
INSERT INTO public.incident_rules (account_id, recipe_key, name, trigger, wait_minutes, conditions, actions, enabled, position)
SELECT a.account_id, 'escalated_' || l.level,
       CASE l.level WHEN 2 THEN 'Level 2: tell the Principal' ELSE 'Top level: tell the Principal and the lead' END,
       'escalated', NULL, jsonb_build_object('level', l.level),
       CASE l.level
         WHEN 2 THEN jsonb_build_array(jsonb_build_object('type', 'notify', 'role_key', 'principal', 'ask_ack', TRUE))
         ELSE jsonb_build_array(jsonb_build_object('type', 'notify', 'role_key', 'principal', 'ask_ack', TRUE), jsonb_build_object('type', 'notify', 'role_key', 'incident_lead'))
       END,
       TRUE, 100 + l.level
  FROM (SELECT DISTINCT account_id FROM public.incident_roles WHERE key = 'principal') a
 CROSS JOIN (VALUES (2), (3)) AS l(level)
 WHERE NOT EXISTS (SELECT 1 FROM public.incident_rules e WHERE e.account_id = a.account_id AND e.trigger = 'escalated')
   AND NOT EXISTS (SELECT 1 FROM public.incident_escalation_recipients o WHERE o.account_id = a.account_id)
ON CONFLICT (account_id, recipe_key) WHERE recipe_key IS NOT NULL DO NOTHING;

-- 4. Escalate now: raise the level and record it. The app runs the escalation rules for the new level.
CREATE OR REPLACE FUNCTION public.incident_escalate_manual(p_incident_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row incidents%ROWTYPE;
  v_new_level INTEGER;
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

  RETURN jsonb_build_object('escalation_level', v_new_level, 'notifications', 0, 'notified', '[]'::jsonb);
END;
$$;

-- 4. The timed sweep: raise the level of an unacknowledged incident when its timer runs out and record it; report what it escalated.
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
           AND y.voided_at IS NULL
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
  END LOOP;

  RETURN jsonb_build_object('escalated', v_escalated, 'notifications', 0, 'notified', '[]'::jsonb, 'escalated_incidents', v_escalated_detail);
END;
$$;
REVOKE ALL ON FUNCTION public.incident_escalation_sweep(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.incident_escalation_sweep(INTEGER) TO service_role;

-- 5. The old list's helpers are no longer used.
DROP FUNCTION IF EXISTS public.incident_escalation_by_rules(UUID);
DROP FUNCTION IF EXISTS public.incident_escalation_recipient_ids(UUID, INTEGER);

COMMENT ON TABLE public.incident_escalation_recipients IS 'Retired (migration 225): escalation now tells roles through rules. Kept so nothing is lost; safe to drop once the school has checked its escalation rules.';

NOTIFY pgrst, 'reload schema';
