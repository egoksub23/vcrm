-- ============================================================
-- 073_knowledge_base_v2
--
-- Rebuilds the knowledge base (migration 030) into a shared library that
-- agents and the AI both use.
--
--   * Articles get a language (English / Bahasa Melayu / Chinese), a
--     status (draft / published), a "use in AI" switch, a kind
--     (article / Q&A), an optional category and review date, and the
--     conversation they were written from.
--   * Keyword search now works for Chinese: the generated tsvector splits
--     every CJK character into its own token (the 'simple' parser treats
--     an unspaced Chinese sentence as one long word).
--   * New retrieval functions filter on status / use_in_ai in SQL, so an
--     agents-only or draft article can never reach a model, whatever the
--     app code does. All SECURITY INVOKER (the lesson of migration 032).
--   * ai_knowledge_citations records which article the AI used, and
--     knowledge_gaps records questions it had no article for.
--   * ai_configs gains an optional embeddings URL + model so any
--     OpenAI-compatible embeddings service works (Kimi has none).
--
-- Existing documents become published + AI-enabled + English, so nothing
-- changes for what is already there. Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- CJK-aware keyword tokenising
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kb_cjk_split(t text)
RETURNS text AS $$
  SELECT regexp_replace(coalesce(t, ''), '([㐀-䶿一-鿿])', ' \1 ', 'g')
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;

