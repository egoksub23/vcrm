-- Verify migration 174 (Doc Sign, document collections: a draft collection can be put in a different order). Self-contained; run against an
-- empty database or production with 157's to 174's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: the place of a document is a deferrable unique constraint that still refuses two documents in one place at once; a place still
-- cannot be changed directly (by anyone, any way), and the envelope of a document still cannot; sign_envelope_set_order writes a whole new
-- order in one step (a reversal, a rotation) for a draft collection; it refuses a list that is not exactly the documents (missing, extra,
-- repeated, another workspace's) and an envelope that is not a draft; the marker it uses does not outlive
-- it; after a document is removed the places are compacted again and the next document takes the next place; nobody but the server can call it.
DO $verify$
DECLARE
  uA      uuid := gen_random_uuid();
  uB      uuid := gen_random_uuid();
  acctA   uuid;
  acctB   uuid;
  e1      uuid;
  e2      uuid;
  eB      uuid;
  d1      uuid;
  d2      uuid;
  d3      uuid;
  d4      uuid;
  dB      uuid;
  r       jsonb;
  v_txt   text;
  v_pos   text;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b-' || uB || '@example.invalid', '{"full_name":"Tenant B"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT account_id INTO acctB FROM profiles WHERE user_id = uB;
  PERFORM public.sign_ensure_defaults(acctA);
  PERFORM public.sign_ensure_defaults(acctB);

  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Collection', uA) RETURNING id INTO e1;
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Second collection', uA) RETURNING id INTO e2;
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctB, 'Other tenant collection', uB) RETURNING id INTO eB;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'One', uA, e1, 1) RETURNING id INTO d1;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'Two', uA, e1, 2) RETURNING id INTO d2;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'Three', uA, e1, 3) RETURNING id INTO d3;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctB, 'B one', uB, eB, 1) RETURNING id INTO dB;

  -- 1. The place is a deferrable unique constraint (checked at once unless deferred), and the old partial index is gone.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_documents_envelope_position_uq' AND conrelid = 'public.sign_documents'::regclass
                   AND contype = 'u' AND condeferrable AND NOT condeferred) THEN
    RAISE EXCEPTION 'FAIL the place of a document is not a deferrable unique constraint that is checked at once';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'sign_documents_envelope_position_idx') THEN
    RAISE EXCEPTION 'FAIL the old unique index is still there';
  END IF;
  BEGIN
    INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'Same place', uA, e1, 2);
    RAISE EXCEPTION 'FAIL two documents took the same place in a collection';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- a document that is not in a collection collides with nothing
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Plain 1', uA);
  INSERT INTO sign_documents (account_id, title, created_by) VALUES (acctA, 'Plain 2', uA);

  -- 2. A place and an envelope still cannot be changed directly.
  BEGIN
    UPDATE sign_documents SET envelope_position = 5 WHERE id = d3;
    RAISE EXCEPTION 'FAIL a place was changed directly';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_documents SET envelope_id = e2, envelope_position = 1 WHERE id = d3;
    RAISE EXCEPTION 'FAIL a document moved to another collection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3. A whole new order in one step: a reversal, then a rotation, then the same order again (nothing moves).
  r := public.sign_envelope_set_order(e1, ARRAY[d3, d2, d1]);
  SELECT string_agg(title, ',' ORDER BY envelope_position) INTO v_pos FROM sign_documents WHERE envelope_id = e1;
  IF v_pos <> 'Three,Two,One' OR (r ->> 'count')::int <> 3 THEN RAISE EXCEPTION 'FAIL the reversal did not give Three,Two,One: % %', v_pos, r; END IF;
  IF (SELECT min(envelope_position) FROM sign_documents WHERE envelope_id = e1) <> 1 OR (SELECT max(envelope_position) FROM sign_documents WHERE envelope_id = e1) <> 3 THEN
    RAISE EXCEPTION 'FAIL the places are not 1 to 3';
  END IF;
  PERFORM public.sign_envelope_set_order(e1, ARRAY[d2, d1, d3]);
  SELECT string_agg(title, ',' ORDER BY envelope_position) INTO v_pos FROM sign_documents WHERE envelope_id = e1;
  IF v_pos <> 'Two,One,Three' THEN RAISE EXCEPTION 'FAIL the rotation did not give Two,One,Three: %', v_pos; END IF;
  r := public.sign_envelope_set_order(e1, ARRAY[d2, d1, d3]);
  IF (r ->> 'moved')::int <> 0 THEN RAISE EXCEPTION 'FAIL the same order moved documents: %', r; END IF;
  -- the marker does not outlive the call: a direct change is refused again
  BEGIN
    UPDATE sign_documents SET envelope_position = 5 WHERE id = d3;
    RAISE EXCEPTION 'FAIL a place was changed directly after an order was written';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- the constraint is immediate again: another document cannot take a place
  BEGIN
    INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'Same place again', uA, e1, 1);
    RAISE EXCEPTION 'FAIL two documents took the same place after an order was written';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 4. A list that is not exactly the documents is refused, and nothing moved.
  BEGIN
    PERFORM public.sign_envelope_set_order(e1, ARRAY[d1, d2]);
    RAISE EXCEPTION 'FAIL an order that left a document out was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_envelope_set_order(e1, ARRAY[d1, d2, d3, gen_random_uuid()]);
    RAISE EXCEPTION 'FAIL an order with a stranger was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_envelope_set_order(e1, ARRAY[d1, d1, d3]);
    RAISE EXCEPTION 'FAIL an order that repeated a document was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_envelope_set_order(e1, ARRAY[d1, d2, dB]);
    RAISE EXCEPTION 'FAIL an order with another workspace''s document was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.sign_envelope_set_order(e1, NULL);
    RAISE EXCEPTION 'FAIL an empty order was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT string_agg(title, ',' ORDER BY envelope_position) INTO v_pos FROM sign_documents WHERE envelope_id = e1;
  IF v_pos <> 'Two,One,Three' THEN RAISE EXCEPTION 'FAIL a refused order changed the places: %', v_pos; END IF;
  BEGIN
    PERFORM public.sign_envelope_set_order(eB, ARRAY[d1]);
    RAISE EXCEPTION 'FAIL the documents of one workspace were put in another workspace''s collection order';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5. Only a draft collection: one that was sent is refused (the function also refuses a draft collection holding a document that is not a draft).
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'E2 one', uA, e2, 1) RETURNING id INTO d4;
  UPDATE sign_envelopes SET status = 'sent' WHERE id = e2;
  BEGIN
    PERFORM public.sign_envelope_set_order(e2, ARRAY[d4]);
    RAISE EXCEPTION 'FAIL a collection that was sent was reordered';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE sign_envelopes SET status = 'draft' WHERE id = e2;

  -- 6. After a removal the places are written again and the next document takes the next place.
  DELETE FROM sign_documents WHERE id = d1;
  PERFORM public.sign_envelope_set_order(e1, ARRAY[d2, d3]);
  SELECT string_agg(title || '=' || envelope_position, ',' ORDER BY envelope_position) INTO v_pos FROM sign_documents WHERE envelope_id = e1;
  IF v_pos <> 'Two=1,Three=2' THEN RAISE EXCEPTION 'FAIL the places were not compacted after a removal: %', v_pos; END IF;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position) VALUES (acctA, 'Four', uA, e1, 3);
  SELECT string_agg(title || '=' || envelope_position, ',' ORDER BY envelope_position) INTO v_pos FROM sign_documents WHERE envelope_id = e1;
  IF v_pos <> 'Two=1,Three=2,Four=3' THEN RAISE EXCEPTION 'FAIL the next document did not take the next place: %', v_pos; END IF;

  -- 7. Nobody but the server calls it; the guard and the function keep a pinned search_path.
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sign_envelope_set_order'
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL callable by signed-in or signed-out users: %', v_txt; END IF;
  IF NOT has_function_privilege('service_role', 'public.sign_envelope_set_order(uuid, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL the server cannot call sign_envelope_set_order';
  END IF;
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef AND p.proname IN ('sign_envelope_set_order', 'sign_documents_envelope_guard')
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL SECURITY DEFINER without a pinned search_path: %', v_txt; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: the place of a document is a deferrable unique constraint checked at once; a place and an envelope still cannot be changed directly; a whole new order is written in one step for a draft collection (reversal, rotation, no-op); a list that is not exactly the documents and a collection that was sent are refused with nothing moved; the marker does not outlive the call; after a removal the places are compacted and the next document takes the next place; only the server can call it; search_path pinned';
END
$verify$;
