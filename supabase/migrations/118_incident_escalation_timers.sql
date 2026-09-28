-- ============================================================
-- 118_incident_escalation_timers.sql
--
-- Corrects incident_escalation_default_minutes() (migration 116) against
-- the policy's actual §9.2 "Response and resolution targets" table
-- (re-read in full for this fix) — the first migration approximated
-- P1/P2 with the same time for both escalation levels, which the table
-- does not say:
--
--   Escalation to Incident Lead (L2): P1 15min, P2 1hr,  P3 1BD, P4 weekly
--   Escalation to CEO (L3):           P1 1hr,   P2 4hrs, P3 monthly, P4 monthly
--
-- P3/P4's L2->L3 target ("monthly review/summary") isn't a per-incident
-- timeout in the way P1/P2's are — approximated here as 30 days so the
-- auto-escalation sweep still has a sane fallback number rather than
-- never firing; per-account overrides (incident_escalation_policies)
-- remain the way to tune this for real.
--
-- Idempotent — safe to run more than once.
-- ============================================================

CREATE OR REPLACE FUNCTION public.incident_escalation_default_minutes(p_severity TEXT, p_level INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_severity
    WHEN 'P1' THEN CASE WHEN p_level = 1 THEN 15 ELSE 60 END
    WHEN 'P2' THEN CASE WHEN p_level = 1 THEN 60 ELSE 240 END
    WHEN 'P3' THEN CASE WHEN p_level = 1 THEN 1440 ELSE 43200 END
    WHEN 'P4' THEN CASE WHEN p_level = 1 THEN 10080 ELSE 43200 END
    ELSE 1440
  END;
$$;
