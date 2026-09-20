-- ============================================================
-- 076_knowledge_v3
--
-- Knowledge base, third pass (design match + rich text + attachments):
--
--   * knowledge_collections   folders of articles (replace the free-text
--                             category; the old `category` column stays and
--                             is kept equal to the collection's name by a
--                             trigger, so search results keep working)
--   * ai_knowledge_documents  + collection_id, content_html (rich text; the
--                             plain `content` stays what search and the AI
--                             read), source_id (imported from a file / URL)
--   * knowledge_attachments   files that travel with an answer
--   * knowledge_sources       where an imported article came from (re-sync)
--   * knowledge_document_versions  edit history (last 30 per article)
--   * kb_usage_counts / kb_ai_answers  aggregates for the library + insights
--   * knowledge_gaps.resolved_at  so insights can use a 30-day window
--   * chat-media bucket: wider MIME allow-list so an article can carry any
--     ordinary file (CSV, zip, OpenDocument, HEIC ...)
--
-- Existing articles keep working unchanged: a collection is created for
-- every distinct existing category and the articles are linked to it.
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- Collections
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_collections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  color      text NOT NULL DEFAULT '#7C3AED' CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_collections_name_uniq
  ON knowledge_collections (account_id, lower(name));
CREATE INDEX IF NOT EXISTS knowledge_collections_account_idx
  ON knowledge_collections (account_id, sort_order, created_at);

ALTER TABLE knowledge_collections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_collections_select ON knowledge_collections;
CREATE POLICY knowledge_collections_select ON knowledge_collections FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS knowledge_collections_insert ON knowledge_collections;
CREATE POLICY knowledge_collections_insert ON knowledge_collections FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS knowledge_collections_update ON knowledge_collections;
CREATE POLICY knowledge_collections_update ON knowledge_collections FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS knowledge_collections_delete ON knowledge_collections;
CREATE POLICY knowledge_collections_delete ON knowledge_collections FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- Sources (where an imported article came from)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('file', 'url')),
  name           text,
  url            text,
  -- SHA-256 of the extracted text, so a re-sync can tell "unchanged".
  checksum       text,
  last_synced_at timestamptz,
  sync_status    text NOT NULL DEFAULT 'ok' CHECK (sync_status IN ('ok', 'error')),
  sync_error     text,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_sources_account_idx ON knowledge_sources (account_id);

ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_sources_select ON knowledge_sources;
CREATE POLICY knowledge_sources_select ON knowledge_sources FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS knowledge_sources_insert ON knowledge_sources;
CREATE POLICY knowledge_sources_insert ON knowledge_sources FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS knowledge_sources_update ON knowledge_sources;
CREATE POLICY knowledge_sources_update ON knowledge_sources FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS knowledge_sources_delete ON knowledge_sources;
CREATE POLICY knowledge_sources_delete ON knowledge_sources FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- Documents: collection, rich text, source
-- ------------------------------------------------------------
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES knowledge_collections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS content_html  text,
  ADD COLUMN IF NOT EXISTS source_id     uuid REFERENCES knowledge_sources(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_collection_idx
  ON ai_knowledge_documents (account_id, collection_id);

-- A category-only change (a collection rename, or moving an article between
-- collections) is filing, not editing: leave "updated" alone so the library's
-- ordering and "review due" reasoning are not disturbed.
CREATE OR REPLACE FUNCTION public.update_ai_knowledge_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  IF (to_jsonb(NEW) - 'category' - 'collection_id' - 'updated_at')
       IS NOT DISTINCT FROM (to_jsonb(OLD) - 'category' - 'collection_id' - 'updated_at') THEN
    NEW.updated_at = OLD.updated_at;
  ELSE
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Backfill: one collection per distinct existing category (case-insensitive),
-- named as the most recently used spelling.
INSERT INTO knowledge_collections (account_id, name, sort_order)
SELECT account_id, name, (row_number() OVER (PARTITION BY account_id ORDER BY lower(name)) - 1)::int
  FROM (
    SELECT DISTINCT ON (account_id, lower(btrim(category)))
           account_id, left(btrim(category), 60) AS name
      FROM ai_knowledge_documents
     WHERE category IS NOT NULL AND btrim(category) <> ''
     ORDER BY account_id, lower(btrim(category)), updated_at DESC
  ) distinct_categories
ON CONFLICT DO NOTHING;

UPDATE ai_knowledge_documents d
   SET collection_id = c.id
  FROM knowledge_collections c
 WHERE d.collection_id IS NULL
   AND d.category IS NOT NULL
   AND c.account_id = d.account_id
   AND lower(c.name) = lower(left(btrim(d.category), 60));

-- ------------------------------------------------------------
-- Keep `category` equal to the collection's name
--
-- One place, in the database, so every writer (API, SQL, imports) gets the
-- same result: setting collection_id copies the name into category (and
-- refuses a collection from another account); clearing it clears the
-- category; renaming a collection renames it on its articles.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kb_sync_doc_category()
RETURNS trigger AS $$
DECLARE
  v_name text;
BEGIN
  IF NEW.collection_id IS NOT NULL THEN
    SELECT name INTO v_name
      FROM knowledge_collections
     WHERE id = NEW.collection_id AND account_id = NEW.account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'collection % is not in this account', NEW.collection_id
        USING ERRCODE = '23503';
    END IF;
    NEW.category := v_name;
  ELSIF TG_OP = 'UPDATE' AND OLD.collection_id IS NOT NULL THEN
    NEW.category := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = public;

DROP TRIGGER IF EXISTS ai_knowledge_documents_sync_category ON ai_knowledge_documents;
CREATE TRIGGER ai_knowledge_documents_sync_category
  BEFORE INSERT OR UPDATE OF collection_id ON ai_knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.kb_sync_doc_category();

CREATE OR REPLACE FUNCTION public.kb_collection_renamed()
RETURNS trigger AS $$
BEGIN
  UPDATE ai_knowledge_documents SET category = NEW.name WHERE collection_id = NEW.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = public;

DROP TRIGGER IF EXISTS knowledge_collections_renamed ON knowledge_collections;
CREATE TRIGGER knowledge_collections_renamed
  AFTER UPDATE OF name ON knowledge_collections
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.kb_collection_renamed();

-- ------------------------------------------------------------
-- Attachments
--
-- Files live in the public chat-media bucket under account-<id>/kb/…, so
-- Meta and mail providers can fetch them. The CHECK ties the object path to
-- the account, so a row can never point at another account's files.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  document_id  uuid NOT NULL REFERENCES ai_knowledge_documents(id) ON DELETE CASCADE,
  file_name    text NOT NULL,
  mime_type    text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes   bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  kind         text NOT NULL DEFAULT 'document' CHECK (kind IN ('image', 'video', 'audio', 'document')),
  storage_path text NOT NULL,
  public_url   text NOT NULL,
  send_with_ai boolean NOT NULL DEFAULT true,
  position     integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_attachments_path_check
    CHECK (storage_path LIKE 'account-' || account_id::text || '/%')
);
CREATE INDEX IF NOT EXISTS knowledge_attachments_doc_idx
  ON knowledge_attachments (document_id, position);
