-- ============================================================
-- Verification for migration 084 (propose and approve).
--
-- Run against a database that already has 084 applied (with or without 088):
--   supabase db query --linked -f supabase/ci/verify-084-approvals.sql
--
-- Everything happens inside one DO block that ends with
-- RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing is ever committed.
-- A message starting with ROLLBACK-OK means every check passed; any
-- other error message names the check that failed.
--
-- People are simulated the way PostgREST does it: set the JWT claims and
-- SET LOCAL ROLE authenticated, so RLS applies for real.
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
  n        INTEGER := 0;
  res      TEXT;
  cnt      INTEGER;
  tag1     UUID;
  tag2     UUID;
  tag3     UUID;
  snip1    UUID;
  snip2    UUID;
  art      UUID := gen_random_uuid();
  contact1 UUID := gen_random_uuid();
  conv1    UUID := gen_random_uuid();
  rec      RECORD;
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

  -- The proposed values of a live row: the pending_edit column until migration 088,
  -- the approval_pending_edits side table since (088 hides them from other members).
  EXECUTE $f$
    CREATE FUNCTION pg_temp.pending_of(p_kind TEXT, p_id UUID) RETURNS JSONB
    LANGUAGE plpgsql AS $b$
    DECLARE r JSONB;
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND column_name = 'pending_edit'
                    AND table_name = CASE p_kind WHEN 'tag' THEN 'tags' ELSE 'quick_replies' END) THEN
        EXECUTE format('SELECT pending_edit FROM %I WHERE id = $1',
                       CASE p_kind WHEN 'tag' THEN 'tags' ELSE 'quick_replies' END) INTO r USING p_id;
      ELSE
        SELECT patch INTO r FROM approval_pending_edits WHERE entity_type = p_kind AND entity_id = p_id;
      END IF;
      RETURN r;
    END $b$;
  $f$;

  -- audit rows of account a matching a WHERE fragment (read as postgres)
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

  -- notifications of one user and type
  EXECUTE $f$
    CREATE FUNCTION pg_temp.nc(p_user UUID, p_type TEXT) RETURNS INTEGER
    LANGUAGE sql AS $b$
      SELECT count(*)::int FROM notifications WHERE user_id = p_user AND type = p_type;
    $b$;
  $f$;

  -- ---------------------------------------------------------
  -- fixtures: users -> (trigger) accounts + profiles
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify084-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
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
  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (contact1, owner_a, a, '+10000000084', 'Casey');
  INSERT INTO conversations (id, user_id, account_id, contact_id) VALUES (conv1, owner_a, a, contact1);

  -- ---------------------------------------------------------
  -- 1. Capabilities: catalogue, defaults, Viewer guard
  -- ---------------------------------------------------------
  IF (SELECT count(*) FROM capability_catalogue
       WHERE capability IN ('approvals.review', 'snippets.propose', 'tags.propose')
         AND min_grant_role = 'agent' AND enforced_by = 'database') <> 3 THEN
    RAISE EXCEPTION 'FAIL new capabilities missing from the catalogue';
  END IF;
  IF (SELECT count(*) FROM capability_catalogue
       WHERE capability IN ('tags.manage', 'snippets.manage') AND enforced_by = 'database') <> 2 THEN
    RAISE EXCEPTION 'FAIL tags.manage / snippets.manage must be database-enforced now';
  END IF;
  IF (SELECT count(*) FROM role_capability_defaults WHERE capability = 'approvals.review') <> 2
  OR (SELECT count(*) FROM role_capability_defaults WHERE capability IN ('snippets.propose', 'tags.propose')) <> 6 THEN
    RAISE EXCEPTION 'FAIL default grants for the new capabilities';
  END IF;
  IF pg_temp.run(owner_a,  format('SELECT has_capability(%L, ''approvals.review'')::text', a)) <> 'true'
  OR pg_temp.run(admin_a,  format('SELECT has_capability(%L, ''approvals.review'')::text', a)) <> 'true'
  OR pg_temp.run(agent_a,  format('SELECT has_capability(%L, ''approvals.review'')::text', a)) <> 'false'
  OR pg_temp.run(viewer_a, format('SELECT has_capability(%L, ''approvals.review'')::text', a)) <> 'false'
  OR pg_temp.run(agent_a,  format('SELECT has_capability(%L, ''tags.propose'')::text', a)) <> 'true'
  OR pg_temp.run(agent_a,  format('SELECT has_capability(%L, ''snippets.propose'')::text', a)) <> 'true'
  OR pg_temp.run(viewer_a, format('SELECT has_capability(%L, ''tags.propose'')::text', a)) <> 'false'
  OR pg_temp.run(agent_a,  format('SELECT has_capability(%L, ''tags.manage'')::text', a)) <> 'false'
  OR pg_temp.run(agent_a,  format('SELECT has_capability(%L, ''snippets.manage'')::text', a)) <> 'true' THEN
    RAISE EXCEPTION 'FAIL default capability parity';
  END IF;
  -- a Viewer can never be given a write capability
  res := pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'viewer', '{"tags.propose": true}'::jsonb)::text$q$, a));
  IF res NOT LIKE 'ERR 22023%' THEN
    RAISE EXCEPTION 'FAIL viewer guard for tags.propose: %', res;
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 2. An agent proposes a tag: pending, hidden from everyone else
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, $q$SELECT propose_tag('tag', 'Wholesale', '#ff8800', 'Buys in bulk')::text$q$);
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL propose_tag: %', res; END IF;
  IF (res::jsonb) ->> 'mode' <> 'proposed' THEN RAISE EXCEPTION 'FAIL propose_tag mode: %', res; END IF;
  tag1 := ((res::jsonb) ->> 'id')::uuid;

  SELECT approval_status, proposed_by, created_by, for_contacts, for_conversations INTO rec FROM tags WHERE id = tag1;
  IF rec.approval_status <> 'pending' OR rec.proposed_by <> agent_a OR rec.created_by <> agent_a
     OR NOT rec.for_contacts OR rec.for_conversations THEN
    RAISE EXCEPTION 'FAIL pending tag row';
  END IF;

  -- visible to the proposer and to reviewers, invisible to another agent, a viewer and another account
  IF pg_temp.run(agent_a,  format('SELECT count(*)::text FROM tags WHERE id = %L', tag1)) <> '1'
  OR pg_temp.run(admin_a,  format('SELECT count(*)::text FROM tags WHERE id = %L', tag1)) <> '1'
  OR pg_temp.run(owner_a,  format('SELECT count(*)::text FROM tags WHERE id = %L', tag1)) <> '1' THEN
    RAISE EXCEPTION 'FAIL proposer and reviewers must see the pending tag';
  END IF;
  IF pg_temp.run(agent2_a, format('SELECT count(*)::text FROM tags WHERE id = %L', tag1)) <> '0'
  OR pg_temp.run(viewer_a, format('SELECT count(*)::text FROM tags WHERE id = %L', tag1)) <> '0'
  OR pg_temp.run(owner_b,  format('SELECT count(*)::text FROM tags WHERE id = %L', tag1)) <> '0' THEN
    RAISE EXCEPTION 'FAIL a pending tag leaked to someone who must not see it';
  END IF;
  -- not in the picker views either
  IF pg_temp.run(agent2_a, format('SELECT count(*)::text FROM tag_usage_counts WHERE tag_id = %L', tag1)) <> '0' THEN
    RAISE EXCEPTION 'FAIL tag_usage_counts leaks a pending tag';
  END IF;
  -- never applied to a contact or a chat, by anyone
  res := pg_temp.run(agent_a, format($q$INSERT INTO contact_tags (contact_id, tag_id) VALUES (%L, %L)$q$, contact1, tag1));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL a pending tag was applied to a contact'; END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO conversation_labels (conversation_id, tag_id) VALUES (%L, %L)$q$, conv1, tag1));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL a pending tag was applied to a chat'; END IF;
  BEGIN
    INSERT INTO contact_tags (contact_id, tag_id) VALUES (contact1, tag1);
    RAISE EXCEPTION 'FAIL the link trigger must refuse a pending tag even for the service role';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  n := n + 1;

  -- audit: one 'created' proposal row by the agent, no duplicate from the row trigger
  IF pg_temp.ac(a, format($c$action = 'created' AND entity_type = 'tag' AND entity_id = %L
                             AND actor_id = %L AND summary ->> 'proposal' = 'new'$c$, tag1, agent_a)) <> 1
  OR pg_temp.ac(a, format($c$entity_id = %L$c$, tag1)) <> 1 THEN
    RAISE EXCEPTION 'FAIL proposal audit row (exactly one expected)';
  END IF;
  -- notifications: reviewers except the actor
  IF pg_temp.nc(owner_a, 'approval_requested') <> 1 OR pg_temp.nc(admin_a, 'approval_requested') <> 1
  OR pg_temp.nc(agent_a, 'approval_requested') <> 0 OR pg_temp.nc(agent2_a, 'approval_requested') <> 0
  OR pg_temp.nc(viewer_a, 'approval_requested') <> 0 OR pg_temp.nc(owner_b, 'approval_requested') <> 0 THEN
    RAISE EXCEPTION 'FAIL approval_requested notifications';
  END IF;
  n := n + 1;

  -- the queue and the badge
  IF pg_temp.run(admin_a, 'SELECT approvals_pending_count()::text') <> '1'
  OR pg_temp.run(agent_a, 'SELECT approvals_pending_count()::text') <> '0' THEN
    RAISE EXCEPTION 'FAIL approvals_pending_count';
  END IF;
  res := pg_temp.run(admin_a, $q$SELECT jsonb_array_length(approvals_list('pending'))::text$q$);
  IF res <> '1' THEN RAISE EXCEPTION 'FAIL approvals_list pending: %', res; END IF;
  res := pg_temp.run(admin_a, $q$SELECT (approvals_list('pending') -> 0 ->> 'action') || '/' || (approvals_list('pending') -> 0 ->> 'kind')$q$);
  IF res <> 'new/tag' THEN RAISE EXCEPTION 'FAIL approvals_list row shape: %', res; END IF;
  IF pg_temp.run(agent_a, $q$SELECT approvals_list('pending')::text$q$) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL an agent must not read the queue';
  END IF;
  n := n + 1;

  -- name conflicts: against a live approved name only
  PERFORM pg_temp.run(owner_a, format(
    $q$INSERT INTO tags (user_id, account_id, name, color) VALUES (%L, %L, 'VIP', '#111111')$q$, owner_a, a));
  res := pg_temp.run(agent_a, $q$SELECT propose_tag('tag', 'vip', '#222222')::text$q$);
  IF res NOT LIKE 'ERR 23505: name_conflict%' THEN RAISE EXCEPTION 'FAIL name conflict: %', res; END IF;
  res := pg_temp.run(agent_a, $q$SELECT propose_tag('tag', 'WHOLESALE', '#222222')::text$q$);
  IF res NOT LIKE 'ERR 23505: name_conflict%' THEN RAISE EXCEPTION 'FAIL duplicate pending own proposal: %', res; END IF;
  res := pg_temp.run(agent_a, $q$SELECT propose_tag('tag', '', '#222222')::text$q$);
  IF res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL empty name: %', res; END IF;
  res := pg_temp.run(agent_a, $q$SELECT propose_tag('tag', 'Bad colour', 'red')::text$q$);
  IF res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL colour validation: %', res; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 3. Capability denial: a Viewer, and a direct table write
  -- ---------------------------------------------------------
  res := pg_temp.run(viewer_a, $q$SELECT propose_tag('tag', 'Nope', '#123456')::text$q$);
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL viewer propose_tag: %', res; END IF;
  res := pg_temp.run(viewer_a, $q$SELECT propose_snippet('Nope', 'text', 'hello')::text$q$);
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL viewer propose_snippet: %', res; END IF;
  res := pg_temp.run(agent_a, format(
    $q$INSERT INTO tags (user_id, account_id, name, color) VALUES (%L, %L, 'Direct', '#123456')$q$, agent_a, a));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL an agent wrote the tags table directly'; END IF;
  res := pg_temp.run(agent_a, format($q$UPDATE tags SET approval_status = 'approved' WHERE id = %L$q$, tag1));
  IF (SELECT approval_status FROM tags WHERE id = tag1) <> 'pending' THEN
    RAISE EXCEPTION 'FAIL an agent approved their own tag';
  END IF;
  res := pg_temp.run(agent_a, format('SELECT decide_proposal(''tag'', %L, ''approve'')::text', tag1));
  IF res NOT LIKE 'ERR 42501%' THEN RAISE EXCEPTION 'FAIL agent decided a proposal: %', res; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 4. Approval flips it live
  -- ---------------------------------------------------------
  res := pg_temp.run(admin_a, format('SELECT decide_proposal(''tag'', %L, ''approve'', ''Welcome'')::text', tag1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL approve: %', res; END IF;
  SELECT approval_status, decided_by, decision_note INTO rec FROM tags WHERE id = tag1;
  IF rec.approval_status <> 'approved' OR rec.decided_by <> admin_a OR rec.decision_note <> 'Welcome' THEN
    RAISE EXCEPTION 'FAIL approved tag row';
  END IF;
  IF pg_temp.run(agent2_a, format('SELECT count(*)::text FROM tags WHERE id = %L', tag1)) <> '1' THEN
    RAISE EXCEPTION 'FAIL an approved tag must be visible to everyone';
  END IF;
  res := pg_temp.run(agent2_a, format($q$INSERT INTO contact_tags (contact_id, tag_id) VALUES (%L, %L)$q$, contact1, tag1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL an approved tag must be applicable: %', res; END IF;
  IF pg_temp.ac(a, format($c$action = 'approved' AND entity_type = 'tag' AND entity_id = %L AND actor_id = %L
                             AND summary ->> 'proposer_id' = %L$c$, tag1, admin_a, agent_a::text)) <> 1 THEN
    RAISE EXCEPTION 'FAIL approved audit row';
  END IF;
  IF pg_temp.nc(agent_a, 'approval_decided') <> 1 THEN
    RAISE EXCEPTION 'FAIL the proposer must be told';
  END IF;
  IF pg_temp.run(admin_a, 'SELECT approvals_pending_count()::text') <> '0' THEN
    RAISE EXCEPTION 'FAIL badge after approval';
  END IF;
  -- already decided
  res := pg_temp.run(admin_a, format('SELECT decide_proposal(''tag'', %L, ''approve'')::text', tag1));
  IF res NOT LIKE 'ERR P0001: not_pending%' THEN RAISE EXCEPTION 'FAIL deciding twice: %', res; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 5. Rejection keeps it hidden, with the note; dismissing removes it
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, $q$SELECT propose_tag('label', 'Spammy', '#00ff00', NULL, true)::text$q$);
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL propose label: %', res; END IF;
  tag2 := ((res::jsonb) ->> 'id')::uuid;
  IF (SELECT for_contacts AND for_conversations FROM tags WHERE id = tag2) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL label proposed for both uses';
  END IF;
  res := pg_temp.run(owner_a, format('SELECT decide_proposal(''tag'', %L, ''reject'')::text', tag2));
  IF res NOT LIKE 'ERR 22023: note_required%' THEN RAISE EXCEPTION 'FAIL reject needs a note: %', res; END IF;
  res := pg_temp.run(owner_a, format('SELECT decide_proposal(''tag'', %L, ''reject'', ''ab'')::text', tag2));
  IF res NOT LIKE 'ERR 22023: note_required%' THEN RAISE EXCEPTION 'FAIL reject note min length: %', res; END IF;
  res := pg_temp.run(owner_a, format('SELECT decide_proposal(''tag'', %L, ''reject'', ''Too vague'')::text', tag2));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL reject: %', res; END IF;
  SELECT approval_status, decision_note, decided_by INTO rec FROM tags WHERE id = tag2;
  IF rec.approval_status <> 'rejected' OR rec.decision_note <> 'Too vague' OR rec.decided_by <> owner_a THEN
    RAISE EXCEPTION 'FAIL rejected tag row';
  END IF;
  IF pg_temp.run(agent_a,  format('SELECT decision_note FROM tags WHERE id = %L', tag2)) <> 'Too vague' THEN
    RAISE EXCEPTION 'FAIL the proposer must see the rejection note';
  END IF;
  IF pg_temp.run(agent2_a, format('SELECT count(*)::text FROM tags WHERE id = %L', tag2)) <> '0' THEN
    RAISE EXCEPTION 'FAIL a rejected tag must stay hidden';
  END IF;
  res := pg_temp.run(admin_a, format($q$INSERT INTO conversation_labels (conversation_id, tag_id) VALUES (%L, %L)$q$, conv1, tag2));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL a rejected tag was applied'; END IF;
  IF pg_temp.ac(a, format($c$action = 'rejected' AND entity_id = %L AND summary ->> 'note' = 'Too vague'$c$, tag2)) <> 1
  OR pg_temp.nc(agent_a, 'approval_decided') <> 2 THEN
    RAISE EXCEPTION 'FAIL rejected audit row / notification';
  END IF;
  -- Edit and resubmit: back to pending, note cleared
  res := pg_temp.run(agent_a, format(
    $q$SELECT propose_tag_edit(%L, '{"name": "Spammy 2"}'::jsonb)::text$q$, tag2));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL resubmit: %', res; END IF;
  SELECT approval_status, decision_note, name INTO rec FROM tags WHERE id = tag2;
  IF rec.approval_status <> 'pending' OR rec.decision_note IS NOT NULL OR rec.name <> 'Spammy 2' THEN
    RAISE EXCEPTION 'FAIL resubmitted tag row';
  END IF;
  -- Withdraw: soft-deleted, the audit history stays
  res := pg_temp.run(agent2_a, format('SELECT withdraw_proposal(''tag'', %L)::text', tag2));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL someone else withdrew a proposal'; END IF;
  res := pg_temp.run(agent_a, format('SELECT withdraw_proposal(''tag'', %L)::text', tag2));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL withdraw: %', res; END IF;
  IF (SELECT deleted_at FROM tags WHERE id = tag2) IS NULL THEN
    RAISE EXCEPTION 'FAIL withdraw must soft-delete';
  END IF;
  IF pg_temp.run(agent_a, format('SELECT count(*)::text FROM tags WHERE id = %L', tag2)) <> '0' THEN
    RAISE EXCEPTION 'FAIL a withdrawn proposal must disappear';
  END IF;
  IF pg_temp.ac(a, format($c$entity_id = %L AND action = 'deleted' AND (summary ->> 'withdrawn')::boolean$c$, tag2)) <> 1 THEN
    RAISE EXCEPTION 'FAIL withdraw audit row';
  END IF;
  -- a withdrawn proposal is not a "removed tag"
  IF EXISTS (SELECT 1 FROM tags WHERE id = tag2 AND deleted_at IS NOT NULL)
     AND pg_temp.run(admin_a, format('SELECT count(*)::text FROM audit_removed_items() WHERE entity_id = %L', tag2)) <> '0' THEN
    RAISE EXCEPTION 'FAIL Recently removed lists a withdrawn proposal';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 6. Edit proposals leave the live values alone until approved
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, format(
    $q$SELECT propose_tag_edit(%L, '{"name": "Wholesale plus", "color": "#0000ff"}'::jsonb)::text$q$, tag1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL propose_tag_edit: %', res; END IF;
  SELECT name, color, approval_status, pg_temp.pending_of('tag', id) AS pending_edit, edit_status, proposed_by INTO rec FROM tags WHERE id = tag1;
  IF rec.name <> 'Wholesale' OR rec.color <> '#ff8800' OR rec.approval_status <> 'approved'
     OR rec.edit_status <> 'pending' OR rec.proposed_by <> agent_a
     OR rec.pending_edit ->> 'name' <> 'Wholesale plus' THEN
    RAISE EXCEPTION 'FAIL live values changed by an edit proposal';
  END IF;
  -- the live tag is still applied and visible with its live values
  IF pg_temp.run(agent2_a, format('SELECT name FROM tags WHERE id = %L', tag1)) <> 'Wholesale' THEN
    RAISE EXCEPTION 'FAIL readers must see the live name';
  END IF;
  -- another agent cannot stack an edit on a pending one
  res := pg_temp.run(agent2_a, format($q$SELECT propose_tag_edit(%L, '{"color": "#010101"}'::jsonb)::text$q$, tag1));
  IF res NOT LIKE 'ERR P0001: edit_pending%' THEN RAISE EXCEPTION 'FAIL stacked edit: %', res; END IF;
  -- no-op edits are refused
  res := pg_temp.run(agent_a, format($q$SELECT propose_tag_edit(%L, '{"name": "Wholesale"}'::jsonb)::text$q$, tag1));
  IF res LIKE 'ERR%' AND res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL no-op edit: %', res; END IF;
  -- queue row
  res := pg_temp.run(admin_a, $q$SELECT (approvals_list('pending') -> 0 ->> 'action') || '/' || (approvals_list('pending') -> 0 -> 'current' ->> 'name') || '/' || (approvals_list('pending') -> 0 -> 'proposed' ->> 'name')$q$);
  IF res <> 'edit/Wholesale/Wholesale plus' THEN RAISE EXCEPTION 'FAIL edit queue row: %', res; END IF;
  -- name conflict when approving: someone renamed onto the same name meanwhile
  PERFORM pg_temp.run(owner_a, format(
    $q$INSERT INTO tags (user_id, account_id, name, color) VALUES (%L, %L, 'Wholesale plus', '#111111')$q$, owner_a, a));
  res := pg_temp.run(admin_a, format('SELECT decide_proposal(''tag'', %L, ''approve'')::text', tag1));
  IF res NOT LIKE 'ERR 23505: name_conflict%' THEN RAISE EXCEPTION 'FAIL approve name conflict: %', res; END IF;
  -- edit then approve
  res := pg_temp.run(admin_a, format(
    $q$SELECT decide_proposal('tag', %L, 'approve', NULL, '{"name": "Wholesale pro"}'::jsonb)::text$q$, tag1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL edit then approve: %', res; END IF;
  SELECT name, color, pg_temp.pending_of('tag', id) AS pending_edit, edit_status, decided_by INTO rec FROM tags WHERE id = tag1;
  IF rec.name <> 'Wholesale pro' OR rec.color <> '#0000ff' OR rec.pending_edit IS NOT NULL
     OR rec.edit_status IS NOT NULL OR rec.decided_by <> admin_a THEN
    RAISE EXCEPTION 'FAIL approved edit must copy the values onto the live row';
  END IF;
  IF pg_temp.ac(a, format($c$action = 'approved' AND entity_id = %L AND summary ->> 'proposal' = 'edit'
                             AND (summary ->> 'edited')::boolean$c$, tag1)) <> 1 THEN
    RAISE EXCEPTION 'FAIL approved edit audit row';
  END IF;
  -- reject an edit: the live row stays, the proposer sees the note, withdraw clears it
  PERFORM pg_temp.run(agent_a, format($q$SELECT propose_tag_edit(%L, '{"color": "#123123"}'::jsonb)::text$q$, tag1));
  res := pg_temp.run(admin_a, format('SELECT decide_proposal(''tag'', %L, ''reject'', ''Keep the blue'')::text', tag1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL reject edit: %', res; END IF;
  SELECT color, edit_status, decision_note, pg_temp.pending_of('tag', id) AS pending_edit INTO rec FROM tags WHERE id = tag1;
  IF rec.color <> '#0000ff' OR rec.edit_status <> 'rejected' OR rec.decision_note <> 'Keep the blue'
     OR rec.pending_edit IS NULL THEN
    RAISE EXCEPTION 'FAIL rejected edit row';
  END IF;
  IF pg_temp.run(admin_a, 'SELECT approvals_pending_count()::text') <> '0' THEN
    RAISE EXCEPTION 'FAIL a rejected edit must leave the queue';
  END IF;
  res := pg_temp.run(agent_a, format('SELECT withdraw_proposal(''tag'', %L)::text', tag1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL dismiss rejected edit: %', res; END IF;
  SELECT pg_temp.pending_of('tag', id) AS pending_edit, edit_status, decision_note INTO rec FROM tags WHERE id = tag1;
  IF rec.pending_edit IS NOT NULL OR rec.edit_status IS NOT NULL OR rec.decision_note IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL dismissed edit must clear';
  END IF;
  n := n + 1;

  -- the manage path is unchanged: an admin creates and edits directly
  res := pg_temp.run(admin_a, $q$SELECT propose_tag('label', 'Urgent', '#ff0000')::text$q$);
  IF (res::jsonb) ->> 'mode' <> 'created' THEN RAISE EXCEPTION 'FAIL admin direct create: %', res; END IF;
  tag3 := ((res::jsonb) ->> 'id')::uuid;
  IF (SELECT approval_status FROM tags WHERE id = tag3) <> 'approved' THEN
    RAISE EXCEPTION 'FAIL admin tag must be live';
  END IF;
  res := pg_temp.run(admin_a, format($q$SELECT propose_tag_edit(%L, '{"color": "#00ff00"}'::jsonb)::text$q$, tag3));
  IF (res::jsonb) ->> 'mode' <> 'updated' OR (SELECT color FROM tags WHERE id = tag3) <> '#00ff00' THEN
    RAISE EXCEPTION 'FAIL admin direct edit: %', res;
  END IF;
  IF pg_temp.ac(a, format($c$action = 'created' AND entity_id = %L AND summary ? 'values'$c$, tag3)) <> 1
  OR pg_temp.ac(a, format($c$action = 'updated' AND entity_id = %L$c$, tag3)) <> 1 THEN
    RAISE EXCEPTION 'FAIL direct path audit rows (the row trigger must still log them)';
  END IF;
  -- direct table writes by an admin still work and cannot forge approval columns
  res := pg_temp.run(admin_a, format(
    $q$INSERT INTO tags (user_id, account_id, name, color, approval_status, proposed_by)
       VALUES (%L, %L, 'Direct admin', '#123123', 'pending', %L)$q$, admin_a, a, agent_a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL admin direct insert: %', res; END IF;
  IF (SELECT approval_status FROM tags WHERE name = 'Direct admin' AND account_id = a) <> 'approved' THEN
    RAISE EXCEPTION 'FAIL the guard must force approved on a direct insert';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 7. Snippets: default agents keep direct editing; switch to approval
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, $q$SELECT propose_snippet('Hours', 'text', 'We open at 9')::text$q$);
  IF (res::jsonb) ->> 'mode' <> 'created' THEN RAISE EXCEPTION 'FAIL default agent snippet path: %', res; END IF;
  snip1 := ((res::jsonb) ->> 'id')::uuid;
  res := pg_temp.run(agent_a, format(
    $q$INSERT INTO quick_replies (account_id, user_id, title, kind, content_text)
       VALUES (%L, %L, 'Direct', 'text', 'x')$q$, a, agent_a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL default agent direct snippet insert: %', res; END IF;

  -- an admin turns approvals on for snippets: Agents lose snippets.manage
  res := pg_temp.run(admin_a, format(
    $q$SELECT set_role_capabilities(%L, 'agent', '{"snippets.manage": false}'::jsonb)::text$q$, a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL switch snippets to approval: %', res; END IF;
  res := pg_temp.run(agent_a, format(
    $q$INSERT INTO quick_replies (account_id, user_id, title, kind, content_text)
       VALUES (%L, %L, 'Sneaky', 'text', 'x')$q$, a, agent_a));
  IF res NOT LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL an agent without snippets.manage wrote the table directly'; END IF;
  res := pg_temp.run(agent_a, format($q$UPDATE quick_replies SET title = 'Hacked' WHERE id = %L$q$, snip1));
  IF (SELECT title FROM quick_replies WHERE id = snip1) <> 'Hours' THEN
    RAISE EXCEPTION 'FAIL an agent without snippets.manage edited a snippet directly';
  END IF;

  res := pg_temp.run(agent_a, $q$SELECT propose_snippet('Greeting', 'text', 'Hello there')::text$q$);
  IF (res::jsonb) ->> 'mode' <> 'proposed' THEN RAISE EXCEPTION 'FAIL snippet proposal: %', res; END IF;
  snip2 := ((res::jsonb) ->> 'id')::uuid;
  IF pg_temp.run(agent2_a, format('SELECT count(*)::text FROM quick_replies WHERE id = %L', snip2)) <> '0'
  OR pg_temp.run(agent_a,  format('SELECT count(*)::text FROM quick_replies WHERE id = %L', snip2)) <> '1'
  OR pg_temp.run(admin_a,  format('SELECT count(*)::text FROM quick_replies WHERE id = %L', snip2)) <> '1' THEN
    RAISE EXCEPTION 'FAIL pending snippet visibility';
  END IF;
  res := pg_temp.run(agent_a, $q$SELECT propose_snippet('Bad', 'text', '')::text$q$);
  IF res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL empty snippet body: %', res; END IF;
  res := pg_temp.run(agent_a, $q$SELECT propose_snippet('Bad', 'interactive', NULL, NULL)::text$q$);
  IF res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL interactive without payload: %', res; END IF;
  res := pg_temp.run(admin_a, format('SELECT decide_proposal(''snippet'', %L, ''approve'')::text', snip2));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL approve snippet: %', res; END IF;
  IF pg_temp.run(agent2_a, format('SELECT count(*)::text FROM quick_replies WHERE id = %L', snip2)) <> '1' THEN
    RAISE EXCEPTION 'FAIL approved snippet must be visible';
  END IF;

  -- an edit of a live snippet
  res := pg_temp.run(agent_a, format(
    $q$SELECT propose_snippet_edit(%L, '{"title": "Hours v2", "content_text": "We open at 10"}'::jsonb)::text$q$, snip1));
  IF (res::jsonb) ->> 'mode' <> 'proposed' THEN RAISE EXCEPTION 'FAIL snippet edit proposal: %', res; END IF;
  SELECT title, content_text, pg_temp.pending_of('snippet', id) ->> 'title' AS pt INTO rec FROM quick_replies WHERE id = snip1;
  IF rec.title <> 'Hours' OR rec.content_text <> 'We open at 9' OR rec.pt <> 'Hours v2' THEN
    RAISE EXCEPTION 'FAIL snippet live values changed by an edit proposal';
  END IF;
  IF pg_temp.run(agent2_a, format('SELECT title FROM quick_replies WHERE id = %L', snip1)) <> 'Hours' THEN
    RAISE EXCEPTION 'FAIL readers must see the live snippet';
  END IF;
  res := pg_temp.run(owner_a, format('SELECT decide_proposal(''snippet'', %L, ''approve'')::text', snip1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL approve snippet edit: %', res; END IF;
  SELECT title, content_text, pg_temp.pending_of('snippet', id) AS pending_edit, edit_status INTO rec FROM quick_replies WHERE id = snip1;
  IF rec.title <> 'Hours v2' OR rec.content_text <> 'We open at 10' OR rec.pending_edit IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL approved snippet edit values';
  END IF;
  -- kind switch clears the other column
  PERFORM pg_temp.run(agent_a, format(
    $q$SELECT propose_snippet_edit(%L, '{"kind": "interactive", "interactive_payload": {"type": "button"}}'::jsonb)::text$q$, snip1));
  PERFORM pg_temp.run(owner_a, format('SELECT decide_proposal(''snippet'', %L, ''approve'')::text', snip1));
  SELECT kind, content_text, interactive_payload INTO rec FROM quick_replies WHERE id = snip1;
  IF rec.kind <> 'interactive' OR rec.content_text IS NOT NULL OR rec.interactive_payload IS NULL THEN
    RAISE EXCEPTION 'FAIL snippet kind switch';
  END IF;
  -- withdraw a pending snippet creation
  res := pg_temp.run(agent_a, $q$SELECT propose_snippet('Temp', 'text', 'tmp')::text$q$);
  PERFORM pg_temp.run(agent_a, format('SELECT withdraw_proposal(''snippet'', %L)::text', ((res::jsonb) ->> 'id')::uuid));
  IF (SELECT deleted_at FROM quick_replies WHERE id = ((res::jsonb) ->> 'id')::uuid) IS NULL THEN
    RAISE EXCEPTION 'FAIL snippet withdraw must soft-delete';
  END IF;
  -- turning the switch back off restores direct editing
  PERFORM pg_temp.run(admin_a, format(
    $q$SELECT set_role_capabilities(%L, 'agent', '{"snippets.manage": null}'::jsonb)::text$q$, a));
  IF pg_temp.run(agent_a, format('SELECT has_capability(%L, ''snippets.manage'')::text', a)) <> 'true' THEN
    RAISE EXCEPTION 'FAIL resetting snippets.manage';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 8. Nobody decides their own proposal
  -- ---------------------------------------------------------
  PERFORM pg_temp.run(owner_a, format(
    $q$SELECT set_role_capabilities(%L, 'admin', '{"tags.manage": false}'::jsonb)::text$q$, a));
  res := pg_temp.run(admin_a, $q$SELECT propose_tag('tag', 'Admin idea', '#456456')::text$q$);
  IF (res::jsonb) ->> 'mode' <> 'proposed' THEN RAISE EXCEPTION 'FAIL admin without tags.manage must propose: %', res; END IF;
  res := pg_temp.run(admin_a, format('SELECT decide_proposal(''tag'', %L, ''approve'')::text', ((res::jsonb) ->> 'id')::uuid));
  IF res NOT LIKE 'ERR 42501: own_proposal%' THEN RAISE EXCEPTION 'FAIL self approval: %', res; END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 9. Knowledge drafts are listed; approve = publish; reject unsupported
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, format(
    $q$INSERT INTO ai_knowledge_documents (id, account_id, created_by, title, content, status)
       VALUES (%L, %L, %L, 'Returns', 'Return within 14 days', 'draft')$q$, art, a, agent_a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL agent draft insert: %', res; END IF;
  res := pg_temp.run(owner_a, $q$SELECT (SELECT count(*) FROM jsonb_array_elements(approvals_list('pending', 'article')))::text$q$);
  IF res <> '1' THEN RAISE EXCEPTION 'FAIL article listing: %', res; END IF;
  res := pg_temp.run(owner_a, format('SELECT decide_proposal(''article'', %L, ''reject'', ''no'')::text', art));
  IF res NOT LIKE 'ERR 22023%' THEN RAISE EXCEPTION 'FAIL article reject must be refused: %', res; END IF;
  res := pg_temp.run(owner_a, format('SELECT decide_proposal(''article'', %L, ''approve'')::text', art));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL article approve: %', res; END IF;
  IF (SELECT status FROM ai_knowledge_documents WHERE id = art) <> 'published' THEN
    RAISE EXCEPTION 'FAIL approving an article must publish it';
  END IF;
  IF pg_temp.ac(a, format($c$action = 'approved' AND entity_type = 'article' AND entity_id = %L$c$, art)) <> 1 THEN
    RAISE EXCEPTION 'FAIL article approval audit row';
  END IF;
  -- an admin's own draft is not "waiting for approval"
  INSERT INTO ai_knowledge_documents (account_id, created_by, title, content, status)
    VALUES (a, admin_a, 'Admin draft', 'text', 'draft');
  IF pg_temp.run(owner_a, $q$SELECT (SELECT count(*) FROM jsonb_array_elements(approvals_list('pending', 'article')))::text$q$) <> '0' THEN
    RAISE EXCEPTION 'FAIL a publisher''s draft must not be in the queue';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 10. The decided tab (from the audit log) and filters
  -- ---------------------------------------------------------
  res := pg_temp.run(owner_a, $q$SELECT jsonb_array_length(approvals_list('decided'))::text$q$);
  IF res::int < 5 THEN RAISE EXCEPTION 'FAIL decided tab too short: %', res; END IF;
  res := pg_temp.run(owner_a, format(
    $q$SELECT jsonb_array_length(approvals_list('decided', 'snippet', %L))::text$q$, agent_a));
  IF res::int < 2 THEN RAISE EXCEPTION 'FAIL decided filter by type and proposer: %', res; END IF;
  res := pg_temp.run(owner_a, $q$SELECT (approvals_list('decided') -> 0 ->> 'status')$q$);
  IF res NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'FAIL decided row shape: %', res; END IF;
  IF pg_temp.run(agent_a, $q$SELECT approvals_list('decided')::text$q$) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL an agent must not read decided items';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 11. Cross-account isolation
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, $q$SELECT propose_tag('tag', 'Leaky', '#777777')::text$q$);
  tag2 := ((res::jsonb) ->> 'id')::uuid;
  -- type filters on the pending tab: a tag proposed for contacts only is a Tag, not a Label
  IF pg_temp.run(owner_a, $q$SELECT jsonb_array_length(approvals_list('pending', 'tag'))::text$q$)::int < 2
  OR pg_temp.run(owner_a, $q$SELECT jsonb_array_length(approvals_list('pending', 'label'))::text$q$) <> '0'
  OR pg_temp.run(owner_a, $q$SELECT jsonb_array_length(approvals_list('pending', 'snippet'))::text$q$) <> '0'
  OR pg_temp.run(owner_a, $q$SELECT jsonb_array_length(approvals_list('pending', 'article'))::text$q$) <> '0' THEN
    RAISE EXCEPTION 'FAIL pending type filters';
  END IF;
  IF pg_temp.run(owner_a, format($q$SELECT jsonb_array_length(approvals_list('pending', NULL, %L))::text$q$, agent_a)) <> '1' THEN
    RAISE EXCEPTION 'FAIL pending proposer filter';
  END IF;
  IF pg_temp.run(owner_a, $q$SELECT approvals_list('pending', 'deal')::text$q$) NOT LIKE 'ERR 22023%' THEN
    RAISE EXCEPTION 'FAIL unknown type filter';
  END IF;
  IF pg_temp.run(owner_b, format('SELECT decide_proposal(''tag'', %L, ''approve'')::text', tag2)) NOT LIKE 'ERR P0002%' THEN
    RAISE EXCEPTION 'FAIL another account decided a proposal';
  END IF;
  IF pg_temp.run(owner_b, format('SELECT withdraw_proposal(''tag'', %L)::text', tag2)) NOT LIKE 'ERR%' THEN
    RAISE EXCEPTION 'FAIL another account withdrew a proposal';
  END IF;
  IF pg_temp.run(owner_b, format($q$SELECT propose_tag_edit(%L, '{"name": "x"}'::jsonb)::text$q$, tag2)) NOT LIKE 'ERR P0002%' THEN
    RAISE EXCEPTION 'FAIL another account edited a proposal';
  END IF;
  IF pg_temp.run(owner_b, $q$SELECT jsonb_array_length(approvals_list('pending'))::text$q$) <> '0'
  OR pg_temp.run(owner_b, $q$SELECT jsonb_array_length(approvals_list('decided'))::text$q$) <> '0'
  OR pg_temp.run(owner_b, 'SELECT approvals_pending_count()::text') <> '0' THEN
    RAISE EXCEPTION 'FAIL another account sees this account''s queue';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 12. Notification types written by earlier migrations still insert
  -- ---------------------------------------------------------
  INSERT INTO notifications (account_id, user_id, type, title) VALUES (a, owner_a, 'ticket_updated', 't');
  INSERT INTO notifications (account_id, user_id, type, title) VALUES (a, owner_a, 'ai_budget', 't');
  INSERT INTO notifications (account_id, user_id, type, title) VALUES (a, owner_a, 'conversation_assigned', 't');
  INSERT INTO notifications (account_id, user_id, type, title) VALUES (a, owner_a, 'approval_decided', 't');
  BEGIN
    INSERT INTO notifications (account_id, user_id, type, title) VALUES (a, owner_a, 'made_up', 't');
    RAISE EXCEPTION 'FAIL the type check must still refuse unknown types';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 13. Cascades still delete for real
  -- ---------------------------------------------------------
  DELETE FROM accounts WHERE id = b;
  IF EXISTS (SELECT 1 FROM tags WHERE account_id = b) THEN
    RAISE EXCEPTION 'FAIL account deletion must hard-delete its tags';
  END IF;
  n := n + 1;

  RAISE EXCEPTION 'ROLLBACK-OK: % check groups passed', n;
END
$verify$;
