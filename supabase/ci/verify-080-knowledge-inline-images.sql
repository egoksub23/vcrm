-- ============================================================
-- Verification for migration 080 (inline images in knowledge articles).
--
-- Run against a database that already has 080 applied:
--   supabase db query --linked -f supabase/ci/verify-080-knowledge-inline-images.sql
--
-- Everything happens inside one DO block that ends with
-- RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing is ever committed.
-- A message starting with ROLLBACK-OK means every check passed; any
-- other error message names the check that failed.
-- ============================================================

DO $verify$
DECLARE
  a        UUID;
  b        UUID;
  owner_a  UUID := gen_random_uuid();
  owner_b  UUID := gen_random_uuid();
  doc_a    UUID := gen_random_uuid();
  att1     UUID := gen_random_uuid();
  att2     UUID := gen_random_uuid();
  n        INTEGER := 0;
  res      TEXT;
  cnt      INTEGER;
BEGIN
  -- ---------------------------------------------------------
  -- fixtures: two users -> (trigger) two accounts
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'verify080-' || u || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  FROM unnest(ARRAY[owner_a, owner_b]) AS u;

  SELECT account_id INTO a FROM profiles WHERE user_id = owner_a;
  SELECT account_id INTO b FROM profiles WHERE user_id = owner_b;
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create accounts';
  END IF;

  INSERT INTO ai_knowledge_documents (id, account_id, created_by, title, content, status)
  VALUES (doc_a, a, owner_a, 'Verify 080', 'body', 'draft');

  -- ---------------------------------------------------------
  -- 1. Column shape and defaults
  -- ---------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'knowledge_attachments'
       AND column_name = 'inline' AND data_type = 'boolean' AND is_nullable = 'NO'
       AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'FAIL inline must be boolean NOT NULL DEFAULT false';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'knowledge_attachments'
       AND column_name = 'caption' AND data_type = 'text' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'FAIL caption must be nullable text';
  END IF;
  n := n + 1;

  -- A row written the old way (no new columns) reads back as not inline, no caption.
  INSERT INTO knowledge_attachments (id, account_id, document_id, file_name, mime_type, size_bytes,
                                     kind, storage_path, public_url)
  VALUES (att1, a, doc_a, 'old.pdf', 'application/pdf', 10, 'document',
          'account-' || a || '/kb/old.pdf', 'https://example.invalid/old.pdf');
  IF (SELECT inline FROM knowledge_attachments WHERE id = att1) IS DISTINCT FROM false
     OR (SELECT caption FROM knowledge_attachments WHERE id = att1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL an old-style row must default to inline=false, caption=NULL';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 2. Inline image with a caption
  -- ---------------------------------------------------------
  INSERT INTO knowledge_attachments (id, account_id, document_id, file_name, mime_type, size_bytes,
                                     kind, storage_path, public_url, inline, caption, position)
  VALUES (att2, a, doc_a, 'pasted-image-1.png', 'image/png', 1234, 'image',
          'account-' || a || '/kb/1-pasted-image-1.png', 'https://example.invalid/1.png',
          true, 'Step 1: open Settings', 1);
  IF NOT (SELECT inline AND caption = 'Step 1: open Settings' FROM knowledge_attachments WHERE id = att2) THEN
    RAISE EXCEPTION 'FAIL inline / caption did not round-trip';
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 3. Caption length cap (1024, Meta's caption limit)
  -- ---------------------------------------------------------
  UPDATE knowledge_attachments SET caption = repeat('x', 1024) WHERE id = att2;
  BEGIN
    UPDATE knowledge_attachments SET caption = repeat('x', 1025) WHERE id = att2;
    RAISE EXCEPTION 'FAIL a 1025-character caption was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 4. The account path CHECK from 076 still holds for inline rows
  -- ---------------------------------------------------------
  BEGIN
    INSERT INTO knowledge_attachments (account_id, document_id, file_name, mime_type, size_bytes,
                                       kind, storage_path, public_url, inline)
    VALUES (a, doc_a, 'x.png', 'image/png', 1, 'image',
            'account-' || b || '/kb/x.png', 'https://example.invalid/x.png', true);
    RAISE EXCEPTION 'FAIL another account''s path was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL; -- expected
  END;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 5. RLS is untouched: the owner (as PostgREST would run) can change the new
  --    columns on their own article, another account cannot see the rows.
  -- ---------------------------------------------------------
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', owner_a, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', owner_a::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE knowledge_attachments SET caption = 'edited by owner', inline = false WHERE id = att2;
    GET DIAGNOSTICS cnt = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    IF cnt <> 1 THEN
      RAISE EXCEPTION 'FAIL the owner could not update inline / caption on their own article (% rows)', cnt;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RAISE;
  END;
  n := n + 1;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', owner_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', owner_b::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO cnt FROM knowledge_attachments WHERE document_id = doc_a;
  EXECUTE 'RESET ROLE';
  IF cnt <> 0 THEN
    RAISE EXCEPTION 'FAIL another account can read % attachment rows', cnt;
  END IF;
  n := n + 1;

  -- ---------------------------------------------------------
  -- 6. The chat-media bucket settings were not touched by this migration
  -- ---------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media' AND public) THEN
    RAISE EXCEPTION 'FAIL chat-media must still exist and be public';
  END IF;
  n := n + 1;

  res := format('%s checks passed', n);
  RAISE EXCEPTION 'ROLLBACK-OK: %', res;
END
$verify$;
