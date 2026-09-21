-- ============================================================
-- Verification for migration 090 (AI in automations).
--
-- Run BEFORE applying, together with the draft (the whole thing rolls back):
--   cat supabase/ci/drafts/090_automation_ai.sql supabase/ci/verify-090-automation-ai.sql > /tmp/both.sql
--   supabase db query --linked -f /tmp/both.sql
--
-- Idempotency: run the draft TWICE before the verification and it must still pass:
--   cat supabase/ci/drafts/090_automation_ai.sql supabase/ci/drafts/090_automation_ai.sql \
--       supabase/ci/verify-090-automation-ai.sql > /tmp/both.sql
--
-- Or, after applying 090 (migrations/090_automation_ai.sql), on its own:
--   supabase db query --linked -f supabase/ci/verify-090-automation-ai.sql
--
-- Everything happens inside one DO block that ends with
-- RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing is ever committed.
-- A message starting with ROLLBACK-OK means every check passed; any other
-- error message names the check that failed.
--
-- What it proves
--   1. ai_task_routing accepts the job 'automation' (and every older job)
--   2. ai_usage_log accepts mode 'automation' (and every older mode)
--   3. an unknown value is still refused by both (the CHECKs were widened, not dropped)
--   4. each constraint lists 'automation' exactly once (a re-run does not duplicate it)
--   5. automations accept the conversation_closed trigger and the new step
--      types, with AI reply's yes / no children
--   6. next_ticket_number_system: service role only, same counter as
--      next_ticket_number; a ticket with no creator (created_by NULL) can be
--      created the way the engine does it, with its 'created' activity row and
--      an internal comment with no author
--   7. next_ticket_number (the people-facing one) still refuses a Viewer
--   8. the close path the engine uses (service role, no session) still closes
--      a conversation and writes its session-log event
-- ============================================================

DO $verify$
DECLARE
  a        UUID;
  owner_a  UUID := gen_random_uuid();
  viewer_a UUID := gen_random_uuid();
  contact_a UUID := gen_random_uuid();
  conv_a   UUID := gen_random_uuid();
  auto_id  UUID := gen_random_uuid();
  step_id  UUID := gen_random_uuid();
  tk       UUID;
  n        INTEGER := 0;
  res      TEXT;
  def      TEXT;
  v        TEXT;
  n1       INTEGER;
  n2       INTEGER;
  seq0     INTEGER;
  cnt      INTEGER;
