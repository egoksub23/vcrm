-- ============================================================
-- 082_audit_trail.sql — Audit trail (Access Control phase 2)
--
-- "Who added / changed / removed this?" for knowledge articles, tags
-- and conversation labels, snippets, teams and members, plus the rare
-- sensitive settings (channels, AI, API keys).
--
-- What this migration does
--   1. Capability `audit.view` (Owner + Admin by default): added to the
--      catalogue and the defaults exactly like the phase-1 keys. Mirrors
--      src/lib/auth/capabilities.ts (capabilities-sql.test.ts).
--   2. audit_log — ONE append-only table. RLS: SELECT for members who
--      hold audit.view, nothing else for any client role. Writes only
--      through log_audit() (SECURITY DEFINER, not executable by clients).
--      A trigger raises on UPDATE / DELETE / TRUNCATE, so even the
--      service role cannot change or remove a row.
--   3. Who-columns: created_by / updated_by / deleted_by / deleted_at on
--      tags, quick_replies, ai_knowledge_documents (+ published_by /
--      published_at), created_by / updated_by on teams, added_by on
--      team_members and contact_tags. Filled by BEFORE triggers from
--      auth.uid(), never from client-supplied values.
--   4. Soft delete for tags (contact tags AND conversation labels share
--      this table), quick replies (snippets) and knowledge articles: a
--      BEFORE DELETE trigger turns the delete into an UPDATE that sets
--      deleted_at / deleted_by. Reads are hidden by adding
--      `deleted_at IS NULL` to the SELECT policies (RLS), the
--      kb_match_* retrieval functions are patched (they run as the
--      service role for the AI), name uniqueness becomes partial, and
--      restore_removed_item() / audit_removed_items() power the
--      "Recently removed" list. Cascades (deleting an account or a user)
--      still delete for real: the trigger only converts a DIRECT delete.
--   5. Audit triggers (all wrapped so logging can never block a write).
--   6. Fallback used on purpose: applied labels, contact tags and team
--      members are still hard-deleted; the removal is logged with the
--      actor instead. Teams are hard-deleted (logged) too.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Capability audit.view
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('audit.view', 'agent', 'database')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'audit.view'),
  ('admin', 'audit.view')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2. audit_log
