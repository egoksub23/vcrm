-- ============================================================
-- Policy cost benchmark for migration 088 (rolled back, nothing is kept).
-- Compares the pre-088 role-floor policies (OLD) with the 088 policies (NEW)
-- on conversations, contacts and messages, as an Agent with RLS on, using
-- synthetic rows generated inside the transaction.
--
--   supabase db query --linked -f supabase/ci/bench-088-policy-cost.sql
--
-- The hosted API cancels a statement after about two minutes, so this file
-- runs the single-row loops and the read (steps 5-8). Edit the constants at
-- the top of the DO block (steps, row counts) to run the bulk statements
-- (steps 1, 2, 4) with 12000 / 24000 rows, or the EXPLAIN (step 9, NEW only).
-- Results are recorded in docs/access-control-enforcement.md.
-- ============================================================
DO $bench$
DECLARE
  a        UUID;
  owner_a  UUID := gen_random_uuid();
  agent_a  UUID := gen_random_uuid();
  out      TEXT := '';
  v        TEXT;
  t0       TIMESTAMPTZ;
  t00      TIMESTAMPTZ := clock_timestamp();
  ms       NUMERIC;
  plan     TEXT;
  r        RECORD;
  ids      UUID[];
  cid      UUID;
  steps    TEXT := ',5,6,7,8,';
  N_CONT   INTEGER := 4000;
  N_MSG    INTEGER := 8000;
  LOOPN    INTEGER := 400;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'bench088-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, agent_a]) AS u;
  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  UPDATE profiles SET account_id = a, account_role = 'agent' WHERE user_id = agent_a;
  DELETE FROM accounts WHERE owner_user_id = agent_a;

  INSERT INTO contacts (id, user_id, account_id, phone, name)
  SELECT gen_random_uuid(), owner_a, a, '+9' || lpad(g::text, 9, '0'), 'C' || g
    FROM generate_series(1, N_CONT) g;
  INSERT INTO conversations (id, user_id, account_id, contact_id)
  SELECT gen_random_uuid(), owner_a, a, c.id FROM contacts c WHERE c.account_id = a;
  INSERT INTO messages (id, conversation_id, sender_type, content_text, message_id)
  SELECT gen_random_uuid(), c.id, 'customer', 'hello ' || g, 'wamid.' || g || c.id
    FROM conversations c
    JOIN generate_series(1, 2) g ON true
   WHERE c.account_id = a
   LIMIT N_MSG;
  ANALYZE contacts; ANALYZE conversations; ANALYZE messages;
  SELECT array_agg(id) INTO ids FROM (SELECT id FROM conversations WHERE account_id = a LIMIT LOOPN) x;
  out := out || format('rows: contacts=%s conversations=%s messages=%s; setup %s ms%s',
    N_CONT, (SELECT count(*) FROM conversations WHERE account_id = a), N_MSG,
    round(extract(epoch FROM clock_timestamp() - t00) * 1000), E'\n');

  -- remember the policies the migration installed, to switch back and forth
  CREATE TEMP TABLE newpol AS
    SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
     WHERE schemaname = 'public' AND tablename IN ('conversations', 'contacts', 'messages')
       AND policyname IN ('conversations_insert', 'conversations_update', 'conversations_delete',
                          'contacts_insert', 'contacts_update', 'contacts_delete',
                          'messages_insert', 'messages_update', 'messages_delete');

  FOREACH v IN ARRAY ARRAY['NEW','OLD','NEW2','OLD2'] LOOP
    FOR r IN SELECT * FROM newpol LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
    END LOOP;
    EXECUTE 'DROP POLICY IF EXISTS messages_modify ON public.messages';
    IF v LIKE 'OLD%' THEN
      EXECUTE 'ALTER TABLE public.conversations DISABLE TRIGGER conversations_capability_guard';
      EXECUTE $p$CREATE POLICY conversations_insert ON public.conversations FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'))$p$;
      EXECUTE $p$CREATE POLICY conversations_update ON public.conversations FOR UPDATE USING (is_account_member(account_id, 'agent'))$p$;
      EXECUTE $p$CREATE POLICY conversations_delete ON public.conversations FOR DELETE USING (is_account_member(account_id, 'agent'))$p$;
      EXECUTE $p$CREATE POLICY contacts_insert ON public.contacts FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'))$p$;
      EXECUTE $p$CREATE POLICY contacts_update ON public.contacts FOR UPDATE USING (is_account_member(account_id, 'agent'))$p$;
      EXECUTE $p$CREATE POLICY contacts_delete ON public.contacts FOR DELETE USING (is_account_member(account_id, 'agent'))$p$;
      EXECUTE $p$CREATE POLICY messages_modify ON public.messages FOR ALL USING (EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND is_account_member(c.account_id, 'agent')))$p$;
    ELSE
      EXECUTE 'ALTER TABLE public.conversations ENABLE TRIGGER conversations_capability_guard';
      FOR r IN SELECT * FROM newpol LOOP
        EXECUTE format('CREATE POLICY %I ON public.%I FOR %s %s %s', r.policyname, r.tablename, r.cmd,
                       CASE WHEN r.qual IS NOT NULL THEN 'USING (' || r.qual || ')' ELSE '' END,
                       CASE WHEN r.with_check IS NOT NULL THEN 'WITH CHECK (' || r.with_check || ')' ELSE '' END);
      END LOOP;
    END IF;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', agent_a, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', agent_a::text, true);
    SET LOCAL ROLE authenticated;

    IF steps LIKE '%,1,%' THEN
      t0 := clock_timestamp();
      UPDATE conversations SET unread_count = COALESCE(unread_count, 0) + 1 WHERE account_id = a;
      ms := extract(epoch FROM clock_timestamp() - t0) * 1000;
      out := out || format('%-17s bulk UPDATE conversations (%s rows): %s ms%s', v, N_CONT, round(ms), E'\n');
    END IF;

    IF steps LIKE '%,2,%' THEN
      t0 := clock_timestamp();
      UPDATE contacts SET company = 'Acme' WHERE account_id = a;
      ms := extract(epoch FROM clock_timestamp() - t0) * 1000;
      out := out || format('%-17s bulk UPDATE contacts (%s rows): %s ms%s', v, N_CONT, round(ms), E'\n');
    END IF;

    IF steps LIKE '%,3,%' THEN
      t0 := clock_timestamp();
      UPDATE messages SET status = 'delivered' WHERE conversation_id = ANY (ids);
      ms := extract(epoch FROM clock_timestamp() - t0) * 1000;
      out := out || format('%-17s bulk UPDATE messages (%s conv): %s ms%s', v, LOOPN, round(ms), E'\n');
    END IF;

    IF steps LIKE '%,4,%' THEN
      t0 := clock_timestamp();
      INSERT INTO messages (conversation_id, sender_type, content_text)
      SELECT ids[1], 'agent', 'x' FROM generate_series(1, 5000);
      ms := extract(epoch FROM clock_timestamp() - t0) * 1000;
      out := out || format('%-17s bulk INSERT messages (5000): %s ms%s', v, round(ms), E'\n');
      t0 := clock_timestamp();
      DELETE FROM messages WHERE conversation_id = ids[1] AND sender_type = 'agent' AND content_text = 'x';
      ms := extract(epoch FROM clock_timestamp() - t0) * 1000;
      out := out || format('%-17s bulk DELETE messages (5000): %s ms%s', v, round(ms), E'\n');
    END IF;

    IF steps LIKE '%,5,%' THEN
      t0 := clock_timestamp();
      FOREACH cid IN ARRAY ids LOOP
        EXECUTE 'UPDATE conversations SET unread_count = 0 WHERE id = $1' USING cid;
      END LOOP;
      ms := extract(epoch FROM clock_timestamp() - t0) * 1000;
      out := out || format('%-17s %s single UPDATE conversations by pk: %s ms (%s ms/op)%s', v, LOOPN, round(ms), round(ms / LOOPN, 4), E'\n');
    END IF;

    IF steps LIKE '%,6,%' THEN
      t0 := clock_timestamp();
      FOREACH cid IN ARRAY ids LOOP
        EXECUTE 'INSERT INTO messages (conversation_id, sender_type, content_text) VALUES ($1, ''agent'', ''y'')' USING cid;
      END LOOP;
      ms := extract(epoch FROM clock_timestamp() - t0) * 1000;
      out := out || format('%-17s %s single INSERT messages: %s ms (%s ms/op)%s', v, LOOPN, round(ms), round(ms / LOOPN, 4), E'\n');
    END IF;

    IF steps LIKE '%,7,%' THEN
      t0 := clock_timestamp();
      FOREACH cid IN ARRAY ids LOOP
        EXECUTE 'UPDATE contacts SET company = ''Z'' WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)' USING cid;
      END LOOP;
      ms := extract(epoch FROM clock_timestamp() - t0) * 1000;
      out := out || format('%-17s %s single UPDATE contacts by pk: %s ms (%s ms/op)%s', v, LOOPN, round(ms), round(ms / LOOPN, 4), E'\n');
    END IF;

    IF steps LIKE '%,8,%' THEN
      t0 := clock_timestamp();
      PERFORM count(*) FROM messages;
      ms := extract(epoch FROM clock_timestamp() - t0) * 1000;
      out := out || format('%-17s SELECT count(*) messages (read, policy unchanged): %s ms%s', v, round(ms), E'\n');
    END IF;

    IF steps LIKE '%,9,%' AND v LIKE 'NEW%' THEN
      plan := '';
      FOR r IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) UPDATE conversations SET priority = ''low'' WHERE account_id = ''' || a || '''' LOOP
        plan := plan || '    ' || r."QUERY PLAN" || E'\n';
      END LOOP;
      out := out || v || E' EXPLAIN UPDATE conversations:\n' || plan;
      plan := '';
      FOR r IN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) UPDATE messages SET status = ''read'' WHERE conversation_id = ''' || ids[1] || '''' LOOP
        plan := plan || '    ' || r."QUERY PLAN" || E'\n';
      END LOOP;
      out := out || v || E' EXPLAIN UPDATE messages:\n' || plan;
    END IF;

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
  END LOOP;

  RAISE EXCEPTION 'ROLLBACK-OK: %', E'\n' || out;
END
$bench$;
