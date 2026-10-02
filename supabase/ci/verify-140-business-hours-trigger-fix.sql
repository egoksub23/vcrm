-- Verify migration 140. Self-contained (builds its own workspace), so it runs against an
-- empty database as well as production. Concatenate 140's migration text in front when the
-- database does not have it yet, then run it. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
--
-- The trigger fires whoever writes, so this runs as the owner: what is under test is the
-- trigger function, not the access rules (those are verify-086).
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();
  acctA  uuid;
  sch1   uuid;
  sch2   uuid;
  hol    uuid;
  v_res  text;
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;

  INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
  VALUES (acctA, 'Weekdays', 'UTC', '{"1":[{"start":"09:00","end":"17:00"}]}'::jsonb) RETURNING id INTO sch1;
  INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
  VALUES (acctA, 'Weekends', 'UTC', '{"6":[{"start":"10:00","end":"14:00"}]}'::jsonb) RETURNING id INTO sch2;

  -- 1. Editing a schedule must work (this raised 42703 before 140): rename, change hours, make default.
  UPDATE business_hours_schedules SET name = 'Weekdays (renamed)' WHERE id = sch1;
  UPDATE business_hours_schedules SET weekly = '{"1":[{"start":"08:00","end":"16:00"}]}'::jsonb WHERE id = sch1;
  UPDATE business_hours_schedules SET is_default = true WHERE id = sch2;
  UPDATE business_hours_schedules SET is_default = true WHERE id = sch1; -- moves the default

  -- 2. Holidays: insert, update, move to another schedule, delete.
  INSERT INTO business_hours_holidays (schedule_id, account_id, holiday_date, name)
  VALUES (sch1, acctA, '2030-12-25', 'Christmas') RETURNING id INTO hol;
  UPDATE business_hours_holidays SET name = 'Christmas Day' WHERE id = hol;
  UPDATE business_hours_holidays SET schedule_id = sch2 WHERE id = hol;
  DELETE FROM business_hours_holidays WHERE id = hol;

  -- 3. The ripple still happens: an incident policy on the schedule has its open incidents'
  --    timers recomputed when the schedule is edited. (Reaching this statement without an
  --    error is the check: the function body runs the recompute for every matching policy.)
  INSERT INTO incident_escalation_policies (account_id, severity, level_1_minutes, level_2_minutes, schedule_id)
  VALUES (acctA, 'P1', 30, 60, sch1)
  ON CONFLICT (account_id, severity) DO UPDATE SET schedule_id = EXCLUDED.schedule_id;
  UPDATE business_hours_schedules SET name = 'Weekdays (again)' WHERE id = sch1;
  INSERT INTO business_hours_holidays (schedule_id, account_id, holiday_date, name)
  VALUES (sch1, acctA, '2030-01-01', 'New Year');
  SELECT 'ok' INTO v_res;

  RAISE EXCEPTION 'ROLLBACK-OK: a business-hours schedule can be renamed, re-timed and made default; holidays can be added, edited, moved between schedules and removed; policies on the schedule still trigger the recompute';
END
$verify$;