-- ------------------------------------------------------------
-- Documents
-- ------------------------------------------------------------
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS language   text    NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS status     text    NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS use_in_ai  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS kind       text    NOT NULL DEFAULT 'article',
  ADD COLUMN IF NOT EXISTS category   text,
  ADD COLUMN IF NOT EXISTS review_by  date,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_knowledge_documents_language_check') THEN
    ALTER TABLE ai_knowledge_documents
      ADD CONSTRAINT ai_knowledge_documents_language_check CHECK (language IN ('en', 'ms', 'zh'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_knowledge_documents_status_check') THEN
    ALTER TABLE ai_knowledge_documents
      ADD CONSTRAINT ai_knowledge_documents_status_check CHECK (status IN ('draft', 'published'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_knowledge_documents_kind_check') THEN
    ALTER TABLE ai_knowledge_documents
      ADD CONSTRAINT ai_knowledge_documents_kind_check CHECK (kind IN ('article', 'qa'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_account_status_idx
  ON ai_knowledge_documents (account_id, status);

-- Agents can write: they may add drafts, and edit/delete their own drafts.
-- Publishing (status = 'published'), editing published articles and
-- deleting them stay admin-only.
DROP POLICY IF EXISTS ai_knowledge_documents_insert ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_insert ON ai_knowledge_documents FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'admin')
    OR (is_account_member(account_id, 'agent') AND status = 'draft')
  );

DROP POLICY IF EXISTS ai_knowledge_documents_update ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_update ON ai_knowledge_documents FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (is_account_member(account_id, 'agent') AND created_by = auth.uid() AND status = 'draft')
  )
  WITH CHECK (
    is_account_member(account_id, 'admin')
    OR (is_account_member(account_id, 'agent') AND created_by = auth.uid() AND status = 'draft')
  );

DROP POLICY IF EXISTS ai_knowledge_documents_delete ON ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_delete ON ai_knowledge_documents FOR DELETE
  USING (
    is_account_member(account_id, 'admin')
    OR (is_account_member(account_id, 'agent') AND created_by = auth.uid() AND status = 'draft')
  );

-- ------------------------------------------------------------
-- Chunks: CJK-aware fts
-- ------------------------------------------------------------
DROP INDEX IF EXISTS ai_knowledge_chunks_fts_idx;
ALTER TABLE ai_knowledge_chunks DROP COLUMN IF EXISTS fts;
ALTER TABLE ai_knowledge_chunks
  ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', public.kb_cjk_split(content))) STORED;
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_fts_idx
  ON ai_knowledge_chunks USING gin (fts);

-- Each chunk now starts with its article title, so a passage like
-- "Exceptions" still knows it belongs to the refund policy. Chunks are
-- rebuilt from the document on every reindex, so this stays consistent.
UPDATE ai_knowledge_chunks c
   SET content = d.title || E'\n\n' || c.content
  FROM ai_knowledge_documents d
 WHERE d.id = c.document_id
   AND left(c.content, length(d.title)) <> d.title;

-- ------------------------------------------------------------
-- Retrieval functions (replace the two from migration 030)
--
-- p_audience = 'ai'    → published AND use_in_ai
-- p_audience = 'agent' → published
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.match_ai_knowledge_fts(uuid, text, integer);
DROP FUNCTION IF EXISTS public.match_ai_knowledge_semantic(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.kb_match_fts(
  p_account_id  uuid,
  p_query       text,
  p_audience    text,
  p_match_count integer
)
RETURNS TABLE (
  chunk_id uuid, document_id uuid, title text, category text,
  language text, content text, rank real
) AS $$
  SELECT c.id, d.id, d.title, d.category, d.language, c.content,
         ts_rank_cd(c.fts, q.tsq, 32)::real AS rank
    FROM (SELECT to_tsquery('simple', p_query) AS tsq) q,
         ai_knowledge_chunks c
    JOIN ai_knowledge_documents d ON d.id = c.document_id
   WHERE c.account_id = p_account_id
     AND d.status = 'published'
     AND (p_audience <> 'ai' OR d.use_in_ai)
     AND c.fts @@ q.tsq
   ORDER BY rank DESC
   LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

CREATE OR REPLACE FUNCTION public.kb_match_semantic(
  p_account_id      uuid,
  p_query_embedding text,
  p_audience        text,
  p_match_count     integer
)
RETURNS TABLE (
  chunk_id uuid, document_id uuid, title text, category text,
  language text, content text, distance real
) AS $$
  SELECT c.id, d.id, d.title, d.category, d.language, c.content,
         (c.embedding <=> p_query_embedding::vector(1536))::real AS distance
    FROM ai_knowledge_chunks c
    JOIN ai_knowledge_documents d ON d.id = c.document_id
   WHERE c.account_id = p_account_id
     AND c.embedding IS NOT NULL
     AND d.status = 'published'
     AND (p_audience <> 'ai' OR d.use_in_ai)
   ORDER BY c.embedding <=> p_query_embedding::vector(1536)
   LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.kb_match_fts(uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kb_match_fts(uuid, text, text, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.kb_match_semantic(uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kb_match_semantic(uuid, text, text, integer) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Which article the AI used (feeds the "AI uses" count)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_knowledge_citations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES ai_knowledge_documents(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  mode            text NOT NULL CHECK (mode IN ('auto_reply', 'draft', 'playground', 'agent_search')),
  score           real,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_knowledge_citations_doc_idx
  ON ai_knowledge_citations (account_id, document_id, created_at DESC);

ALTER TABLE ai_knowledge_citations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_knowledge_citations_select ON ai_knowledge_citations;
CREATE POLICY ai_knowledge_citations_select ON ai_knowledge_citations FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS ai_knowledge_citations_insert ON ai_knowledge_citations;
CREATE POLICY ai_knowledge_citations_insert ON ai_knowledge_citations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

-- ------------------------------------------------------------
-- Gaps: questions the AI had no article for
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  question             text NOT NULL,
  norm_text            text NOT NULL,
  times_asked          integer NOT NULL DEFAULT 1,
  conversation_id      uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_document_id uuid REFERENCES ai_knowledge_documents(id) ON DELETE SET NULL,
  last_asked_at        timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_gaps_open_uniq
  ON knowledge_gaps (account_id, norm_text) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS knowledge_gaps_account_status_idx
  ON knowledge_gaps (account_id, status, last_asked_at DESC);

ALTER TABLE knowledge_gaps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_gaps_select ON knowledge_gaps;
CREATE POLICY knowledge_gaps_select ON knowledge_gaps FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS knowledge_gaps_update ON knowledge_gaps;
CREATE POLICY knowledge_gaps_update ON knowledge_gaps FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- Called by the auto-reply bot (service role): the same open question
-- bumps a counter instead of adding a row.
CREATE OR REPLACE FUNCTION public.kb_log_gap(
  p_account_id      uuid,
  p_question        text,
  p_conversation_id uuid
)
RETURNS void AS $$
  INSERT INTO knowledge_gaps (account_id, question, norm_text, conversation_id)
  VALUES (
    p_account_id,
    left(p_question, 500),
    lower(regexp_replace(left(p_question, 500), '\s+', ' ', 'g')),
    p_conversation_id
  )
  ON CONFLICT (account_id, norm_text) WHERE status = 'open'
  DO UPDATE SET times_asked = knowledge_gaps.times_asked + 1,
                last_asked_at = now(),
                conversation_id = EXCLUDED.conversation_id;
$$ LANGUAGE sql SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.kb_log_gap(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kb_log_gap(uuid, text, uuid) TO service_role;

-- ------------------------------------------------------------
-- Embeddings via any OpenAI-compatible service
-- ------------------------------------------------------------
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS embeddings_base_url text,
  ADD COLUMN IF NOT EXISTS embeddings_model    text;
