-- ============================================================
-- 086_ticket_sla.sql — Ticket SLA with business hours (0.44.0)
--
-- Business-hour schedules (timezone, weekly time slots, holidays, one
-- default), SLA policies for tickets (first-response and resolution
-- targets matched by priority / type / label / channel / team, measured in
-- business hours), and a database-driven clock on every ticket so every
-- write path (agent edits, board drags, bulk updates, Jira sync, API) is
-- covered without the app having to remember.
--
-- What this migration does
--   1. Capability `sla.configure` (Owner + Admin by default, database tier:
--      the three config tables' write policies call has_capability()).
--      Mirrors src/lib/auth/capabilities.ts (capabilities-sql.test.ts).
--   2. Tables business_hours_schedules, business_hours_holidays,
--      ticket_sla_policies. RLS: members SELECT, writes need sla.configure.
--      BEFORE triggers validate them (timezone against pg_timezone_names,
--      weekly slots, policy targets, condition shape); exactly one default
--      schedule per account (partial unique index + triggers).
--   3. Business-time functions, the SQL twin of src/lib/sla/business-time.ts
--      (parity fixtures in src/lib/sla/business-time.fixtures.ts):
--        sla_add_business_seconds / sla_business_seconds_between   (exact)
--        sla_add_business_minutes / sla_business_minutes_between   (int)
--      DST-correct (slot edges are converted to instants per local date),
--      holiday-aware, capped at 366 local days (NULL + WARNING beyond).
--   4. tickets: SLA columns and the BEFORE INSERT/UPDATE trigger
--      ticket_sla_state (never blocks a real write). Clock: runs in open and
--      in_progress, pauses in pending (policy option), stops at
--      resolved/closed, resumes/restarts when reopened. The algorithm is
--      documented above ticket_sla_state().
--   5. First response: ticket_sla_first_response() on ticket_comments (the
--      first comment written by a Vircle user, not Jira-sourced: exactly the
--      "first teammate comment" Reports > Tickets already measures).
--   6. sla_sweep() (service role only) marks running targets past due as
--      breached and sends the once-only at-risk / breach notifications
--      (FOR UPDATE SKIP LOCKED, batch limited). Called by
--      GET /api/sla/tickets-cron.
--   7. sla_apply_to_open_tickets() (one-time "Apply to open tickets"),
--      sla_reorder_policies(), ticket_sla_report() (Reports > Tickets).
--   8. notifications.type gains ticket_sla_at_risk and ticket_sla_breached.
--      The CHECK is rebuilt from the LIVE definition. It ALSO restores
--      `sla_breach`, which migration 081 dropped from the list while the
--      conversation SLA cron (049) still inserts it (those inserts were
--      failing the CHECK).
--   9. Audit triggers (082's audit_row_change) for schedules, holidays and
--      policies. audit_log.entity_type has no CHECK, so nothing to widen.
--
-- The existing conversation SLA (049) is not changed.
-- Depends on: 063/081 (tickets), 079 (capabilities), 082 (audit).
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Capability
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('sla.configure', 'agent', 'database')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'sla.configure'),
  ('admin', 'sla.configure')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Validation helpers (pure)
-- ------------------------------------------------------------

-- "HH:MM" -> minutes since midnight; "24:00" is 1440; NULL when malformed.
CREATE OR REPLACE FUNCTION public.sla_hm_to_min(p text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p = '24:00' THEN 1440
    WHEN p ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      THEN substr(p, 1, 2)::int * 60 + substr(p, 4, 2)::int
    ELSE NULL
  END;
$$;

-- Weekly hours: an object with keys "1".."7" (ISO weekday), each an array of
-- at most 4 {start, end} slots; times valid, end after start, slots in a day
-- never overlap; at least one open day. Raises 22023 with a short code.
CREATE OR REPLACE FUNCTION public.sla_validate_weekly(p jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  k        TEXT;
  v        JSONB;
  slot     JSONB;
  s        INTEGER;
  e        INTEGER;
  prev_end INTEGER;
  open_days INTEGER := 0;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'sla_weekly_invalid: bad_day' USING ERRCODE = '22023';
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(p) LOOP
    IF k !~ '^[1-7]$' OR jsonb_typeof(v) <> 'array' THEN
      RAISE EXCEPTION 'sla_weekly_invalid: bad_day' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v) > 4 THEN
      RAISE EXCEPTION 'sla_weekly_invalid: too_many_slots (day %)', k USING ERRCODE = '22023';
    END IF;
    prev_end := NULL;
    FOR slot IN SELECT x FROM jsonb_array_elements(v) AS x ORDER BY x ->> 'start' LOOP
      IF jsonb_typeof(slot) <> 'object'
         OR jsonb_typeof(slot -> 'start') IS DISTINCT FROM 'string'
         OR jsonb_typeof(slot -> 'end') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'sla_weekly_invalid: bad_time (day %)', k USING ERRCODE = '22023';
      END IF;
      s := sla_hm_to_min(slot ->> 'start');
      e := sla_hm_to_min(slot ->> 'end');
      IF s IS NULL OR e IS NULL OR s >= 1440 THEN
        RAISE EXCEPTION 'sla_weekly_invalid: bad_time (day %)', k USING ERRCODE = '22023';
      END IF;
      IF e <= s THEN
        RAISE EXCEPTION 'sla_weekly_invalid: end_before_start (day %)', k USING ERRCODE = '22023';
      END IF;
      IF prev_end IS NOT NULL AND s < prev_end THEN
        RAISE EXCEPTION 'sla_weekly_invalid: overlap (day %)', k USING ERRCODE = '22023';
      END IF;
      prev_end := e;
    END LOOP;
    IF jsonb_array_length(v) > 0 THEN open_days := open_days + 1; END IF;
  END LOOP;
  IF open_days = 0 THEN
    RAISE EXCEPTION 'sla_weekly_invalid: no_open_day' USING ERRCODE = '22023';
  END IF;
END;
$$;

-- Policy conditions: { priorities, categories, labels, channels, team_ids },
-- each an array of at most 50 short strings; empty / missing = any.
CREATE OR REPLACE FUNCTION public.sla_validate_conditions(p jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  k TEXT;
  v JSONB;
  x JSONB;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'sla_conditions_invalid: not an object' USING ERRCODE = '22023';
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(p) LOOP
    IF k NOT IN ('priorities', 'categories', 'labels', 'channels', 'team_ids') THEN
      RAISE EXCEPTION 'sla_conditions_invalid: unknown key %', k USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) > 50 THEN
      RAISE EXCEPTION 'sla_conditions_invalid: % must be a short list', k USING ERRCODE = '22023';
    END IF;
    FOR x IN SELECT e FROM jsonb_array_elements(v) AS e LOOP
      IF jsonb_typeof(x) <> 'string' OR length(x #>> '{}') > 64 THEN
        RAISE EXCEPTION 'sla_conditions_invalid: % entries must be short text', k USING ERRCODE = '22023';
      END IF;
      IF k = 'priorities' AND (x #>> '{}') NOT IN ('urgent', 'high', 'normal', 'low') THEN
        RAISE EXCEPTION 'sla_conditions_invalid: priority %', x #>> '{}' USING ERRCODE = '22023';
      END IF;
      IF k = 'categories' AND (x #>> '{}') NOT IN
         ('general', 'billing', 'technical', 'feature_request', 'bug', 'account', 'other') THEN
        RAISE EXCEPTION 'sla_conditions_invalid: type %', x #>> '{}' USING ERRCODE = '22023';
      END IF;
      IF k = 'team_ids' AND (x #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'sla_conditions_invalid: team id' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

-- ------------------------------------------------------------
-- 3. Tables
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.business_hours_schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  timezone    TEXT NOT NULL,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  weekly      JSONB NOT NULL,
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bh_schedules_account ON public.business_hours_schedules (account_id);
-- At most one default schedule per account (the triggers keep it exactly one).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bh_schedules_one_default
  ON public.business_hours_schedules (account_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS public.business_hours_holidays (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id   UUID NOT NULL REFERENCES public.business_hours_schedules(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  holiday_date  DATE NOT NULL,
  name          TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 80),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, holiday_date)
);

CREATE INDEX IF NOT EXISTS idx_bh_holidays_schedule ON public.business_hours_holidays (schedule_id, holiday_date);

CREATE TABLE IF NOT EXISTS public.ticket_sla_policies (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  position                INTEGER NOT NULL DEFAULT 0,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  conditions              JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_response_minutes  INTEGER CHECK (first_response_minutes IS NULL OR first_response_minutes BETWEEN 1 AND 525600),
  resolution_minutes      INTEGER CHECK (resolution_minutes IS NULL OR resolution_minutes BETWEEN 1 AND 525600),
  -- NULL = 24/7. RESTRICT: a schedule a policy uses cannot be deleted.
  schedule_id             UUID REFERENCES public.business_hours_schedules(id) ON DELETE RESTRICT,
  pause_while_pending     BOOLEAN NOT NULL DEFAULT true,
  at_risk_percent         INTEGER NOT NULL DEFAULT 80 CHECK (at_risk_percent BETWEEN 50 AND 95),
  created_by              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ticket_sla_policies_has_target
    CHECK (first_response_minutes IS NOT NULL OR resolution_minutes IS NOT NULL),
  CONSTRAINT ticket_sla_policies_order
    CHECK (first_response_minutes IS NULL OR resolution_minutes IS NULL
           OR resolution_minutes > first_response_minutes)
);

CREATE INDEX IF NOT EXISTS idx_ticket_sla_policies_account
  ON public.ticket_sla_policies (account_id, position);
CREATE INDEX IF NOT EXISTS idx_ticket_sla_policies_schedule
  ON public.ticket_sla_policies (schedule_id) WHERE schedule_id IS NOT NULL;

-- ------------------------------------------------------------
-- 4. Validation and default-schedule triggers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sla_schedule_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_swap BOOLEAN;
BEGIN
  NEW.name := btrim(NEW.name);
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'sla_timezone_invalid: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  PERFORM sla_validate_weekly(NEW.weekly);

  IF TG_OP = 'UPDATE' THEN
    NEW.account_id := OLD.account_id;
    -- Losing the default must go through "make another the default".
    IF OLD.is_default AND NOT NEW.is_default
       AND COALESCE(current_setting('vircle.sla_default_swap', true), '') <> 'on' THEN
      RAISE EXCEPTION 'sla_default_required' USING ERRCODE = '22023';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM business_hours_schedules WHERE account_id = NEW.account_id) THEN
    -- The first schedule of a workspace is its default.
    NEW.is_default := true;
  END IF;

  v_swap := NEW.is_default;
  IF v_swap AND TG_OP = 'UPDATE' THEN v_swap := NOT OLD.is_default; END IF;
  IF v_swap THEN
    PERFORM set_config('vircle.sla_default_swap', 'on', true);
    UPDATE business_hours_schedules
       SET is_default = false
     WHERE account_id = NEW.account_id AND is_default AND id IS DISTINCT FROM NEW.id;
    PERFORM set_config('vircle.sla_default_swap', '', true);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sla_schedule_before_write ON public.business_hours_schedules;
CREATE TRIGGER sla_schedule_before_write
  BEFORE INSERT OR UPDATE ON public.business_hours_schedules
  FOR EACH ROW EXECUTE FUNCTION public.sla_schedule_before_write();

-- Deleting the default promotes the oldest remaining schedule.
CREATE OR REPLACE FUNCTION public.sla_schedule_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.is_default THEN
    UPDATE business_hours_schedules
       SET is_default = true
     WHERE id = (SELECT id FROM business_hours_schedules
                  WHERE account_id = OLD.account_id
                  ORDER BY created_at, id LIMIT 1);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sla_schedule_after_delete ON public.business_hours_schedules;
CREATE TRIGGER sla_schedule_after_delete
  AFTER DELETE ON public.business_hours_schedules
  FOR EACH ROW EXECUTE FUNCTION public.sla_schedule_after_delete();

CREATE OR REPLACE FUNCTION public.sla_holiday_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_account UUID;
BEGIN
  SELECT account_id INTO v_account FROM business_hours_schedules WHERE id = NEW.schedule_id;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'sla_schedule_missing' USING ERRCODE = '23503';
  END IF;
  -- The account always comes from the schedule; a client cannot pick it.
  NEW.account_id := v_account;
  NEW.name := btrim(COALESCE(NEW.name, ''));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sla_holiday_before_write ON public.business_hours_holidays;
CREATE TRIGGER sla_holiday_before_write
  BEFORE INSERT OR UPDATE ON public.business_hours_holidays
  FOR EACH ROW EXECUTE FUNCTION public.sla_holiday_before_write();

CREATE OR REPLACE FUNCTION public.sla_policy_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  NEW.name := btrim(NEW.name);
  PERFORM sla_validate_conditions(NEW.conditions);
  IF TG_OP = 'UPDATE' THEN
    NEW.account_id := OLD.account_id;
  ELSE
    SELECT count(*) INTO v_count FROM ticket_sla_policies WHERE account_id = NEW.account_id;
    IF v_count >= 50 THEN
      RAISE EXCEPTION 'sla_policy_limit' USING ERRCODE = '54000';
    END IF;
    IF NEW.position IS NULL OR NEW.position = 0 THEN
      SELECT COALESCE(max(position), 0) + 1 INTO NEW.position
        FROM ticket_sla_policies WHERE account_id = NEW.account_id;
    END IF;
  END IF;
  IF NEW.schedule_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM business_hours_schedules
        WHERE id = NEW.schedule_id AND account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'sla_schedule_missing' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sla_policy_before_write ON public.ticket_sla_policies;
CREATE TRIGGER sla_policy_before_write
  BEFORE INSERT OR UPDATE ON public.ticket_sla_policies
  FOR EACH ROW EXECUTE FUNCTION public.sla_policy_before_write();

-- who / when
DROP TRIGGER IF EXISTS audit_stamp_row ON public.business_hours_schedules;
CREATE TRIGGER audit_stamp_row
  BEFORE INSERT OR UPDATE ON public.business_hours_schedules
  FOR EACH ROW EXECUTE FUNCTION public.audit_stamp_row();

DROP TRIGGER IF EXISTS audit_stamp_row ON public.ticket_sla_policies;
CREATE TRIGGER audit_stamp_row
  BEFORE INSERT OR UPDATE ON public.ticket_sla_policies
  FOR EACH ROW EXECUTE FUNCTION public.audit_stamp_row();

DROP TRIGGER IF EXISTS set_updated_at ON public.business_hours_schedules;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.business_hours_schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at ON public.ticket_sla_policies;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.ticket_sla_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ------------------------------------------------------------
-- 5. RLS: members read, sla.configure writes (database tier)
-- ------------------------------------------------------------
ALTER TABLE public.business_hours_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_hours_holidays  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_sla_policies      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_hours_schedules_select ON public.business_hours_schedules;
DROP POLICY IF EXISTS business_hours_schedules_insert ON public.business_hours_schedules;
DROP POLICY IF EXISTS business_hours_schedules_update ON public.business_hours_schedules;
DROP POLICY IF EXISTS business_hours_schedules_delete ON public.business_hours_schedules;
CREATE POLICY business_hours_schedules_select ON public.business_hours_schedules
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY business_hours_schedules_insert ON public.business_hours_schedules
  FOR INSERT WITH CHECK (has_capability(account_id, 'sla.configure'));
CREATE POLICY business_hours_schedules_update ON public.business_hours_schedules
  FOR UPDATE USING (has_capability(account_id, 'sla.configure'))
  WITH CHECK (has_capability(account_id, 'sla.configure'));
CREATE POLICY business_hours_schedules_delete ON public.business_hours_schedules
  FOR DELETE USING (has_capability(account_id, 'sla.configure'));

DROP POLICY IF EXISTS business_hours_holidays_select ON public.business_hours_holidays;
DROP POLICY IF EXISTS business_hours_holidays_insert ON public.business_hours_holidays;
DROP POLICY IF EXISTS business_hours_holidays_update ON public.business_hours_holidays;
DROP POLICY IF EXISTS business_hours_holidays_delete ON public.business_hours_holidays;
CREATE POLICY business_hours_holidays_select ON public.business_hours_holidays
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY business_hours_holidays_insert ON public.business_hours_holidays
  FOR INSERT WITH CHECK (has_capability(account_id, 'sla.configure'));
CREATE POLICY business_hours_holidays_update ON public.business_hours_holidays
  FOR UPDATE USING (has_capability(account_id, 'sla.configure'))
  WITH CHECK (has_capability(account_id, 'sla.configure'));
CREATE POLICY business_hours_holidays_delete ON public.business_hours_holidays
  FOR DELETE USING (has_capability(account_id, 'sla.configure'));

DROP POLICY IF EXISTS ticket_sla_policies_select ON public.ticket_sla_policies;
DROP POLICY IF EXISTS ticket_sla_policies_insert ON public.ticket_sla_policies;
DROP POLICY IF EXISTS ticket_sla_policies_update ON public.ticket_sla_policies;
DROP POLICY IF EXISTS ticket_sla_policies_delete ON public.ticket_sla_policies;
CREATE POLICY ticket_sla_policies_select ON public.ticket_sla_policies
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY ticket_sla_policies_insert ON public.ticket_sla_policies
  FOR INSERT WITH CHECK (has_capability(account_id, 'sla.configure'));
CREATE POLICY ticket_sla_policies_update ON public.ticket_sla_policies
  FOR UPDATE USING (has_capability(account_id, 'sla.configure'))
  WITH CHECK (has_capability(account_id, 'sla.configure'));
CREATE POLICY ticket_sla_policies_delete ON public.ticket_sla_policies
  FOR DELETE USING (has_capability(account_id, 'sla.configure'));

-- ------------------------------------------------------------
-- 6. Business-time functions (SQL twin of src/lib/sla/business-time.ts)
--
-- SECURITY INVOKER: they read the schedule tables under the caller's own
-- RLS (members can read them); the DEFINER trigger functions below call
-- them with the owner's rights. p_schedule_id NULL = 24/7.
--
-- Rules (each one has a fixture in business-time.fixtures.ts):
--   * slot edges are turned into instants per LOCAL date with the schedule's
--     zone, so a DST day counts the real open time;
--   * a wall time that does not exist / exists twice resolves with the
--     standard offset, which is what `timestamp AT TIME ZONE zone` does;
--   * slots are [start, end): the end instant is closed, the start is open;
--   * a holiday closes its whole local day;
--   * zero seconds returns p_from unchanged; a positive amount from outside
--     hours starts counting at the next opening;
--   * the walk covers at most 366 local dates: beyond that NULL and a WARNING.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sla_add_business_seconds(
  p_schedule_id uuid,
  p_from        timestamptz,
  p_seconds     bigint
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_tz     TEXT;
  v_weekly JSONB;
  v_hol    DATE[];
  v_d      DATE;
  v_k      INTEGER;
  v_slot   RECORD;
  v_s      TIMESTAMPTZ;
  v_e      TIMESTAMPTZ;
  v_avail  NUMERIC;
  v_rem    NUMERIC := p_seconds;
BEGIN
  IF p_from IS NULL OR p_seconds IS NULL OR p_seconds < 0 THEN RETURN NULL; END IF;
  IF p_schedule_id IS NULL THEN
    RETURN p_from + make_interval(secs => p_seconds::double precision);
  END IF;
  IF p_seconds = 0 THEN RETURN p_from; END IF;

  SELECT timezone, weekly INTO v_tz, v_weekly
    FROM business_hours_schedules WHERE id = p_schedule_id;
  IF NOT FOUND THEN
    RAISE WARNING 'sla_add_business_seconds: schedule % not found', p_schedule_id;
    RETURN NULL;
  END IF;
  SELECT COALESCE(array_agg(holiday_date), ARRAY[]::date[]) INTO v_hol
    FROM business_hours_holidays WHERE schedule_id = p_schedule_id;

  v_d := (p_from AT TIME ZONE v_tz)::date;
  FOR v_k IN 0..365 LOOP
    IF NOT (v_d = ANY (v_hol)) THEN
      FOR v_slot IN
        SELECT x ->> 'start' AS st, x ->> 'end' AS en
          FROM jsonb_array_elements(
                 COALESCE(v_weekly -> (EXTRACT(isodow FROM v_d)::int)::text, '[]'::jsonb)) AS x
         ORDER BY x ->> 'start'
      LOOP
        v_e := (v_d + v_slot.en::time) AT TIME ZONE v_tz;
        CONTINUE WHEN v_e <= p_from;
        v_s := (v_d + v_slot.st::time) AT TIME ZONE v_tz;
        IF v_s < p_from THEN v_s := p_from; END IF;
        v_avail := EXTRACT(epoch FROM (v_e - v_s));
        IF v_rem <= v_avail THEN
          RETURN v_s + make_interval(secs => v_rem::double precision);
        END IF;
        v_rem := v_rem - v_avail;
      END LOOP;
    END IF;
    v_d := v_d + 1;
  END LOOP;

  RAISE WARNING 'sla_add_business_seconds: not enough open time within 366 days (schedule %)', p_schedule_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.sla_business_seconds_between(
  p_schedule_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_tz     TEXT;
  v_weekly JSONB;
  v_hol    DATE[];
  v_d      DATE;
  v_last   DATE;
  v_k      INTEGER;
  v_slot   RECORD;
  v_s      TIMESTAMPTZ;
  v_e      TIMESTAMPTZ;
  v_total  NUMERIC := 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN RETURN NULL; END IF;
  IF p_to <= p_from THEN RETURN 0; END IF;
  IF p_schedule_id IS NULL THEN
    RETURN floor(EXTRACT(epoch FROM (p_to - p_from)))::bigint;
  END IF;

  SELECT timezone, weekly INTO v_tz, v_weekly
    FROM business_hours_schedules WHERE id = p_schedule_id;
  IF NOT FOUND THEN
    RAISE WARNING 'sla_business_seconds_between: schedule % not found', p_schedule_id;
    RETURN NULL;
  END IF;
  SELECT COALESCE(array_agg(holiday_date), ARRAY[]::date[]) INTO v_hol
    FROM business_hours_holidays WHERE schedule_id = p_schedule_id;

  v_d := (p_from AT TIME ZONE v_tz)::date;
  v_last := (p_to AT TIME ZONE v_tz)::date;
  FOR v_k IN 0..365 LOOP
    IF v_d > v_last THEN RETURN floor(v_total)::bigint; END IF;
    IF NOT (v_d = ANY (v_hol)) THEN
      FOR v_slot IN
        SELECT x ->> 'start' AS st, x ->> 'end' AS en
          FROM jsonb_array_elements(
                 COALESCE(v_weekly -> (EXTRACT(isodow FROM v_d)::int)::text, '[]'::jsonb)) AS x
         ORDER BY x ->> 'start'
      LOOP
        v_e := (v_d + v_slot.en::time) AT TIME ZONE v_tz;
        CONTINUE WHEN v_e <= p_from;
        v_s := (v_d + v_slot.st::time) AT TIME ZONE v_tz;
        IF v_s >= p_to THEN RETURN floor(v_total)::bigint; END IF;
        v_total := v_total + EXTRACT(epoch FROM (LEAST(v_e, p_to) - GREATEST(v_s, p_from)));
        IF v_e >= p_to THEN RETURN floor(v_total)::bigint; END IF;
      END LOOP;
    END IF;
    v_d := v_d + 1;
  END LOOP;

  RAISE WARNING 'sla_business_seconds_between: range longer than 366 days (schedule %)', p_schedule_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.sla_add_business_minutes(
  p_schedule_id uuid,
  p_from        timestamptz,
  p_minutes     integer
)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT sla_add_business_seconds(p_schedule_id, p_from, p_minutes::bigint * 60);
$$;

CREATE OR REPLACE FUNCTION public.sla_business_minutes_between(
  p_schedule_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (floor(sla_business_seconds_between(p_schedule_id, p_from, p_to) / 60.0))::int;
$$;

-- ------------------------------------------------------------
-- 7. tickets: SLA columns
-- ------------------------------------------------------------
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS sla_policy_id              UUID REFERENCES public.ticket_sla_policies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sla_first_response_due_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_first_response_risk_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_first_response_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_first_response_state   TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS sla_resolution_due_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_resolution_risk_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_resolution_state       TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS sla_paused_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_stopped_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_evaluated_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_fr_risk_notified_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_fr_breach_notified_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_res_risk_notified_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_res_breach_notified_at TIMESTAMPTZ;

ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_sla_first_response_state_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_sla_first_response_state_check
  CHECK (sla_first_response_state IN ('none', 'running', 'paused', 'met', 'breached'));
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_sla_resolution_state_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_sla_resolution_state_check
  CHECK (sla_resolution_state IN ('none', 'running', 'paused', 'met', 'breached'));

CREATE INDEX IF NOT EXISTS idx_tickets_sla_fr_due ON public.tickets (sla_first_response_due_at)
  WHERE sla_first_response_state = 'running';
CREATE INDEX IF NOT EXISTS idx_tickets_sla_res_due ON public.tickets (sla_resolution_due_at)
  WHERE sla_resolution_state = 'running';
CREATE INDEX IF NOT EXISTS idx_tickets_sla_fr_risk ON public.tickets (sla_first_response_risk_at)
  WHERE sla_first_response_state = 'running' AND sla_fr_risk_notified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_sla_res_risk ON public.tickets (sla_resolution_risk_at)
  WHERE sla_resolution_state = 'running' AND sla_res_risk_notified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_sla_policy ON public.tickets (sla_policy_id)
  WHERE sla_policy_id IS NOT NULL;

-- ------------------------------------------------------------
-- 8. Policy matching and the pure state steps
-- ------------------------------------------------------------

-- The first ACTIVE policy (lowest position) whose non-empty conditions all
-- match. labels: the ticket has ANY of the listed labels. channels: the
-- linked conversation's last_channel_type (a ticket with no conversation
-- never matches a policy that names channels).
CREATE OR REPLACE FUNCTION public.sla_match_policy(
  p_account      uuid,
  p_priority     text,
  p_category     text,
  p_labels       text[],
  p_team         uuid,
  p_conversation uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_channel TEXT;
  v_id      UUID;
BEGIN
  IF p_conversation IS NOT NULL THEN
    SELECT last_channel_type INTO v_channel FROM conversations WHERE id = p_conversation;
  END IF;
  SELECT p.id INTO v_id
    FROM ticket_sla_policies p
   WHERE p.account_id = p_account
     AND p.is_active
     AND (jsonb_array_length(COALESCE(p.conditions -> 'priorities', '[]'::jsonb)) = 0
          OR (p.conditions -> 'priorities') ? p_priority)
     AND (jsonb_array_length(COALESCE(p.conditions -> 'categories', '[]'::jsonb)) = 0
          OR (p.conditions -> 'categories') ? p_category)
     AND (jsonb_array_length(COALESCE(p.conditions -> 'labels', '[]'::jsonb)) = 0
          OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.conditions -> 'labels') AS l
                      WHERE l = ANY (COALESCE(p_labels, ARRAY[]::text[]))))
     AND (jsonb_array_length(COALESCE(p.conditions -> 'channels', '[]'::jsonb)) = 0
          OR COALESCE((p.conditions -> 'channels') ? v_channel, false))
     AND (jsonb_array_length(COALESCE(p.conditions -> 'team_ids', '[]'::jsonb)) = 0
          OR COALESCE((p.conditions -> 'team_ids') ? p_team::text, false))
   ORDER BY p.position, p.created_at, p.id
   LIMIT 1;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.sla_due(p_schedule uuid, p_from timestamptz, p_minutes integer)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE WHEN p_minutes IS NULL THEN NULL
              ELSE sla_add_business_seconds(p_schedule, p_from, p_minutes::bigint * 60) END;
$$;

-- The at-risk instant: p_pct percent of the target consumed.
CREATE OR REPLACE FUNCTION public.sla_risk(
  p_schedule uuid, p_from timestamptz, p_minutes integer, p_pct integer
)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE WHEN p_minutes IS NULL THEN NULL
              ELSE sla_add_business_seconds(
                     p_schedule, p_from, floor(p_minutes::numeric * 60 * p_pct / 100)::bigint) END;
$$;

-- Start the clock from `created_at` under policy `pol`. A first response that
-- already happened (sla_first_response_at) settles the first-response target
-- at once. Resolution runs. Nothing is paused, stopped or settled here.
CREATE OR REPLACE FUNCTION public.sla_t_init(
  p_t   public.tickets,
  pol   public.ticket_sla_policies,
  p_now timestamptz
)
RETURNS public.tickets
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  t public.tickets := p_t;
BEGIN
  t.sla_policy_id := pol.id;
  t.sla_paused_at := NULL;
  t.sla_stopped_at := NULL;

  IF pol.first_response_minutes IS NULL THEN
    t.sla_first_response_due_at := NULL;
    t.sla_first_response_risk_at := NULL;
    t.sla_first_response_state := 'none';
  ELSE
    t.sla_first_response_due_at := sla_due(pol.schedule_id, t.created_at, pol.first_response_minutes);
    t.sla_first_response_risk_at := sla_risk(pol.schedule_id, t.created_at, pol.first_response_minutes, pol.at_risk_percent);
    IF t.sla_first_response_due_at IS NULL THEN
      t.sla_first_response_state := 'none';
    ELSIF t.sla_first_response_at IS NOT NULL THEN
      t.sla_first_response_state :=
        CASE WHEN t.sla_first_response_at <= t.sla_first_response_due_at THEN 'met' ELSE 'breached' END;
    ELSE
      t.sla_first_response_state := 'running';
    END IF;
  END IF;

  IF pol.resolution_minutes IS NULL THEN
    t.sla_resolution_due_at := NULL;
    t.sla_resolution_risk_at := NULL;
    t.sla_resolution_state := 'none';
  ELSE
    t.sla_resolution_due_at := sla_due(pol.schedule_id, t.created_at, pol.resolution_minutes);
    t.sla_resolution_risk_at := sla_risk(pol.schedule_id, t.created_at, pol.resolution_minutes, pol.at_risk_percent);
    t.sla_resolution_state := CASE WHEN t.sla_resolution_due_at IS NULL THEN 'none' ELSE 'running' END;
  END IF;

  t.sla_evaluated_at := p_now;
  RETURN t;
END;
$$;

-- A running target whose due time has passed is breached (strictly after:
-- an answer at exactly the due instant is on time).
CREATE OR REPLACE FUNCTION public.sla_t_settle(p_t public.tickets, p_now timestamptz)
RETURNS public.tickets
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  t public.tickets := p_t;
BEGIN
  IF t.sla_first_response_state = 'running'
     AND t.sla_first_response_due_at IS NOT NULL AND p_now > t.sla_first_response_due_at THEN
    t.sla_first_response_state := 'breached';
  END IF;
  IF t.sla_resolution_state = 'running'
     AND t.sla_resolution_due_at IS NOT NULL AND p_now > t.sla_resolution_due_at THEN
    t.sla_resolution_state := 'breached';
  END IF;
  RETURN t;
END;
$$;

-- pending: settle first (so a target that was already late stays breached),
-- then pause every running target and remember when.
CREATE OR REPLACE FUNCTION public.sla_t_pause(p_t public.tickets, p_now timestamptz)
RETURNS public.tickets
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  t public.tickets := sla_t_settle(p_t, p_now);
BEGIN
  IF t.sla_first_response_state = 'running' THEN t.sla_first_response_state := 'paused'; END IF;
  IF t.sla_resolution_state = 'running' THEN t.sla_resolution_state := 'paused'; END IF;
  IF t.sla_first_response_state = 'paused' OR t.sla_resolution_state = 'paused' THEN
    t.sla_paused_at := p_now;
  END IF;
  RETURN t;
END;
$$;

-- Leaving pending: the business time still to run when the clock stopped
-- (paused_at -> due) is laid out again from now in the policy's schedule.
--   remaining = business_seconds_between(schedule, paused_at, due)
--   due'      = add_business_seconds(schedule, now, remaining)
-- The at-risk instant moves the same way (unless it had already passed).
CREATE OR REPLACE FUNCTION public.sla_t_resume(
  p_t   public.tickets,
  pol   public.ticket_sla_policies,
  p_now timestamptz
)
RETURNS public.tickets
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  t   public.tickets := p_t;
  rem BIGINT;
BEGIN
  IF t.sla_paused_at IS NULL THEN RETURN t; END IF;

  IF t.sla_first_response_state = 'paused' THEN
    rem := COALESCE(sla_business_seconds_between(pol.schedule_id, t.sla_paused_at, t.sla_first_response_due_at), 0);
    t.sla_first_response_due_at := sla_add_business_seconds(pol.schedule_id, p_now, rem);
    IF t.sla_first_response_risk_at IS NOT NULL AND t.sla_first_response_risk_at > t.sla_paused_at THEN
      t.sla_first_response_risk_at := sla_add_business_seconds(pol.schedule_id, p_now,
        COALESCE(sla_business_seconds_between(pol.schedule_id, t.sla_paused_at, t.sla_first_response_risk_at), 0));
    END IF;
    t.sla_first_response_state := CASE WHEN t.sla_first_response_due_at IS NULL THEN 'none' ELSE 'running' END;
  END IF;

  IF t.sla_resolution_state = 'paused' THEN
    rem := COALESCE(sla_business_seconds_between(pol.schedule_id, t.sla_paused_at, t.sla_resolution_due_at), 0);
    t.sla_resolution_due_at := sla_add_business_seconds(pol.schedule_id, p_now, rem);
    IF t.sla_resolution_risk_at IS NOT NULL AND t.sla_resolution_risk_at > t.sla_paused_at THEN
      t.sla_resolution_risk_at := sla_add_business_seconds(pol.schedule_id, p_now,
        COALESCE(sla_business_seconds_between(pol.schedule_id, t.sla_paused_at, t.sla_resolution_risk_at), 0));
    END IF;
    t.sla_resolution_state := CASE WHEN t.sla_resolution_due_at IS NULL THEN 'none' ELSE 'running' END;
  END IF;

  t.sla_paused_at := NULL;
  RETURN sla_t_settle(t, p_now);
END;
$$;

-- resolved / closed: the clock stops. Running -> met if on time, else
-- breached. Paused -> met (it was settled when it paused, so it was on time).
-- A first-response target that never got a response counts by the clock too.
CREATE OR REPLACE FUNCTION public.sla_t_stop(p_t public.tickets, p_now timestamptz)
RETURNS public.tickets
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  t public.tickets := p_t;
BEGIN
  IF t.sla_first_response_state = 'running' THEN
    t.sla_first_response_state :=
      CASE WHEN t.sla_first_response_due_at IS NULL OR p_now <= t.sla_first_response_due_at THEN 'met' ELSE 'breached' END;
  ELSIF t.sla_first_response_state = 'paused' THEN
    t.sla_first_response_state := 'met';
  END IF;
  IF t.sla_resolution_state = 'running' THEN
    t.sla_resolution_state :=
      CASE WHEN t.sla_resolution_due_at IS NULL OR p_now <= t.sla_resolution_due_at THEN 'met' ELSE 'breached' END;
  ELSIF t.sla_resolution_state = 'paused' THEN
    t.sla_resolution_state := 'met';
  END IF;
  t.sla_paused_at := NULL;
  t.sla_stopped_at := p_now;
  RETURN t;
END;
$$;

-- Reopened: a resolution target that was MET restarts with the business time
-- that was left when it stopped (stopped_at -> due). A breached one stays
-- breached. The first-response target never restarts.
CREATE OR REPLACE FUNCTION public.sla_t_restart(
  p_t   public.tickets,
  pol   public.ticket_sla_policies,
  p_now timestamptz
)
RETURNS public.tickets
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  t public.tickets := p_t;
BEGIN
  IF t.sla_resolution_state = 'met' AND t.sla_resolution_due_at IS NOT NULL
     AND t.sla_stopped_at IS NOT NULL THEN
    IF t.sla_resolution_risk_at IS NOT NULL AND t.sla_resolution_risk_at > t.sla_stopped_at THEN
      t.sla_resolution_risk_at := sla_add_business_seconds(pol.schedule_id, p_now,
        COALESCE(sla_business_seconds_between(pol.schedule_id, t.sla_stopped_at, t.sla_resolution_risk_at), 0));
    END IF;
    t.sla_resolution_due_at := sla_add_business_seconds(pol.schedule_id, p_now,
      COALESCE(sla_business_seconds_between(pol.schedule_id, t.sla_stopped_at, t.sla_resolution_due_at), 0));
    t.sla_resolution_state := CASE WHEN t.sla_resolution_due_at IS NULL THEN 'none' ELSE 'running' END;
  END IF;
  t.sla_stopped_at := NULL;
  RETURN t;
END;
$$;

-- Start (or re-start) under a policy for a ticket in ITS CURRENT status:
-- init from created_at, settle, then pause (pending) or stop (resolved/closed).
CREATE OR REPLACE FUNCTION public.sla_t_apply(
  p_t   public.tickets,
  pol   public.ticket_sla_policies,
  p_now timestamptz
)
RETURNS public.tickets
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  t public.tickets := sla_t_settle(sla_t_init(p_t, pol, p_now), p_now);
BEGIN
  IF t.status IN ('resolved', 'closed') THEN
    RETURN sla_t_stop(t, COALESCE(t.closed_at, t.resolved_at, p_now));
  ELSIF t.status = 'pending' AND pol.pause_while_pending THEN
    RETURN sla_t_pause(t, p_now);
  END IF;
  RETURN t;
END;
$$;

-- Priority / type / labels / team / conversation changed on an active ticket.
--   no policy before, one now     -> start from created_at (as "apply")
--   policy before, none now       -> running / paused targets end (kept: met / breached)
--   another policy now            -> keep the elapsed business time:
--       elapsed   = old_target - business_seconds_between(old_schedule, ref, due)
--       remaining = max(new_target - elapsed, 0)
--       due       = add_business_seconds(new_schedule, ref, remaining)
--     where ref = paused_at while paused, else now. Same for the at-risk instant
--     with the new at-risk percent. A target the old policy did not have starts
--     from created_at.
--   same policy                   -> nothing
CREATE OR REPLACE FUNCTION public.sla_t_rematch(
  p_t       public.tickets,
  p_new_id  uuid,
  p_now     timestamptz
)
RETURNS public.tickets
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  t       public.tickets := p_t;
  old_pol public.ticket_sla_policies;
  new_pol public.ticket_sla_policies;
  ref     TIMESTAMPTZ := COALESCE(p_t.sla_paused_at, p_now);
  elapsed BIGINT;
  tsec    BIGINT;
BEGIN
  IF p_new_id IS NOT DISTINCT FROM t.sla_policy_id THEN RETURN t; END IF;

  IF p_new_id IS NULL THEN
    IF t.sla_first_response_state IN ('running', 'paused') THEN
      t.sla_first_response_state := 'none';
      t.sla_first_response_due_at := NULL;
      t.sla_first_response_risk_at := NULL;
    END IF;
    IF t.sla_resolution_state IN ('running', 'paused') THEN
      t.sla_resolution_state := 'none';
      t.sla_resolution_due_at := NULL;
      t.sla_resolution_risk_at := NULL;
    END IF;
    t.sla_policy_id := NULL;
    t.sla_paused_at := NULL;
    t.sla_evaluated_at := p_now;
    RETURN t;
  END IF;

  SELECT * INTO new_pol FROM ticket_sla_policies WHERE id = p_new_id;
  IF new_pol.id IS NULL THEN RETURN t; END IF;

  IF t.sla_policy_id IS NULL THEN
    RETURN sla_t_apply(t, new_pol, p_now);
  END IF;

  SELECT * INTO old_pol FROM ticket_sla_policies WHERE id = t.sla_policy_id;

  -- first response (only while it is still open: running / paused)
  IF t.sla_first_response_state IN ('running', 'paused') THEN
    IF new_pol.first_response_minutes IS NULL THEN
      t.sla_first_response_state := 'none';
      t.sla_first_response_due_at := NULL;
      t.sla_first_response_risk_at := NULL;
    ELSE
      tsec := new_pol.first_response_minutes::bigint * 60;
      IF old_pol.id IS NOT NULL AND old_pol.first_response_minutes IS NOT NULL
         AND t.sla_first_response_due_at IS NOT NULL THEN
        elapsed := GREATEST(0, old_pol.first_response_minutes::bigint * 60
                   - COALESCE(sla_business_seconds_between(old_pol.schedule_id, ref, t.sla_first_response_due_at), 0));
      ELSE
        elapsed := COALESCE(sla_business_seconds_between(new_pol.schedule_id, t.created_at, ref), 0);
      END IF;
      t.sla_first_response_due_at := sla_add_business_seconds(new_pol.schedule_id, ref, GREATEST(tsec - elapsed, 0));
      t.sla_first_response_risk_at := sla_add_business_seconds(new_pol.schedule_id, ref,
        GREATEST(floor(tsec::numeric * new_pol.at_risk_percent / 100)::bigint - elapsed, 0));
      IF t.sla_first_response_due_at IS NULL THEN t.sla_first_response_state := 'none'; END IF;
    END IF;
  ELSIF t.sla_first_response_state = 'none' AND new_pol.first_response_minutes IS NOT NULL THEN
    t.sla_first_response_due_at := sla_due(new_pol.schedule_id, t.created_at, new_pol.first_response_minutes);
    t.sla_first_response_risk_at := sla_risk(new_pol.schedule_id, t.created_at, new_pol.first_response_minutes, new_pol.at_risk_percent);
    t.sla_first_response_state := CASE
      WHEN t.sla_first_response_due_at IS NULL THEN 'none'
      WHEN t.sla_first_response_at IS NOT NULL THEN
        CASE WHEN t.sla_first_response_at <= t.sla_first_response_due_at THEN 'met' ELSE 'breached' END
      WHEN t.sla_paused_at IS NOT NULL THEN 'paused'
      ELSE 'running' END;
  END IF;

  -- resolution
  IF t.sla_resolution_state IN ('running', 'paused') THEN
    IF new_pol.resolution_minutes IS NULL THEN
      t.sla_resolution_state := 'none';
      t.sla_resolution_due_at := NULL;
      t.sla_resolution_risk_at := NULL;
    ELSE
      tsec := new_pol.resolution_minutes::bigint * 60;
      IF old_pol.id IS NOT NULL AND old_pol.resolution_minutes IS NOT NULL
         AND t.sla_resolution_due_at IS NOT NULL THEN
        elapsed := GREATEST(0, old_pol.resolution_minutes::bigint * 60
                   - COALESCE(sla_business_seconds_between(old_pol.schedule_id, ref, t.sla_resolution_due_at), 0));
      ELSE
        elapsed := COALESCE(sla_business_seconds_between(new_pol.schedule_id, t.created_at, ref), 0);
      END IF;
      t.sla_resolution_due_at := sla_add_business_seconds(new_pol.schedule_id, ref, GREATEST(tsec - elapsed, 0));
      t.sla_resolution_risk_at := sla_add_business_seconds(new_pol.schedule_id, ref,
        GREATEST(floor(tsec::numeric * new_pol.at_risk_percent / 100)::bigint - elapsed, 0));
      IF t.sla_resolution_due_at IS NULL THEN t.sla_resolution_state := 'none'; END IF;
    END IF;
  ELSIF t.sla_resolution_state = 'none' AND new_pol.resolution_minutes IS NOT NULL THEN
    t.sla_resolution_due_at := sla_due(new_pol.schedule_id, t.created_at, new_pol.resolution_minutes);
    t.sla_resolution_risk_at := sla_risk(new_pol.schedule_id, t.created_at, new_pol.resolution_minutes, new_pol.at_risk_percent);
    t.sla_resolution_state := CASE
      WHEN t.sla_resolution_due_at IS NULL THEN 'none'
      WHEN t.sla_paused_at IS NOT NULL THEN 'paused'
      ELSE 'running' END;
  END IF;

  t.sla_policy_id := new_pol.id;
  t.sla_evaluated_at := p_now;
  IF t.sla_paused_at IS NOT NULL
     AND t.sla_first_response_state <> 'paused' AND t.sla_resolution_state <> 'paused' THEN
    t.sla_paused_at := NULL;
  END IF;
  -- Paused targets are not settled (their clock is stopped).
  RETURN sla_t_settle(t, p_now);
END;
$$;

-- ------------------------------------------------------------
-- 9. The ticket trigger
--
-- BEFORE INSERT OR UPDATE on tickets. Never blocks a write: any error in the
-- SLA maths becomes a WARNING and the row is written as it came.
--
-- Trusted callers only may change sla_* columns directly: another trigger
-- (pg_trigger_depth() > 1: the comment trigger, the FK "set null" action) or
-- SQL that set vircle.sla_internal = 'on' (the sweep, apply-to-open). For a
-- client write at depth 1 every sla_* column is put back to its old value.
--
-- Clock, by status (a = active: open, in_progress, pending):
--   insert                    match a policy; start from created_at
--   a(not pending) -> pending pause  (settle, states running -> paused)   [if the policy pauses]
--   pending -> a(not pending) resume (see sla_t_resume)
--   a -> resolved/closed      stop   (met / breached, stopped_at = now)
--   resolved/closed -> a      restart a met resolution from its remaining
--                             business time (see sla_t_restart)
--   priority / type / labels / team / conversation changed while active:
--                             re-match (see sla_t_rematch)
--   first_response_at set     first-response target settles: met / breached
-- updated_at is left alone when only sla_* columns changed, so a sweep or a
-- first response does not reorder the "recently updated" list.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ticket_sla_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now     TIMESTAMPTZ := now();
  v_trusted BOOLEAN := pg_trigger_depth() > 1
                       OR COALESCE(current_setting('vircle.sla_internal', true), '') = 'on';
  v_new     public.tickets := NEW;
  v_pol     public.ticket_sla_policies;
  v_pol_id  UUID;
  v_was_act BOOLEAN;
  v_is_act  BOOLEAN;
  v_relevant BOOLEAN;
  v_cols    TEXT[] := ARRAY['updated_at', 'sla_policy_id', 'sla_first_response_due_at',
    'sla_first_response_risk_at', 'sla_first_response_at', 'sla_first_response_state',
    'sla_resolution_due_at', 'sla_resolution_risk_at', 'sla_resolution_state',
    'sla_paused_at', 'sla_stopped_at', 'sla_evaluated_at', 'sla_fr_risk_notified_at',
    'sla_fr_breach_notified_at', 'sla_res_risk_notified_at', 'sla_res_breach_notified_at'];
BEGIN
  -- ---- 1. keep clients out of the SLA columns --------------------------
  IF TG_OP = 'INSERT' THEN
    NEW.sla_policy_id := NULL;
    NEW.sla_first_response_due_at := NULL;
    NEW.sla_first_response_risk_at := NULL;
    NEW.sla_first_response_at := NULL;
    NEW.sla_first_response_state := 'none';
    NEW.sla_resolution_due_at := NULL;
    NEW.sla_resolution_risk_at := NULL;
    NEW.sla_resolution_state := 'none';
    NEW.sla_paused_at := NULL;
    NEW.sla_stopped_at := NULL;
    NEW.sla_evaluated_at := NULL;
    NEW.sla_fr_risk_notified_at := NULL;
    NEW.sla_fr_breach_notified_at := NULL;
    NEW.sla_res_risk_notified_at := NULL;
    NEW.sla_res_breach_notified_at := NULL;
  ELSIF NOT v_trusted THEN
    NEW.sla_policy_id := OLD.sla_policy_id;
    NEW.sla_first_response_due_at := OLD.sla_first_response_due_at;
    NEW.sla_first_response_risk_at := OLD.sla_first_response_risk_at;
    NEW.sla_first_response_at := OLD.sla_first_response_at;
    NEW.sla_first_response_state := OLD.sla_first_response_state;
    NEW.sla_resolution_due_at := OLD.sla_resolution_due_at;
    NEW.sla_resolution_risk_at := OLD.sla_resolution_risk_at;
    NEW.sla_resolution_state := OLD.sla_resolution_state;
    NEW.sla_paused_at := OLD.sla_paused_at;
    NEW.sla_stopped_at := OLD.sla_stopped_at;
    NEW.sla_evaluated_at := OLD.sla_evaluated_at;
    NEW.sla_fr_risk_notified_at := OLD.sla_fr_risk_notified_at;
    NEW.sla_fr_breach_notified_at := OLD.sla_fr_breach_notified_at;
    NEW.sla_res_risk_notified_at := OLD.sla_res_risk_notified_at;
    NEW.sla_res_breach_notified_at := OLD.sla_res_breach_notified_at;
  END IF;
  v_new := NEW;

  v_relevant := (TG_OP = 'INSERT');
  IF TG_OP = 'UPDATE' THEN
    v_relevant := NEW.status IS DISTINCT FROM OLD.status
      OR NEW.priority IS DISTINCT FROM OLD.priority
      OR NEW.category IS DISTINCT FROM OLD.category
      OR NEW.labels IS DISTINCT FROM OLD.labels
      OR NEW.assigned_team_id IS DISTINCT FROM OLD.assigned_team_id
      OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
      OR NEW.sla_policy_id IS DISTINCT FROM OLD.sla_policy_id
      OR NEW.sla_first_response_at IS DISTINCT FROM OLD.sla_first_response_at;
  END IF;

  IF v_relevant THEN
  BEGIN
    v_is_act := NEW.status IN ('open', 'in_progress', 'pending');

    IF TG_OP = 'INSERT' THEN
      v_pol_id := sla_match_policy(NEW.account_id, NEW.priority, NEW.category, NEW.labels,
                                   NEW.assigned_team_id, NEW.conversation_id);
      IF v_pol_id IS NOT NULL THEN
        SELECT * INTO v_pol FROM ticket_sla_policies WHERE id = v_pol_id;
        v_new := sla_t_apply(v_new, v_pol, v_now);
      END IF;

    ELSE
      v_was_act := OLD.status IN ('open', 'in_progress', 'pending');

      IF OLD.sla_policy_id IS NOT NULL AND NEW.sla_policy_id IS NULL AND v_trusted THEN
        -- The policy was deleted (FK set null): running / paused targets end.
        v_new.sla_policy_id := OLD.sla_policy_id;   -- so the re-match sees a change
        v_new := sla_t_rematch(v_new, NULL, v_now);

      ELSIF OLD.sla_policy_id IS NULL AND NEW.sla_policy_id IS NOT NULL AND v_trusted THEN
        -- "Apply to open tickets": start from created_at under the given policy.
        SELECT * INTO v_pol FROM ticket_sla_policies WHERE id = NEW.sla_policy_id;
        IF v_pol.id IS NOT NULL THEN
          v_new := sla_t_apply(v_new, v_pol, v_now);
        ELSE
          v_new.sla_policy_id := NULL;
        END IF;

      ELSE
        -- ---- first response recorded (trusted only) ---------------------
        IF v_trusted AND OLD.sla_first_response_at IS NULL AND NEW.sla_first_response_at IS NOT NULL THEN
          IF NEW.sla_first_response_state = 'paused' THEN
            -- the clock was stopped (and settled) when it paused: on time
            v_new.sla_first_response_state := 'met';
          ELSIF NEW.sla_first_response_state = 'running' THEN
            v_new.sla_first_response_state :=
              CASE WHEN NEW.sla_first_response_due_at IS NULL
                        OR NEW.sla_first_response_at <= NEW.sla_first_response_due_at
                   THEN 'met' ELSE 'breached' END;
          END IF;
        END IF;

        -- ---- status transitions -----------------------------------------
        IF NEW.status IS DISTINCT FROM OLD.status AND NEW.sla_policy_id IS NOT NULL THEN
          SELECT * INTO v_pol FROM ticket_sla_policies WHERE id = NEW.sla_policy_id;
          IF v_pol.id IS NOT NULL THEN
            IF NOT v_was_act AND v_is_act THEN
              v_new := sla_t_restart(v_new, v_pol, v_now);
              IF NEW.status = 'pending' AND v_pol.pause_while_pending THEN
                v_new := sla_t_pause(v_new, v_now);
              END IF;
            ELSIF v_was_act AND NOT v_is_act THEN
              v_new := sla_t_stop(v_new, v_now);
            ELSIF NEW.status = 'pending' AND OLD.status <> 'pending' AND v_pol.pause_while_pending THEN
              v_new := sla_t_pause(v_new, v_now);
            ELSIF OLD.status = 'pending' AND NEW.status <> 'pending' THEN
              v_new := sla_t_resume(v_new, v_pol, v_now);
            END IF;
            v_new.sla_evaluated_at := v_now;
          END IF;
        END IF;

        -- ---- attributes that select the policy ----------------------------
        IF v_is_act AND (NEW.priority IS DISTINCT FROM OLD.priority
                         OR NEW.category IS DISTINCT FROM OLD.category
                         OR NEW.labels IS DISTINCT FROM OLD.labels
                         OR NEW.assigned_team_id IS DISTINCT FROM OLD.assigned_team_id
                         OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id) THEN
          v_pol_id := sla_match_policy(NEW.account_id, NEW.priority, NEW.category, NEW.labels,
                                       NEW.assigned_team_id, NEW.conversation_id);
          v_new := sla_t_rematch(v_new, v_pol_id, v_now);
        END IF;
      END IF;
    END IF;

    NEW := v_new;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ticket_sla_state failed for ticket %: %', NEW.id, SQLERRM;
  END;
  END IF;

  -- Only SLA bookkeeping changed: do not count it as an edit.
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - v_cols) = (to_jsonb(OLD) - v_cols) THEN
      NEW.updated_at := OLD.updated_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ticket_sla_state ON public.tickets;
CREATE TRIGGER ticket_sla_state
  BEFORE INSERT OR UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.ticket_sla_state();

-- ------------------------------------------------------------
-- 10. First response: the first comment by a Vircle user
--
-- This is the definition Reports > Tickets already uses (the earliest
-- ticket_comments row on the ticket), narrowed to what a customer-facing
-- SLA needs: written by a person (author_id set) and not synced from Jira.
-- Jira-sourced notes are detected from the row itself so this migration
-- does not depend on 085's column being present.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ticket_sla_first_response()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.author_id IS NULL OR COALESCE(to_jsonb(NEW) ->> 'source', 'vircle') <> 'vircle' THEN
    RETURN NEW;
  END IF;
  UPDATE tickets
     SET sla_first_response_at = NEW.created_at
   WHERE id = NEW.ticket_id
     AND sla_first_response_at IS NULL;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'ticket_sla_first_response failed for comment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ticket_sla_first_response ON public.ticket_comments;
CREATE TRIGGER ticket_sla_first_response
  AFTER INSERT ON public.ticket_comments
  FOR EACH ROW EXECUTE FUNCTION public.ticket_sla_first_response();

-- ------------------------------------------------------------
-- 11. Notification types (rebuilt from the LIVE definition)
--
-- pg_get_constraintdef prints a list CHECK in one of two shapes:
--   ARRAY['a'::text, 'b'::text]   or   '{a,b,c}'::text[]
-- the helper reads both, so this can run after any earlier rebuild and can
-- be re-run. It is dropped at the end of the migration.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sla_check_values(p_def text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(DISTINCT v), ARRAY[]::text[])
    FROM (
      SELECT unnest(
               CASE WHEN m[1] ~ '^\{.*\}$'
                    THEN string_to_array(replace(btrim(m[1], '{}'), '"', ''), ',')
                    ELSE ARRAY[m[1]] END) AS v
        FROM regexp_matches(COALESCE(p_def, ''), '''([^'']+)''::text', 'g') AS m
    ) s;
$$;

DO $$
DECLARE
  v_def   TEXT;
  v_types TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';

  v_types := public.sla_check_values(v_def);
  -- sla_breach: written by the conversation SLA cron (049); migration 081
  -- rebuilt the list without it, so restore it here.
  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY['sla_breach', 'ticket_sla_at_risk', 'ticket_sla_breached']) AS x);

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

-- ------------------------------------------------------------
-- 12. The sweep (service role, called by GET /api/sla/tickets-cron)
--
-- 1. running targets past due -> breached (batch of p_limit tickets);
-- 2. once-only notifications (batch of p_limit tickets):
--      at risk  : running, risk instant passed, no risk notice yet
--      breached : breached, no breach notice yet (a breach also settles the
--                 risk notice, so nobody gets "at risk" after "breached")
--    Recipients: the assignee, or every Owner/Admin holding tickets.work when
--    unassigned, plus everyone watching the ticket.
-- FOR UPDATE SKIP LOCKED: two overlapping runs never take the same ticket.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sla_notify_ticket(
  p_ticket_id uuid,
  p_target    text,   -- 'first_response' | 'resolution'
  p_kind      text    -- 'at_risk' | 'breached'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t       public.tickets;
  v_key   TEXT;
  v_title TEXT;
  v_users UUID[];
  u       UUID;
  n       INTEGER := 0;
BEGIN
  SELECT * INTO t FROM tickets WHERE id = p_ticket_id;
  IF t.id IS NULL THEN RETURN 0; END IF;
  SELECT ticket_key_prefix || '-' || t.ticket_number INTO v_key FROM accounts WHERE id = t.account_id;
  v_title := CASE p_target WHEN 'first_response' THEN 'First response' ELSE 'Resolution' END
             || CASE p_kind WHEN 'breached' THEN ' SLA breached' ELSE ' SLA at risk' END;

  SELECT array_agg(DISTINCT x.uid) INTO v_users
    FROM (
      SELECT t.assigned_agent_id AS uid WHERE t.assigned_agent_id IS NOT NULL
      UNION
      SELECT p.user_id FROM profiles p
       WHERE t.assigned_agent_id IS NULL
         AND p.account_id = t.account_id
         AND p.account_role IN ('owner', 'admin')
         AND effective_capability(p.account_id, p.account_role, 'tickets.work')
      UNION
      SELECT w.user_id FROM ticket_watchers w WHERE w.ticket_id = t.id
    ) x
   WHERE x.uid IS NOT NULL
     AND EXISTS (SELECT 1 FROM profiles pp WHERE pp.user_id = x.uid AND pp.account_id = t.account_id);

  FOREACH u IN ARRAY COALESCE(v_users, ARRAY[]::uuid[]) LOOP
    INSERT INTO notifications (account_id, user_id, type, ticket_id, contact_id, title, body)
    VALUES (t.account_id, u,
            CASE p_kind WHEN 'breached' THEN 'ticket_sla_breached' ELSE 'ticket_sla_at_risk' END,
            t.id, t.contact_id, v_title, v_key || ' · ' || left(t.subject, 160));
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

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

  -- 1. breach marking
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
      WHERE x.status IN ('open', 'in_progress', 'pending')
        AND ((x.sla_first_response_state = 'running' AND x.sla_first_response_due_at < v_now)
          OR (x.sla_resolution_state = 'running' AND x.sla_resolution_due_at < v_now))
      ORDER BY x.id
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS v_breached = ROW_COUNT;

  -- 2. notifications, once per ticket, target and kind
  FOR r IN
    SELECT x.id
      FROM tickets x
     WHERE x.status IN ('open', 'in_progress', 'pending')
       AND ((x.sla_first_response_state = 'breached' AND x.sla_fr_breach_notified_at IS NULL)
         OR (x.sla_resolution_state = 'breached' AND x.sla_res_breach_notified_at IS NULL)
         OR (x.sla_first_response_state = 'running' AND x.sla_first_response_risk_at <= v_now
             AND x.sla_fr_risk_notified_at IS NULL)
         OR (x.sla_resolution_state = 'running' AND x.sla_resolution_risk_at <= v_now
             AND x.sla_res_risk_notified_at IS NULL))
     ORDER BY x.id
     LIMIT p_limit
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

-- ------------------------------------------------------------
-- 13. Apply to open tickets (one-time button)
--
-- Tickets that are open / in progress / pending and have no SLA at all get
-- the first matching policy, computed from their created_at (so an old
-- ticket can start out breached). p_dry_run = true only counts.
-- Callable by a member holding sla.configure; the service role may too.
-- Capped at 5000 tickets a call: `truncated` says when more remain.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sla_apply_to_open_tickets(
  p_account uuid,
  p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r         RECORD;
  v_pol     public.ticket_sla_policies;
  v_pol_id  UUID;
  v_matched INTEGER := 0;
  v_overdue INTEGER := 0;
  v_seen    INTEGER := 0;
  v_due     TIMESTAMPTZ;
  v_res     TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT has_capability(p_account, 'sla.configure') THEN
    RAISE EXCEPTION 'sla_apply: not allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT p_dry_run THEN PERFORM set_config('vircle.sla_internal', 'on', true); END IF;

  FOR r IN
    SELECT t.* FROM tickets t
     WHERE t.account_id = p_account
       AND t.status IN ('open', 'in_progress', 'pending')
       AND t.sla_policy_id IS NULL
       AND t.sla_first_response_state = 'none'
       AND t.sla_resolution_state = 'none'
     ORDER BY t.created_at
     LIMIT 5000
  LOOP
    v_seen := v_seen + 1;
    v_pol_id := sla_match_policy(r.account_id, r.priority, r.category, r.labels,
                                 r.assigned_team_id, r.conversation_id);
    CONTINUE WHEN v_pol_id IS NULL;
    v_matched := v_matched + 1;
    SELECT * INTO v_pol FROM ticket_sla_policies WHERE id = v_pol_id;
    v_due := sla_due(v_pol.schedule_id, r.created_at, v_pol.first_response_minutes);
    v_res := sla_due(v_pol.schedule_id, r.created_at, v_pol.resolution_minutes);
    IF (v_due IS NOT NULL AND r.sla_first_response_at IS NULL AND v_due < now())
       OR (v_res IS NOT NULL AND v_res < now()) THEN
      v_overdue := v_overdue + 1;
    END IF;
    IF NOT p_dry_run THEN
      UPDATE tickets SET sla_policy_id = v_pol_id WHERE id = r.id;
    END IF;
  END LOOP;

  IF NOT p_dry_run THEN PERFORM set_config('vircle.sla_internal', '', true); END IF;
  RETURN jsonb_build_object(
    'matched', v_matched, 'overdue', v_overdue, 'examined', v_seen,
    'truncated', v_seen >= 5000, 'applied', NOT p_dry_run);
END;
$$;

-- ------------------------------------------------------------
-- 14. Reorder policies (drag and drop): position = index + 1
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sla_reorder_policies(p_account uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i INTEGER;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT has_capability(p_account, 'sla.configure') THEN
    RAISE EXCEPTION 'sla_reorder: not allowed' USING ERRCODE = '42501';
  END IF;
  FOR i IN 1..COALESCE(array_length(p_ids, 1), 0) LOOP
    UPDATE ticket_sla_policies SET position = i
     WHERE id = p_ids[i] AND account_id = p_account AND position IS DISTINCT FROM i;
  END LOOP;
END;
$$;

-- ------------------------------------------------------------
-- 15. Report: SLA compliance for tickets created in a range
--
-- SECURITY INVOKER, so RLS (members of the account only) applies. "running"
-- counts running and paused targets.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ticket_sla_report(
  p_account uuid,
  p_from    timestamptz,
  p_to      timestamptz,
  p_limit   integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_now    TIMESTAMPTZ := now();
  v_result JSONB;
BEGIN
  WITH t AS (
    SELECT id, ticket_number, subject, priority, assigned_team_id, assigned_agent_id,
           sla_first_response_state AS fr, sla_resolution_state AS res,
           sla_first_response_due_at, sla_resolution_due_at,
           sla_first_response_at, sla_stopped_at
      FROM tickets
     WHERE account_id = p_account
       AND created_at >= p_from AND created_at < p_to
       AND (sla_first_response_state <> 'none' OR sla_resolution_state <> 'none')
  ),
  total AS (
    SELECT jsonb_build_object(
      'firstResponse', jsonb_build_object(
        'met',      count(*) FILTER (WHERE fr = 'met'),
        'breached', count(*) FILTER (WHERE fr = 'breached'),
        'running',  count(*) FILTER (WHERE fr IN ('running', 'paused'))),
      'resolution', jsonb_build_object(
        'met',      count(*) FILTER (WHERE res = 'met'),
        'breached', count(*) FILTER (WHERE res = 'breached'),
        'running',  count(*) FILTER (WHERE res IN ('running', 'paused')))) AS j
      FROM t
  ),
  by_priority AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'key', priority,
             'firstResponse', jsonb_build_object('met', frm, 'breached', frb, 'running', frr),
             'resolution', jsonb_build_object('met', rsm, 'breached', rsb, 'running', rsr))
           ORDER BY array_position(ARRAY['urgent', 'high', 'normal', 'low'], priority)), '[]'::jsonb) AS j
      FROM (
        SELECT priority,
               count(*) FILTER (WHERE fr = 'met') AS frm,
               count(*) FILTER (WHERE fr = 'breached') AS frb,
               count(*) FILTER (WHERE fr IN ('running', 'paused')) AS frr,
               count(*) FILTER (WHERE res = 'met') AS rsm,
               count(*) FILTER (WHERE res = 'breached') AS rsb,
               count(*) FILTER (WHERE res IN ('running', 'paused')) AS rsr
          FROM t GROUP BY priority) g
  ),
  by_team AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'key', COALESCE(team_id::text, ''),
             'label', team_name,
             'firstResponse', jsonb_build_object('met', frm, 'breached', frb, 'running', frr),
             'resolution', jsonb_build_object('met', rsm, 'breached', rsb, 'running', rsr))
           ORDER BY (frm + frb + frr + rsm + rsb + rsr) DESC, team_name NULLS LAST), '[]'::jsonb) AS j
      FROM (
        SELECT t.assigned_team_id AS team_id, tm.name AS team_name,
               count(*) FILTER (WHERE fr = 'met') AS frm,
               count(*) FILTER (WHERE fr = 'breached') AS frb,
               count(*) FILTER (WHERE fr IN ('running', 'paused')) AS frr,
               count(*) FILTER (WHERE res = 'met') AS rsm,
               count(*) FILTER (WHERE res = 'breached') AS rsb,
               count(*) FILTER (WHERE res IN ('running', 'paused')) AS rsr
          FROM t LEFT JOIN teams tm ON tm.id = t.assigned_team_id
         GROUP BY t.assigned_team_id, tm.name) g
  ),
  late AS (
    SELECT * FROM (
      SELECT id, ticket_number, subject, assigned_agent_id, 'first_response'::text AS target,
             sla_first_response_due_at AS due_at,
             floor(EXTRACT(epoch FROM (COALESCE(sla_first_response_at, sla_stopped_at, v_now)
                                       - sla_first_response_due_at)))::bigint AS overdue_seconds
        FROM t WHERE fr = 'breached' AND sla_first_response_due_at IS NOT NULL
      UNION ALL
      SELECT id, ticket_number, subject, assigned_agent_id, 'resolution'::text,
             sla_resolution_due_at,
             floor(EXTRACT(epoch FROM (COALESCE(sla_stopped_at, v_now) - sla_resolution_due_at)))::bigint
        FROM t WHERE res = 'breached' AND sla_resolution_due_at IS NOT NULL
    ) u
    ORDER BY overdue_seconds DESC
    LIMIT GREATEST(COALESCE(p_limit, 25), 1)
  ),
  late_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'ticketId', id, 'ticketNumber', ticket_number, 'subject', subject,
             'assigneeId', assigned_agent_id, 'target', target,
             'dueAt', due_at, 'overdueSeconds', overdue_seconds)
           ORDER BY overdue_seconds DESC), '[]'::jsonb) AS j
      FROM late
  )
  SELECT total.j
         || jsonb_build_object('byPriority', by_priority.j, 'byTeam', by_team.j, 'breached', late_json.j)
    INTO v_result
    FROM total, by_priority, by_team, late_json;
  RETURN v_result;
END;
$$;

-- ------------------------------------------------------------
-- 16. Audit triggers (082's generic row trigger)
--   Column values for small fields; names only for the long ones. position
--   is not tracked, so a drag-reorder writes no audit rows.
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS audit_row_change ON public.business_hours_schedules;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.business_hours_schedules
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'business_hours', 'name', 'name,timezone,is_default', 'weekly', '', '');

DROP TRIGGER IF EXISTS audit_row_change ON public.business_hours_holidays;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.business_hours_holidays
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'business_hours_holiday', 'name', 'name,holiday_date', '', '', '');

DROP TRIGGER IF EXISTS audit_row_change ON public.ticket_sla_policies;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.ticket_sla_policies
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'sla_policy', 'name',
    'name,is_active,first_response_minutes,resolution_minutes,schedule_id,pause_while_pending,at_risk_percent',
    'conditions', '', '');

-- ------------------------------------------------------------
-- 17. Privileges
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.sla_sweep(integer)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sla_notify_ticket(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sla_sweep(integer)        TO service_role;
GRANT EXECUTE ON FUNCTION public.sla_notify_ticket(uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.sla_apply_to_open_tickets(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sla_apply_to_open_tickets(uuid, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.sla_reorder_policies(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sla_reorder_policies(uuid, uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ticket_sla_report(uuid, timestamptz, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ticket_sla_report(uuid, timestamptz, timestamptz, integer) TO authenticated, service_role;

-- The trigger functions are called by triggers only.
REVOKE ALL ON FUNCTION public.ticket_sla_state()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ticket_sla_first_response() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sla_schedule_before_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sla_schedule_after_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sla_holiday_before_write()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sla_policy_before_write()   FROM PUBLIC, anon, authenticated;

-- The reading helper is not needed after the rebuild above.
DROP FUNCTION IF EXISTS public.sla_check_values(text);