BEGIN
  -- ---------------------------------------------------------
  -- helper: run one statement as a person (NULL = no session) or another role
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

  -- ---------------------------------------------------------
  -- fixtures: users -> (trigger) accounts + profiles
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify090-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, viewer_a]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  IF a IS NULL THEN
    RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create the account';
  END IF;
  UPDATE profiles SET account_id = a, account_role = 'viewer' WHERE user_id = viewer_a;
  DELETE FROM accounts WHERE owner_user_id = viewer_a;
  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (contact_a, owner_a, a, '+10000000090', 'Casey');
  INSERT INTO conversations (id, user_id, account_id, contact_id) VALUES (conv_a, owner_a, a, contact_a);

  -- ---------------------------------------------------------
  -- 1. ai_task_routing accepts 'automation' and every older job
  -- ---------------------------------------------------------
  FOREACH v IN ARRAY ARRAY['draft', 'auto_reply', 'auto_label', 'closing_note', 'summary', 'translate', 'automation'] LOOP
    res := pg_temp.run(owner_a, format(
      $q$INSERT INTO ai_task_routing (account_id, task, enabled) VALUES (%L, %L, true) ON CONFLICT (account_id, task) DO NOTHING$q$, a, v));
    IF res <> 'OK' THEN
      RAISE EXCEPTION 'FAIL ai_task_routing refused the job %: %', v, res;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM ai_task_routing WHERE account_id = a) <> 7 THEN
    RAISE EXCEPTION 'FAIL ai_task_routing should hold all seven jobs';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 2. ai_usage_log accepts mode 'automation' and every older mode
  -- ---------------------------------------------------------
  FOREACH v IN ARRAY ARRAY['auto_reply', 'draft', 'auto_label', 'closing_note', 'summary', 'translate', 'automation'] LOOP
    INSERT INTO ai_usage_log (account_id, conversation_id, mode, provider, model, prompt_tokens, completion_tokens, total_tokens)
    VALUES (a, conv_a, v, 'openai', 'verify-model', 10, 5, 15);
  END LOOP;
  IF (SELECT count(*) FROM ai_usage_log WHERE account_id = a AND mode = 'automation') <> 1 THEN
    RAISE EXCEPTION 'FAIL ai_usage_log did not keep the automation row';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 3. an unknown value is still refused (widened, not dropped)
  -- ---------------------------------------------------------
  res := pg_temp.run(owner_a, format(
    $q$INSERT INTO ai_task_routing (account_id, task, enabled) VALUES (%L, 'nonsense', true)$q$, a));
  IF res NOT LIKE 'ERR 23514%' THEN
    RAISE EXCEPTION 'FAIL ai_task_routing accepted an unknown job: %', res;
  END IF;
  BEGIN
    INSERT INTO ai_usage_log (account_id, mode, provider, model) VALUES (a, 'nonsense', 'openai', 'x');
    RAISE EXCEPTION 'FAIL ai_usage_log accepted an unknown mode';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 4. 'automation' appears exactly once in each definition (idempotent re-run)
  -- ---------------------------------------------------------
  FOR def IN
    SELECT pg_get_constraintdef(oid) FROM pg_constraint
     WHERE contype = 'c'
       AND conrelid IN ('public.ai_task_routing'::regclass, 'public.ai_usage_log'::regclass)
       AND pg_get_constraintdef(oid) LIKE '%closing_note%'
  LOOP
    cnt := (length(def) - length(replace(def, '''automation''', ''))) / length('''automation''');
    IF cnt <> 1 THEN
      RAISE EXCEPTION 'FAIL ''automation'' should be listed exactly once, found % in %', cnt, def;
    END IF;
  END LOOP;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 5. automations: the new trigger and step types, with AI reply's branches
  -- ---------------------------------------------------------
  INSERT INTO automations (id, user_id, account_id, name, trigger_type, is_active)
  VALUES (auto_id, owner_a, a, 'verify 090', 'conversation_closed', false);
  INSERT INTO automation_steps (id, automation_id, step_type, step_config, position)
  VALUES (step_id, auto_id, 'ai_reply', '{"mode":"send","on_failure":"skip"}'::jsonb, 0);
  INSERT INTO automation_steps (automation_id, parent_step_id, branch, step_type, step_config, position)
  VALUES (auto_id, step_id, 'no', 'create_ticket', '{"subject":"x","ai_write":true}'::jsonb, 0),
         (auto_id, step_id, 'yes', 'ai_summarize', '{}'::jsonb, 0),
         (auto_id, NULL, NULL, 'ai_extract', '{"fields":[]}'::jsonb, 1),
         (auto_id, NULL, NULL, 'ai_translate', '{"target_language":"ko"}'::jsonb, 2);
  IF (SELECT count(*) FROM automation_steps WHERE automation_id = auto_id) <> 5 THEN
    RAISE EXCEPTION 'FAIL the new step types were not stored';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 6. next_ticket_number_system: server only, the same counter, no creator
  -- ---------------------------------------------------------
  IF has_function_privilege('anon', 'public.next_ticket_number_system(uuid)', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.next_ticket_number_system(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL next_ticket_number_system must not be executable by anon or authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.next_ticket_number_system(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL service_role cannot execute next_ticket_number_system';
  END IF;
  res := pg_temp.run(owner_a, format('SELECT public.next_ticket_number_system(%L)::text', a));
  IF res NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL a signed-in member could call next_ticket_number_system: %', res;
  END IF;

  SELECT ticket_seq INTO seq0 FROM accounts WHERE id = a;
  res := pg_temp.run(NULL, format('SELECT public.next_ticket_number_system(%L)::text', a), 'service_role');
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the service role could not take a ticket number: %', res; END IF;
  n1 := res::int;
  res := pg_temp.run(NULL, format('SELECT public.next_ticket_number_system(%L)::text', a), 'service_role');
  n2 := res::int;
  IF n1 <> seq0 + 1 OR n2 <> n1 + 1 THEN
    RAISE EXCEPTION 'FAIL ticket numbers are not one sequence: seq %, got % then %', seq0, n1, n2;
  END IF;
  -- The people-facing function shares that counter (its next number follows).
  IF (SELECT ticket_seq FROM accounts WHERE id = a) <> n2 THEN
    RAISE EXCEPTION 'FAIL the counter is not accounts.ticket_seq';
  END IF;

  -- The ticket the engine creates: no creator, linked to the conversation.
  tk := gen_random_uuid();
  res := pg_temp.run(NULL, format(
    $q$INSERT INTO tickets (id, account_id, ticket_number, contact_id, conversation_id, subject, description, category, priority, created_by)
       VALUES (%L, %L, %s, %L, %L, 'Follow-up: Casey', 'Summary text', 'general', 'normal', NULL)$q$,
    tk, a, n2, contact_a, conv_a), 'service_role');
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL the engine could not insert a ticket: %', res; END IF;
  res := pg_temp.run(NULL, format(
    $q$INSERT INTO ticket_comments (ticket_id, account_id, author_id, body, mentions)
       VALUES (%L, %L, NULL, 'Created by automation "verify 090"', '[]'::jsonb)$q$, tk, a), 'service_role');
  IF res <> 'OK' THEN RAISE EXCEPTION 'FAIL the engine could not add the ticket note: %', res; END IF;
  IF (SELECT count(*) FROM ticket_activity WHERE ticket_id = tk AND event_type = 'created') <> 1 THEN
    RAISE EXCEPTION 'FAIL the ticket "created" activity row is missing';
  END IF;
  IF (SELECT created_by FROM tickets WHERE id = tk) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL an automation ticket should have no creator';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 7. the people-facing counter still needs tickets.work
  -- ---------------------------------------------------------
  res := pg_temp.run(viewer_a, format('SELECT public.next_ticket_number(%L)::text', a));
  IF res NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL next_ticket_number let a Viewer through: %', res;
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 8. the engine's close path: service role, no session
  -- ---------------------------------------------------------
  res := pg_temp.run(NULL, format(
    $q$SELECT public.close_conversation_with_note(%L, 'Closed automatically by automation "verify 090"')::text$q$, conv_a), 'service_role');
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL the engine could not close a conversation: %', res; END IF;
  IF (SELECT status FROM conversations WHERE id = conv_a) <> 'closed' THEN
    RAISE EXCEPTION 'FAIL the conversation is not closed';
  END IF;
  IF (SELECT count(*) FROM conversation_events WHERE conversation_id = conv_a AND event_type = 'closed') <> 1 THEN
    RAISE EXCEPTION 'FAIL the close did not write its session-log event';
  END IF;
  n := n + 1;

  RAISE EXCEPTION 'ROLLBACK-OK: % sections (routing and usage log accept automation, older values kept, unknown refused, no duplicate value, new trigger and step types, ticket numbering for the engine, close path)', n;
END
$verify$;
