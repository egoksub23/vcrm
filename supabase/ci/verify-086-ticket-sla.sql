-- ============================================================
-- Verification for migration 086 (ticket SLA with business hours).
--
-- Run against a database that already has 086 applied:
--   supabase db query --linked -f supabase/ci/verify-086-ticket-sla.sql
--
-- Or BEFORE applying, together with the draft (the whole thing rolls back):
--   cat supabase/ci/drafts/086_ticket_sla.sql supabase/ci/verify-086-ticket-sla.sql > /tmp/both.sql
--   supabase db query --linked -f /tmp/both.sql
--
-- Everything happens inside one DO block that ends with
-- RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing is ever committed.
-- A message starting with ROLLBACK-OK means every check passed; any other
-- error message names the check that failed.
--
-- People are simulated the way PostgREST does it: set the JWT claims and
-- SET LOCAL ROLE authenticated, so RLS applies for real.
--
-- Time: the ticket trigger uses now(), which does not move inside one
-- transaction. Clock passing is simulated by shifting the stored sla_*
-- timestamps back (pg_temp.shift), which is exactly what a pause of that
-- length would have left in the row.
--
-- The parity fixtures (section 2) are generated from
-- src/lib/sla/business-time.fixtures.ts: the same cases and answers that
-- business-time.test.ts asserts in TypeScript.
-- ============================================================

DO $verify$
DECLARE
  a        UUID;
  b        UUID;
  owner_a  UUID := gen_random_uuid();
  admin_a  UUID := gen_random_uuid();
  agent_a  UUID := gen_random_uuid();
  agent2_a UUID := gen_random_uuid();
  viewer_a UUID := gen_random_uuid();
  owner_b  UUID := gen_random_uuid();
  contact_a UUID := gen_random_uuid();
  contact_b UUID := gen_random_uuid();
  conv_a   UUID := gen_random_uuid();
  n        INTEGER := 0;
  res      TEXT;
  cnt      INTEGER;
  rec      RECORD;
  v_id     UUID;
  v_ts     TIMESTAMPTZ;
  v_int    INTEGER;
  sc_ny    UUID;
  sc_kl    UUID;
  sch2     UUID;
  sch3     UUID;
  p_urgent UUID;
  p_bill   UUID;
  p_all    UUID;
  p_vip    UUID;
  p_email  UUID;
  p_x      UUID;
  p_b      UUID;
  t1 UUID; t2 UUID; t3 UUID; t4 UUID; t5 UUID; t6 UUID; t7 UUID; t8 UUID;
  tk UUID; tl UUID; tm UUID; tx UUID;
  tb1 UUID; tb2 UUID; tb3 UUID;
  upd_before TIMESTAMPTZ;
  j        JSONB;
