-- ============================================================
-- Verification for migration 082 (audit trail).
--
-- Run against a database that already has 082 applied:
--   supabase db query --linked -f supabase/ci/verify-082-audit.sql
--
-- Everything happens inside one DO block that ends with
-- RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing is ever committed.
-- A message starting with ROLLBACK-OK means every check passed; any
-- other error message names the check that failed.
--
-- People are simulated the way PostgREST does it: set the JWT claims and
-- SET LOCAL ROLE authenticated, so RLS applies for real. Statements run
-- with no claims act as the service role / a webhook ("system").
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
  tag1     UUID := gen_random_uuid();
  tag2     UUID := gen_random_uuid();
  snip     UUID := gen_random_uuid();
  art      UUID := gen_random_uuid();
  art_tr   UUID := gen_random_uuid();
  team1    UUID := gen_random_uuid();
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

  -- ---------------------------------------------------------
  -- fixtures: users -> (trigger) accounts + profiles
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify082-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
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
  -- fixtures above must not have produced audit noise as "removals"
  IF pg_temp.ac(a, $c$action = 'member_removed'$c$) <> 0 THEN
    RAISE EXCEPTION 'FAIL joining an account from an empty personal account must not log a removal';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 1. Capability audit.view: catalogue + defaults
  -- ---------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM capability_catalogue
                  WHERE capability = 'audit.view' AND min_grant_role = 'agent' AND enforced_by = 'database') THEN
    RAISE EXCEPTION 'FAIL audit.view missing from the catalogue';
  END IF;
  IF (SELECT count(*) FROM role_capability_defaults WHERE capability = 'audit.view') <> 2 THEN
    RAISE EXCEPTION 'FAIL audit.view defaults must be owner + admin only';
  END IF;
  IF pg_temp.run(owner_a,  format('SELECT has_capability(%L, ''audit.view'')::text', a)) <> 'true'
  OR pg_temp.run(admin_a,  format('SELECT has_capability(%L, ''audit.view'')::text', a)) <> 'true'
  OR pg_temp.run(agent_a,  format('SELECT has_capability(%L, ''audit.view'')::text', a)) <> 'false'
  OR pg_temp.run(viewer_a, format('SELECT has_capability(%L, ''audit.view'')::text', a)) <> 'false' THEN
    RAISE EXCEPTION 'FAIL audit.view default parity (owner+admin only)';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 2. Tags: created / updated, stamped from auth.uid()
  -- ---------------------------------------------------------
  res := pg_temp.run(admin_a, format(
    $q$INSERT INTO tags (id, user_id, account_id, name, color, created_by, for_contacts, for_conversations)
       VALUES (%L, %L, %L, 'VIP', '#ff0000', %L, true, true)$q$, tag1, admin_a, a, owner_b));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL tag insert: %', res; END IF;
  IF (SELECT created_by FROM tags WHERE id = tag1) IS DISTINCT FROM admin_a THEN
    RAISE EXCEPTION 'FAIL created_by must come from auth.uid(), not the client';
  END IF;
  IF pg_temp.ac(a, format($c$action = 'created' AND entity_type = 'tag' AND entity_id = %L
                             AND actor_id = %L AND actor_kind = 'user' AND entity_label = 'VIP'$c$, tag1, admin_a)) <> 1 THEN
    RAISE EXCEPTION 'FAIL tag created row';
  END IF;
  n := n + 1;

  res := pg_temp.run(admin_a, format($q$UPDATE tags SET name = 'VIP gold', color = '#00ff00' WHERE id = %L$q$, tag1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL tag update: %', res; END IF;
  SELECT summary INTO rec FROM audit_log
   WHERE account_id = a AND entity_id = tag1 AND action = 'updated';
  IF rec.summary #>> '{changes,name,from}' IS DISTINCT FROM 'VIP'
  OR rec.summary #>> '{changes,name,to}'   IS DISTINCT FROM 'VIP gold'
  OR rec.summary #>> '{changes,color,to}'  IS DISTINCT FROM '#00ff00' THEN
    RAISE EXCEPTION 'FAIL tag updated summary: %', rec.summary;
  END IF;
  IF (SELECT updated_by FROM tags WHERE id = tag1) IS DISTINCT FROM admin_a THEN
    RAISE EXCEPTION 'FAIL updated_by';
  END IF;
  -- an update that changes nothing tracked writes no row
  cnt := pg_temp.ac(a, 'true');
  PERFORM pg_temp.run(admin_a, format($q$UPDATE tags SET description = description WHERE id = %L$q$, tag1));
  IF pg_temp.ac(a, 'true') <> cnt THEN RAISE EXCEPTION 'FAIL no-op update must not be logged'; END IF;
  n := n + 1;

  -- a client cannot forge a soft delete
  PERFORM pg_temp.run(admin_a, format($q$UPDATE tags SET deleted_at = now(), deleted_by = %L WHERE id = %L$q$, owner_b, tag1));
  IF (SELECT deleted_at FROM tags WHERE id = tag1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a client changed deleted_at directly';
  END IF;
  n := n + 1;

  -- apply the tag to a contact and a conversation (as the agent)
  INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES (contact1, owner_a, a, '+10000000001', 'Casey');
  INSERT INTO conversations (id, user_id, account_id, contact_id) VALUES (conv1, owner_a, a, contact1);
  res := pg_temp.run(agent_a, format($q$INSERT INTO contact_tags (contact_id, tag_id) VALUES (%L, %L)$q$, contact1, tag1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL contact tag insert: %', res; END IF;
  res := pg_temp.run(agent_a, format($q$INSERT INTO conversation_labels (conversation_id, tag_id) VALUES (%L, %L)$q$, conv1, tag1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL label insert: %', res; END IF;
  IF (SELECT added_by FROM contact_tags WHERE contact_id = contact1) IS DISTINCT FROM agent_a
  OR (SELECT applied_by FROM conversation_labels WHERE conversation_id = conv1) IS DISTINCT FROM agent_a THEN
    RAISE EXCEPTION 'FAIL added_by / applied_by stamp';
  END IF;
  IF pg_temp.ac(a, format($c$action = 'applied' AND entity_type = 'contact' AND entity_id = %L
                             AND actor_id = %L AND summary ->> 'tag' = 'VIP gold'$c$, contact1, agent_a)) <> 1
  OR pg_temp.ac(a, format($c$action = 'applied' AND entity_type = 'conversation' AND entity_id = %L
                             AND summary ->> 'label' = 'VIP gold'$c$, conv1)) <> 1 THEN
    RAISE EXCEPTION 'FAIL applied rows';
  END IF;
  -- removal of a link is logged with the actor (hard delete + log fallback)
  PERFORM pg_temp.run(agent_a, format($q$DELETE FROM conversation_labels WHERE conversation_id = %L$q$, conv1));
  IF pg_temp.ac(a, format($c$action = 'removed' AND entity_type = 'conversation' AND entity_id = %L AND actor_id = %L$c$, conv1, agent_a)) <> 1 THEN
    RAISE EXCEPTION 'FAIL removed row for a label';
  END IF;
  -- put it back, plus a system (service role) application
  PERFORM pg_temp.run(agent_a, format($q$INSERT INTO conversation_labels (conversation_id, tag_id) VALUES (%L, %L)$q$, conv1, tag1));
  n := n + 1;

  -- ---------------------------------------------------------
  -- 3. Soft delete of a tag
  -- ---------------------------------------------------------
  res := pg_temp.run(admin_a, format($q$DELETE FROM tags WHERE id = %L$q$, tag1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL tag delete: %', res; END IF;
  IF NOT EXISTS (SELECT 1 FROM tags WHERE id = tag1 AND deleted_at IS NOT NULL AND deleted_by = admin_a) THEN
    RAISE EXCEPTION 'FAIL tag delete must be a soft delete with deleted_by';
  END IF;
  IF pg_temp.run(admin_a, format('SELECT count(*)::text FROM tags WHERE id = %L', tag1)) <> '0' THEN
    RAISE EXCEPTION 'FAIL soft-deleted tag still visible to members';
  END IF;
  IF pg_temp.run(admin_a, format($q$SELECT count(*)::text FROM tag_usage_counts WHERE tag_id = %L$q$, tag1)) <> '0' THEN
    RAISE EXCEPTION 'FAIL soft-deleted tag still counted';
  END IF;
  -- applications went with it (as ON DELETE CASCADE did) and are counted in the summary
  IF EXISTS (SELECT 1 FROM contact_tags WHERE tag_id = tag1)
  OR EXISTS (SELECT 1 FROM conversation_labels WHERE tag_id = tag1) THEN
    RAISE EXCEPTION 'FAIL applications of a deleted tag must be removed';
  END IF;
  IF pg_temp.ac(a, format($c$action = 'deleted' AND entity_type = 'tag' AND entity_id = %L AND actor_id = %L
                             AND (summary ->> 'contacts_untagged')::int = 1
                             AND (summary ->> 'conversations_unlabelled')::int = 1$c$, tag1, admin_a)) <> 1 THEN
    RAISE EXCEPTION 'FAIL tag deleted row (one row, with counts)';
  END IF;
  -- per-link removals inside the soft delete are not logged one by one
  IF pg_temp.ac(a, $c$action = 'removed' AND entity_type = 'contact'$c$) <> 0 THEN
    RAISE EXCEPTION 'FAIL tag soft delete flooded the log with per-link rows';
  END IF;
  n := n + 1;

  -- a deleted tag cannot be applied any more (the FK used to guarantee that)
  BEGIN
    INSERT INTO contact_tags (contact_id, tag_id) VALUES (contact1, tag1);
    RAISE EXCEPTION 'FAIL linking a soft-deleted tag must fail';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  n := n + 1;

  -- the same name can be created again
  res := pg_temp.run(admin_a, format(
    $q$INSERT INTO tags (id, user_id, account_id, name, color) VALUES (%L, %L, %L, 'vip gold', '#111111')$q$, tag2, admin_a, a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL re-creating a deleted tag name: %', res; END IF;
  n := n + 1;

  -- restore hits the name conflict with a friendly error
  res := pg_temp.run(admin_a, format($q$SELECT restore_removed_item('tag', %L)::text$q$, tag1));
  IF res NOT LIKE 'ERR 23505%name_conflict%' THEN
    RAISE EXCEPTION 'FAIL restore with a name conflict: %', res;
  END IF;
  -- once the name is free, restore works and is logged
  PERFORM pg_temp.run(admin_a, format($q$DELETE FROM tags WHERE id = %L$q$, tag2));
  res := pg_temp.run(admin_a, format($q$SELECT restore_removed_item('tag', %L)::text$q$, tag1));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL tag restore: %', res; END IF;
  IF pg_temp.run(admin_a, format('SELECT count(*)::text FROM tags WHERE id = %L', tag1)) <> '1'
  OR pg_temp.ac(a, format($c$action = 'restored' AND entity_type = 'tag' AND entity_id = %L AND actor_id = %L$c$, tag1, admin_a)) <> 1 THEN
    RAISE EXCEPTION 'FAIL tag restored / visible again';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 4. Snippets (agent floor): created / updated / soft delete / restore
  -- ---------------------------------------------------------
  res := pg_temp.run(agent_a, format(
    $q$INSERT INTO quick_replies (id, account_id, user_id, title, kind, content_text)
       VALUES (%L, %L, %L, 'Hours', 'text', 'We open at 9')$q$, snip, a, agent_a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL snippet insert: %', res; END IF;
  PERFORM pg_temp.run(agent_a, format($q$UPDATE quick_replies SET content_text = 'We open at 10' WHERE id = %L$q$, snip));
  SELECT summary INTO rec FROM audit_log WHERE account_id = a AND entity_id = snip AND action = 'updated';
  IF rec.summary -> 'changed' IS DISTINCT FROM '["content_text"]'::jsonb
  OR rec.summary::text LIKE '%We open%' THEN
    RAISE EXCEPTION 'FAIL snippet updated summary must name the column, not carry the text: %', rec.summary;
  END IF;
  res := pg_temp.run(agent_a, format($q$DELETE FROM quick_replies WHERE id = %L$q$, snip));
  IF NOT EXISTS (SELECT 1 FROM quick_replies WHERE id = snip AND deleted_at IS NOT NULL AND deleted_by = agent_a)
  OR pg_temp.run(agent_a, format('SELECT count(*)::text FROM quick_replies WHERE id = %L', snip)) <> '0'
  OR pg_temp.ac(a, format($c$action = 'deleted' AND entity_type = 'snippet' AND entity_id = %L$c$, snip)) <> 1 THEN
    RAISE EXCEPTION 'FAIL snippet soft delete';
  END IF;
  -- a viewer cannot restore; an agent can (snippets.manage)
  IF pg_temp.run(viewer_a, format($q$SELECT restore_removed_item('snippet', %L)::text$q$, snip)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL viewer must not restore a snippet';
  END IF;
  IF pg_temp.run(agent_a, format($q$SELECT restore_removed_item('snippet', %L)::text$q$, snip)) LIKE 'ERR%'
  OR pg_temp.ac(a, format($c$action = 'restored' AND entity_id = %L$c$, snip)) <> 1 THEN
    RAISE EXCEPTION 'FAIL snippet restore';
  END IF;
  -- an agent cannot restore a tag (tags.manage)
  PERFORM pg_temp.run(admin_a, format($q$DELETE FROM tags WHERE id = %L$q$, tag1));
  IF pg_temp.run(agent_a, format($q$SELECT restore_removed_item('tag', %L)::text$q$, tag1)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL agent must not restore a tag';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 5. Knowledge articles
  -- ---------------------------------------------------------
  res := pg_temp.run(admin_a, format(
    $q$INSERT INTO ai_knowledge_documents (id, account_id, created_by, title, content, status)
       VALUES (%L, %L, %L, 'Refunds', 'Refund in 30 days', 'draft')$q$, art, a, admin_a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL article insert: %', res; END IF;
  IF pg_temp.ac(a, format($c$action = 'created' AND entity_type = 'article' AND entity_id = %L$c$, art)) <> 1 THEN
    RAISE EXCEPTION 'FAIL article created row';
  END IF;
  -- autosave: two edits by the same person inside a minute => ONE updated row
  PERFORM pg_temp.run(admin_a, format($q$UPDATE ai_knowledge_documents SET title = 'Refunds v2' WHERE id = %L$q$, art));
  PERFORM pg_temp.run(admin_a, format($q$UPDATE ai_knowledge_documents SET content = 'Refund in 14 days' WHERE id = %L$q$, art));
  IF pg_temp.ac(a, format($c$action = 'updated' AND entity_type = 'article' AND entity_id = %L$c$, art)) <> 1 THEN
    RAISE EXCEPTION 'FAIL article autosave debounce (expected exactly one updated row)';
  END IF;
  -- another person's edit is logged
  PERFORM pg_temp.run(owner_a, format($q$UPDATE ai_knowledge_documents SET title = 'Refunds v3' WHERE id = %L$q$, art));
  IF pg_temp.ac(a, format($c$action = 'updated' AND entity_type = 'article' AND entity_id = %L$c$, art)) <> 2 THEN
    RAISE EXCEPTION 'FAIL a different actor must be logged';
  END IF;
  -- an edit that changes no tracked field (use_in_ai) is not logged
  PERFORM pg_temp.run(admin_a, format($q$UPDATE ai_knowledge_documents SET use_in_ai = false WHERE id = %L$q$, art));
  IF pg_temp.ac(a, format($c$entity_type = 'article' AND entity_id = %L$c$, art)) <> 3 THEN
    RAISE EXCEPTION 'FAIL untracked article field was logged';
  END IF;
  -- publishing
  PERFORM pg_temp.run(admin_a, format($q$UPDATE ai_knowledge_documents SET status = 'published' WHERE id = %L$q$, art));
  IF pg_temp.ac(a, format($c$action = 'updated' AND summary ->> 'published' = 'true' AND entity_id = %L AND actor_id = %L$c$, art, admin_a)) <> 1
  OR NOT EXISTS (SELECT 1 FROM ai_knowledge_documents WHERE id = art AND published_by = admin_a AND published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL article published row / published_by';
  END IF;
  -- a translation + a search chunk
  INSERT INTO ai_knowledge_documents (id, account_id, title, content, status, language, translation_of)
    VALUES (art_tr, a, 'Reembolsos', 'Reembolso', 'published', 'ms', art);
  INSERT INTO ai_knowledge_chunks (document_id, account_id, content) VALUES (art, a, 'refund policy hello');
  IF (SELECT count(*) FROM kb_match_fts(a, 'hello', 'staff', 5)) <> 1 THEN
    RAISE EXCEPTION 'FAIL kb_match_fts baseline';
  END IF;
  n := n + 1;

  res := pg_temp.run(admin_a, format($q$DELETE FROM ai_knowledge_documents WHERE id = %L$q$, art));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL article delete: %', res; END IF;
  IF (SELECT count(*) FROM ai_knowledge_documents WHERE id IN (art, art_tr) AND deleted_at IS NOT NULL AND deleted_by = admin_a) <> 2 THEN
    RAISE EXCEPTION 'FAIL article + translation must both be soft-deleted';
  END IF;
  IF pg_temp.run(admin_a, format('SELECT count(*)::text FROM ai_knowledge_documents WHERE id IN (%L, %L)', art, art_tr)) <> '0' THEN
    RAISE EXCEPTION 'FAIL soft-deleted article visible to members';
  END IF;
  IF (SELECT count(*) FROM kb_match_fts(a, 'hello', 'staff', 5)) <> 0
  OR (SELECT count(*) FROM kb_match_semantic(a, ('[' || array_to_string(array_fill(0, ARRAY[1536]), ',') || ']'), 'staff', 5)) <> 0 THEN
    RAISE EXCEPTION 'FAIL retrieval must skip soft-deleted articles';
  END IF;
  IF pg_temp.ac(a, format($c$action = 'deleted' AND entity_type = 'article' AND entity_id = %L$c$, art)) <> 1 THEN
    RAISE EXCEPTION 'FAIL article deleted row (the translation must not add a second row)';
  END IF;
  -- Recently removed (audit.view): admin sees it, agent (no audit.view) does not
  IF pg_temp.run(admin_a, $q$SELECT count(*)::text FROM audit_removed_items() WHERE entity_type = 'article'$q$) <> '1'
  OR pg_temp.run(agent_a, $q$SELECT count(*)::text FROM audit_removed_items()$q$) <> '0' THEN
    RAISE EXCEPTION 'FAIL audit_removed_items visibility';
  END IF;
  -- restore (knowledge.publish): agent refused, admin ok, translation comes back
  IF pg_temp.run(agent_a, format($q$SELECT restore_removed_item('article', %L)::text$q$, art)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL agent must not restore an article';
  END IF;
  res := pg_temp.run(admin_a, format($q$SELECT restore_removed_item('article', %L)::text$q$, art));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL article restore: %', res; END IF;
  IF pg_temp.run(admin_a, format('SELECT count(*)::text FROM ai_knowledge_documents WHERE id IN (%L, %L)', art, art_tr)) <> '2'
  OR (SELECT count(*) FROM kb_match_fts(a, 'hello', 'staff', 5)) <> 1
  OR pg_temp.ac(a, format($c$action = 'restored' AND entity_type = 'article' AND entity_id = %L$c$, art)) <> 1 THEN
    RAISE EXCEPTION 'FAIL article restore (rows, retrieval, one restored row)';
  END IF;
  n := n + 1;

  -- older than 90 days: hidden from Recently removed and not restorable
  PERFORM pg_temp.run(admin_a, format($q$DELETE FROM tags WHERE id = %L$q$, tag2));  -- already deleted: no-op
  PERFORM set_config('vircle.soft_delete', 'on', true);
  UPDATE tags SET deleted_at = now() - interval '91 days' WHERE id = tag1;
  PERFORM set_config('vircle.soft_delete', 'off', true);
  IF pg_temp.run(admin_a, format($q$SELECT count(*)::text FROM audit_removed_items() WHERE entity_id = %L$q$, tag1)) <> '0'
  OR pg_temp.run(admin_a, format($q$SELECT restore_removed_item('tag', %L)::text$q$, tag1)) NOT LIKE 'ERR P0002%' THEN
    RAISE EXCEPTION 'FAIL 90-day window';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 6. Teams and members
  -- ---------------------------------------------------------
  res := pg_temp.run(admin_a, format(
    $q$INSERT INTO teams (id, account_id, name) VALUES (%L, %L, 'Support')$q$, team1, a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL team insert: %', res; END IF;
  IF (SELECT created_by FROM teams WHERE id = team1) IS DISTINCT FROM admin_a THEN
    RAISE EXCEPTION 'FAIL teams.created_by';
  END IF;
  PERFORM pg_temp.run(admin_a, format($q$INSERT INTO team_members (team_id, user_id) VALUES (%L, %L)$q$, team1, agent_a));
  IF (SELECT added_by FROM team_members WHERE team_id = team1) IS DISTINCT FROM admin_a
  OR pg_temp.ac(a, format($c$action = 'team_member_added' AND entity_id = %L AND actor_id = %L$c$, team1, admin_a)) <> 1 THEN
    RAISE EXCEPTION 'FAIL team member added';
  END IF;
  PERFORM pg_temp.run(admin_a, format($q$DELETE FROM team_members WHERE team_id = %L$q$, team1));
  IF pg_temp.ac(a, format($c$action = 'team_member_removed' AND entity_id = %L AND actor_id = %L$c$, team1, admin_a)) <> 1 THEN
    RAISE EXCEPTION 'FAIL team member removed';
  END IF;
  PERFORM pg_temp.run(admin_a, format($q$INSERT INTO team_members (team_id, user_id) VALUES (%L, %L)$q$, team1, agent_a));
  PERFORM pg_temp.run(admin_a, format($q$DELETE FROM teams WHERE id = %L$q$, team1));
  IF pg_temp.ac(a, format($c$action = 'deleted' AND entity_type = 'team' AND entity_id = %L$c$, team1)) <> 1
  OR pg_temp.ac(a, $c$action = 'team_member_removed'$c$) <> 1 THEN
    RAISE EXCEPTION 'FAIL team deleted (members removed by the cascade are not logged one by one)';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 7. Roles, capabilities, invitations, member removal
  -- ---------------------------------------------------------
  PERFORM pg_temp.run(owner_a, format($q$SELECT set_member_role(%L, 'viewer')::text$q$, agent2_a));
  IF pg_temp.ac(a, format($c$action = 'role_changed' AND entity_id = %L AND actor_id = %L
                             AND summary ->> 'from' = 'agent' AND summary ->> 'to' = 'viewer'$c$, agent2_a, owner_a)) <> 1 THEN
    RAISE EXCEPTION 'FAIL role_changed row';
  END IF;
  res := pg_temp.run(owner_a, format($q$SELECT set_role_capabilities(%L, 'agent', '{"audit.view": true}'::jsonb)::text$q$, a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL granting audit.view to agents: %', res; END IF;
  IF pg_temp.ac(a, format($c$action = 'capability_changed' AND entity_label = 'agent' AND actor_id = %L
                             AND summary ->> 'capability' = 'audit.view' AND summary -> 'to' = 'true'::jsonb$c$, owner_a)) <> 1 THEN
    RAISE EXCEPTION 'FAIL capability_changed row';
  END IF;
  res := pg_temp.run(admin_a, format(
    $q$INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, label, expires_at)
       VALUES (%L, 'SECRET-TOKEN-HASH', 'agent', %L, 'For Sam', now() + interval '7 days')$q$, a, admin_a));
  IF res LIKE 'ERR%' THEN RAISE EXCEPTION 'FAIL invitation insert: %', res; END IF;
  IF pg_temp.ac(a, format($c$action = 'invited' AND actor_id = %L AND summary ->> 'role' = 'agent'
                             AND entity_label = 'For Sam'$c$, admin_a)) <> 1
  OR EXISTS (SELECT 1 FROM audit_log WHERE account_id = a AND row_to_json(audit_log)::text LIKE '%SECRET-TOKEN-HASH%') THEN
    RAISE EXCEPTION 'FAIL invited row (and it must not carry the token)';
  END IF;
  PERFORM pg_temp.run(owner_a, format($q$SELECT remove_account_member(%L)::text$q$, agent2_a));
  IF pg_temp.ac(a, format($c$action = 'member_removed' AND entity_id = %L AND actor_id = %L$c$, agent2_a, owner_a)) <> 1 THEN
    RAISE EXCEPTION 'FAIL member_removed row';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 8. Sensitive settings: names only, never values
  -- ---------------------------------------------------------
  INSERT INTO ai_configs (account_id, provider, model, api_key) VALUES (a, 'openai', 'gpt-x', 'sk-SECRET-KEY-1');
  UPDATE ai_configs SET api_key = 'sk-SECRET-KEY-2', model = 'gpt-y' WHERE account_id = a;
  INSERT INTO web_widget_config (account_id, user_id, widget_token) VALUES (a, owner_a, 'WIDGET-SECRET-1');
  UPDATE web_widget_config SET widget_token = 'WIDGET-SECRET-2' WHERE account_id = a;
  INSERT INTO api_keys (account_id, created_by, name, key_prefix, key_hash, scopes)
    VALUES (a, admin_a, 'Zapier', 'vk_abc', 'KEYHASH-SECRET', ARRAY['contacts:read']);
  INSERT INTO webhook_endpoints (account_id, created_by, url, secret, events)
    VALUES (a, admin_a, 'https://example.invalid/hook?token=URL-SECRET', 'WEBHOOK-SECRET', ARRAY['message.received']);
  IF pg_temp.ac(a, $c$entity_type = 'ai_settings' AND action = 'updated'
                      AND summary -> 'changed' @> '["api_key","model"]'::jsonb$c$) <> 1
  OR pg_temp.ac(a, $c$entity_type = 'channel_config' AND action = 'updated'
                      AND summary -> 'changed' @> '["widget_token"]'::jsonb$c$) <> 1
  OR pg_temp.ac(a, $c$entity_type = 'api_key' AND action = 'created' AND entity_label = 'Zapier'$c$) <> 1
  OR pg_temp.ac(a, format($c$entity_type = 'api_key' AND actor_id = %L$c$, admin_a)) <> 1 THEN
    RAISE EXCEPTION 'FAIL sensitive-settings rows';
  END IF;
  IF EXISTS (
    SELECT 1 FROM audit_log
     WHERE account_id = a
       AND row_to_json(audit_log)::text ~ 'SECRET'
  ) THEN
    RAISE EXCEPTION 'FAIL a secret leaked into audit_log';
  END IF;
  IF (SELECT entity_label FROM audit_log WHERE account_id = a AND entity_type = 'webhook') <> 'https://example.invalid/hook' THEN
    RAISE EXCEPTION 'FAIL webhook label must drop the query string';
  END IF;
  -- service role / no user => system actor
  IF (SELECT actor_kind FROM audit_log
       WHERE account_id = a AND entity_type = 'ai_settings' AND action = 'updated') <> 'system' THEN
    RAISE EXCEPTION 'FAIL system actor';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 9. Append-only, RLS
  -- ---------------------------------------------------------
  BEGIN
    UPDATE audit_log SET action = 'deleted' WHERE account_id = a;
    RAISE EXCEPTION 'FAIL audit_log UPDATE must raise';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM audit_log WHERE account_id = a;
    RAISE EXCEPTION 'FAIL audit_log DELETE must raise';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    TRUNCATE audit_log;
    RAISE EXCEPTION 'FAIL audit_log TRUNCATE must raise';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- no client role can write
  IF pg_temp.run(admin_a, format(
       $q$INSERT INTO audit_log (account_id, actor_kind, action, entity_type) VALUES (%L, 'user', 'created', 'x')$q$, a)) NOT LIKE 'ERR 42501%'
  OR pg_temp.run(admin_a, format($q$UPDATE audit_log SET action = 'deleted' WHERE account_id = %L$q$, a)) NOT LIKE 'ERR%'
  OR pg_temp.run(admin_a, format($q$DELETE FROM audit_log WHERE account_id = %L$q$, a)) NOT LIKE 'ERR%'
  OR pg_temp.run(NULL, format(
       $q$INSERT INTO audit_log (account_id, actor_kind, action, entity_type) VALUES (%L, 'system', 'created', 'x')$q$, a),
       'service_role') NOT LIKE 'ERR 42501%'
  OR pg_temp.run(admin_a, format($q$SELECT log_audit(%L, 'created', 'x', NULL, NULL)::text$q$, a)) NOT LIKE 'ERR 42501%' THEN
    RAISE EXCEPTION 'FAIL clients must not be able to write audit_log';
  END IF;
  -- who can read
  cnt := pg_temp.ac(a, 'true');
  IF cnt < 20 THEN RAISE EXCEPTION 'FAIL expected many audit rows, got %', cnt; END IF;
  IF pg_temp.run(admin_a, format('SELECT count(*)::text FROM audit_log WHERE account_id = %L', a)) <> cnt::text
  OR pg_temp.run(owner_a, format('SELECT count(*)::text FROM audit_log WHERE account_id = %L', a)) <> cnt::text THEN
    RAISE EXCEPTION 'FAIL owner/admin must read every row of their account';
  END IF;
  IF pg_temp.run(viewer_a, format('SELECT count(*)::text FROM audit_log WHERE account_id = %L', a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL a member without audit.view must see zero rows';
  END IF;
  -- agents were granted audit.view above (section 7), so they read; revoke and re-check
  IF pg_temp.run(agent_a, format('SELECT count(*)::text FROM audit_log WHERE account_id = %L', a)) <> cnt::text THEN
    RAISE EXCEPTION 'FAIL an agent granted audit.view must read the log';
  END IF;
  PERFORM pg_temp.run(owner_a, format($q$SELECT set_role_capabilities(%L, 'agent', '{"audit.view": null}'::jsonb)::text$q$, a));
  IF pg_temp.run(agent_a, format('SELECT count(*)::text FROM audit_log WHERE account_id = %L', a)) <> '0' THEN
    RAISE EXCEPTION 'FAIL agent lost audit.view but still reads the log';
  END IF;
  -- other account
  IF pg_temp.run(owner_b, format('SELECT count(*)::text FROM audit_log WHERE account_id = %L', a)) <> '0'
  OR pg_temp.run(owner_b, format($q$SELECT count(*)::text FROM audit_removed_items()$q$)) <> '0' THEN
    RAISE EXCEPTION 'FAIL another account must see zero rows';
  END IF;
  -- an account of their own logs separately
  PERFORM pg_temp.run(owner_b, format(
    $q$INSERT INTO tags (user_id, account_id, name, color) VALUES (%L, %L, 'B tag', '#222222')$q$, owner_b, b));
  IF pg_temp.run(owner_b, format('SELECT count(*)::text FROM audit_log WHERE account_id = %L', b)) <> '1' THEN
    RAISE EXCEPTION 'FAIL owner_b must see exactly their own account row';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 10. Cascades still delete for real (account deletion must not be blocked)
  -- ---------------------------------------------------------
  DELETE FROM accounts WHERE id = b;
  IF EXISTS (SELECT 1 FROM tags WHERE account_id = b) THEN
    RAISE EXCEPTION 'FAIL account deletion must hard-delete its tags';
  END IF;
  n := n + 1;

  RAISE EXCEPTION 'ROLLBACK-OK: % check groups passed', n;
END
$verify$;
