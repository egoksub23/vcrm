-- ============================================================
-- 078_kb_translations
--
-- Knowledge base: English (or any base language) is the source and an AI
-- translation into another language is its own article, linked to the base
-- one, so search, chunking, citations, gaps and the AI keep working
-- unchanged and every translation can be edited by hand.
--
--   * ai_knowledge_documents
--       translation_of       the base article (NULL = a base article);
--                            deleting the base deletes its translations
--       translated_from_at   the base's updated_at when the translation was
--                            last made by the AI or marked up to date; the
--                            translation is "out of date" once the base's
--                            updated_at is later
--       machine_translated   true until a person saves the translation
--     One translation per language per base (unique index). A translation
--     cannot be in its base's language, cannot be translated itself (no
--     chains), must sit in the base's account, and starts in the base's
--     collection (trigger; the 076 trigger then syncs `category`).
--   * kb_match_fts / kb_match_semantic also return translation_of, so
--     retrieval can keep one article per translation group.
--   * ai_task_routing.task and ai_usage_log.mode accept the new AI job
--     'translate' (constraints are looked up in pg_constraint, as in 075).
--
-- RLS is unchanged: a translation is an ordinary article row, so the 073
-- policies apply (admins anywhere; an agent only on a draft they wrote).
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- Columns, uniqueness, simple row checks
-- ------------------------------------------------------------
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS translation_of     uuid REFERENCES ai_knowledge_documents(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS translated_from_at timestamptz,
  ADD COLUMN IF NOT EXISTS machine_translated boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_documents_translation_uniq
  ON ai_knowledge_documents (translation_of, language)
  WHERE translation_of IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_knowledge_documents_translation_self_check') THEN
    ALTER TABLE ai_knowledge_documents
      ADD CONSTRAINT ai_knowledge_documents_translation_self_check
      CHECK (translation_of IS NULL OR translation_of <> id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_knowledge_documents_machine_check') THEN
    ALTER TABLE ai_knowledge_documents
      ADD CONSTRAINT ai_knowledge_documents_machine_check
      CHECK (NOT machine_translated OR translation_of IS NOT NULL);
  END IF;
END $$;

-- ------------------------------------------------------------
-- Translation rules that a CHECK cannot express (they read another row).
--
-- Named so it sorts BEFORE ai_knowledge_documents_sync_category (076): on
-- insert this sets collection_id first and the category trigger then copies
-- the collection's name. SECURITY INVOKER: an agent can already read every
-- article in their account, which is all these checks need.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kb_check_translation()
RETURNS trigger AS $$
DECLARE
  b RECORD;
BEGIN
  IF NEW.translation_of IS NOT NULL THEN
    SELECT id, account_id, language, translation_of, collection_id
      INTO b
      FROM ai_knowledge_documents
     WHERE id = NEW.translation_of;
    IF NOT FOUND OR b.account_id <> NEW.account_id THEN
      RAISE EXCEPTION 'the article to translate is not in this account'
        USING ERRCODE = '23503';
    END IF;
    IF b.translation_of IS NOT NULL THEN
      RAISE EXCEPTION 'a translation cannot be translated again'
        USING ERRCODE = '23514';
    END IF;
    IF b.language = NEW.language THEN
      RAISE EXCEPTION 'a translation must be in a different language from its article'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM ai_knowledge_documents t WHERE t.translation_of = NEW.id) THEN
      RAISE EXCEPTION 'an article that has translations cannot become a translation'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
      NEW.collection_id := b.collection_id;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.language IS DISTINCT FROM OLD.language THEN
    -- A base article moving to a language one of its translations already uses.
    IF EXISTS (
      SELECT 1 FROM ai_knowledge_documents t
       WHERE t.translation_of = NEW.id AND t.language = NEW.language
    ) THEN
      RAISE EXCEPTION 'a translation of this article already exists in that language'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = public;

DROP TRIGGER IF EXISTS ai_knowledge_documents_check_translation ON ai_knowledge_documents;
CREATE TRIGGER ai_knowledge_documents_check_translation
  BEFORE INSERT OR UPDATE OF translation_of, language ON ai_knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.kb_check_translation();

-- ------------------------------------------------------------
-- Retrieval: also return the article a hit is a translation of, so the app
-- can keep one article per group. Same filters as 073 (published; AI
-- audience additionally needs use_in_ai), plus one trailing column.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.kb_match_fts(uuid, text, text, integer);
DROP FUNCTION IF EXISTS public.kb_match_semantic(uuid, text, text, integer);

CREATE OR REPLACE FUNCTION public.kb_match_fts(
  p_account_id  uuid,
  p_query       text,
  p_audience    text,
  p_match_count integer
)
RETURNS TABLE (
  chunk_id uuid, document_id uuid, title text, category text,
  language text, content text, rank real, translation_of uuid
) AS $$
  SELECT c.id, d.id, d.title, d.category, d.language, c.content,
         ts_rank_cd(c.fts, q.tsq, 32)::real AS rank,
         d.translation_of
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
  language text, content text, distance real, translation_of uuid
) AS $$
  SELECT c.id, d.id, d.title, d.category, d.language, c.content,
         (c.embedding <=> p_query_embedding::vector(1536))::real AS distance,
         d.translation_of
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
-- The new AI job: 'translate'
-- ------------------------------------------------------------
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'ai_task_routing'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%closing_note%'
  LOOP
    EXECUTE format('ALTER TABLE ai_task_routing DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE ai_task_routing DROP CONSTRAINT IF EXISTS ai_task_routing_task_check;
ALTER TABLE ai_task_routing ADD CONSTRAINT ai_task_routing_task_check
  CHECK (task IN ('draft', 'auto_reply', 'auto_label', 'closing_note', 'summary', 'translate'));

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'ai_usage_log'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%mode%'
  LOOP
    EXECUTE format('ALTER TABLE ai_usage_log DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'auto_label', 'closing_note', 'summary', 'translate'));