CREATE INDEX IF NOT EXISTS knowledge_attachments_account_idx
  ON knowledge_attachments (account_id);

ALTER TABLE knowledge_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_attachments_select ON knowledge_attachments;
CREATE POLICY knowledge_attachments_select ON knowledge_attachments FOR SELECT
  USING (is_account_member(account_id));

-- Same shape as the article policies (073): admins anywhere; an agent only on
-- a draft they wrote.
DROP POLICY IF EXISTS knowledge_attachments_insert ON knowledge_attachments;
CREATE POLICY knowledge_attachments_insert ON knowledge_attachments FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND EXISTS (
        SELECT 1 FROM ai_knowledge_documents d
         WHERE d.id = document_id AND d.account_id = knowledge_attachments.account_id
           AND d.created_by = auth.uid() AND d.status = 'draft'
      )
    )
  );
DROP POLICY IF EXISTS knowledge_attachments_update ON knowledge_attachments;
CREATE POLICY knowledge_attachments_update ON knowledge_attachments FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND EXISTS (
        SELECT 1 FROM ai_knowledge_documents d
         WHERE d.id = document_id AND d.created_by = auth.uid() AND d.status = 'draft'
      )
    )
  )
  WITH CHECK (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND EXISTS (
        SELECT 1 FROM ai_knowledge_documents d
         WHERE d.id = document_id AND d.account_id = knowledge_attachments.account_id
           AND d.created_by = auth.uid() AND d.status = 'draft'
      )
    )
  );
DROP POLICY IF EXISTS knowledge_attachments_delete ON knowledge_attachments;
CREATE POLICY knowledge_attachments_delete ON knowledge_attachments FOR DELETE
  USING (
    is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND EXISTS (
        SELECT 1 FROM ai_knowledge_documents d
         WHERE d.id = document_id AND d.created_by = auth.uid() AND d.status = 'draft'
      )
    )
  );