BEGIN
  -- ---------------------------------------------------------
  -- helpers (temp functions live only for this session)
  -- ---------------------------------------------------------
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      IF u IS NULL THEN
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
      ELSE
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', u, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.jwt.claim.sub', u::text, true);
      END IF;
      EXECUTE format('SET LOCAL ROLE %I', r);
      BEGIN
        IF q ~* '^\s*(select|with)' THEN
          EXECUTE q INTO res;
        ELSE
          EXECUTE q;
        END IF;
        res := COALESCE(res, 'OK');
      EXCEPTION WHEN OTHERS THEN
        res := 'ERR ' || SQLSTATE || ': ' || SQLERRM;
      END;
      EXECUTE 'RESET ROLE';
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      RETURN res;
    END $b$;
  $f$;

  -- a new ticket (as postgres); returns its id
  EXECUTE $f$
    CREATE FUNCTION pg_temp.mk(p_acct UUID, p_contact UUID, p_prio TEXT, p_cat TEXT,
                               p_status TEXT, p_created TIMESTAMPTZ, p_assignee UUID DEFAULT NULL,
                               p_labels TEXT[] DEFAULT '{}', p_conv UUID DEFAULT NULL) RETURNS UUID
    LANGUAGE plpgsql AS $b$
    DECLARE v_id UUID := gen_random_uuid();
    BEGIN
      INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, priority, category,
                           status, created_at, assigned_agent_id, labels, conversation_id)
      VALUES (v_id, p_acct, (SELECT COALESCE(max(ticket_number), 0) + 1 FROM tickets WHERE account_id = p_acct),
              p_contact, 'SLA test ' || left(v_id::text, 6), p_prio, p_cat, p_status, p_created,
              p_assignee, p_labels, p_conv);
      RETURN v_id;
    END $b$;
  $f$;

  -- compact SLA state of a ticket: 'fr/res/paused?'
  EXECUTE $f$
    CREATE FUNCTION pg_temp.st(p_id UUID) RETURNS TEXT
    LANGUAGE sql AS $b$
      SELECT sla_first_response_state || '/' || sla_resolution_state || '/' || (sla_paused_at IS NOT NULL)::text
        FROM tickets WHERE id = p_id;
    $b$;
  $f$;

  -- pretend p_min minutes have passed since the SLA columns were last written
  EXECUTE $f$
    CREATE FUNCTION pg_temp.shift(p_id UUID, p_min INTEGER) RETURNS VOID
    LANGUAGE plpgsql AS $b$
    BEGIN
      PERFORM set_config('vircle.sla_internal', 'on', true);
      UPDATE tickets SET
        sla_paused_at = sla_paused_at - make_interval(mins => p_min),
        sla_stopped_at = sla_stopped_at - make_interval(mins => p_min),
        sla_first_response_due_at = sla_first_response_due_at - make_interval(mins => p_min),
        sla_first_response_risk_at = sla_first_response_risk_at - make_interval(mins => p_min),
        sla_resolution_due_at = sla_resolution_due_at - make_interval(mins => p_min),
        sla_resolution_risk_at = sla_resolution_risk_at - make_interval(mins => p_min)
       WHERE id = p_id;
      PERFORM set_config('vircle.sla_internal', '', true);
    END $b$;
  $f$;

  -- run an internal write to sla_* columns as postgres
  EXECUTE $f$
    CREATE FUNCTION pg_temp.internal(p_sql TEXT) RETURNS VOID
    LANGUAGE plpgsql AS $b$
    BEGIN
      PERFORM set_config('vircle.sla_internal', 'on', true);
      EXECUTE p_sql;
      PERFORM set_config('vircle.sla_internal', '', true);
    END $b$;
  $f$;

  EXECUTE $f$
    CREATE FUNCTION pg_temp.ac(p_acct UUID, p_where TEXT) RETURNS INTEGER
    LANGUAGE plpgsql AS $b$
    DECLARE c INTEGER;
    BEGIN
      EXECUTE format('SELECT count(*)::int FROM audit_log WHERE account_id = %L AND (%s)', p_acct, p_where)
        INTO c;
      RETURN c;
    END $b$;
  $f$;

  EXECUTE $f$
    CREATE FUNCTION pg_temp.nc(p_user UUID, p_type TEXT, p_ticket UUID) RETURNS INTEGER
    LANGUAGE sql AS $b$
      SELECT count(*)::int FROM notifications
       WHERE user_id = p_user AND type = p_type AND ticket_id = p_ticket;
    $b$;
  $f$;

  -- ---------------------------------------------------------
  -- fixtures: users -> (trigger) accounts + profiles
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify086-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, admin_a, agent_a, agent2_a, viewer_a, owner_b]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create accounts';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'admin'  WHERE user_id = admin_a;
  UPDATE profiles SET account_id = a, account_role = 'agent'  WHERE user_id IN (agent_a, agent2_a);
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = viewer_a;
  DELETE FROM accounts WHERE owner_user_id IN (admin_a, agent_a, agent2_a, viewer_a);
  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (contact_a, owner_a, a, '+10000000086', 'Casey');
  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (contact_b, owner_b, b, '+10000000087', 'Robin');
  INSERT INTO conversations (id, user_id, account_id, contact_id) VALUES (conv_a, owner_a, a, contact_a);

  -- ---------------------------------------------------------
  -- 1. Capability: catalogue, defaults, database tier, Viewer guard
  -- ---------------------------------------------------------
  IF (SELECT count(*) FROM capability_catalogue
       WHERE capability = 'sla.configure' AND min_grant_role = 'agent' AND enforced_by = 'database') <> 1 THEN
    RAISE EXCEPTION 'FAIL sla.configure missing from the catalogue';
  END IF;
  IF (SELECT array_agg(role::text ORDER BY role::text) FROM role_capability_defaults
       WHERE capability = 'sla.configure') IS DISTINCT FROM ARRAY['admin', 'owner'] THEN
    RAISE EXCEPTION 'FAIL sla.configure defaults are Owner + Admin only';
  END IF;
  IF pg_temp.run(owner_a,  format('SELECT has_capability(%L, ''sla.configure'')::text', a)) <> 'true'
  OR pg_temp.run(admin_a,  format('SELECT has_capability(%L, ''sla.configure'')::text', a)) <> 'true'
  OR pg_temp.run(agent_a,  format('SELECT has_capability(%L, ''sla.configure'')::text', a)) <> 'false'
  OR pg_temp.run(viewer_a, format('SELECT has_capability(%L, ''sla.configure'')::text', a)) <> 'false' THEN
    RAISE EXCEPTION 'FAIL default sla.configure parity';
  END IF;
  res := pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'viewer', '{"sla.configure": true}'::jsonb)::text$q$, a));
  IF res NOT LIKE 'ERR 22023%' THEN
    RAISE EXCEPTION 'FAIL a Viewer must not be grantable sla.configure: %', res;
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 2. Business-time functions: parity with the TypeScript fixtures
  -- ---------------------------------------------------------
  -- schedules: (key, timezone, weekly, holidays)
  CREATE TEMP TABLE fx_sched (k text, tz text, weekly jsonb, hol text[]) ON COMMIT DROP;
  INSERT INTO fx_sched VALUES
    ('NY', 'America/New_York', '{"1":[{"start":"09:00","end":"18:00"}],"2":[{"start":"09:00","end":"18:00"}],"3":[{"start":"09:00","end":"18:00"}],"4":[{"start":"09:00","end":"18:00"}],"5":[{"start":"09:00","end":"18:00"}],"6":[],"7":[]}'::jsonb, ARRAY['2026-09-07']::text[]),
    ('KL', 'Asia/Kuala_Lumpur', '{"1":[{"start":"09:00","end":"12:00"},{"start":"13:00","end":"17:00"}],"2":[{"start":"09:00","end":"12:00"},{"start":"13:00","end":"17:00"}],"3":[{"start":"09:00","end":"12:00"},{"start":"13:00","end":"17:00"}],"4":[{"start":"09:00","end":"12:00"},{"start":"13:00","end":"17:00"}],"5":[{"start":"09:00","end":"12:00"},{"start":"13:00","end":"17:00"}],"6":[],"7":[]}'::jsonb, ARRAY[]::text[]),
    ('NIGHT_NY', 'America/New_York', '{"1":[{"start":"00:00","end":"04:00"}],"2":[{"start":"00:00","end":"04:00"}],"3":[{"start":"00:00","end":"04:00"}],"4":[{"start":"00:00","end":"04:00"}],"5":[{"start":"00:00","end":"04:00"}],"6":[{"start":"00:00","end":"04:00"}],"7":[{"start":"00:00","end":"04:00"}]}'::jsonb, ARRAY[]::text[]),
    ('NIGHT_SYD', 'Australia/Sydney', '{"1":[{"start":"00:00","end":"04:00"}],"2":[{"start":"00:00","end":"04:00"}],"3":[{"start":"00:00","end":"04:00"}],"4":[{"start":"00:00","end":"04:00"}],"5":[{"start":"00:00","end":"04:00"}],"6":[{"start":"00:00","end":"04:00"}],"7":[{"start":"00:00","end":"04:00"}]}'::jsonb, ARRAY[]::text[]);
  CREATE TEMP TABLE fx_add (name text, sched text, from_ts timestamptz, minutes int, expected timestamptz) ON COMMIT DROP;
  INSERT INTO fx_add VALUES
    ('normal day, spills into the next morning', 'NY', '2026-09-14T21:30:00Z', 45, '2026-09-15T13:15:00Z'),
    ('starts after hours, waits for Monday', 'NY', '2026-09-12T00:00:00Z', 60, '2026-09-14T14:00:00Z'),
    ('starts on a Saturday', 'NY', '2026-09-12T15:00:00Z', 30, '2026-09-14T13:30:00Z'),
    ('skips a holiday Monday', 'NY', '2026-09-04T21:00:00Z', 120, '2026-09-08T14:00:00Z'),
    ('ends exactly at closing time', 'NY', '2026-09-14T20:00:00Z', 120, '2026-09-14T22:00:00Z'),
    ('starts exactly at closing time', 'NY', '2026-09-14T22:00:00Z', 30, '2026-09-15T13:30:00Z'),
    ('starts exactly at opening time', 'NY', '2026-09-15T13:00:00Z', 30, '2026-09-15T13:30:00Z'),
    ('zero minutes outside hours changes nothing', 'NY', '2026-09-12T15:00:00Z', 0, '2026-09-12T15:00:00Z'),
    ('thirty business days (six weeks)', 'NY', '2026-09-14T13:00:00Z', 16200, '2026-10-23T22:00:00Z'),
    ('beyond the 366 day cap gives NULL', 'NY', '2026-09-14T13:00:00Z', 300000, NULL),
    ('no schedule is 24/7', NULL, '2026-09-14T21:30:00Z', 90, '2026-09-14T23:00:00Z'),
    ('two slots, lunch break in between (no DST zone)', 'KL', '2026-09-15T03:30:00Z', 120, '2026-09-15T06:30:00Z'),
    ('Friday evening in Kuala Lumpur waits for Monday', 'KL', '2026-09-18T10:00:00Z', 30, '2026-09-21T01:30:00Z'),
    ('DST spring forward, New York (3 real hours in the slot)', 'NIGHT_NY', '2026-03-08T05:30:00Z', 180, '2026-03-09T04:30:00Z'),
    ('DST fall back, New York (5 real hours in the slot)', 'NIGHT_NY', '2026-11-01T04:30:00Z', 240, '2026-11-01T08:30:00Z'),
    ('DST spring forward, Sydney (southern hemisphere)', 'NIGHT_SYD', '2026-10-03T14:30:00Z', 180, '2026-10-04T13:30:00Z'),
    ('DST fall back, Sydney (southern hemisphere)', 'NIGHT_SYD', '2026-04-04T13:30:00Z', 240, '2026-04-04T17:30:00Z');
  CREATE TEMP TABLE fx_between (name text, sched text, from_ts timestamptz, to_ts timestamptz, expected int) ON COMMIT DROP;
  INSERT INTO fx_between VALUES
    ('across the evening', 'NY', '2026-09-14T21:30:00Z', '2026-09-15T13:15:00Z', 45),
    ('across a weekend-free holiday Monday', 'NY', '2026-09-04T16:00:00Z', '2026-09-08T16:00:00Z', 540),
    ('Sydney spring forward night', 'NIGHT_SYD', '2026-10-03T14:00:00Z', '2026-10-04T14:00:00Z', 240),
    ('New York spring forward night', 'NIGHT_NY', '2026-03-08T00:00:00Z', '2026-03-09T00:00:00Z', 180),
    ('reversed range is zero', 'NY', '2026-09-15T13:15:00Z', '2026-09-14T21:30:00Z', 0),
    ('more than a year is NULL', 'NY', '2026-01-01T00:00:00Z', '2027-03-01T00:00:00Z', NULL),
    ('no schedule is wall time', NULL, '2026-09-14T21:30:00Z', '2026-09-14T23:00:00Z', 90);
  ALTER TABLE fx_sched ADD COLUMN id UUID;

  FOR rec IN SELECT k, tz, weekly, hol FROM fx_sched LOOP
    INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
    VALUES (a, 'fx ' || rec.k, rec.tz, rec.weekly) RETURNING id INTO v_id;
    UPDATE fx_sched SET id = v_id WHERE k = rec.k;
    INSERT INTO business_hours_holidays (schedule_id, account_id, holiday_date, name)
    SELECT v_id, a, h::date, 'fixture holiday' FROM unnest(rec.hol) AS h;
  END LOOP;
  SELECT id INTO sc_ny FROM fx_sched WHERE k = 'NY';
  SELECT id INTO sc_kl FROM fx_sched WHERE k = 'KL';

  FOR rec IN SELECT * FROM fx_add LOOP
    SELECT id INTO v_id FROM fx_sched WHERE k = rec.sched;
    v_ts := sla_add_business_minutes(v_id, rec.from_ts, rec.minutes);
    IF v_ts IS DISTINCT FROM rec.expected THEN
      RAISE EXCEPTION 'FAIL parity add "%": got % expected %', rec.name, v_ts, rec.expected;
    END IF;
    n := n + 1;
  END LOOP;
  FOR rec IN SELECT * FROM fx_between LOOP
    SELECT id INTO v_id FROM fx_sched WHERE k = rec.sched;
    v_int := sla_business_minutes_between(v_id, rec.from_ts, rec.to_ts);
    IF v_int IS DISTINCT FROM rec.expected THEN
      RAISE EXCEPTION 'FAIL parity between "%": got % expected %', rec.name, v_int, rec.expected;
    END IF;
    n := n + 1;
  END LOOP;
  -- the timezone rules the TypeScript mirror copies
  IF ('2026-03-08 02:30'::timestamp AT TIME ZONE 'America/New_York') <> '2026-03-08T07:30:00Z'::timestamptz
  OR ('2026-11-01 01:30'::timestamp AT TIME ZONE 'America/New_York') <> '2026-11-01T06:30:00Z'::timestamptz
  OR ('2026-10-04 02:30'::timestamp AT TIME ZONE 'Australia/Sydney') <> '2026-10-03T16:30:00Z'::timestamptz
  OR ('2026-04-05 02:30'::timestamp AT TIME ZONE 'Australia/Sydney') <> '2026-04-04T16:30:00Z'::timestamptz THEN
    RAISE EXCEPTION 'FAIL Postgres gap / overlap resolution differs from the TypeScript mirror';
  END IF;
  -- seconds precision, zero and negative
  IF sla_add_business_seconds(sc_ny, '2026-09-15T13:00:00Z', 90) <> '2026-09-15T13:01:30Z'::timestamptz
  OR sla_add_business_seconds(sc_ny, '2026-09-12T15:00:00Z', 0) <> '2026-09-12T15:00:00Z'::timestamptz
  OR sla_add_business_seconds(sc_ny, '2026-09-12T15:00:00Z', -5) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL business seconds edge cases';
  END IF;
  -- the round trip: between(from, add(from, n)) = n for a start inside hours
  IF sla_business_minutes_between(sc_ny, '2026-09-14T14:00:00Z', sla_add_business_minutes(sc_ny, '2026-09-14T14:00:00Z', 1000)) <> 1000 THEN
    RAISE EXCEPTION 'FAIL business minutes round trip';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 3. Schedules: validation, default rules, RLS
  -- ---------------------------------------------------------
  IF (SELECT count(*) FROM business_hours_schedules WHERE account_id = a AND is_default) <> 1
     OR NOT (SELECT is_default FROM business_hours_schedules WHERE id = sc_ny) THEN
    RAISE EXCEPTION 'FAIL the first schedule must be the (only) default';
  END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
    VALUES (%L, 'Overlap', 'UTC', '{"1":[{"start":"09:00","end":"12:00"},{"start":"11:00","end":"13:00"}]}')$q$, a));
  IF res NOT LIKE 'ERR 22023%overlap%' THEN RAISE EXCEPTION 'FAIL overlapping slots accepted: %', res; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
    VALUES (%L, 'Backwards', 'UTC', '{"1":[{"start":"12:00","end":"09:00"}]}')$q$, a));
  IF res NOT LIKE 'ERR 22023%end_before_start%' THEN RAISE EXCEPTION 'FAIL end before start accepted: %', res; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
    VALUES (%L, 'Five', 'UTC', '{"1":[{"start":"01:00","end":"02:00"},{"start":"03:00","end":"04:00"},{"start":"05:00","end":"06:00"},{"start":"07:00","end":"08:00"},{"start":"09:00","end":"10:00"}]}')$q$, a));
  IF res NOT LIKE 'ERR 22023%too_many_slots%' THEN RAISE EXCEPTION 'FAIL five slots accepted: %', res; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
    VALUES (%L, 'Closed', 'UTC', '{"1":[],"2":[]}')$q$, a));
  IF res NOT LIKE 'ERR 22023%no_open_day%' THEN RAISE EXCEPTION 'FAIL an all-closed week accepted: %', res; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
    VALUES (%L, 'Mars', 'Mars/Olympus', '{"1":[{"start":"09:00","end":"10:00"}]}')$q$, a));
  IF res NOT LIKE 'ERR 22023%sla_timezone_invalid%' THEN RAISE EXCEPTION 'FAIL a bad timezone accepted: %', res; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
    VALUES (%L, 'Bad time', 'UTC', '{"1":[{"start":"9:00","end":"10:00"}]}')$q$, a));
  IF res NOT LIKE 'ERR 22023%bad_time%' THEN RAISE EXCEPTION 'FAIL a bad time accepted: %', res; END IF;
  n := n + 1;

  -- a second and third schedule; making one the default swaps it
  res := pg_temp.run(admin_a, format($q$INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
    VALUES (%L, 'Weekend desk', 'Asia/Kuala_Lumpur', '{"6":[{"start":"10:00","end":"14:00"}],"7":[{"start":"10:00","end":"14:00"}]}')$q$, a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL admin creates a schedule: %', res; END IF;
  SELECT id INTO sch2 FROM business_hours_schedules WHERE account_id = a AND name = 'Weekend desk';
  IF (SELECT is_default FROM business_hours_schedules WHERE id = sch2) THEN
    RAISE EXCEPTION 'FAIL the second schedule must not take the default';
  END IF;
  res := pg_temp.run(admin_a, format('UPDATE business_hours_schedules SET is_default = true WHERE id = %L', sch2));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL make default: %', res; END IF;
  IF (SELECT count(*) FROM business_hours_schedules WHERE account_id = a AND is_default) <> 1
     OR NOT (SELECT is_default FROM business_hours_schedules WHERE id = sch2)
     OR (SELECT is_default FROM business_hours_schedules WHERE id = sc_ny) THEN
    RAISE EXCEPTION 'FAIL make default did not swap';
  END IF;
  res := pg_temp.run(admin_a, format('UPDATE business_hours_schedules SET is_default = false WHERE id = %L', sch2));
  IF res NOT LIKE 'ERR 22023%sla_default_required%' THEN RAISE EXCEPTION 'FAIL the default was un-set directly: %', res; END IF;
  -- deleting the default promotes another
  res := pg_temp.run(admin_a, format('DELETE FROM business_hours_schedules WHERE id = %L', sch2));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL delete the default schedule: %', res; END IF;
  IF (SELECT count(*) FROM business_hours_schedules WHERE account_id = a AND is_default) <> 1 THEN
    RAISE EXCEPTION 'FAIL deleting the default must promote another schedule';
  END IF;
  -- holidays: whole days, unique per schedule, account taken from the schedule
  res := pg_temp.run(admin_a, format($q$INSERT INTO business_hours_holidays (schedule_id, account_id, holiday_date, name)
    VALUES (%L, %L, '2026-12-25', 'Christmas')$q$, sc_kl, b));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL add holiday: %', res; END IF;
  IF (SELECT account_id FROM business_hours_holidays WHERE schedule_id = sc_kl AND holiday_date = '2026-12-25') <> a THEN
    RAISE EXCEPTION 'FAIL a holiday must take the account of its schedule, not the client value';
  END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO business_hours_holidays (schedule_id, account_id, holiday_date, name)
    VALUES (%L, %L, '2026-12-25', 'Again')$q$, sc_kl, a));
  IF res NOT LIKE 'ERR 23505%' THEN RAISE EXCEPTION 'FAIL duplicate holiday accepted: %', res; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 4. Policies: validation and matching order
  -- ---------------------------------------------------------
  res := pg_temp.run(admin_a, format($q$INSERT INTO ticket_sla_policies (account_id, name, conditions, first_response_minutes, resolution_minutes)
    VALUES (%L, 'Urgent', '{"priorities":["urgent"]}', 30, 240)$q$, a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL create policy: %', res; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO ticket_sla_policies (account_id, name, conditions, first_response_minutes, resolution_minutes, schedule_id)
    VALUES (%L, 'Billing (New York hours)', '{"categories":["billing"]}', 60, 480, %L)$q$, a, sc_ny));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL create billing policy: %', res; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO ticket_sla_policies (account_id, name, conditions, first_response_minutes, resolution_minutes, pause_while_pending)
    VALUES (%L, 'Everything else', '{}', 120, 1440, true)$q$, a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL create catch-all policy: %', res; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO ticket_sla_policies (account_id, name, conditions, resolution_minutes)
    VALUES (%L, 'VIP label', '{"labels":["vip"]}', 60)$q$, a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL create label policy: %', res; END IF;
  SELECT id INTO p_urgent FROM ticket_sla_policies WHERE account_id = a AND name = 'Urgent';
  SELECT id INTO p_bill   FROM ticket_sla_policies WHERE account_id = a AND name LIKE 'Billing%';
  SELECT id INTO p_all    FROM ticket_sla_policies WHERE account_id = a AND name = 'Everything else';
  SELECT id INTO p_vip    FROM ticket_sla_policies WHERE account_id = a AND name = 'VIP label';
  IF (SELECT array_agg(position ORDER BY position) FROM ticket_sla_policies WHERE account_id = a) IS DISTINCT FROM ARRAY[1, 2, 3, 4] THEN
    RAISE EXCEPTION 'FAIL positions are not assigned 1..4 in creation order';
  END IF;

  -- validation
  res := pg_temp.run(admin_a, format($q$INSERT INTO ticket_sla_policies (account_id, name) VALUES (%L, 'No target')$q$, a));
  IF res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL a policy without a target was accepted: %', res; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO ticket_sla_policies (account_id, name, first_response_minutes, resolution_minutes)
    VALUES (%L, 'Inverted', 120, 60)$q$, a));
  IF res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL resolution <= first response accepted: %', res; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO ticket_sla_policies (account_id, name, first_response_minutes, at_risk_percent)
    VALUES (%L, 'Risk 30', 60, 30)$q$, a));
  IF res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL at_risk_percent 30 accepted: %', res; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO ticket_sla_policies (account_id, name, first_response_minutes, conditions)
    VALUES (%L, 'Bad cond', 60, '{"priorities":["asap"]}')$q$, a));
  IF res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL an unknown priority condition accepted: %', res; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO ticket_sla_policies (account_id, name, first_response_minutes, conditions)
    VALUES (%L, 'Bad key', 60, '{"colour":["red"]}')$q$, a));
  IF res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL an unknown condition key accepted: %', res; END IF;
  n := n + 1;

  -- match order: first active policy wins
  IF sla_match_policy(a, 'urgent', 'general', ARRAY[]::text[], NULL, NULL) IS DISTINCT FROM p_urgent
  OR sla_match_policy(a, 'normal', 'billing', ARRAY[]::text[], NULL, NULL) IS DISTINCT FROM p_bill
  OR sla_match_policy(a, 'normal', 'bug', ARRAY[]::text[], NULL, NULL) IS DISTINCT FROM p_all
  OR sla_match_policy(a, 'urgent', 'billing', ARRAY[]::text[], NULL, NULL) IS DISTINCT FROM p_urgent THEN
    RAISE EXCEPTION 'FAIL policy match order';
  END IF;
  -- the catch-all sits before the label policy, so a vip ticket lands on the catch-all ...
  IF sla_match_policy(a, 'normal', 'bug', ARRAY['vip'], NULL, NULL) IS DISTINCT FROM p_all THEN
    RAISE EXCEPTION 'FAIL label policy must lose to the catch-all above it';
  END IF;
  -- ... until it is dragged to the top
  res := pg_temp.run(admin_a, format($q$SELECT sla_reorder_policies(%L, ARRAY[%L, %L, %L, %L]::uuid[])::text$q$,
                                     a, p_vip, p_urgent, p_bill, p_all));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL reorder: %', res; END IF;
  IF sla_match_policy(a, 'normal', 'bug', ARRAY['vip'], NULL, NULL) IS DISTINCT FROM p_vip
  OR sla_match_policy(a, 'normal', 'bug', ARRAY['other'], NULL, NULL) IS DISTINCT FROM p_all THEN
    RAISE EXCEPTION 'FAIL reordered match';
  END IF;
  IF pg_temp.run(agent_a, format($q$SELECT sla_reorder_policies(%L, ARRAY[%L]::uuid[])::text$q$, a, p_vip)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL an agent reordered the policies';
  END IF;
  -- an inactive policy is skipped
  UPDATE ticket_sla_policies SET is_active = false WHERE id = p_vip;
  IF sla_match_policy(a, 'normal', 'bug', ARRAY['vip'], NULL, NULL) IS DISTINCT FROM p_all THEN
    RAISE EXCEPTION 'FAIL an inactive policy still matched';
  END IF;
  -- team and channel conditions
  INSERT INTO ticket_sla_policies (account_id, name, conditions, first_response_minutes)
  VALUES (a, 'Email only', '{"channels":["email"]}', 45) RETURNING id INTO p_email;
  UPDATE ticket_sla_policies SET position = -1 WHERE id = p_email;   -- first place
  IF sla_match_policy(a, 'low', 'other', ARRAY[]::text[], NULL, conv_a) IS DISTINCT FROM p_all THEN
    RAISE EXCEPTION 'FAIL a whatsapp conversation matched the email policy';
  END IF;
  UPDATE conversations SET last_channel_type = 'email' WHERE id = conv_a;
  IF sla_match_policy(a, 'low', 'other', ARRAY[]::text[], NULL, conv_a) IS DISTINCT FROM p_email THEN
    RAISE EXCEPTION 'FAIL the email conversation did not match the email policy';
  END IF;
  IF sla_match_policy(a, 'low', 'other', ARRAY[]::text[], NULL, NULL) IS DISTINCT FROM p_all THEN
    RAISE EXCEPTION 'FAIL a ticket with no conversation matched a channel policy';
  END IF;
  UPDATE ticket_sla_policies SET is_active = false WHERE id = p_email;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 5. Ticket clock: start
  -- ---------------------------------------------------------
  -- urgent, 24/7 policy: due = created + target; at risk at 80 % of the target
  t1 := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now());
  SELECT * INTO rec FROM tickets WHERE id = t1;
  IF rec.sla_policy_id IS DISTINCT FROM p_urgent
     OR rec.sla_first_response_due_at <> now() + interval '30 minutes'
     OR rec.sla_first_response_risk_at <> now() + interval '24 minutes'
     OR rec.sla_resolution_due_at <> now() + interval '240 minutes'
     OR rec.sla_resolution_risk_at <> now() + interval '192 minutes'
     OR pg_temp.st(t1) <> 'running/running/false' THEN
    RAISE EXCEPTION 'FAIL ticket start (24/7): % %', rec.sla_policy_id, pg_temp.st(t1);
  END IF;

  -- billing ticket created in the past under New York hours: computed from
  -- created_at (Mon 17:30 EDT + 60 business minutes = Tue 09:30 EDT) and, being
  -- long overdue, breached straight away
  t2 := pg_temp.mk(a, contact_a, 'normal', 'billing', 'open', '2026-09-14T21:30:00Z');
  SELECT * INTO rec FROM tickets WHERE id = t2;
  IF rec.sla_policy_id IS DISTINCT FROM p_bill
     OR rec.sla_first_response_due_at <> '2026-09-15T13:30:00Z'::timestamptz
     OR rec.sla_first_response_state <> 'breached' THEN
    RAISE EXCEPTION 'FAIL business-hours due date at insert: % %', rec.sla_first_response_due_at, rec.sla_first_response_state;
  END IF;
  -- resolution 480 min: 30 today + 450 tomorrow = 09:00 + 7h30 = 16:30 EDT Tue = 20:30Z
  IF rec.sla_resolution_due_at <> '2026-09-15T20:30:00Z'::timestamptz THEN
    RAISE EXCEPTION 'FAIL resolution due (New York hours): %', rec.sla_resolution_due_at;
  END IF;
  n := n + 1;

  -- no policy in an account without policies
  tb1 := pg_temp.mk(b, contact_b, 'urgent', 'general', 'open', now() - interval '3 hours');
  IF pg_temp.st(tb1) <> 'none/none/false' OR (SELECT sla_policy_id FROM tickets WHERE id = tb1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a ticket that matches no policy must have no SLA';
  END IF;
  tb2 := pg_temp.mk(b, contact_b, 'low', 'general', 'pending', now() - interval '3 hours');
  tb3 := pg_temp.mk(b, contact_b, 'urgent', 'general', 'resolved', now() - interval '3 hours');
  n := n + 1;

  -- ---------------------------------------------------------
  -- 6. Pause / resume / stop / reopen (24/7 policy so the numbers are exact)
  -- ---------------------------------------------------------
  t3 := pg_temp.mk(a, contact_a, 'urgent', 'general', 'in_progress', now());
  UPDATE tickets SET status = 'pending' WHERE id = t3;
  IF pg_temp.st(t3) <> 'paused/paused/true' THEN RAISE EXCEPTION 'FAIL pause on pending: %', pg_temp.st(t3); END IF;
  PERFORM pg_temp.shift(t3, 10);   -- it has been pending for 10 minutes
  UPDATE tickets SET status = 'in_progress' WHERE id = t3;
  SELECT * INTO rec FROM tickets WHERE id = t3;
  IF pg_temp.st(t3) <> 'running/running/false'
     OR rec.sla_first_response_due_at <> now() + interval '30 minutes'
     OR rec.sla_first_response_risk_at <> now() + interval '24 minutes'
     OR rec.sla_resolution_due_at <> now() + interval '240 minutes' THEN
    RAISE EXCEPTION 'FAIL resume must give back the remaining time (30 / 24 / 240 min): % % %',
      pg_temp.st(t3), rec.sla_first_response_due_at - now(), rec.sla_resolution_due_at - now();
  END IF;

  -- a policy that does not pause keeps running while pending
  UPDATE ticket_sla_policies SET pause_while_pending = false WHERE id = p_urgent;
  t4 := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now());
  UPDATE tickets SET status = 'pending' WHERE id = t4;
  IF pg_temp.st(t4) <> 'running/running/false' THEN RAISE EXCEPTION 'FAIL pause_while_pending=false: %', pg_temp.st(t4); END IF;
  UPDATE ticket_sla_policies SET pause_while_pending = true WHERE id = p_urgent;

  -- open -> pending -> resolved: stops as met (it was on time when it paused)
  t5 := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now());
  UPDATE tickets SET status = 'pending' WHERE id = t5;
  UPDATE tickets SET status = 'resolved', resolved_at = now() WHERE id = t5;
  IF pg_temp.st(t5) <> 'met/met/false' OR (SELECT sla_stopped_at FROM tickets WHERE id = t5) IS NULL THEN
    RAISE EXCEPTION 'FAIL resolve from pending: %', pg_temp.st(t5);
  END IF;

  -- resolved late: breached; resolved on time: met
  t6 := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now() - interval '5 hours');
  IF pg_temp.st(t6) <> 'breached/breached/false' THEN RAISE EXCEPTION 'FAIL an old ticket must start breached: %', pg_temp.st(t6); END IF;
  UPDATE tickets SET status = 'resolved', resolved_at = now() WHERE id = t6;
  IF pg_temp.st(t6) <> 'breached/breached/false' THEN RAISE EXCEPTION 'FAIL late stop must stay breached: %', pg_temp.st(t6); END IF;
  UPDATE tickets SET status = 'open', resolved_at = NULL WHERE id = t6;
  IF pg_temp.st(t6) <> 'breached/breached/false' THEN RAISE EXCEPTION 'FAIL reopen must not un-breach: %', pg_temp.st(t6); END IF;

  t7 := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now());
  UPDATE tickets SET status = 'resolved', resolved_at = now() WHERE id = t7;
  IF pg_temp.st(t7) <> 'met/met/false' THEN RAISE EXCEPTION 'FAIL on-time stop: %', pg_temp.st(t7); END IF;
  -- closing after resolving changes nothing
  UPDATE tickets SET status = 'closed', closed_at = now() WHERE id = t7;
  IF pg_temp.st(t7) <> 'met/met/false' THEN RAISE EXCEPTION 'FAIL resolved -> closed: %', pg_temp.st(t7); END IF;
  -- reopen: the resolution restarts from what was left (240 min), first response stays met
  PERFORM pg_temp.shift(t7, 5);
  UPDATE tickets SET status = 'open', closed_at = NULL, resolved_at = NULL WHERE id = t7;
  SELECT * INTO rec FROM tickets WHERE id = t7;
  IF rec.sla_first_response_state <> 'met' OR rec.sla_resolution_state <> 'running'
     OR rec.sla_resolution_due_at <> now() + interval '240 minutes'
     OR rec.sla_stopped_at IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL reopen: % due in % min', pg_temp.st(t7), extract(epoch FROM rec.sla_resolution_due_at - now()) / 60;
  END IF;
  -- a reopen into pending pauses at once
  t8 := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now());
  UPDATE tickets SET status = 'resolved', resolved_at = now() WHERE id = t8;
  UPDATE tickets SET status = 'pending', resolved_at = NULL WHERE id = t8;
  IF pg_temp.st(t8) <> 'met/paused/true' THEN RAISE EXCEPTION 'FAIL reopen into pending: %', pg_temp.st(t8); END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 7. Re-match while the ticket is active keeps the elapsed business time
  -- ---------------------------------------------------------
  -- created 20 minutes ago under the catch-all (120 / 1440 min): normal -> urgent (30 / 240)
  tx := pg_temp.mk(a, contact_a, 'normal', 'general', 'open', now() - interval '20 minutes');
  IF (SELECT sla_policy_id FROM tickets WHERE id = tx) IS DISTINCT FROM p_all THEN
    RAISE EXCEPTION 'FAIL catch-all did not match';
  END IF;
  UPDATE tickets SET priority = 'urgent' WHERE id = tx;
  SELECT * INTO rec FROM tickets WHERE id = tx;
  IF rec.sla_policy_id IS DISTINCT FROM p_urgent
     OR rec.sla_first_response_due_at <> now() + interval '10 minutes'      -- 30 - 20 elapsed
     OR rec.sla_first_response_risk_at <> now() + interval '4 minutes'      -- 24 - 20
     OR rec.sla_resolution_due_at <> now() + interval '220 minutes'         -- 240 - 20
     OR pg_temp.st(tx) <> 'running/running/false' THEN
    RAISE EXCEPTION 'FAIL re-match keeps elapsed time: % fr+% res+%', pg_temp.st(tx),
      rec.sla_first_response_due_at - now(), rec.sla_resolution_due_at - now();
  END IF;
  -- back to a bigger target: elapsed still 20
  UPDATE tickets SET priority = 'low' WHERE id = tx;
  SELECT * INTO rec FROM tickets WHERE id = tx;
  IF rec.sla_policy_id IS DISTINCT FROM p_all
     OR rec.sla_first_response_due_at <> now() + interval '100 minutes'
     OR rec.sla_resolution_due_at <> now() + interval '1420 minutes' THEN
    RAISE EXCEPTION 'FAIL re-match to a longer target: +% +%', rec.sla_first_response_due_at - now(), rec.sla_resolution_due_at - now();
  END IF;
  -- the same policy again: nothing moves
  SELECT sla_first_response_due_at INTO v_ts FROM tickets WHERE id = tx;
  UPDATE tickets SET category = 'bug' WHERE id = tx;
  IF (SELECT sla_first_response_due_at FROM tickets WHERE id = tx) <> v_ts THEN
    RAISE EXCEPTION 'FAIL re-matching the same policy moved the due date';
  END IF;
  -- no policy matches any more: running targets end
  UPDATE ticket_sla_policies SET is_active = false WHERE id = p_all;
  UPDATE tickets SET category = 'other' WHERE id = tx;
  IF pg_temp.st(tx) <> 'none/none/false' OR (SELECT sla_policy_id FROM tickets WHERE id = tx) IS NOT NULL
     OR (SELECT sla_first_response_due_at FROM tickets WHERE id = tx) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL no policy matches: the SLA must end: %', pg_temp.st(tx);
  END IF;
  UPDATE ticket_sla_policies SET is_active = true WHERE id = p_all;
  -- ... and comes back (from created_at) when one matches again
  UPDATE tickets SET category = 'general' WHERE id = tx;
  IF (SELECT sla_policy_id FROM tickets WHERE id = tx) IS DISTINCT FROM p_all
     OR (SELECT sla_first_response_due_at FROM tickets WHERE id = tx) <> (SELECT created_at + interval '120 minutes' FROM tickets WHERE id = tx) THEN
    RAISE EXCEPTION 'FAIL a policy matching again must restart from created_at';
  END IF;
  -- a resolved ticket is never re-matched
  UPDATE tickets SET status = 'resolved', resolved_at = now() WHERE id = tx;
  SELECT sla_policy_id INTO v_id FROM tickets WHERE id = tx;
  UPDATE tickets SET priority = 'urgent' WHERE id = tx;
  IF (SELECT sla_policy_id FROM tickets WHERE id = tx) IS DISTINCT FROM v_id THEN
    RAISE EXCEPTION 'FAIL a stopped ticket was re-matched';
  END IF;
  -- re-match while paused measures from paused_at
  t1 := pg_temp.mk(a, contact_a, 'normal', 'general', 'in_progress', now() - interval '20 minutes');
  UPDATE tickets SET status = 'pending' WHERE id = t1;
  UPDATE tickets SET priority = 'urgent' WHERE id = t1;
  SELECT * INTO rec FROM tickets WHERE id = t1;
  IF pg_temp.st(t1) <> 'paused/paused/true'
     OR rec.sla_first_response_due_at <> rec.sla_paused_at + interval '10 minutes' THEN
    RAISE EXCEPTION 'FAIL re-match while paused: % %', pg_temp.st(t1), rec.sla_first_response_due_at - rec.sla_paused_at;
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 8. First response: once, agent only, Jira excluded, no updated_at bump
  -- ---------------------------------------------------------
  t1 := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now());
  upd_before := (SELECT updated_at FROM tickets WHERE id = t1);
  -- a note by nobody (author NULL, not Jira) does not count
  INSERT INTO ticket_comments (ticket_id, account_id, author_id, body) VALUES (t1, a, NULL, 'system note');
  IF (SELECT sla_first_response_at FROM tickets WHERE id = t1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL an authorless note counted as a first response';
  END IF;
  -- a Jira-sourced note does not count (when the column exists)
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
              AND table_name = 'ticket_comments' AND column_name = 'source') THEN
    EXECUTE format($q$INSERT INTO ticket_comments (ticket_id, account_id, author_id, body, source, jira_author)
                      VALUES (%L, %L, %L, 'from jira', 'jira', 'Priya')$q$, t1, a, agent_a);
    IF (SELECT sla_first_response_at FROM tickets WHERE id = t1) IS NOT NULL THEN
      RAISE EXCEPTION 'FAIL a Jira-sourced note counted as a first response';
    END IF;
  END IF;
  res := pg_temp.run(agent_a, format($q$INSERT INTO ticket_comments (ticket_id, account_id, author_id, body)
                                        VALUES (%L, %L, %L, 'Looking into it')$q$, t1, a, agent_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL agent comment: %', res; END IF;
  SELECT * INTO rec FROM tickets WHERE id = t1;
  IF rec.sla_first_response_at IS NULL OR rec.sla_first_response_state <> 'met' OR rec.sla_resolution_state <> 'running' THEN
    RAISE EXCEPTION 'FAIL first response: % %', rec.sla_first_response_at, pg_temp.st(t1);
  END IF;
  IF rec.updated_at <> upd_before THEN RAISE EXCEPTION 'FAIL a first response must not bump updated_at'; END IF;
  v_ts := rec.sla_first_response_at;
  PERFORM pg_temp.internal(format('UPDATE ticket_comments SET created_at = created_at WHERE ticket_id = %L', t1));
  INSERT INTO ticket_comments (ticket_id, account_id, author_id, body, created_at)
  VALUES (t1, a, agent2_a, 'second note', now() + interval '1 hour');
  IF (SELECT sla_first_response_at FROM tickets WHERE id = t1) <> v_ts THEN
    RAISE EXCEPTION 'FAIL the first response moved on a later note';
  END IF;
  -- a late first response is breached; one while paused is met
  t2 := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now() - interval '3 hours');
  INSERT INTO ticket_comments (ticket_id, account_id, author_id, body) VALUES (t2, a, agent_a, 'sorry for the wait');
  IF (SELECT sla_first_response_state FROM tickets WHERE id = t2) <> 'breached'
     OR (SELECT sla_first_response_at FROM tickets WHERE id = t2) IS NULL THEN
    RAISE EXCEPTION 'FAIL a late first response must stay breached';
  END IF;
  t3 := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now());
  UPDATE tickets SET status = 'pending' WHERE id = t3;
  INSERT INTO ticket_comments (ticket_id, account_id, author_id, body) VALUES (t3, a, agent_a, 'asked the customer');
  IF pg_temp.st(t3) <> 'met/paused/true' THEN RAISE EXCEPTION 'FAIL first response while pending: %', pg_temp.st(t3); END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 9. Clients cannot write the SLA columns
  -- ---------------------------------------------------------
  t4 := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now());
  SELECT sla_resolution_due_at INTO v_ts FROM tickets WHERE id = t4;
  res := pg_temp.run(agent_a, format($q$UPDATE tickets SET sla_first_response_state = 'met',
      sla_resolution_due_at = now() + interval '99 days', sla_policy_id = NULL, sla_stopped_at = now() WHERE id = %L$q$, t4));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL the agent update must still succeed: %', res; END IF;
  IF pg_temp.st(t4) <> 'running/running/false' OR (SELECT sla_resolution_due_at FROM tickets WHERE id = t4) <> v_ts
     OR (SELECT sla_policy_id FROM tickets WHERE id = t4) IS DISTINCT FROM p_urgent
     OR (SELECT sla_stopped_at FROM tickets WHERE id = t4) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a client changed the SLA columns';
  END IF;
  -- an INSERT with forged values is reset and computed properly
  tk := gen_random_uuid();
  res := pg_temp.run(agent_a, format($q$INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, priority,
        sla_first_response_state, sla_resolution_state, sla_resolution_due_at)
      VALUES (%L, %L, 9001, %L, 'forged', 'urgent', 'met', 'met', now() + interval '99 days')$q$, tk, a, contact_a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL the agent insert: %', res; END IF;
  IF pg_temp.st(tk) <> 'running/running/false'
     OR (SELECT sla_resolution_due_at FROM tickets WHERE id = tk) <> (SELECT created_at + interval '240 minutes' FROM tickets WHERE id = tk) THEN
    RAISE EXCEPTION 'FAIL forged SLA values on insert were kept';
  END IF;
  -- an ordinary edit (a board move) does not bump updated_at through the SLA trigger and still works
  res := pg_temp.run(agent_a, format($q$UPDATE tickets SET subject = 'renamed' WHERE id = %L$q$, t4));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL an ordinary edit: %', res; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 10. The sweep: breached + once-only notifications
  -- ---------------------------------------------------------
  IF pg_temp.run(agent_a, 'SELECT sla_sweep(10)::text') NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL an authenticated user ran the sweep';
  END IF;
  -- the earlier tickets in this run are all to be swept; start clean
  DELETE FROM notifications WHERE account_id = a;
  PERFORM pg_temp.internal(format($q$UPDATE tickets SET sla_first_response_state = 'met', sla_resolution_state = 'met' WHERE account_id = %L$q$, a));

  -- tk: assigned, first response overdue, resolution at risk
  tk := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now(), agent_a);
  INSERT INTO ticket_watchers (ticket_id, user_id, account_id) VALUES (tk, agent2_a, a) ON CONFLICT DO NOTHING;
  PERFORM pg_temp.internal(format($q$UPDATE tickets SET
      sla_first_response_due_at = now() - interval '1 minute',
      sla_first_response_risk_at = now() - interval '10 minutes',
      sla_resolution_due_at = now() + interval '1 hour',
      sla_resolution_risk_at = now() - interval '1 minute' WHERE id = %L$q$, tk));
  -- tl: unassigned, resolution overdue
  tl := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now());
  PERFORM pg_temp.internal(format($q$UPDATE tickets SET
      sla_first_response_state = 'met', sla_resolution_due_at = now() - interval '5 minutes' WHERE id = %L$q$, tl));
  -- tm: paused and past due: must not be touched
  tm := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now());
  UPDATE tickets SET status = 'pending' WHERE id = tm;
  PERFORM pg_temp.internal(format($q$UPDATE tickets SET sla_first_response_due_at = now() - interval '1 hour',
      sla_first_response_risk_at = now() - interval '2 hours' WHERE id = %L$q$, tm));
  upd_before := (SELECT updated_at FROM tickets WHERE id = tk);

  j := sla_sweep(200);
  IF (j ->> 'breached')::int < 2 THEN RAISE EXCEPTION 'FAIL sweep breached count: %', j; END IF;
  IF pg_temp.st(tk) <> 'breached/running/false' OR pg_temp.st(tl) <> 'met/breached/false' OR pg_temp.st(tm) <> 'paused/paused/true' THEN
    RAISE EXCEPTION 'FAIL sweep states: % % %', pg_temp.st(tk), pg_temp.st(tl), pg_temp.st(tm);
  END IF;
  IF (SELECT updated_at FROM tickets WHERE id = tk) <> upd_before THEN
    RAISE EXCEPTION 'FAIL the sweep bumped updated_at';
  END IF;
  -- tk: breach notice to the assignee and the watcher, at-risk notice for the resolution
  IF pg_temp.nc(agent_a, 'ticket_sla_breached', tk) <> 1 OR pg_temp.nc(agent2_a, 'ticket_sla_breached', tk) <> 1
     OR pg_temp.nc(agent_a, 'ticket_sla_at_risk', tk) <> 1 OR pg_temp.nc(agent2_a, 'ticket_sla_at_risk', tk) <> 1
     OR pg_temp.nc(owner_a, 'ticket_sla_breached', tk) <> 0 OR pg_temp.nc(viewer_a, 'ticket_sla_breached', tk) <> 0 THEN
    RAISE EXCEPTION 'FAIL notifications for the assigned ticket';
  END IF;
  -- tl: unassigned -> every owner / admin (not agents, not viewers)
  IF pg_temp.nc(owner_a, 'ticket_sla_breached', tl) <> 1 OR pg_temp.nc(admin_a, 'ticket_sla_breached', tl) <> 1
     OR pg_temp.nc(agent_a, 'ticket_sla_breached', tl) <> 0 OR pg_temp.nc(viewer_a, 'ticket_sla_breached', tl) <> 0 THEN
    RAISE EXCEPTION 'FAIL notifications for the unassigned ticket';
  END IF;
  IF (SELECT count(*) FROM notifications WHERE ticket_id = tm) <> 0 THEN
    RAISE EXCEPTION 'FAIL a paused ticket was notified';
  END IF;
  SELECT count(*) INTO cnt FROM notifications WHERE account_id = a AND type LIKE 'ticket_sla_%';
  -- once only: a second run (and a third) adds nothing
  j := sla_sweep(200);
  PERFORM sla_sweep(200);
  IF (SELECT count(*) FROM notifications WHERE account_id = a AND type LIKE 'ticket_sla_%') <> cnt THEN
    RAISE EXCEPTION 'FAIL the sweep notified twice';
  END IF;
  IF (j ->> 'notifications')::int <> 0 THEN RAISE EXCEPTION 'FAIL second sweep reported notifications: %', j; END IF;
  -- reopen after a breach does not notify again either
  UPDATE tickets SET status = 'resolved', resolved_at = now() WHERE id = tl;
  UPDATE tickets SET status = 'open', resolved_at = NULL WHERE id = tl;
  PERFORM sla_sweep(200);
  IF (SELECT count(*) FROM notifications WHERE account_id = a AND type LIKE 'ticket_sla_%') <> cnt THEN
    RAISE EXCEPTION 'FAIL notified again after reopen';
  END IF;
  -- batch limit: p_limit 1 handles one ticket per phase
  PERFORM pg_temp.internal(format($q$UPDATE tickets SET sla_resolution_state = 'running', sla_resolution_due_at = now() - interval '1 minute',
      sla_res_breach_notified_at = NULL WHERE id IN (%L, %L)$q$, tk, tl));
  j := sla_sweep(1);
  IF (j ->> 'breached')::int > 1 OR (j ->> 'tickets_notified')::int > 1 THEN
    RAISE EXCEPTION 'FAIL the sweep ignored its batch limit: %', j;
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 11. notifications CHECK keeps every old value and adds the new ones
  -- ---------------------------------------------------------
  SELECT pg_get_constraintdef(oid) INTO res FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';
  FOR rec IN SELECT unnest(ARRAY['ai_budget', 'approval_decided', 'approval_requested', 'conversation_assigned',
                                 'mention', 'ticket_assigned', 'ticket_comment', 'ticket_mention', 'ticket_updated',
                                 'sla_breach', 'ticket_sla_at_risk', 'ticket_sla_breached']) AS v LOOP
    IF res NOT LIKE '%' || rec.v || '%' THEN RAISE EXCEPTION 'FAIL notifications CHECK lost %: %', rec.v, res; END IF;
  END LOOP;
  -- Jira's types too when 085 is applied
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'jira_audit') THEN
    IF res NOT LIKE '%jira_reauth_required%' OR res NOT LIKE '%jira_issue_done%' THEN
      RAISE EXCEPTION 'FAIL notifications CHECK lost the Jira types: %', res;
    END IF;
  END IF;
  INSERT INTO notifications (account_id, user_id, type, title) VALUES (a, owner_a, 'sla_breach', 'conversation SLA still works');
  n := n + 1;

  -- ---------------------------------------------------------
  -- 12. Apply to open tickets (account b: tickets created before any policy)
  -- ---------------------------------------------------------
  INSERT INTO ticket_sla_policies (account_id, name, conditions, first_response_minutes, resolution_minutes)
  VALUES (b, 'Urgent b', '{"priorities":["urgent"]}', 30, 240) RETURNING id INTO p_b;
  IF pg_temp.st(tb1) <> 'none/none/false' THEN RAISE EXCEPTION 'FAIL a new policy changed an existing ticket by itself'; END IF;
  IF pg_temp.run(agent_a, format($q$SELECT sla_apply_to_open_tickets(%L, true)::text$q$, a)) NOT LIKE 'ERR 42501%'
  OR pg_temp.run(owner_a, format($q$SELECT sla_apply_to_open_tickets(%L, true)::text$q$, b)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL apply-to-open permission (an agent, or another account, could run it)';
  END IF;
  res := pg_temp.run(owner_b, format($q$SELECT sla_apply_to_open_tickets(%L, true)::text$q$, b));
  j := res::jsonb;
  IF (j ->> 'matched')::int <> 1 OR (j ->> 'overdue')::int <> 1 OR (j ->> 'applied')::boolean THEN
    RAISE EXCEPTION 'FAIL apply-to-open dry run: %', res;
  END IF;
  IF pg_temp.st(tb1) <> 'none/none/false' THEN RAISE EXCEPTION 'FAIL the dry run changed a ticket'; END IF;
  res := pg_temp.run(owner_b, format($q$SELECT sla_apply_to_open_tickets(%L, false)::text$q$, b));
  IF (res::jsonb ->> 'applied')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL apply-to-open: %', res; END IF;
  IF pg_temp.st(tb1) <> 'breached/running/false'
     OR (SELECT sla_first_response_due_at FROM tickets WHERE id = tb1) <> (SELECT created_at + interval '30 minutes' FROM tickets WHERE id = tb1)
     OR pg_temp.st(tb2) <> 'none/none/false' OR pg_temp.st(tb3) <> 'none/none/false' THEN
    RAISE EXCEPTION 'FAIL apply-to-open result: % % %', pg_temp.st(tb1), pg_temp.st(tb2), pg_temp.st(tb3);
  END IF;
  -- a second run finds nothing left
  IF ((pg_temp.run(owner_b, format($q$SELECT sla_apply_to_open_tickets(%L, true)::text$q$, b)))::jsonb ->> 'matched')::int <> 0 THEN
    RAISE EXCEPTION 'FAIL apply-to-open is not one-time';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 13. Deleting a policy / a schedule
  -- ---------------------------------------------------------
  INSERT INTO ticket_sla_policies (account_id, name, conditions, first_response_minutes, resolution_minutes)
  VALUES (a, 'Doomed', '{"categories":["account"]}', 15, 60) RETURNING id INTO p_x;
  UPDATE ticket_sla_policies SET position = -5 WHERE id = p_x;
  t1 := pg_temp.mk(a, contact_a, 'normal', 'account', 'open', now());
  t2 := pg_temp.mk(a, contact_a, 'normal', 'account', 'open', now());
  UPDATE tickets SET status = 'resolved', resolved_at = now() WHERE id = t2;
  IF (SELECT sla_policy_id FROM tickets WHERE id = t1) IS DISTINCT FROM p_x THEN RAISE EXCEPTION 'FAIL doomed policy did not match'; END IF;
  res := pg_temp.run(admin_a, format('DELETE FROM ticket_sla_policies WHERE id = %L', p_x));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL delete policy: %', res; END IF;
  IF (SELECT sla_policy_id FROM tickets WHERE id = t1) IS NOT NULL OR pg_temp.st(t1) <> 'none/none/false' THEN
    RAISE EXCEPTION 'FAIL the running SLA must end when its policy is deleted: %', pg_temp.st(t1);
  END IF;
  IF pg_temp.st(t2) <> 'met/met/false' THEN RAISE EXCEPTION 'FAIL a finished SLA must survive its policy: %', pg_temp.st(t2); END IF;
  -- a schedule a policy uses cannot be deleted
  res := pg_temp.run(admin_a, format('DELETE FROM business_hours_schedules WHERE id = %L', sc_ny));
  IF res NOT LIKE 'ERR 23503%' THEN RAISE EXCEPTION 'FAIL a schedule in use was deleted: %', res; END IF;
  -- a policy cannot use another account's schedule
  INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
  VALUES (b, 'b hours', 'UTC', '{"1":[{"start":"09:00","end":"17:00"}]}') RETURNING id INTO sch3;
  res := pg_temp.run(admin_a, format($q$INSERT INTO ticket_sla_policies (account_id, name, first_response_minutes, schedule_id)
    VALUES (%L, 'Foreign schedule', 60, %L)$q$, a, sch3));
  IF res NOT LIKE 'ERR 23503%' THEN RAISE EXCEPTION 'FAIL a foreign schedule was accepted: %', res; END IF;
  -- a target that does not fit in 366 local days: no due time, no error, the ticket is still written
  INSERT INTO ticket_sla_policies (account_id, name, conditions, first_response_minutes, schedule_id)
  VALUES (b, 'Too long', '{"categories":["account"]}', 525000, sch3) RETURNING id INTO p_x;
  UPDATE ticket_sla_policies SET position = -9 WHERE id = p_x;
  tb1 := pg_temp.mk(b, contact_b, 'normal', 'account', 'open', now());
  IF (SELECT sla_policy_id FROM tickets WHERE id = tb1) IS DISTINCT FROM p_x
     OR pg_temp.st(tb1) <> 'none/none/false'
     OR (SELECT sla_first_response_due_at FROM tickets WHERE id = tb1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a target beyond the 366 day cap must give no due time and never block the write: %', pg_temp.st(tb1);
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 14. RLS: members read, only sla.configure writes, accounts are isolated
  -- ---------------------------------------------------------
  FOR rec IN SELECT * FROM (VALUES (agent_a), (viewer_a), (admin_a), (owner_a)) AS x(u) LOOP
    IF pg_temp.run(rec.u, format('SELECT count(*)::text FROM ticket_sla_policies WHERE account_id = %L', a))::int < 4
    OR pg_temp.run(rec.u, format('SELECT count(*)::text FROM business_hours_schedules WHERE account_id = %L', a))::int < 1
    OR pg_temp.run(rec.u, format('SELECT count(*)::text FROM business_hours_holidays WHERE account_id = %L', a))::int < 1 THEN
      RAISE EXCEPTION 'FAIL a member cannot read the SLA configuration';
    END IF;
  END LOOP;
  IF pg_temp.run(owner_b, format('SELECT count(*)::text FROM ticket_sla_policies WHERE account_id = %L', a)) <> '0'
  OR pg_temp.run(owner_b, format('SELECT count(*)::text FROM business_hours_schedules WHERE account_id = %L', a)) <> '0'
  OR pg_temp.run(owner_b, format('SELECT count(*)::text FROM business_hours_holidays WHERE account_id = %L', a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL cross-account read';
  END IF;
  FOR rec IN SELECT * FROM (VALUES (agent_a), (viewer_a)) AS x(u) LOOP
    res := pg_temp.run(rec.u, format($q$INSERT INTO ticket_sla_policies (account_id, name, first_response_minutes) VALUES (%L, 'nope', 10)$q$, a));
    IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL policy insert without sla.configure: %', res; END IF;
    res := pg_temp.run(rec.u, format($q$INSERT INTO business_hours_schedules (account_id, name, timezone, weekly)
      VALUES (%L, 'nope', 'UTC', '{"1":[{"start":"09:00","end":"10:00"}]}')$q$, a));
    IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL schedule insert without sla.configure: %', res; END IF;
    res := pg_temp.run(rec.u, format($q$INSERT INTO business_hours_holidays (schedule_id, account_id, holiday_date) VALUES (%L, %L, '2026-01-01')$q$, sc_ny, a));
    IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL holiday insert without sla.configure: %', res; END IF;
    PERFORM pg_temp.run(rec.u, format($q$UPDATE ticket_sla_policies SET first_response_minutes = 1 WHERE id = %L$q$, p_urgent));
    PERFORM pg_temp.run(rec.u, format($q$DELETE FROM ticket_sla_policies WHERE id = %L$q$, p_urgent));
    PERFORM pg_temp.run(rec.u, format($q$UPDATE business_hours_schedules SET name = 'hacked' WHERE id = %L$q$, sc_ny));
    PERFORM pg_temp.run(rec.u, format($q$DELETE FROM business_hours_holidays WHERE schedule_id = %L$q$, sc_kl));
  END LOOP;
  IF (SELECT first_response_minutes FROM ticket_sla_policies WHERE id = p_urgent) <> 30
     OR NOT EXISTS (SELECT 1 FROM ticket_sla_policies WHERE id = p_urgent)
     OR (SELECT name FROM business_hours_schedules WHERE id = sc_ny) = 'hacked'
     OR NOT EXISTS (SELECT 1 FROM business_hours_holidays WHERE schedule_id = sc_kl) THEN
    RAISE EXCEPTION 'FAIL a member without sla.configure changed the configuration';
  END IF;
  -- another account's admin cannot write into a
  res := pg_temp.run(owner_b, format($q$INSERT INTO ticket_sla_policies (account_id, name, first_response_minutes) VALUES (%L, 'x', 10)$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL cross-account policy insert: %', res; END IF;
  -- grant sla.configure to the Agent role: now an agent can (the capability is what counts)
  res := pg_temp.run(owner_a, format($q$SELECT set_role_capabilities(%L, 'agent', '{"sla.configure": true}'::jsonb)::text$q$, a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL grant sla.configure to agents: %', res; END IF;
  res := pg_temp.run(agent_a, format($q$INSERT INTO ticket_sla_policies (account_id, name, first_response_minutes) VALUES (%L, 'agent made', 10)$q$, a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL an agent holding sla.configure could not write: %', res; END IF;
  res := pg_temp.run(owner_a, format($q$SELECT set_role_capabilities(%L, 'agent', '{"sla.configure": null}'::jsonb)::text$q$, a));
  res := pg_temp.run(agent2_a, format($q$INSERT INTO ticket_sla_policies (account_id, name, first_response_minutes) VALUES (%L, 'agent made 2', 10)$q$, a));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL the reset did not take sla.configure away again: %', res; END IF;
  -- other people's tickets are not readable across accounts either (SLA columns included)
  IF pg_temp.run(owner_b, format($q$SELECT count(*)::text FROM tickets WHERE account_id = %L AND sla_policy_id IS NOT NULL$q$, a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL cross-account ticket SLA read';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 15. Report
  -- ---------------------------------------------------------
  j := (pg_temp.run(agent_a, format($q$SELECT ticket_sla_report(%L, now() - interval '30 days', now() + interval '1 day', 5)::text$q$, a)))::jsonb;
  IF j -> 'firstResponse' IS NULL OR j -> 'resolution' IS NULL OR jsonb_typeof(j -> 'byPriority') <> 'array'
     OR jsonb_typeof(j -> 'byTeam') <> 'array' OR jsonb_array_length(j -> 'breached') > 5 THEN
    RAISE EXCEPTION 'FAIL report shape: %', j;
  END IF;
  IF (j -> 'firstResponse' ->> 'breached')::int < 1 OR (j -> 'firstResponse' ->> 'met')::int < 1
     OR (j -> 'resolution' ->> 'met')::int < 1 THEN
    RAISE EXCEPTION 'FAIL report counts: %', j;
  END IF;
  IF (j -> 'breached' -> 0 ->> 'overdueSeconds')::bigint <= 0 OR (j -> 'breached' -> 0 ->> 'ticketNumber') IS NULL THEN
    RAISE EXCEPTION 'FAIL report drill-down: %', j -> 'breached';
  END IF;
  -- sorted by how late, worst first
  IF (SELECT array_agg((e ->> 'overdueSeconds')::bigint ORDER BY ord)
        FROM jsonb_array_elements(j -> 'breached') WITH ORDINALITY AS x(e, ord))
     IS DISTINCT FROM
     (SELECT array_agg((e ->> 'overdueSeconds')::bigint ORDER BY (e ->> 'overdueSeconds')::bigint DESC)
        FROM jsonb_array_elements(j -> 'breached') AS x(e)) THEN
    RAISE EXCEPTION 'FAIL breached list is not sorted worst first';
  END IF;
  j := (pg_temp.run(owner_b, format($q$SELECT ticket_sla_report(%L, now() - interval '30 days', now() + interval '1 day', 5)::text$q$, a)))::jsonb;
  IF (j -> 'firstResponse' ->> 'met')::int + (j -> 'firstResponse' ->> 'breached')::int + (j -> 'firstResponse' ->> 'running')::int <> 0 THEN
    RAISE EXCEPTION 'FAIL the report leaked another account: %', j;
  END IF;
  -- nothing in the range -> zero counts and empty lists
  j := (pg_temp.run(owner_a, format($q$SELECT ticket_sla_report(%L, '2000-01-01', '2000-02-01', 5)::text$q$, a)))::jsonb;
  IF (j -> 'firstResponse' ->> 'met')::int <> 0 OR jsonb_array_length(j -> 'byPriority') <> 0 OR jsonb_array_length(j -> 'breached') <> 0 THEN
    RAISE EXCEPTION 'FAIL empty report: %', j;
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 16. Audit rows
  -- ---------------------------------------------------------
  IF pg_temp.ac(a, 'entity_type = ''sla_policy'' AND action = ''created''') < 4
  OR pg_temp.ac(a, 'entity_type = ''sla_policy'' AND action = ''deleted''') < 1
  OR pg_temp.ac(a, 'entity_type = ''business_hours'' AND action = ''created''') < 1
  OR pg_temp.ac(a, 'entity_type = ''business_hours'' AND action = ''deleted''') < 1
  OR pg_temp.ac(a, 'entity_type = ''business_hours_holiday'' AND action = ''created''') < 1 THEN
    RAISE EXCEPTION 'FAIL audit rows for schedules, holidays and policies';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE account_id = a AND entity_type = 'sla_policy' AND action = 'created'
                  AND actor_id = admin_a AND entity_label = 'Urgent') THEN
    RAISE EXCEPTION 'FAIL the policy audit row does not credit the admin who made it';
  END IF;
  -- a rename is an update with before / after; a reorder writes nothing
  cnt := pg_temp.ac(a, 'entity_type = ''sla_policy'' AND action = ''updated''');
  PERFORM pg_temp.run(admin_a, format($q$UPDATE ticket_sla_policies SET position = position WHERE id = %L$q$, p_bill));
  PERFORM pg_temp.run(admin_a, format($q$SELECT sla_reorder_policies(%L, ARRAY[%L, %L, %L]::uuid[])::text$q$, a, p_urgent, p_bill, p_all));
  IF pg_temp.ac(a, 'entity_type = ''sla_policy'' AND action = ''updated''') <> cnt THEN
    RAISE EXCEPTION 'FAIL a reorder wrote audit rows';
  END IF;
  res := pg_temp.run(admin_a, format($q$UPDATE ticket_sla_policies SET name = 'Urgent (renamed)' WHERE id = %L$q$, p_urgent));
  IF pg_temp.ac(a, 'entity_type = ''sla_policy'' AND action = ''updated'' AND entity_label = ''Urgent (renamed)''') <> 1 THEN
    RAISE EXCEPTION 'FAIL the rename was not audited';
  END IF;
  -- ticket SLA bookkeeping (sweep, clock) never writes to the audit log
  IF pg_temp.ac(a, 'entity_type = ''ticket''') <> 0 THEN RAISE EXCEPTION 'FAIL ticket clock writes audit rows'; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 17. The SLA maths can never block a real write
  --     (corrupt a policy on purpose: matching raises inside the trigger)
  -- ---------------------------------------------------------
  ALTER TABLE ticket_sla_policies DISABLE TRIGGER sla_policy_before_write;
  UPDATE ticket_sla_policies SET conditions = '{"priorities": "urgent"}'::jsonb WHERE id = p_urgent;
  ALTER TABLE ticket_sla_policies ENABLE TRIGGER sla_policy_before_write;
  t1 := pg_temp.mk(a, contact_a, 'urgent', 'general', 'open', now());
  IF NOT EXISTS (SELECT 1 FROM tickets WHERE id = t1) OR pg_temp.st(t1) <> 'none/none/false' THEN
    RAISE EXCEPTION 'FAIL a failure in the SLA maths blocked or corrupted the ticket write: %', pg_temp.st(t1);
  END IF;
  res := pg_temp.run(agent_a, format($q$UPDATE tickets SET priority = 'high', status = 'pending' WHERE id = %L$q$, t1));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL a failure in the SLA maths blocked an update: %', res; END IF;
  IF (SELECT status FROM tickets WHERE id = t1) <> 'pending' THEN RAISE EXCEPTION 'FAIL the update was lost'; END IF;
  n := n + 1;

  RAISE EXCEPTION 'ROLLBACK-OK: % check groups passed (086 ticket SLA)', n;
END
$verify$;
