-- ============================================================
-- Verification for migration 096 (a required resolution when a ticket is
-- resolved or closed).
--
-- Run against a database that already has 096 applied (and 095, for the
-- mention checks):
--   supabase db query --linked -f supabase/ci/verify-096-ticket-resolutions.sql
--
-- Or BEFORE applying, with the drafts in front (the whole thing rolls back):
--   cat supabase/ci/drafts/095_ticket_mentions.sql supabase/ci/drafts/096_ticket_resolutions.sql \
--       supabase/ci/verify-096-ticket-resolutions.sql > /tmp/both.sql
--   supabase db query --linked -f /tmp/both.sql
--
-- One DO block that ends with RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing
-- is ever committed. A message starting with ROLLBACK-OK means every check
-- passed; any other error message names the check that failed.
--
-- People are simulated the way PostgREST does it: set the JWT claims and
-- SET LOCAL ROLE authenticated, so RLS, grants and the guards apply for real.
-- The DO block itself runs as the migration owner, which is exactly what a
-- "system writer" looks like to the guard (not the `authenticated` role).
-- ============================================================

DO $verify$
DECLARE
  a        UUID;
  b        UUID;
  owner_a  UUID := gen_random_uuid();
  agent_a  UUID := gen_random_uuid();
  agent2_a UUID := gen_random_uuid();
  owner_b  UUID := gen_random_uuid();
  contact_a UUID := gen_random_uuid();
  tk1      UUID := gen_random_uuid();
  tk2      UUID := gen_random_uuid();
  tk3      UUID := gen_random_uuid();
  tk4      UUID := gen_random_uuid();
  tk5      UUID := gen_random_uuid();
  c1       UUID := gen_random_uuid();
  m1       UUID := gen_random_uuid();
  r_fixed  UUID;
  r_dup    UUID;
  r_jira   UUID;
  r_auto   UUID;
  r_other  UUID;
  r_new    UUID;
  res      TEXT;
  n        INTEGER;
