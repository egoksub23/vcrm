-- ============================================================
-- 180: the Comments inbox grouped by post, with threads and a per-person "seen" marker.
--
-- Until now the Comments tab listed EVERY comment as its own row (migration 074), so one Instagram post with fifteen comments from the
-- same account flooded the list. The list is now one row per POST, and a post opens as a conversation of all its comments.
--
--   comment_post_reads    NEW. One row per (person, post): the moment that person last opened the post. A post is "unread" for that person
--                         while it holds a customer comment that arrived after that moment. Personal state, not workspace data: a person
--                         reads and writes only their own rows, inside their own workspace.
--   comment_posts_inbox() NEW. The left column: one row per post with its counts, its newest customer comment and the unread flag, filtered
--                         by the same four views the comment list has (To do / Handled / Spam / All), by provider and by search.
--   comment_post_mark_seen() NEW. Stamps "seen now" for the signed-in person on one post.
--
-- Both functions are SECURITY INVOKER on purpose. Row level security already decides who may read a comment (074: members of the workspace,
-- comments_select and comment_posts_select) and which "seen" rows a person may touch (below), so the functions add no privilege of their own
-- and need no allow-list entry in verify-guard-catalog.sql; another workspace's posts and comments are simply not visible to the caller. The
-- signed-in person is auth.uid(); it is never a parameter, so nobody can ask for another person's unread state.
--
-- What counts (customer comments only: direction = 'inbound'; a comment an agent deleted on the platform is ignored everywhere):
--   open_count     handled_status = 'open'
--   done_count     handled_status IN ('replied', 'resolved')
--   spam_count     handled_status = 'spam'
--   total_count    all of them
-- The four views are about posts:
--   open  (To do)    at least one open comment
--   done  (Handled)  no open comment and at least one replied / resolved comment
--   spam             at least one comment marked spam (so a post can be both To do and Spam)
--   all              every post that has a customer comment
-- Unread: the post has a customer comment that ARRIVED (created_at) after the person's seen_at. A person who has never opened the post sees it
-- as unread only while it still has an open comment (so switching this on does not light a dot on every old, handled post).
-- Ordering: the newest customer comment first (provider_created_at, the time shown to people), then the post id for a stable page boundary.
--
-- Comment handled/hidden/replied semantics, ingest, webhooks and the audit trail are untouched.
-- Export and deletion need no list: the table has account_id (153 discovers it, and it goes with the workspace).
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Index for the per-post aggregate (the customer comments of a workspace, by post)
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS comments_account_post_idx
  ON public.comments (account_id, post_id)
  WHERE direction = 'inbound' AND status <> 'deleted';

-- ------------------------------------------------------------
-- 2. comment_post_reads
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.comment_post_reads (
  account_id UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id    UUID        NOT NULL REFERENCES public.comment_posts(id) ON DELETE CASCADE,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS comment_post_reads_account_idx ON public.comment_post_reads (account_id);

COMMENT ON TABLE public.comment_post_reads IS 'When each person last opened a post in the Comments inbox (drives the unread dot). Personal state: a person reads and writes only their own rows.';

ALTER TABLE public.comment_post_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.comment_post_reads FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.comment_post_reads TO authenticated, service_role;

DROP POLICY IF EXISTS comment_post_reads_select ON public.comment_post_reads;
DROP POLICY IF EXISTS comment_post_reads_insert ON public.comment_post_reads;
DROP POLICY IF EXISTS comment_post_reads_update ON public.comment_post_reads;
DROP POLICY IF EXISTS comment_post_reads_delete ON public.comment_post_reads;

CREATE POLICY comment_post_reads_select ON public.comment_post_reads FOR SELECT
  USING (user_id = (SELECT auth.uid()) AND public.is_account_member(account_id));

-- the row must name the signed-in person, a workspace they belong to, and a post OF that workspace
CREATE POLICY comment_post_reads_insert ON public.comment_post_reads FOR INSERT
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND public.is_account_member(account_id)
    AND EXISTS (SELECT 1 FROM public.comment_posts p WHERE p.id = comment_post_reads.post_id AND p.account_id = comment_post_reads.account_id)
  );

CREATE POLICY comment_post_reads_update ON public.comment_post_reads FOR UPDATE
  USING (user_id = (SELECT auth.uid()) AND public.is_account_member(account_id))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND public.is_account_member(account_id)
    AND EXISTS (SELECT 1 FROM public.comment_posts p WHERE p.id = comment_post_reads.post_id AND p.account_id = comment_post_reads.account_id)
  );

CREATE POLICY comment_post_reads_delete ON public.comment_post_reads FOR DELETE
  USING (user_id = (SELECT auth.uid()) AND public.is_account_member(account_id));