-- ------------------------------------------------------------
-- No FK on account_id or actor_id: the log is append-only, so it must
-- survive (and never block) an account or user deletion.
CREATE TABLE IF NOT EXISTS public.audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL,
  actor_id     UUID,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('user', 'system', 'automation', 'api')),
  actor_label  TEXT,
  action       TEXT NOT NULL CHECK (action IN (
                 'created', 'updated', 'deleted', 'restored', 'applied', 'removed',
                 'role_changed', 'capability_changed', 'invited', 'member_removed',
                 'team_member_added', 'team_member_removed', 'approved', 'rejected')),
  entity_type  TEXT NOT NULL,
  entity_id    UUID,
  entity_label TEXT,
  summary      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_account_time
  ON public.audit_log (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_account_entity
  ON public.audit_log (account_id, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_account_actor
  ON public.audit_log (account_id, actor_id, created_at DESC);

-- Append-only: nobody (service role included) updates or deletes a row.
CREATE OR REPLACE FUNCTION public.audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_no_change ON public.audit_log;
CREATE TRIGGER audit_log_no_change
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_append_only();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON public.audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON public.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_append_only();

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_select ON public.audit_log;
CREATE POLICY audit_log_select ON public.audit_log
  FOR SELECT USING (has_capability(account_id, 'audit.view'));

-- Read only. No INSERT/UPDATE/DELETE policy exists and the privileges are
-- revoked too (service role included): log_audit() is the only writer.
REVOKE ALL ON public.audit_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.audit_log TO authenticated, service_role;

-- ------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------

-- Truncate every string inside a jsonb value to 200 characters.
CREATE OR REPLACE FUNCTION public.audit_clip(v jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  k   TEXT;
  x   JSONB;
  out JSONB;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(v)
    WHEN 'string' THEN
      IF length(v #>> '{}') > 200 THEN
        RETURN to_jsonb(left(v #>> '{}', 200) || '…');
      END IF;
      RETURN v;
    WHEN 'object' THEN
      out := '{}'::jsonb;
      FOR k, x IN SELECT key, value FROM jsonb_each(v) LOOP
        out := out || jsonb_build_object(k, audit_clip(x));
      END LOOP;
      RETURN out;
    WHEN 'array' THEN
      out := '[]'::jsonb;
      FOR x IN SELECT value FROM jsonb_array_elements(v) LIMIT 20 LOOP
        out := out || jsonb_build_array(audit_clip(x));
      END LOOP;
      RETURN out;
    ELSE
      RETURN v;
  END CASE;
END;
$$;

-- Small before/after summary: `changes` holds {column: {from, to}} for the
-- p_values columns, `changed` lists the column NAMES of p_names columns
-- whose value must never be stored (long text, tokens, secrets).
-- NULL when nothing tracked changed.
CREATE OR REPLACE FUNCTION public.audit_diff(
  p_old    jsonb,
  p_new    jsonb,
  p_values text[],
  p_names  text[]
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  c       TEXT;
  changes JSONB := '{}'::jsonb;
  changed JSONB := '[]'::jsonb;
  result  JSONB := '{}'::jsonb;
BEGIN
  FOREACH c IN ARRAY COALESCE(p_values, ARRAY[]::text[]) LOOP
    IF p_old -> c IS DISTINCT FROM p_new -> c THEN
      changes := changes || jsonb_build_object(
        c, jsonb_build_object('from', p_old -> c, 'to', p_new -> c));
    END IF;
  END LOOP;
  FOREACH c IN ARRAY COALESCE(p_names, ARRAY[]::text[]) LOOP
    IF p_old -> c IS DISTINCT FROM p_new -> c THEN
      changed := changed || to_jsonb(c);
    END IF;
  END LOOP;
  IF changes <> '{}'::jsonb THEN
    result := result || jsonb_build_object('changes', audit_clip(changes));
  END IF;
  IF jsonb_array_length(changed) > 0 THEN
    result := result || jsonb_build_object('changed', changed);
  END IF;
  RETURN NULLIF(result, '{}'::jsonb);
END;
$$;

-- Split a comma list argument into an array ('' => empty).
CREATE OR REPLACE FUNCTION public.audit_cols(p_list text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(string_to_array(NULLIF(p_list, ''), ','), ARRAY[]::text[]);
$$;

-- ------------------------------------------------------------
-- log_audit — the ONLY writer of audit_log.
--
-- Actor: p_actor if given, else auth.uid() => 'user'. With no user
-- (service role, cron, webhooks, migrations) the actor is 'system'. The
-- session settings vircle.actor_kind / vircle.actor_label
-- (automation | api | system, and a name) refine that when SQL code sets
-- them with set_config(..., true); PostgREST calls do not share a
-- transaction, so application code cannot set them today and the
-- non-user actor stays 'system'.
--
-- p_dedupe_seconds > 0: skip the row when the same actor already logged
-- the same action for the same entity that recently (autosave noise).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_audit(
  p_account_id     uuid,
  p_action         text,
  p_entity_type    text,
  p_entity_id      uuid,
  p_entity_label   text,
  p_summary        jsonb   DEFAULT NULL,
  p_actor          uuid    DEFAULT NULL,
  p_dedupe_seconds integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   UUID;
  v_kind  TEXT;
  v_label TEXT;
BEGIN
  IF p_account_id IS NULL THEN RETURN; END IF;

  v_uid := COALESCE(p_actor, auth.uid());
  IF v_uid IS NOT NULL THEN
    v_kind := 'user';
    -- Snapshot the display name: a removed member's profile leaves the
    -- account, but their history must still read "Maya", not "unknown".
    SELECT COALESCE(NULLIF(btrim(full_name), ''), email)
      INTO v_label
      FROM profiles WHERE user_id = v_uid;
  ELSE
    v_kind := COALESCE(NULLIF(current_setting('vircle.actor_kind', true), ''), 'system');
    IF v_kind NOT IN ('system', 'automation', 'api') THEN v_kind := 'system'; END IF;
    v_label := NULLIF(left(COALESCE(current_setting('vircle.actor_label', true), ''), 120), '');
  END IF;

  IF p_dedupe_seconds > 0 AND EXISTS (
    SELECT 1 FROM audit_log l
     WHERE l.account_id  = p_account_id
       AND l.entity_type = p_entity_type
       AND l.entity_id   IS NOT DISTINCT FROM p_entity_id
       AND l.action      = p_action
       AND l.actor_id    IS NOT DISTINCT FROM v_uid
       AND l.created_at  > now() - make_interval(secs => p_dedupe_seconds)
  ) THEN
    RETURN;
  END IF;

  INSERT INTO audit_log
    (account_id, actor_id, actor_kind, actor_label, action,
     entity_type, entity_id, entity_label, summary)
  VALUES
    (p_account_id, v_uid, v_kind, v_label, p_action,
     p_entity_type, p_entity_id,
     NULLIF(left(COALESCE(p_entity_label, ''), 200), ''),
     audit_clip(p_summary));
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'log_audit failed: %', SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.log_audit(uuid, text, text, uuid, text, jsonb, uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.audit_clip(jsonb)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_diff(jsonb, jsonb, text[], text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_cols(text)                       FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Who-columns
-- ------------------------------------------------------------
ALTER TABLE public.tags
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE public.quick_replies
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- created_by / updated_by already exist on knowledge articles.
ALTER TABLE public.ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ;

ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS added_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.contact_tags
  ADD COLUMN IF NOT EXISTS added_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
-- conversation_labels.applied_by already exists.

-- Reading "Recently removed" and restore look rows up by deleted_at.
CREATE INDEX IF NOT EXISTS idx_tags_deleted_at
  ON public.tags (account_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quick_replies_deleted_at
  ON public.quick_replies (account_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_documents_deleted_at
  ON public.ai_knowledge_documents (account_id, deleted_at) WHERE deleted_at IS NOT NULL;

-- A soft-deleted row must not block re-creating the same name.
DROP INDEX IF EXISTS public.idx_tags_account_name_ci;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_account_name_ci
  ON public.tags (account_id, lower(name)) WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS public.ai_knowledge_documents_translation_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_documents_translation_uniq
  ON public.ai_knowledge_documents (translation_of, language)
  WHERE translation_of IS NOT NULL AND deleted_at IS NULL;

-- ------------------------------------------------------------
-- Stamp trigger: who created / updated / published / deleted.
-- Values come from auth.uid(); a client can never supply or change them.
-- With no user (service role) a value the server code set is kept.
-- deleted_at / deleted_by only change inside the soft-delete / restore
-- functions (which set vircle.soft_delete).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_stamp_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  n          JSONB := to_jsonb(NEW);
  o          JSONB;
  patch      JSONB := '{}'::jsonb;
  v_internal BOOLEAN := COALESCE(current_setting('vircle.soft_delete', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    patch := patch || jsonb_build_object(
      'created_by', COALESCE(v_uid, (n ->> 'created_by')::uuid, (n ->> 'user_id')::uuid));
    IF n ? 'updated_by' THEN
      patch := patch || jsonb_build_object('updated_by', COALESCE(v_uid, (n ->> 'updated_by')::uuid));
    END IF;
    IF NOT v_internal THEN
      IF n ? 'deleted_at' THEN
        patch := patch || jsonb_build_object('deleted_at', NULL, 'deleted_by', NULL);
      END IF;
    END IF;
    IF n ? 'published_at' THEN
      IF n ->> 'status' = 'published' THEN
        patch := patch || jsonb_build_object(
          'published_by', COALESCE(v_uid, (n ->> 'published_by')::uuid),
          'published_at', COALESCE((n ->> 'published_at')::timestamptz, now()));
      ELSE
        patch := patch || jsonb_build_object('published_by', NULL, 'published_at', NULL);
      END IF;
    END IF;
  ELSE
    o := to_jsonb(OLD);
    patch := patch || jsonb_build_object('created_by', o -> 'created_by');
    IF n ? 'updated_by' THEN
      patch := patch || jsonb_build_object('updated_by', COALESCE(v_uid, (n ->> 'updated_by')::uuid));
    END IF;
    IF NOT v_internal AND n ? 'deleted_at' THEN
      patch := patch || jsonb_build_object(
        'deleted_at', o -> 'deleted_at', 'deleted_by', o -> 'deleted_by');
    END IF;
    IF n ? 'published_at' THEN
      IF n ->> 'status' = 'published' AND o ->> 'status' IS DISTINCT FROM 'published' THEN
        patch := patch || jsonb_build_object(
          'published_by', COALESCE(v_uid, (n ->> 'published_by')::uuid),
          'published_at', now());
      ELSE
        patch := patch || jsonb_build_object(
          'published_by', o -> 'published_by', 'published_at', o -> 'published_at');
      END IF;
    END IF;
  END IF;

  -- created_by does not exist on every table that shares this function.
  patch := (SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
              FROM jsonb_each(patch) AS e(k, v) WHERE n ? k);
  NEW := jsonb_populate_record(NEW, patch);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_stamp_row ON public.tags;
CREATE TRIGGER audit_stamp_row
  BEFORE INSERT OR UPDATE ON public.tags
  FOR EACH ROW EXECUTE FUNCTION public.audit_stamp_row();

DROP TRIGGER IF EXISTS audit_stamp_row ON public.quick_replies;
CREATE TRIGGER audit_stamp_row
  BEFORE INSERT OR UPDATE ON public.quick_replies
  FOR EACH ROW EXECUTE FUNCTION public.audit_stamp_row();

DROP TRIGGER IF EXISTS audit_stamp_row ON public.ai_knowledge_documents;
CREATE TRIGGER audit_stamp_row
  BEFORE INSERT OR UPDATE ON public.ai_knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.audit_stamp_row();

DROP TRIGGER IF EXISTS audit_stamp_row ON public.teams;
CREATE TRIGGER audit_stamp_row
  BEFORE INSERT OR UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.audit_stamp_row();

-- Link rows: who added them, and never link a soft-deleted tag (this is
-- what the foreign key used to guarantee when a delete really removed it).
CREATE OR REPLACE FUNCTION public.audit_link_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_col TEXT := TG_ARGV[0];
  v_uid UUID := auth.uid();
BEGIN
  IF EXISTS (SELECT 1 FROM tags t WHERE t.id = NEW.tag_id AND t.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'tag % was deleted', NEW.tag_id USING ERRCODE = '23503';
  END IF;
  IF v_uid IS NOT NULL THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(v_col, v_uid));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_link_before_insert ON public.contact_tags;
CREATE TRIGGER audit_link_before_insert
  BEFORE INSERT ON public.contact_tags
  FOR EACH ROW EXECUTE FUNCTION public.audit_link_before_insert('added_by');

DROP TRIGGER IF EXISTS audit_link_before_insert ON public.conversation_labels;
CREATE TRIGGER audit_link_before_insert
  BEFORE INSERT ON public.conversation_labels
  FOR EACH ROW EXECUTE FUNCTION public.audit_link_before_insert('applied_by');

CREATE OR REPLACE FUNCTION public.audit_stamp_added_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.added_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_stamp_added_by ON public.team_members;
CREATE TRIGGER audit_stamp_added_by
  BEFORE INSERT ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.audit_stamp_added_by();

REVOKE ALL ON FUNCTION public.audit_stamp_row()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_link_before_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_stamp_added_by()    FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Soft delete
--
-- BEFORE DELETE converts a DIRECT delete into an UPDATE and returns NULL
-- (the physical delete is skipped). It steps aside when
--   * pg_trigger_depth() > 1: the delete is a cascade (account or user
--     deletion), which must really delete;
--   * vircle.hard_delete = 'on' (reserved for a future purge function);
--   * the row is already soft-deleted.
--
-- Deleting a tag also removes its applications (contact tags, applied
-- labels, auto-label rules) exactly as the old ON DELETE CASCADE did; the
-- count goes in the audit summary. Restoring a tag does not bring those
-- applications back.
-- Deleting an article soft-deletes its translations with it; chunks and
-- versions stay so a restore is instant.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_soft_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind     TEXT := TG_ARGV[0];
  v_contacts INTEGER := 0;
  v_convs    INTEGER := 0;
BEGIN
  IF pg_trigger_depth() > 1
     OR COALESCE(current_setting('vircle.hard_delete', true), '') = 'on'
     OR OLD.deleted_at IS NOT NULL THEN
    RETURN OLD;
  END IF;

  PERFORM set_config('vircle.soft_delete', 'on', true);

  IF v_kind = 'tag' THEN
    WITH d AS (DELETE FROM contact_tags WHERE tag_id = OLD.id RETURNING 1)
      SELECT count(*) INTO v_contacts FROM d;
    WITH d AS (DELETE FROM conversation_labels WHERE tag_id = OLD.id RETURNING 1)
      SELECT count(*) INTO v_convs FROM d;
    DELETE FROM auto_label_rules WHERE tag_id = OLD.id;
    PERFORM set_config('vircle.audit_extra',
      jsonb_build_object('contacts_untagged', v_contacts,
                         'conversations_unlabelled', v_convs)::text, true);
    UPDATE tags SET deleted_at = now(), deleted_by = auth.uid() WHERE id = OLD.id;
  ELSIF v_kind = 'snippet' THEN
    UPDATE quick_replies SET deleted_at = now(), deleted_by = auth.uid() WHERE id = OLD.id;
  ELSIF v_kind = 'article' THEN
    PERFORM set_config('vircle.audit_root', OLD.id::text, true);
    UPDATE ai_knowledge_documents
       SET deleted_at = now(), deleted_by = auth.uid()
     WHERE id = OLD.id;
    UPDATE ai_knowledge_documents
       SET deleted_at = now(), deleted_by = auth.uid()
     WHERE translation_of = OLD.id AND deleted_at IS NULL;
  END IF;

  PERFORM set_config('vircle.soft_delete', 'off', true);
  PERFORM set_config('vircle.audit_extra', '', true);
  PERFORM set_config('vircle.audit_root', '', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS audit_soft_delete ON public.tags;
CREATE TRIGGER audit_soft_delete
  BEFORE DELETE ON public.tags
  FOR EACH ROW EXECUTE FUNCTION public.audit_soft_delete('tag');

DROP TRIGGER IF EXISTS audit_soft_delete ON public.quick_replies;
CREATE TRIGGER audit_soft_delete
  BEFORE DELETE ON public.quick_replies
  FOR EACH ROW EXECUTE FUNCTION public.audit_soft_delete('snippet');

DROP TRIGGER IF EXISTS audit_soft_delete ON public.ai_knowledge_documents;
CREATE TRIGGER audit_soft_delete
  BEFORE DELETE ON public.ai_knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.audit_soft_delete('article');

REVOKE ALL ON FUNCTION public.audit_soft_delete() FROM PUBLIC, anon, authenticated;

-- Hide soft-deleted rows from every ordinary read (browser, server routes
-- with the user's own client, embeds, views with security_invoker).
DROP POLICY IF EXISTS tags_select ON public.tags;
CREATE POLICY tags_select ON public.tags
  FOR SELECT USING (is_account_member(account_id) AND deleted_at IS NULL);

DROP POLICY IF EXISTS quick_replies_select ON public.quick_replies;
CREATE POLICY quick_replies_select ON public.quick_replies
  FOR SELECT USING (is_account_member(account_id) AND deleted_at IS NULL);

DROP POLICY IF EXISTS ai_knowledge_documents_select ON public.ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_select ON public.ai_knowledge_documents
  FOR SELECT USING (is_account_member(account_id) AND deleted_at IS NULL);

-- The AI retrieval RPCs are used with the service role too (RLS is
-- bypassed there), so they filter explicitly.
CREATE OR REPLACE FUNCTION public.kb_match_fts(
  p_account_id uuid, p_query text, p_audience text, p_match_count integer)
RETURNS TABLE(chunk_id uuid, document_id uuid, title text, category text,
              language text, content text, rank real, translation_of uuid)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT c.id, d.id, d.title, d.category, d.language, c.content,
         ts_rank_cd(c.fts, q.tsq, 32)::real AS rank,
         d.translation_of
    FROM (SELECT to_tsquery('simple', p_query) AS tsq) q,
         ai_knowledge_chunks c
    JOIN ai_knowledge_documents d ON d.id = c.document_id
   WHERE c.account_id = p_account_id
     AND d.status = 'published'
     AND d.deleted_at IS NULL
     AND (p_audience <> 'ai' OR d.use_in_ai)
     AND c.fts @@ q.tsq
   ORDER BY rank DESC
   LIMIT GREATEST(p_match_count, 0);
$function$;

CREATE OR REPLACE FUNCTION public.kb_match_semantic(
  p_account_id uuid, p_query_embedding text, p_audience text, p_match_count integer)
RETURNS TABLE(chunk_id uuid, document_id uuid, title text, category text,
              language text, content text, distance real, translation_of uuid)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT c.id, d.id, d.title, d.category, d.language, c.content,
         (c.embedding <=> p_query_embedding::vector(1536))::real AS distance,
         d.translation_of
    FROM ai_knowledge_chunks c
    JOIN ai_knowledge_documents d ON d.id = c.document_id
   WHERE c.account_id = p_account_id
     AND c.embedding IS NOT NULL
     AND d.status = 'published'
     AND d.deleted_at IS NULL
     AND (p_audience <> 'ai' OR d.use_in_ai)
   ORDER BY c.embedding <=> p_query_embedding::vector(1536)
   LIMIT GREATEST(p_match_count, 0);
$function$;

-- ------------------------------------------------------------
-- Recently removed: list + restore. RLS hides soft-deleted rows, so both
-- are SECURITY DEFINER and gate themselves on capabilities.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_removed_items(p_limit integer DEFAULT 200)
RETURNS TABLE (
  entity_type     text,
  entity_id       uuid,
  label           text,
  kind            text,
  deleted_at      timestamptz,
  deleted_by      uuid,
  deleted_by_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct UUID;
  v_cut  TIMESTAMPTZ := now() - interval '90 days';
BEGIN
  SELECT p.account_id INTO v_acct FROM profiles p WHERE p.user_id = auth.uid();
  IF v_acct IS NULL OR NOT has_capability(v_acct, 'audit.view') THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT x.entity_type, x.entity_id, x.label, x.kind, x.deleted_at, x.deleted_by,
         COALESCE(NULLIF(btrim(pr.full_name), ''), pr.email)
    FROM (
      SELECT 'tag'::text AS entity_type, t.id AS entity_id, t.name AS label,
             CASE WHEN t.for_contacts AND t.for_conversations THEN 'both'
                  WHEN t.for_conversations THEN 'label'
                  ELSE 'tag' END AS kind,
             t.deleted_at, t.deleted_by
        FROM tags t
       WHERE t.account_id = v_acct AND t.deleted_at IS NOT NULL AND t.deleted_at >= v_cut
      UNION ALL
      SELECT 'snippet', q.id, q.title, q.kind, q.deleted_at, q.deleted_by
        FROM quick_replies q
       WHERE q.account_id = v_acct AND q.deleted_at IS NOT NULL AND q.deleted_at >= v_cut
      UNION ALL
      SELECT 'article', d.id, d.title, d.language, d.deleted_at, d.deleted_by
        FROM ai_knowledge_documents d
       WHERE d.account_id = v_acct AND d.deleted_at IS NOT NULL AND d.deleted_at >= v_cut
         AND NOT EXISTS (
           SELECT 1 FROM ai_knowledge_documents b
            WHERE b.id = d.translation_of AND b.deleted_at = d.deleted_at)
    ) x
    LEFT JOIN profiles pr ON pr.user_id = x.deleted_by
   ORDER BY x.deleted_at DESC
   LIMIT GREATEST(LEAST(p_limit, 500), 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_removed_item(p_entity_type text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct    UUID;
  v_deleted TIMESTAMPTZ;
  v_cap     TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_entity_type = 'tag' THEN
    v_cap := 'tags.manage';
    SELECT account_id, deleted_at INTO v_acct, v_deleted FROM tags WHERE id = p_id;
  ELSIF p_entity_type = 'snippet' THEN
    v_cap := 'snippets.manage';
    SELECT account_id, deleted_at INTO v_acct, v_deleted FROM quick_replies WHERE id = p_id;
  ELSIF p_entity_type = 'article' THEN
    v_cap := 'knowledge.publish';
    SELECT account_id, deleted_at INTO v_acct, v_deleted FROM ai_knowledge_documents WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'Unknown item type: %', p_entity_type USING ERRCODE = '22023';
  END IF;

  -- Not found / not removed / not yours / older than the 90-day window all
  -- look the same to the caller.
  IF v_acct IS NULL OR v_deleted IS NULL OR v_deleted < now() - interval '90 days'
     OR NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = auth.uid() AND account_id = v_acct) THEN
    RAISE EXCEPTION 'That item is not in Recently removed' USING ERRCODE = 'P0002';
  END IF;
  IF NOT has_capability(v_acct, v_cap) THEN
    RAISE EXCEPTION 'This action requires the ''%'' permission', v_cap USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('vircle.soft_delete', 'on', true);
  BEGIN
    IF p_entity_type = 'tag' THEN
      UPDATE tags SET deleted_at = NULL, deleted_by = NULL WHERE id = p_id;
    ELSIF p_entity_type = 'snippet' THEN
      UPDATE quick_replies SET deleted_at = NULL, deleted_by = NULL WHERE id = p_id;
    ELSE
      PERFORM set_config('vircle.audit_root', p_id::text, true);
      UPDATE ai_knowledge_documents
         SET deleted_at = NULL, deleted_by = NULL
       WHERE id = p_id OR (translation_of = p_id AND deleted_at = v_deleted);
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'name_conflict' USING ERRCODE = '23505';
  END;
  PERFORM set_config('vircle.soft_delete', 'off', true);
  PERFORM set_config('vircle.audit_root', '', true);

  RETURN jsonb_build_object('restored', true);
END;
$$;

REVOKE ALL ON FUNCTION public.audit_removed_items(integer)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_removed_item(text, uuid)   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_removed_items(integer)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_removed_item(text, uuid) TO authenticated;

-- ------------------------------------------------------------
-- 5. Audit triggers
-- ------------------------------------------------------------

-- Generic row trigger. Arguments:
--   0 entity type
--   1 label column, or '=Literal text'
--   2 comma list: columns whose from/to values are recorded
--   3 comma list: columns whose NAME only is recorded (secrets, long text)
--   4 'soft' when the table has deleted_at (delete / restore transitions)
--   5 optional column holding the user to credit when there is no
--     auth.uid() (OAuth callbacks run with the service role and only know
--     connected_by_user_id); used on INSERT or when that column changed.
CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o        JSONB;
  n        JSONB;
  base     JSONB;
  v_lbl    TEXT := TG_ARGV[1];
  v_soft   BOOLEAN := COALESCE(TG_ARGV[4], '') = 'soft';
  v_actcol TEXT := COALESCE(TG_ARGV[5], '');
  v_action TEXT;
  v_summary JSONB;
  v_actor  UUID;
  v_extra  TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    o := to_jsonb(OLD);
    base := o;
  ELSIF TG_OP = 'INSERT' THEN
    n := to_jsonb(NEW);
    base := n;
  ELSE
    o := to_jsonb(OLD);
    n := to_jsonb(NEW);
    base := n;
  END IF;

  IF left(v_lbl, 1) = '=' THEN
    v_lbl := substr(v_lbl, 2);
  ELSE
    v_lbl := base ->> v_lbl;
    -- a webhook URL may carry a secret in its query string
    IF TG_ARGV[1] = 'url' THEN v_lbl := split_part(v_lbl, '?', 1); END IF;
  END IF;

  IF v_actcol <> '' AND auth.uid() IS NULL
     AND (TG_OP = 'INSERT' OR n -> v_actcol IS DISTINCT FROM o -> v_actcol) THEN
    v_actor := NULLIF(n ->> v_actcol, '')::uuid;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'created';
    v_summary := audit_diff('{}'::jsonb, n, audit_cols(TG_ARGV[2]), ARRAY[]::text[]);
    -- for a creation `changes` would be {col: {from: null, to: x}}: keep just the values
    IF v_summary ? 'changes' THEN
      v_summary := NULLIF(jsonb_build_object('values', COALESCE(
        (SELECT jsonb_object_agg(k, v -> 'to')
           FROM jsonb_each(v_summary -> 'changes') AS e(k, v)
          WHERE v -> 'to' <> 'null'::jsonb), '{}'::jsonb)), '{"values": {}}'::jsonb);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
  ELSIF v_soft AND o ->> 'deleted_at' IS NULL AND n ->> 'deleted_at' IS NOT NULL THEN
    v_action := 'deleted';
    v_extra := NULLIF(current_setting('vircle.audit_extra', true), '');
    IF v_extra IS NOT NULL THEN v_summary := v_extra::jsonb; END IF;
  ELSIF v_soft AND o ->> 'deleted_at' IS NOT NULL AND n ->> 'deleted_at' IS NULL THEN
    v_action := 'restored';
  ELSE
    v_action := 'updated';
    v_summary := audit_diff(o, n, audit_cols(TG_ARGV[2]), audit_cols(TG_ARGV[3]));
    IF v_summary IS NULL THEN RETURN NULL; END IF;
  END IF;

  PERFORM log_audit(
    (base ->> 'account_id')::uuid, v_action, TG_ARGV[0],
    NULLIF(base ->> 'id', '')::uuid, v_lbl, v_summary, v_actor);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'audit_row_change failed on %: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_row_change() FROM PUBLIC, anon, authenticated;

-- tags (contact tags AND conversation labels share the table)
DROP TRIGGER IF EXISTS audit_row_change ON public.tags;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.tags
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'tag', 'name', 'name,color,description,for_contacts,for_conversations', '', 'soft', '');

-- snippets
DROP TRIGGER IF EXISTS audit_row_change ON public.quick_replies;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.quick_replies
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'snippet', 'title', 'title,kind', 'content_text,interactive_payload', 'soft', '');

-- teams (hard delete, logged)
DROP TRIGGER IF EXISTS audit_row_change ON public.teams;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'team', 'name', 'name,description,color', '', '', '');

-- Sensitive settings: column NAMES only, never a value. Columns that the
-- app refreshes on its own (access tokens, sync cursors, health checks,
-- last_used_at) are left out so routine token refreshes do not flood the log.
DROP TRIGGER IF EXISTS audit_row_change ON public.whatsapp_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=WhatsApp', '',
    'phone_number_id,waba_id,access_token,verify_token,status,mirror_inbound_media', '', 'user_id');

DROP TRIGGER IF EXISTS audit_row_change ON public.messenger_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.messenger_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=Messenger', '',
    'page_id,page_name,page_access_token,long_lived_user_token,verify_token,status,comments_enabled_at',
    '', 'connected_by_user_id');

DROP TRIGGER IF EXISTS audit_row_change ON public.instagram_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.instagram_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=Instagram', '',
    'page_id,ig_business_account_id,ig_username,page_access_token,long_lived_user_token,verify_token,status,comments_enabled_at',
    '', 'connected_by_user_id');

DROP TRIGGER IF EXISTS audit_row_change ON public.email_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.email_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=Email', '',
    'mailbox_user_id,mailbox_address,refresh_token,status', '', 'connected_by_user_id');

DROP TRIGGER IF EXISTS audit_row_change ON public.gmail_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.gmail_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=Gmail', '',
    'email_address,refresh_token,pubsub_verify_token,status', '', 'connected_by_user_id');

DROP TRIGGER IF EXISTS audit_row_change ON public.tiktok_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.tiktok_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=TikTok', '',
    'open_id,display_name,username,scopes,status', '', 'connected_by_user_id');

DROP TRIGGER IF EXISTS audit_row_change ON public.web_widget_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.web_widget_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=Web chat widget', '',
    'widget_token,name,welcome_message,primary_color,avatar_url,position,allowed_origins,enabled',
    '', 'user_id');

DROP TRIGGER IF EXISTS audit_row_change ON public.ai_configs;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.ai_configs
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'ai_settings', '=AI settings', '',
    'provider,model,api_key,system_prompt,is_active,auto_reply_enabled,auto_reply_max_per_conversation,embeddings_api_key,handoff_agent_id,base_url,embeddings_base_url,embeddings_model,monthly_token_budget',
    '', 'created_by');

DROP TRIGGER IF EXISTS audit_row_change ON public.ai_connections;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.ai_connections
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'ai_settings', 'name', '',
    'name,provider,base_url,model,api_key', '', 'created_by');

DROP TRIGGER IF EXISTS audit_row_change ON public.ai_task_routing;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.ai_task_routing
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'ai_settings', 'task', '', 'connection_id,model_override,enabled', '', '');

DROP TRIGGER IF EXISTS audit_row_change ON public.api_keys;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'api_key', 'name', '', 'name,scopes,expires_at,revoked_at', '', 'created_by');

DROP TRIGGER IF EXISTS audit_row_change ON public.webhook_endpoints;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'webhook', 'url', '', 'url,secret,events,is_active', '', 'created_by');

-- Knowledge articles ----------------------------------------------------
-- created; updated (title / content / status / collection changed, once
-- per 60 s per person so autosave does not flood the log); published
-- (status became published: an 'updated' row with summary.published); deleted / restored (soft delete). A translation
-- is logged against its base article with the language in the summary.
CREATE OR REPLACE FUNCTION public.audit_article_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entity  UUID := COALESCE(NEW.translation_of, NEW.id);
  v_summary JSONB := CASE WHEN NEW.translation_of IS NOT NULL
                          THEN jsonb_build_object('language', NEW.language) END;
  v_changed JSONB := '[]'::jsonb;
  v_changes JSONB := '{}'::jsonb;
  v_root    TEXT := COALESCE(current_setting('vircle.audit_root', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM log_audit(NEW.account_id, 'created', 'article', v_entity, NEW.title,
      COALESCE(v_summary, '{}'::jsonb) || jsonb_build_object('status', NEW.status));
    RETURN NULL;
  END IF;

  -- Soft delete / restore. A translation that went with its base article
  -- (the function set vircle.audit_root) is not logged on its own.
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    IF NEW.translation_of IS NULL OR v_root <> NEW.translation_of::text THEN
      PERFORM log_audit(NEW.account_id, 'deleted', 'article', v_entity, NEW.title, v_summary);
    END IF;
    RETURN NULL;
  ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    IF NEW.translation_of IS NULL OR v_root <> NEW.translation_of::text THEN
      PERFORM log_audit(NEW.account_id, 'restored', 'article', v_entity, NEW.title, v_summary);
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.deleted_at IS NOT NULL THEN RETURN NULL; END IF;

  IF NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
    -- 'published' is not one of the log's actions: it is an update whose
    -- summary says so (and is never debounced).
    PERFORM log_audit(NEW.account_id, 'updated', 'article', v_entity, NEW.title,
      COALESCE(v_summary, '{}'::jsonb) || jsonb_build_object('published', true));
    RETURN NULL;
  END IF;

  IF NEW.title IS DISTINCT FROM OLD.title THEN
    v_changes := v_changes || jsonb_build_object('title',
      jsonb_build_object('from', OLD.title, 'to', NEW.title));
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_changes := v_changes || jsonb_build_object('status',
      jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.content_html IS DISTINCT FROM OLD.content_html THEN
    v_changed := v_changed || to_jsonb('content'::text);
  END IF;
  IF NEW.collection_id IS DISTINCT FROM OLD.collection_id THEN
    v_changed := v_changed || to_jsonb('collection'::text);
  END IF;

  IF v_changes = '{}'::jsonb AND jsonb_array_length(v_changed) = 0 THEN
    RETURN NULL;
  END IF;

  v_summary := COALESCE(v_summary, '{}'::jsonb);
  IF v_changes <> '{}'::jsonb THEN
    v_summary := v_summary || jsonb_build_object('changes', v_changes);
  END IF;
  IF jsonb_array_length(v_changed) > 0 THEN
    v_summary := v_summary || jsonb_build_object('changed', v_changed);
  END IF;

  PERFORM log_audit(NEW.account_id, 'updated', 'article', v_entity, NEW.title, v_summary, NULL, 60);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'audit_article_change failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_article_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_article_change ON public.ai_knowledge_documents;
CREATE TRIGGER audit_article_change
  AFTER INSERT OR UPDATE ON public.ai_knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.audit_article_change();

-- Applied labels / contact tags ------------------------------------------
-- Hard-deleted rows, so the removal is logged here. Only DIRECT changes
-- are logged (pg_trigger_depth() = 1): cascades and the tag soft delete
-- (whose count sits in the tag's own "deleted" row) are not repeated per row.
CREATE OR REPLACE FUNCTION public.audit_link_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind   TEXT := TG_ARGV[0];      -- 'conversation' | 'contact'
  r        RECORD;
  v_acct   UUID;
  v_parent UUID;
  v_tag    TEXT;
  v_name   TEXT;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;

  -- entity_label = the contact's name (for a conversation: its contact)
  IF v_kind = 'conversation' THEN
    v_parent := r.conversation_id;
    SELECT c.account_id, ct.name INTO v_acct, v_name
      FROM conversations c LEFT JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.id = v_parent;
  ELSE
    v_parent := r.contact_id;
    SELECT account_id, name INTO v_acct, v_name FROM contacts WHERE id = v_parent;
  END IF;
  IF v_acct IS NULL THEN RETURN NULL; END IF;

  SELECT name INTO v_tag FROM tags WHERE id = r.tag_id;

  PERFORM log_audit(
    v_acct,
    CASE TG_OP WHEN 'DELETE' THEN 'removed' ELSE 'applied' END,
    v_kind, v_parent,
    v_name,
    jsonb_build_object(CASE v_kind WHEN 'conversation' THEN 'label' ELSE 'tag' END, v_tag,
                       'tag_id', r.tag_id));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'audit_link_change failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_link_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_link_change ON public.conversation_labels;
CREATE TRIGGER audit_link_change
  AFTER INSERT OR DELETE ON public.conversation_labels
  FOR EACH ROW EXECUTE FUNCTION public.audit_link_change('conversation');

DROP TRIGGER IF EXISTS audit_link_change ON public.contact_tags;
CREATE TRIGGER audit_link_change
  AFTER INSERT OR DELETE ON public.contact_tags
  FOR EACH ROW EXECUTE FUNCTION public.audit_link_change('contact');

-- Team members (hard delete, logged) ----------------------------------------
CREATE OR REPLACE FUNCTION public.audit_team_member_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r        RECORD;
  v_team   RECORD;
  v_person TEXT;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;

  SELECT id, account_id, name INTO v_team FROM teams WHERE id = r.team_id;
  IF v_team.id IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(NULLIF(btrim(full_name), ''), email) INTO v_person
    FROM profiles WHERE user_id = r.user_id;

  PERFORM log_audit(
    v_team.account_id,
    CASE TG_OP WHEN 'DELETE' THEN 'team_member_removed' ELSE 'team_member_added' END,
    'team', v_team.id, v_team.name,
    jsonb_build_object('member', v_person, 'user_id', r.user_id));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'audit_team_member_change failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_team_member_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_team_member_change ON public.team_members;
CREATE TRIGGER audit_team_member_change
  AFTER INSERT OR DELETE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.audit_team_member_change();

-- Members: role changes and removal --------------------------------------------
-- A profile whose account_id changes while people remain in the old account
-- was removed from it (by an admin) or left it. A user leaving their own
-- empty personal account to join another (accepting an invitation) is not
-- a removal and is not logged.
CREATE OR REPLACE FUNCTION public.audit_profile_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_person TEXT := COALESCE(NULLIF(btrim(OLD.full_name), ''), OLD.email);
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    IF OLD.account_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.account_id = OLD.account_id AND p.user_id <> OLD.user_id
    ) THEN
      PERFORM log_audit(OLD.account_id, 'member_removed', 'member', OLD.user_id, v_person,
        jsonb_build_object('role', OLD.account_role,
                           'self', auth.uid() IS NOT DISTINCT FROM OLD.user_id));
    END IF;
  ELSIF NEW.account_role IS DISTINCT FROM OLD.account_role THEN
    PERFORM log_audit(NEW.account_id, 'role_changed', 'member', NEW.user_id, v_person,
      jsonb_build_object('from', OLD.account_role, 'to', NEW.account_role));
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'audit_profile_change failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_profile_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_profile_change ON public.profiles;
CREATE TRIGGER audit_profile_change
  AFTER UPDATE OF account_id, account_role ON public.profiles
  FOR EACH ROW
  WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id
     OR OLD.account_role IS DISTINCT FROM NEW.account_role)
  EXECUTE FUNCTION public.audit_profile_change();

-- Invitations (the token hash is never logged) ---------------------------------
CREATE OR REPLACE FUNCTION public.audit_invitation_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM log_audit(NEW.account_id, 'invited', 'invitation', NEW.id,
    NULLIF(btrim(COALESCE(NEW.label, '')), ''),
    jsonb_build_object('role', NEW.role));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'audit_invitation_change failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_invitation_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_invitation_change ON public.account_invitations;
CREATE TRIGGER audit_invitation_change
  AFTER INSERT ON public.account_invitations
  FOR EACH ROW EXECUTE FUNCTION public.audit_invitation_change();

-- Capability changes (role_capability_log already records each one) ---------------
CREATE OR REPLACE FUNCTION public.audit_capability_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM log_audit(NEW.account_id, 'capability_changed', 'role', NULL, NEW.role::text,
    jsonb_build_object('capability', NEW.capability,
                       'from', NEW.old_granted, 'to', NEW.new_granted),
    NEW.actor);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'audit_capability_change failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_capability_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_capability_change ON public.role_capability_log;
CREATE TRIGGER audit_capability_change
  AFTER INSERT ON public.role_capability_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_capability_change();

NOTIFY pgrst, 'reload schema';