-- ------------------------------------------------------------
-- Edit history
--
-- A snapshot on every insert and every change to title / text / rich text;
-- the newest 30 per article are kept. Clients can only read it (restoring
-- means updating the article, which snapshots again). The trigger function
-- is SECURITY DEFINER so it can write the history and prune it whoever
-- edits; it returns `trigger`, so it cannot be called as an RPC, and its
-- EXECUTE is revoked anyway.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_document_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES ai_knowledge_documents(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title        text NOT NULL,
  content      text NOT NULL,
  content_html text,
  edited_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS knowledge_document_versions_doc_idx
  ON knowledge_document_versions (document_id, created_at DESC);

ALTER TABLE knowledge_document_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_document_versions_select ON knowledge_document_versions;
CREATE POLICY knowledge_document_versions_select ON knowledge_document_versions FOR SELECT
  USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION public.kb_snapshot_version()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.title IS NOT DISTINCT FROM OLD.title
     AND NEW.content IS NOT DISTINCT FROM OLD.content
     AND NEW.content_html IS NOT DISTINCT FROM OLD.content_html THEN
    RETURN NEW;
  END IF;

  INSERT INTO knowledge_document_versions (document_id, account_id, title, content, content_html, edited_by)
  VALUES (NEW.id, NEW.account_id, NEW.title, NEW.content, NEW.content_html,
          COALESCE(NEW.updated_by, NEW.created_by));

  DELETE FROM knowledge_document_versions
   WHERE document_id = NEW.id
     AND id NOT IN (
       SELECT id FROM knowledge_document_versions
        WHERE document_id = NEW.id
        ORDER BY created_at DESC, id DESC
        LIMIT 30
     );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.kb_snapshot_version() FROM PUBLIC;

DROP TRIGGER IF EXISTS ai_knowledge_documents_snapshot ON ai_knowledge_documents;
CREATE TRIGGER ai_knowledge_documents_snapshot
  AFTER INSERT OR UPDATE OF title, content, content_html ON ai_knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.kb_snapshot_version();

-- Baseline: every article that already exists starts with one version.
INSERT INTO knowledge_document_versions (document_id, account_id, title, content, content_html, edited_by, created_at)
SELECT d.id, d.account_id, d.title, d.content, d.content_html,
       COALESCE(d.updated_by, d.created_by), d.updated_at
  FROM ai_knowledge_documents d
 WHERE NOT EXISTS (SELECT 1 FROM knowledge_document_versions v WHERE v.document_id = d.id);

-- ------------------------------------------------------------
-- Usage aggregates (library "AI uses", tiles, insights)
-- SECURITY INVOKER: RLS limits a member to their own account.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kb_usage_counts(p_account_id uuid, p_since timestamptz)
RETURNS TABLE (document_id uuid, uses bigint) AS $$
  SELECT c.document_id, count(*)::bigint
    FROM ai_knowledge_citations c
   WHERE c.account_id = p_account_id AND c.created_at >= p_since
   GROUP BY c.document_id
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

-- One answer cites one or more articles in a single insert, so rows that
-- share (conversation, timestamp, mode) are one answer.
CREATE OR REPLACE FUNCTION public.kb_ai_answers(p_account_id uuid, p_since timestamptz)
RETURNS bigint AS $$
  SELECT count(*)::bigint FROM (
    SELECT DISTINCT conversation_id, created_at, mode
      FROM ai_knowledge_citations
     WHERE account_id = p_account_id AND created_at >= p_since
       AND mode IN ('auto_reply', 'draft')
  ) answers
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.kb_usage_counts(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kb_usage_counts(uuid, timestamptz) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.kb_ai_answers(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kb_ai_answers(uuid, timestamptz) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Gaps: when one was resolved (insights use a 30-day window)
-- ------------------------------------------------------------
ALTER TABLE knowledge_gaps ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
UPDATE knowledge_gaps SET resolved_at = last_asked_at
 WHERE status = 'resolved' AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS knowledge_gaps_resolved_doc_idx
  ON knowledge_gaps (account_id, resolved_document_id) WHERE resolved_document_id IS NOT NULL;

-- ------------------------------------------------------------
-- chat-media: a wider allow-list so an article can carry any ordinary file.
-- Same UPSERT shape as 023 / 039; the bucket stays public, 16 MB. The
-- storage RLS policies (023) already let any member write under
-- account-<id>/, which covers the kb/ sub-folder. application/octet-stream
-- is what a browser reports for a file it does not recognise; it is served
-- as a download, never rendered.
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-media',
  'chat-media',
  TRUE,
  16777216,
  ARRAY[
    -- Images
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'image/heic', 'image/heif', 'image/bmp', 'image/tiff',
    -- Videos
    'video/mp4', 'video/3gpp', 'video/3gp', 'video/quicktime',
    -- Documents
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/rtf', 'text/rtf',
    'text/plain', 'text/csv', 'text/markdown',
    'application/zip', 'application/x-zip-compressed',
    'application/octet-stream',
    -- Audio
    'audio/ogg', 'audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/amr', 'audio/opus',
    'audio/wav', 'audio/x-wav'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