BEGIN
  -- ---------------------------------------------------------
  -- helpers
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

  EXECUTE $f$
    CREATE FUNCTION pg_temp.act(p_ticket UUID, p_type TEXT) RETURNS INTEGER
    LANGUAGE sql AS $b$
      SELECT count(*)::int FROM ticket_activity WHERE ticket_id = p_ticket AND event_type = p_type;
    $b$;
  $f$;

  EXECUTE $f$
    CREATE FUNCTION pg_temp.resname(p_ticket UUID) RETURNS TEXT
    LANGUAGE sql AS $b$
      SELECT r.name FROM tickets t LEFT JOIN ticket_resolutions r ON r.id = t.resolution_id WHERE t.id = p_ticket;
    $b$;
  $f$;

  -- ---------------------------------------------------------
  -- fixtures: users -> (trigger) accounts + profiles
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify096-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, agent_a, agent2_a, owner_b]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create accounts';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id IN (agent_a, agent2_a);
  DELETE FROM accounts WHERE owner_user_id IN (agent_a, agent2_a);

  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (contact_a, owner_a, a, '+10000000096', 'Casey');

  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, status, created_by)
  SELECT t.id, a, (SELECT COALESCE(max(ticket_number), 0) FROM tickets WHERE account_id = a) + t.n,
         contact_a, 'Resolution test ' || t.n, 'open', agent_a
    FROM (VALUES (tk1, 1), (tk2, 2), (tk3, 3), (tk4, 4), (tk5, 5)) AS t(id, n);

  -- ---------------------------------------------------------
  -- 1. The catalogue: seeded, shaped, protected
  -- ---------------------------------------------------------
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ticket_resolutions'::regclass) THEN
    RAISE EXCEPTION 'FAIL 1a ticket_resolutions has no row level security';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ticket_resolutions' AND cmd = 'DELETE') THEN
    RAISE EXCEPTION 'FAIL 1b ticket_resolutions has a delete policy';
  END IF;
  IF has_table_privilege('authenticated', 'public.ticket_resolutions', 'DELETE')
     OR has_table_privilege('anon', 'public.ticket_resolutions', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL 1c wrong grants on ticket_resolutions';
  END IF;
  IF has_function_privilege('authenticated', 'public.ticket_system_resolution(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ticket_resolutions_seed(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.jira_apply_ticket_status(uuid, text, text, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tickets_resolution_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 1d an internal function is executable by clients';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.jira_apply_ticket_status(uuid, text, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL 1e service_role cannot run the Jira status function';
  END IF;

  SELECT count(*) INTO n FROM ticket_resolutions WHERE account_id = a;
  IF n <> 8 THEN RAISE EXCEPTION 'FAIL 1f a new account should be seeded with 8 resolutions, got %', n; END IF;
  SELECT id INTO r_fixed FROM ticket_resolutions WHERE account_id = a AND name = 'Fixed';
  SELECT id INTO r_dup   FROM ticket_resolutions WHERE account_id = a AND name = 'Duplicate';
  SELECT id INTO r_jira  FROM ticket_resolutions WHERE account_id = a AND system_key = 'resolved_in_jira';
  SELECT id INTO r_auto  FROM ticket_resolutions WHERE account_id = a AND system_key = 'closed_automatically';
  SELECT id INTO r_other FROM ticket_resolutions WHERE account_id = b AND name = 'Fixed';
  IF r_fixed IS NULL OR r_dup IS NULL OR r_jira IS NULL OR r_auto IS NULL OR r_other IS NULL THEN
    RAISE EXCEPTION 'FAIL 1g the default resolutions or their system keys are missing';
  END IF;
  IF (SELECT require_ticket_resolution FROM accounts WHERE id = a) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL 1h the setting is not ON by default';
  END IF;
  -- seeding twice adds nothing
  PERFORM ticket_resolutions_seed(a);
  IF (SELECT count(*) FROM ticket_resolutions WHERE account_id = a) <> 8 THEN
    RAISE EXCEPTION 'FAIL 1i seeding twice added rows';
  END IF;

  -- who reads and writes the catalogue
  IF pg_temp.run(agent_a, format('SELECT count(*)::text FROM ticket_resolutions WHERE account_id = %L', a)) <> '8' THEN
    RAISE EXCEPTION 'FAIL 1j a member cannot read the catalogue';
  END IF;
  IF pg_temp.run(owner_b, format('SELECT count(*)::text FROM ticket_resolutions WHERE account_id = %L', a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL 1k a user of ANOTHER account can read the catalogue';
  END IF;
  res := pg_temp.run(agent_a, format(
    'INSERT INTO ticket_resolutions (account_id, name, position) VALUES (%L, ''Agent added'', 90)', a));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 1l an agent without tickets.configure-form added a resolution: %', res; END IF;
  res := pg_temp.run(agent_a, format('UPDATE ticket_resolutions SET name = ''Hacked'' WHERE id = %L', r_fixed));
  IF (SELECT name FROM ticket_resolutions WHERE id = r_fixed) <> 'Fixed' THEN
    RAISE EXCEPTION 'FAIL 1m an agent renamed a resolution';
  END IF;
  res := pg_temp.run(owner_a, format(
    'INSERT INTO ticket_resolutions (account_id, name, position, is_system, system_key) VALUES (%L, ''Workaround given'', 90, true, ''resolved_in_jira'')', a));
  -- the guard forces an ordinary row: the unique system key is not taken by it
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 1n the owner could not add a resolution: %', res; END IF;
  SELECT id INTO r_new FROM ticket_resolutions WHERE account_id = a AND name = 'Workaround given';
  IF (SELECT is_system OR system_key IS NOT NULL FROM ticket_resolutions WHERE id = r_new) THEN
    RAISE EXCEPTION 'FAIL 1o a person created a system resolution';
  END IF;
  res := pg_temp.run(owner_a, format('INSERT INTO ticket_resolutions (account_id, name) VALUES (%L, ''fixed'')', a));
  IF res NOT LIKE 'ERR 23505%' THEN RAISE EXCEPTION 'FAIL 1p a duplicate active name was accepted: %', res; END IF;
  res := pg_temp.run(owner_a, format('UPDATE ticket_resolutions SET is_active = false WHERE id = %L', r_jira));
  IF res NOT LIKE '%system_resolution_locked%' THEN RAISE EXCEPTION 'FAIL 1q a system resolution was archived: %', res; END IF;
  res := pg_temp.run(owner_a, format('UPDATE ticket_resolutions SET name = ''Closed by Jira'' WHERE id = %L', r_jira));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 1r a system resolution could not be renamed: %', res; END IF;
  res := pg_temp.run(owner_a, format('UPDATE ticket_resolutions SET system_key = NULL, is_system = false WHERE id = %L', r_jira));
  IF res NOT LIKE '%system_resolution_locked%' THEN RAISE EXCEPTION 'FAIL 1s a system resolution was demoted: %', res; END IF;
  res := pg_temp.run(owner_a, format('UPDATE ticket_resolutions SET account_id = %L WHERE id = %L', b, r_new));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL 1t a resolution was moved to another account: %', res; END IF;
  res := pg_temp.run(owner_a, format('DELETE FROM ticket_resolutions WHERE id = %L', r_new));
  IF (SELECT count(*) FROM ticket_resolutions WHERE id = r_new) <> 1 THEN
    RAISE EXCEPTION 'FAIL 1u a person deleted a resolution';
  END IF;
  -- audited: the owner's insert and the rename are in the log, the seeding is not
  IF (SELECT count(*) FROM audit_log WHERE account_id = a AND entity_type = 'ticket_resolution' AND actor_id = owner_a) < 2 THEN
    RAISE EXCEPTION 'FAIL 1v the owner''s catalogue changes were not audited';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_log WHERE account_id = a AND entity_type = 'ticket_resolution' AND actor_id IS NULL) THEN
    RAISE EXCEPTION 'FAIL 1w seeding wrote audit rows';
  END IF;

  -- ---------------------------------------------------------
  -- 2. The rule for people (setting ON)
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''resolved'' WHERE id = %L', tk1));
  IF res NOT LIKE 'ERR 22023: resolution_required' THEN RAISE EXCEPTION 'FAIL 2a resolving without a resolution was not rejected: %', res; END IF;
  res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''closed'' WHERE id = %L', tk1));
  IF res NOT LIKE 'ERR 22023: resolution_required' THEN RAISE EXCEPTION 'FAIL 2b closing without a resolution was not rejected: %', res; END IF;
  IF (SELECT status FROM tickets WHERE id = tk1) <> 'open' THEN RAISE EXCEPTION 'FAIL 2c the rejected ticket moved'; END IF;
  -- a whole multi-row statement fails as one
  res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''resolved'' WHERE id IN (%L, %L)', tk1, tk2));
  IF res NOT LIKE 'ERR 22023%' OR (SELECT count(*) FROM tickets WHERE id IN (tk1, tk2) AND status <> 'open') <> 0 THEN
    RAISE EXCEPTION 'FAIL 2d a bulk status change without a resolution was partly applied: %', res;
  END IF;
  -- other edits are untouched
  res := pg_temp.run(agent_a, format('UPDATE tickets SET priority = ''high'' WHERE id = %L', tk1));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 2e an ordinary edit was blocked: %', res; END IF;
  res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''pending'' WHERE id = %L', tk1));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 2f moving to Pending was blocked: %', res; END IF;

  -- with a resolution and a note
  res := pg_temp.run(agent_a, format(
    'UPDATE tickets SET status = ''resolved'', resolved_at = now(), resolution_id = %L, resolution_note = %L WHERE id = %L',
    r_fixed, 'Restarted the sync job', tk1));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 2g resolving with a resolution failed: %', res; END IF;
  IF pg_temp.resname(tk1) <> 'Fixed' THEN RAISE EXCEPTION 'FAIL 2h resolution not stored'; END IF;
  IF pg_temp.act(tk1, 'resolved_as') <> 1 OR
     (SELECT to_value || '|' || detail FROM ticket_activity WHERE ticket_id = tk1 AND event_type = 'resolved_as') <> 'Fixed|Restarted the sync job' THEN
    RAISE EXCEPTION 'FAIL 2i the history has no "resolved as" line';
  END IF;
  IF pg_temp.act(tk1, 'status_changed') < 1 THEN RAISE EXCEPTION 'FAIL 2j the status line is missing'; END IF;

  -- a bulk statement WITH a resolution applies to every row
  res := pg_temp.run(agent_a, format(
    'UPDATE tickets SET status = ''closed'', closed_at = now(), resolution_id = %L WHERE id IN (%L, %L)', r_dup, tk2, tk3));
  IF res <> 'OK' OR pg_temp.resname(tk2) <> 'Duplicate' OR pg_temp.resname(tk3) <> 'Duplicate' THEN
    RAISE EXCEPTION 'FAIL 2k a bulk close with a resolution: %', res;
  END IF;

  -- note rules
  res := pg_temp.run(agent_a, format('UPDATE tickets SET resolution_note = %L WHERE id = %L', repeat('x', 2001), tk1));
  IF res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL 2l a 2001 character note was accepted: %', res; END IF;
  res := pg_temp.run(agent_a, format('UPDATE tickets SET resolution_note = %L WHERE id = %L', repeat('x', 2000), tk1));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 2m a 2000 character note was rejected: %', res; END IF;
  res := pg_temp.run(agent_a, format('UPDATE tickets SET resolution_note = ''orphan'' WHERE id = %L', tk4));
  IF res NOT LIKE 'ERR 23514%' THEN RAISE EXCEPTION 'FAIL 2n a note without a resolution was accepted: %', res; END IF;

  -- a resolution that is not usable
  res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''resolved'', resolution_id = %L WHERE id = %L', r_other, tk4));
  IF res NOT LIKE 'ERR 22023: resolution_invalid' THEN RAISE EXCEPTION 'FAIL 2o another account''s resolution was accepted: %', res; END IF;
  UPDATE ticket_resolutions SET is_active = false WHERE id = r_new;
  res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''resolved'', resolution_id = %L WHERE id = %L', r_new, tk4));
  IF res NOT LIKE 'ERR 22023: resolution_invalid' THEN RAISE EXCEPTION 'FAIL 2p an archived resolution was accepted: %', res; END IF;
  UPDATE ticket_resolutions SET is_active = true WHERE id = r_new;

  -- a ticket created already resolved needs one too
  res := pg_temp.run(agent_a, format(
    'INSERT INTO tickets (account_id, ticket_number, contact_id, subject, status) VALUES (%L, 9001, %L, ''born resolved'', ''resolved'')', a, contact_a));
  IF res NOT LIKE 'ERR 22023: resolution_required' THEN RAISE EXCEPTION 'FAIL 2q a ticket was created resolved without a resolution: %', res; END IF;

  -- ---------------------------------------------------------
  -- 3. Changing it later is allowed and logged; re-opening clears nothing
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, format('UPDATE tickets SET resolution_id = %L, resolution_note = NULL WHERE id = %L', r_dup, tk1));
  IF res <> 'OK' OR pg_temp.resname(tk1) <> 'Duplicate' THEN RAISE EXCEPTION 'FAIL 3a changing the resolution: %', res; END IF;
  IF pg_temp.act(tk1, 'resolution_changed') < 1 OR
     NOT EXISTS (SELECT 1 FROM ticket_activity WHERE ticket_id = tk1 AND event_type = 'resolution_changed'
                  AND from_value = 'Fixed' AND to_value = 'Duplicate') THEN
    RAISE EXCEPTION 'FAIL 3b the change of resolution was not logged';
  END IF;
  -- it cannot be cleared while the ticket is done
  res := pg_temp.run(agent_a, format('UPDATE tickets SET resolution_id = NULL WHERE id = %L', tk1));
  IF res NOT LIKE 'ERR 22023: resolution_required' THEN RAISE EXCEPTION 'FAIL 3c a done ticket lost its resolution: %', res; END IF;
  -- re-open: nothing is cleared
  res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''open'', resolved_at = NULL, closed_at = NULL WHERE id = %L', tk1));
  IF res <> 'OK' OR pg_temp.resname(tk1) <> 'Duplicate' THEN RAISE EXCEPTION 'FAIL 3d re-opening cleared the resolution: %', res; END IF;
  IF pg_temp.act(tk1, 'resolved_as') <> 1 THEN RAISE EXCEPTION 'FAIL 3e re-opening rewrote the history'; END IF;
  -- resolving again keeps the earlier resolution and adds another "resolved as" line
  res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''resolved'', resolved_at = now() WHERE id = %L', tk1));
  IF res <> 'OK' OR pg_temp.act(tk1, 'resolved_as') <> 2 THEN RAISE EXCEPTION 'FAIL 3f resolving again: %', res; END IF;
  -- resolved -> closed keeps what is there and needs nothing
  res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''closed'', closed_at = now() WHERE id = %L', tk1));
  IF res <> 'OK' OR pg_temp.resname(tk1) <> 'Duplicate' THEN RAISE EXCEPTION 'FAIL 3g resolved -> closed: %', res; END IF;

  -- ---------------------------------------------------------
  -- 4. The setting: only tickets.configure-form changes it; OFF lets people through
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, format('UPDATE accounts SET require_ticket_resolution = false WHERE id = %L', a));
  IF (SELECT require_ticket_resolution FROM accounts WHERE id = a) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL 4a an agent turned the requirement off: %', res;
  END IF;
  res := pg_temp.run(owner_a, format('UPDATE accounts SET require_ticket_resolution = false WHERE id = %L', a));
  IF res <> 'OK' OR (SELECT require_ticket_resolution FROM accounts WHERE id = a) THEN
    RAISE EXCEPTION 'FAIL 4b the owner could not turn the requirement off: %', res;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE account_id = a AND entity_type = 'ticket_settings' AND actor_id = owner_a) THEN
    RAISE EXCEPTION 'FAIL 4c turning the requirement off was not audited';
  END IF;
  res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''resolved'', resolved_at = now() WHERE id = %L', tk4));
  IF res <> 'OK' OR pg_temp.resname(tk4) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 4d with the setting OFF a person was blocked or given a resolution: %', res;
  END IF;
  -- a wrong resolution is still refused with the setting off
  res := pg_temp.run(agent_a, format('UPDATE tickets SET resolution_id = %L WHERE id = %L', r_other, tk4));
  IF res NOT LIKE 'ERR 22023: resolution_invalid' THEN RAISE EXCEPTION 'FAIL 4e a foreign resolution was accepted with the setting off: %', res; END IF;
  res := pg_temp.run(owner_a, format('UPDATE accounts SET require_ticket_resolution = true WHERE id = %L', a));
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 4f could not turn it back on: %', res; END IF;
  -- other account columns still need settings.workspace as before (an agent cannot rename the account)
  res := pg_temp.run(agent_a, format('UPDATE accounts SET name = ''Renamed'' WHERE id = %L', a));
  IF (SELECT name FROM accounts WHERE id = a) = 'Renamed' THEN RAISE EXCEPTION 'FAIL 4g the accounts guard lost its other rules'; END IF;

  -- ---------------------------------------------------------
  -- 5. System writers are never blocked and get a default
  -- ---------------------------------------------------------
  -- the owner / service role, no person
  UPDATE tickets SET status = 'resolved', resolved_at = now() WHERE id = tk5;
  IF pg_temp.resname(tk5) IS DISTINCT FROM 'Closed automatically' THEN
    RAISE EXCEPTION 'FAIL 5a a system status change got resolution %', pg_temp.resname(tk5);
  END IF;
  res := pg_temp.run(NULL, format('UPDATE tickets SET status = ''open'' WHERE id = %L', tk5), 'service_role');
  res := pg_temp.run(NULL, format('UPDATE tickets SET status = ''closed'', resolution_id = NULL WHERE id = %L', tk5), 'service_role');
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 5b the service role was blocked: %', res; END IF;
  IF pg_temp.resname(tk5) IS NULL THEN RAISE EXCEPTION 'FAIL 5c the service role got no default resolution'; END IF;

  -- the Jira sync: no resolution given -> "Resolved in Jira" (renamed above to "Closed by Jira")
  UPDATE tickets SET status = 'open', resolved_at = NULL, closed_at = NULL WHERE id = tk5;
  IF NOT jira_apply_ticket_status(tk5, 'resolved', 'ENG-1') THEN RAISE EXCEPTION 'FAIL 5d Jira apply changed nothing'; END IF;
  IF (SELECT resolution_id FROM tickets WHERE id = tk5) <> r_jira THEN
    RAISE EXCEPTION 'FAIL 5e Jira done did not get the Jira resolution, got %', pg_temp.resname(tk5);
  END IF;
  IF pg_temp.act(tk5, 'resolved_as') < 1 THEN RAISE EXCEPTION 'FAIL 5f the Jira resolution was not logged'; END IF;
  -- with a mapped resolution
  UPDATE tickets SET status = 'open', resolved_at = NULL, closed_at = NULL WHERE id = tk5;
  IF NOT jira_apply_ticket_status(tk5, 'closed', 'ENG-1', r_fixed) THEN RAISE EXCEPTION 'FAIL 5g Jira apply (mapped) changed nothing'; END IF;
  IF (SELECT resolution_id FROM tickets WHERE id = tk5) <> r_fixed THEN
    RAISE EXCEPTION 'FAIL 5h the mapped Jira resolution was ignored, got %', pg_temp.resname(tk5);
  END IF;
  -- a mapped resolution of another account is ignored (falls back to the Jira one)
  UPDATE tickets SET status = 'open', resolved_at = NULL, closed_at = NULL WHERE id = tk5;
  PERFORM jira_apply_ticket_status(tk5, 'resolved', 'ENG-1', r_other);
  IF (SELECT resolution_id FROM tickets WHERE id = tk5) <> r_jira THEN
    RAISE EXCEPTION 'FAIL 5i a resolution of another account was applied by the Jira sync';
  END IF;
  -- Jira reopening keeps the resolution (nothing is cleared); a 3-argument call still works
  IF NOT jira_apply_ticket_status(tk5, 'in_progress', 'ENG-1') THEN RAISE EXCEPTION 'FAIL 5j Jira reopen'; END IF;
  IF (SELECT resolution_id FROM tickets WHERE id = tk5) <> r_jira THEN RAISE EXCEPTION 'FAIL 5k Jira reopen cleared the resolution'; END IF;

  -- a lost system row is recreated rather than blocking the writer
  DELETE FROM tickets WHERE id = tk5;
  DELETE FROM ticket_resolutions WHERE id = r_auto;
  INSERT INTO tickets (id, account_id, ticket_number, contact_id, subject, status)
  VALUES (tk5, a, 9002, contact_a, 'system born closed', 'closed');
  IF pg_temp.resname(tk5) IS NULL THEN RAISE EXCEPTION 'FAIL 5l a system insert as closed got no resolution'; END IF;

  -- ---------------------------------------------------------
  -- 6. Mention resolution (095) still runs when a person closes a ticket with a resolution
  -- ---------------------------------------------------------
  IF to_regclass('public.ticket_mentions') IS NOT NULL THEN
    INSERT INTO ticket_comments (id, ticket_id, account_id, author_id, body, mentions)
    VALUES (c1, tk4, a, agent_a, '@Agent2 please look', jsonb_build_array(agent2_a));
    INSERT INTO ticket_mentions (id, account_id, ticket_id, comment_id, mentioned_user_id, requested_by)
    VALUES (m1, a, tk4, c1, agent2_a, agent_a);
    -- tk4 is Resolved without a resolution (setting was off); reopen, then close it as a person with one
    UPDATE tickets SET status = 'open', resolved_at = NULL WHERE id = tk4;
    res := pg_temp.run(agent_a, format('UPDATE tickets SET status = ''resolved'' WHERE id = %L', tk4));
    IF res NOT LIKE 'ERR 22023%' OR (SELECT status FROM ticket_mentions WHERE id = m1) <> 'open' THEN
      RAISE EXCEPTION 'FAIL 6a a rejected close changed the mention: %', res;
    END IF;
    res := pg_temp.run(agent_a, format(
      'UPDATE tickets SET status = ''resolved'', resolved_at = now(), resolution_id = %L WHERE id = %L', r_fixed, tk4));
    IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL 6b closing with a resolution: %', res; END IF;
    IF (SELECT status || ':' || resolved_reason FROM ticket_mentions WHERE id = m1) <> 'done:ticket_closed' THEN
      RAISE EXCEPTION 'FAIL 6c the mention was not resolved by the close';
    END IF;
    IF pg_temp.act(tk4, 'mention_done') < 1 THEN RAISE EXCEPTION 'FAIL 6d the mention history line is missing'; END IF;
    -- and the earlier event types still fit the CHECK
    INSERT INTO ticket_activity (ticket_id, account_id, event_type) VALUES (tk4, a, 'mention_requested');
  END IF;
  INSERT INTO ticket_activity (ticket_id, account_id, event_type) VALUES (tk4, a, 'jira_status_synced');
  INSERT INTO ticket_activity (ticket_id, account_id, event_type) VALUES (tk4, a, 'status_changed');

  -- ---------------------------------------------------------
  -- 7. A new account is seeded by the trigger; deleting an account works
  -- ---------------------------------------------------------
  IF (SELECT count(*) FROM ticket_resolutions WHERE account_id = b) <> 8 THEN
    RAISE EXCEPTION 'FAIL 7a the second account was not seeded';
  END IF;
  DELETE FROM accounts WHERE id = b;
  IF EXISTS (SELECT 1 FROM ticket_resolutions WHERE account_id = b) THEN
    RAISE EXCEPTION 'FAIL 7b the catalogue survived its account';
  END IF;

  -- deleting an account that has tickets carrying resolutions is not blocked by the foreign key
  DELETE FROM accounts WHERE id = a;
  IF EXISTS (SELECT 1 FROM tickets WHERE account_id = a) OR EXISTS (SELECT 1 FROM ticket_resolutions WHERE account_id = a) THEN
    RAISE EXCEPTION 'FAIL 7c deleting the account left tickets or resolutions';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: ticket resolutions (catalogue RLS and seeding, required on Resolved and Closed for people, setting on/off with its capability, system writers and Jira never blocked, history lines, mention resolution unaffected) checked in % groups', 7;
END
$verify$;
