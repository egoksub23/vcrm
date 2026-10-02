-- Verify migration 131. Self-contained (builds its own tenant), so it runs against
-- an empty database as well as production. Concatenate 131's migration text in front
-- when the database does not have it yet, then run it. Ends in a deliberate error so
-- nothing is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uOwner   uuid := gen_random_uuid();
  uLeaver  uuid := gen_random_uuid();
  acct     uuid;
  acctOld  uuid;
  v_contact uuid;
  v_conv    uuid;
  v_cnt     int;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uOwner,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-' || uOwner  || '@example.invalid', '{"full_name":"Owner"}',  now()),
    (uLeaver, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'l-' || uLeaver || '@example.invalid', '{"full_name":"Leaver"}', now());
  SELECT account_id INTO acct    FROM profiles WHERE user_id = uOwner;
  SELECT account_id INTO acctOld FROM profiles WHERE user_id = uLeaver;

  -- The leaver joins the owner's account as an agent; their own personal account goes away.
  UPDATE profiles SET account_id = acct, account_role = 'agent' WHERE user_id = uLeaver;
  DELETE FROM accounts WHERE id = acctOld;

  -- Things the leaver created for the company.
  INSERT INTO contacts (account_id, user_id, phone) VALUES (acct, uLeaver, '+60100009999') RETURNING id INTO v_contact;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (acct, uLeaver, v_contact) RETURNING id INTO v_conv;

  DELETE FROM auth.users WHERE id = uLeaver;

  SELECT count(*) INTO v_cnt FROM contacts WHERE id = v_contact AND user_id IS NULL;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'FAIL deleting a member deleted (or did not detach) the contact they created'; END IF;
  SELECT count(*) INTO v_cnt FROM conversations WHERE id = v_conv AND user_id IS NULL;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'FAIL deleting a member deleted (or did not detach) their conversation'; END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE user_id = uLeaver) THEN
    RAISE EXCEPTION 'FAIL the leaver''s profile survived the user delete';
  END IF;

  -- Every table in the list is detached (nullable + SET NULL), not just the three above.
  SELECT count(*) INTO v_cnt
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass
     AND c.connamespace = 'public'::regnamespace
     AND (c.confdeltype <> 'n' OR a.attnotnull)
     AND a.attname IN ('user_id','connected_by_user_id')
     AND c.conrelid::regclass::text IN ('automation_logs','automation_pending_executions','automations','broadcasts','contact_notes',
          'contacts','conversations','custom_fields','deals','email_config','flow_runs','flows','gmail_config','instagram_config',
          'message_templates','messenger_config','pipelines','tags','tiktok_config','web_widget_config','whatsapp_config');
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'FAIL % shared-table FK(s) to auth.users are still NOT NULL or cascade', v_cnt; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: deleting a member detaches (SET NULL) the contacts/conversations they created, removes only their profile, and all 21 shared attribution columns are nullable SET NULL';
END
$verify$;
