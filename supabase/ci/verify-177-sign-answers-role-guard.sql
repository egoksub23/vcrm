-- Verify migration 177 (Doc Sign: an answer to a place that belongs to another role is refused by the database). Self-contained; run against an empty
-- database or production with 157's to 177's migration text concatenated in front when they are not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Proves: on a document on its own and on each document of a collection, a person's answer to a place of THEIR role is kept; an answer to a place of
-- another role is refused (check_violation sign_answer_is_not_the_signers), whether it is inserted for the wrong person or moved to one; the
-- refusal holds for an upsert (the way the server saves) and leaves nothing behind; a person of a collection has their own role on each document, so
-- the same key on another document is judged by that document's place; a key that is not a place on the page (a data field of a form, or no field
-- at all), a place with no role and a place that prints a form's answer are not judged; rows that were already there are untouched; the guard is not
-- callable by signed-in or signed-out users and keeps a pinned search_path; an answer is kept only against the person's own row on the document it answers; and the trigger is installed on sign_answers.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();
  acctA  uuid;
  d1     uuid;  -- a document on its own
  e1     uuid;  -- a collection
  c1     uuid;  -- its first document
  c2     uuid;  -- its second document
  gokula uuid;  -- role pp_gokula on d1
  gopala uuid;  -- role pp_gopala on d1
  cg1    uuid;  -- Gokula's row on c1
  cp1    uuid;  -- Gopala's row on c1
  cp2    uuid;  -- Gopala's row on c2
  v_n    int;
  v_txt  text;
  v_fields jsonb := '[{"key":"sigGokula","type":"signature","role":"pp_gokula","page":0,"x":0.1,"y":0.1,"w":0.2,"h":0.05,"required":true},
                      {"key":"sigGopala","type":"signature","role":"pp_gopala","page":0,"x":0.1,"y":0.3,"w":0.2,"h":0.05,"required":true},
                      {"key":"noRole","type":"text","page":0,"x":0.1,"y":0.5,"w":0.2,"h":0.05},
                      {"key":"printed","type":"text","role":"sender","data":"legalName","page":0,"x":0.1,"y":0.6,"w":0.2,"h":0.05},
                      {"key":"legalName","type":"text","role":"pp_gopala","page":0,"x":0.1,"y":0.7,"w":0.2,"h":0.05}]'::jsonb;
  v_form   jsonb := '{"version":1,"parts":[{"key":"company","title":{"en":"Company"},"role":"pp_gopala"}],
                      "fields":[{"key":"legalName","type":"text","part":"company","label":{"en":"Legal name"},"required":true}]}'::jsonb;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  PERFORM public.sign_ensure_defaults(acctA);

  -- 0. The trigger is installed; its function is the database's own (nobody calls it) and pins its search_path.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.sign_answers'::regclass AND tgname = 'sign_answers_role_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FAIL the trigger sign_answers_role_guard is missing';
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sign_answers_role_guard'
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL the guard is callable by signed-in or signed-out users'; END IF;
  SELECT string_agg(p.proname, ', ') INTO v_txt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sign_answers_role_guard' AND p.prosecdef
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'FAIL the guard is SECURITY DEFINER without a pinned search_path'; END IF;

  -- 1. A document on its own: two people, two roles.
  INSERT INTO sign_documents (account_id, title, created_by, fields_snapshot, form_snapshot) VALUES (acctA, 'On its own', uA, v_fields, v_form) RETURNING id INTO d1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d1, 'pp_gokula', 'Gokula Krishnan', 'gokula@example.invalid', 1) RETURNING id INTO gokula;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, d1, 'pp_gopala', 'Gopala Krishnan', 'gopala@example.invalid', 2) RETURNING id INTO gopala;

  -- their own places are kept
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d1, gokula, 'sigGokula', '{"typed":"Gokula"}'::jsonb);
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d1, gopala, 'sigGopala', '{"typed":"Gopala"}'::jsonb);
  -- the other person's place is refused, for either of them, and nothing is left behind
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d1, gokula, 'sigGopala', '{"typed":"Gokula pretending"}'::jsonb);
    RAISE EXCEPTION 'FAIL Gokula could answer the place of Gopala';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d1, gopala, 'sigGokula', '{"typed":"Gopala pretending"}'::jsonb);
    RAISE EXCEPTION 'FAIL Gopala could answer the place of Gokula';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT count(*) FROM sign_answers WHERE document_id = d1) <> 2 THEN RAISE EXCEPTION 'FAIL a refused answer left a row behind'; END IF;
  -- the way the server saves (an upsert) is held to the same rule, on the insert side and when it would update
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d1, gokula, 'sigGopala', '{"typed":"x"}'::jsonb)
      ON CONFLICT (document_id, signer_id, field_key) DO UPDATE SET value = EXCLUDED.value;
    RAISE EXCEPTION 'FAIL an upsert put Gokula on the place of Gopala';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- an answer cannot be moved to another person's place, or to the other person
  BEGIN
    UPDATE sign_answers SET field_key = 'sigGopala' WHERE document_id = d1 AND signer_id = gokula AND field_key = 'sigGokula';
    RAISE EXCEPTION 'FAIL an answer was moved onto the place of another role';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sign_answers SET signer_id = gopala WHERE document_id = d1 AND signer_id = gokula AND field_key = 'sigGokula';
    RAISE EXCEPTION 'FAIL an answer was moved to a person of another role';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- what is not a place of a role is not judged: a key the document does not have, a place with no role, a place that prints a form's answer
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d1, gokula, 'nothingLikeThis', '{"text":"x"}'::jsonb);
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d1, gokula, 'noRole', '{"text":"x"}'::jsonb);
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d1, gokula, 'printed', '{"text":"x"}'::jsonb);
  -- a key that is a data field of the form is the form's business, even when a place of another role has the same key
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, d1, gokula, 'legalName', '{"text":"Kedai Gokula"}'::jsonb);

  -- 2. A collection: a person has a row, with their own role, on each document they are on; the same key on another document is judged there.
  INSERT INTO sign_envelopes (account_id, title, created_by) VALUES (acctA, 'Collection', uA) RETURNING id INTO e1;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position, fields_snapshot)
  VALUES (acctA, 'First', uA, e1, 1, '[{"key":"s1","type":"signature","role":"pp_gokula","page":0,"x":0.1,"y":0.1,"w":0.2,"h":0.05},
                                      {"key":"s2","type":"signature","role":"pp_gopala","page":0,"x":0.1,"y":0.3,"w":0.2,"h":0.05}]'::jsonb) RETURNING id INTO c1;
  INSERT INTO sign_documents (account_id, title, created_by, envelope_id, envelope_position, fields_snapshot)
  VALUES (acctA, 'Second', uA, e1, 2, '[{"key":"s1","type":"signature","role":"pp_gopala","page":0,"x":0.1,"y":0.1,"w":0.2,"h":0.05}]'::jsonb) RETURNING id INTO c2;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, c1, 'pp_gokula', 'Gokula Krishnan', 'gokula@example.invalid', 1) RETURNING id INTO cg1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, c1, 'pp_gopala', 'Gopala Krishnan', 'gopala@example.invalid', 2) RETURNING id INTO cp1;
  INSERT INTO sign_signers (account_id, document_id, role_key, full_name, email, order_no) VALUES (acctA, c2, 'pp_gopala', 'Gopala Krishnan', 'gopala@example.invalid', 2) RETURNING id INTO cp2;
  -- "s1" is Gokula's on the first document and Gopala's on the second
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, c1, cg1, 's1', '{"typed":"Gokula"}'::jsonb);
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, c2, cp2, 's1', '{"typed":"Gopala"}'::jsonb);
  INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, c1, cp1, 's2', '{"typed":"Gopala"}'::jsonb);
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, c1, cp1, 's1', '{"typed":"Gopala pretending"}'::jsonb);
    RAISE EXCEPTION 'FAIL Gopala could answer Gokula''s place on the first document of a collection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, c1, cg1, 's2', '{"typed":"Gokula pretending"}'::jsonb);
    RAISE EXCEPTION 'FAIL Gokula could answer Gopala''s place on the first document of a collection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- a person's row on one document cannot carry an answer to another document (the place's key is the same on both: only the row's own document counts)
  BEGIN
    INSERT INTO sign_answers (account_id, document_id, signer_id, field_key, value) VALUES (acctA, c2, cg1, 's1', '{"typed":"Gokula on the second"}'::jsonb);
    RAISE EXCEPTION 'FAIL an answer was kept against a person''s row on another document';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT count(*) FROM sign_answers WHERE document_id IN (c1, c2)) <> 3 THEN RAISE EXCEPTION 'FAIL the collection holds an answer that was refused'; END IF;

  -- 3. A row handed to a different person loses the earlier person's signature, and keeps the rest; a name or a case change changes nothing.
  IF (SELECT count(*) FROM sign_answers WHERE document_id = d1 AND signer_id = gokula AND field_key = 'sigGokula') <> 1 THEN RAISE EXCEPTION 'FAIL the signature to be cleared was not there to begin with'; END IF;
  UPDATE sign_signers SET full_name = 'Gokula K.' WHERE id = gokula;
  UPDATE sign_signers SET email = upper(email) WHERE id = gokula;
  IF (SELECT count(*) FROM sign_answers WHERE document_id = d1 AND signer_id = gokula AND field_key = 'sigGokula') <> 1 THEN RAISE EXCEPTION 'FAIL a change of name or of the address''s case took the signature away'; END IF;
  UPDATE sign_signers SET status = 'sent' WHERE id = gokula;
  UPDATE sign_signers SET full_name = 'Somebody Else', email = 'somebody.else@example.invalid' WHERE id = gokula;
  IF EXISTS (SELECT 1 FROM sign_answers WHERE document_id = d1 AND signer_id = gokula AND field_key = 'sigGokula') THEN RAISE EXCEPTION 'FAIL the earlier person''s signature stayed on the row of the new person'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sign_answers WHERE document_id = d1 AND signer_id = gokula AND field_key = 'noRole') THEN RAISE EXCEPTION 'FAIL the rest of what was typed was taken away too'; END IF;
  -- Gopala has not changed: hers stays
  IF NOT EXISTS (SELECT 1 FROM sign_answers WHERE document_id = d1 AND signer_id = gopala AND field_key = 'sigGopala') THEN RAISE EXCEPTION 'FAIL another person''s signature was taken away'; END IF;
  -- a person who has already signed is not touched by an address that is changed afterwards (their answers are the record)
  UPDATE sign_signers SET status = 'signed', signed_at = now() WHERE id = gopala;
  UPDATE sign_signers SET email = 'gopala.new@example.invalid' WHERE id = gopala;
  IF NOT EXISTS (SELECT 1 FROM sign_answers WHERE document_id = d1 AND signer_id = gopala AND field_key = 'sigGopala') THEN RAISE EXCEPTION 'FAIL the signature of a person who had signed was taken away'; END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'sign_signers_new_person_clear'
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL the clearing trigger function is callable by signed-in or signed-out users'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.sign_signers'::regclass AND tgname = 'sign_signers_new_person_clear' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FAIL the trigger sign_signers_new_person_clear is missing';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: a person''s answer to a place of their own role is kept and an answer to a place of another role is refused (insert, upsert, moved key, moved person), on a document on its own and on each document of a collection; a data field of a form, a key the document does not have, a place with no role and a place that prints a form''s answer are not judged; an answer is kept only against the person''s own row on its document; a row handed to a different person loses the earlier person''s signature and initials and keeps the rest, a name or case change and a person who has signed are untouched; both guards are the database''s own with a pinned search_path';
END
$verify$;