-- ------------------------------------------------------------
-- 3. comment_posts_inbox(): one row per post
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.comment_posts_inbox(
  p_account  UUID,
  p_provider TEXT DEFAULT NULL,
  p_filter   TEXT DEFAULT 'open',
  p_search   TEXT DEFAULT NULL,
  p_limit    INTEGER DEFAULT 40,
  p_offset   INTEGER DEFAULT 0
)
RETURNS TABLE (
  post_id                  UUID,
  provider                 TEXT,
  source                   TEXT,
  external_post_id         TEXT,
  message                  TEXT,
  permalink_url            TEXT,
  media_url                TEXT,
  media_type               TEXT,
  posted_at                TIMESTAMPTZ,
  open_count               BIGINT,
  done_count               BIGINT,
  spam_count               BIGINT,
  total_count              BIGINT,
  last_comment_id          UUID,
  last_comment_text        TEXT,
  last_author_name         TEXT,
  last_author_username     TEXT,
  last_comment_at          TIMESTAMPTZ,
  last_provider_created_at TIMESTAMPTZ,
  has_test                 BOOLEAN,
  unread                   BOOLEAN,
  seen_at                  TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_limit  INTEGER := LEAST(GREATEST(COALESCE(p_limit, 40), 1), 100);
  v_offset INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_user   UUID := auth.uid();
  v_search TEXT := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_pat    TEXT;
BEGIN
  IF p_filter IS NULL OR p_filter NOT IN ('open', 'done', 'spam', 'all') THEN
    RAISE EXCEPTION 'Unknown view' USING ERRCODE = '22023';
  END IF;
  IF p_provider IS NOT NULL AND p_provider NOT IN ('facebook', 'instagram', 'tiktok') THEN
    RAISE EXCEPTION 'Unknown provider' USING ERRCODE = '22023';
  END IF;
  IF v_search IS NOT NULL THEN
    -- a search is words, not a pattern: % _ and \ match themselves
    v_pat := '%' || replace(replace(replace(left(v_search, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  RETURN QUERY
  WITH agg AS (
    SELECT c.post_id                                                              AS pid,
           count(*) FILTER (WHERE c.handled_status = 'open')                       AS open_n,
           count(*) FILTER (WHERE c.handled_status IN ('replied', 'resolved'))     AS done_n,
           count(*) FILTER (WHERE c.handled_status = 'spam')                       AS spam_n,
           count(*)                                                                AS total_n,
           max(c.created_at)                                                       AS arrived,
           max(c.provider_created_at)                                              AS latest,
           bool_or(c.is_test)                                                      AS any_test
      FROM public.comments c
     WHERE c.account_id = p_account
       AND c.direction = 'inbound'
       AND c.status <> 'deleted'
       AND (p_provider IS NULL OR c.provider = p_provider)
     GROUP BY c.post_id
  ),
  page AS (
    SELECT a.*, p.provider AS p_provider_col, p.source AS p_source, p.external_post_id AS p_external,
           p.message AS p_message, p.permalink_url AS p_permalink, p.media_url AS p_media_url,
           p.media_type AS p_media_type, p.posted_at AS p_posted_at
      FROM agg a
      JOIN public.comment_posts p ON p.id = a.pid AND p.account_id = p_account
     WHERE (p_filter = 'all'
            OR (p_filter = 'open' AND a.open_n > 0)
            OR (p_filter = 'done' AND a.open_n = 0 AND a.done_n > 0)
            OR (p_filter = 'spam' AND a.spam_n > 0))
       AND (v_pat IS NULL
            OR p.message ILIKE v_pat
            OR EXISTS (
                 SELECT 1 FROM public.comments s
                  WHERE s.post_id = a.pid AND s.account_id = p_account
                    AND s.direction = 'inbound' AND s.status <> 'deleted'
                    AND (s.text ILIKE v_pat OR s.author_name ILIKE v_pat OR s.author_username ILIKE v_pat)))
     ORDER BY a.latest DESC, a.pid DESC
     LIMIT v_limit OFFSET v_offset
  )
  SELECT pg.pid,
         pg.p_provider_col,
         pg.p_source,
         pg.p_external,
         pg.p_message,
         pg.p_permalink,
         pg.p_media_url,
         pg.p_media_type,
         pg.p_posted_at,
         pg.open_n,
         pg.done_n,
         pg.spam_n,
         pg.total_n,
         l.id,
         l.text,
         l.author_name,
         l.author_username,
         pg.arrived,
         pg.latest,
         pg.any_test,
         CASE WHEN r.seen_at IS NULL THEN pg.open_n > 0 ELSE pg.arrived > r.seen_at END,
         r.seen_at
    FROM page pg
    LEFT JOIN LATERAL (
      SELECT c.id, c.text, c.author_name, c.author_username
        FROM public.comments c
       WHERE c.post_id = pg.pid AND c.account_id = p_account
         AND c.direction = 'inbound' AND c.status <> 'deleted'
       ORDER BY c.provider_created_at DESC, c.id DESC
       LIMIT 1
    ) l ON true
    LEFT JOIN public.comment_post_reads r ON r.post_id = pg.pid AND r.user_id = v_user
   ORDER BY pg.latest DESC, pg.pid DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.comment_posts_inbox(UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.comment_posts_inbox(UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. comment_post_mark_seen(): "I have opened this post"
--    Returns the new seen_at, or NULL when the post is not one the caller may see (another workspace's, or one that does not exist).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.comment_post_mark_seen(p_post UUID)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_seen TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.comment_post_reads AS r (account_id, user_id, post_id, seen_at)
  SELECT p.account_id, auth.uid(), p.id, now()
    FROM public.comment_posts p
   WHERE p.id = p_post
  ON CONFLICT (user_id, post_id) DO UPDATE
     SET seen_at = GREATEST(r.seen_at, EXCLUDED.seen_at)
  RETURNING r.seen_at INTO v_seen;

  RETURN v_seen;
END;
$$;

REVOKE ALL ON FUNCTION public.comment_post_mark_seen(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.comment_post_mark_seen(UUID) TO authenticated, service_role;
