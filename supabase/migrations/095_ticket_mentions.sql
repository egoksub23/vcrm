-- ============================================================
-- 095_ticket_mentions.sql — @mentions on tickets: people AND teams, and
-- "needs your response" tracking (0.51.0)
--
-- Owner request: "In ticket management I want to use the @ mention to get
-- members from teams to act on this ticket. When I log in, if I have a
-- mention which needs resolution or response, an indicator bubble should
-- exist."
--
-- What this migration does
--   1. ticket_mentions: one row per person asked for a response on a ticket
--      comment (kind 'response'; 'fyi' is allowed for later, the app writes
--      only 'response' today: an FYI mention is just a normal mention and
--      needs no tracking). via_team_id says the request came through an @team.
--      Members read their own rows and the rows of tickets they can read;
--      nobody writes from the browser: the API route (service role) creates
--      and resolves rows.
--   2. ticket_comments.mention_teams: the teams @mentioned in a comment (ids),
--      so the comment can show the team chip. Display only.
--   3. notifications.comment_id: the bell notification links to the comment.
--      notify_ticket_comment_mentions() now fills it (nothing else changes).
--   4. Automatic resolution, all in the database so every write path is
--      covered:
--        - the mentioned person comments on the ticket   -> done / replied
--        - the requester deletes the comment             -> cancelled
--        - the ticket becomes resolved or closed         -> done / ticket_closed
--        - Mark as done / Cancel request (API)           -> done / marked_done, cancelled
--      Each resolution also marks the matching bell notification read.
--   5. ticket_activity gets three event types (mention_requested,
--      mention_done, mention_cancelled) written by a trigger, so the history
--      shows every request and resolution like any other ticket change. A
--      request to a team is ONE history line, not one per member; a mass
--      resolution (comment deleted, ticket closed) is one line with a count.
--   6. ticket_mentions joins the realtime publication (the sidebar bubble and
--      the "Waiting on you" banner update live).
--
-- Not changed: SLA logic, Jira sync. Tickets are not in audit_log (their
-- history is ticket_activity), so neither are their mentions.
--
-- Depends on: 063 / 064 / 081 (tickets, comments, activity, watchers,
-- notifications), 043 (teams), 085 (ticket_activity.detail).
-- Idempotent: safe to run twice.
-- ============================================================

-- ------------------------------------------------------------
-- 1. ticket_mentions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ticket_mentions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  ticket_id         UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  -- The comment that asked. Set to NULL (not deleted) when that comment is deleted,
  -- so the cancelled request keeps its history.
  comment_id        UUID REFERENCES public.ticket_comments(id) ON DELETE SET NULL,
  mentioned_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  via_team_id       UUID REFERENCES public.teams(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL DEFAULT 'response' CHECK (kind IN ('response', 'fyi')),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  resolved_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_reason   TEXT CHECK (resolved_reason IN ('replied', 'marked_done', 'ticket_closed', 'cancelled')),
  -- When the requester last nudged this person (at most once an hour).
  nudged_at         TIMESTAMPTZ,
  CONSTRAINT ticket_mentions_resolved_shape CHECK (
    (status = 'open' AND resolved_at IS NULL AND resolved_reason IS NULL)
    OR (status <> 'open' AND resolved_at IS NOT NULL AND resolved_reason IS NOT NULL)
  ),
  CONSTRAINT ticket_mentions_not_self CHECK (requested_by IS DISTINCT FROM mentioned_user_id)
);

-- One request per person per comment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_mentions_comment_user
  ON public.ticket_mentions (comment_id, mentioned_user_id) WHERE comment_id IS NOT NULL;
-- The sidebar bubble and the "Mentioned me" filter.
CREATE INDEX IF NOT EXISTS idx_ticket_mentions_user_open
  ON public.ticket_mentions (mentioned_user_id, ticket_id) WHERE status = 'open';
-- The ticket's own banner and the resolution triggers.
CREATE INDEX IF NOT EXISTS idx_ticket_mentions_ticket
  ON public.ticket_mentions (ticket_id, status);
CREATE INDEX IF NOT EXISTS idx_ticket_mentions_comment
  ON public.ticket_mentions (comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ticket_mentions_requester_open
  ON public.ticket_mentions (requested_by, ticket_id) WHERE status = 'open';

ALTER TABLE public.ticket_mentions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_mentions_select ON public.ticket_mentions;
-- Own rows (asked of you, or asked by you), and every row on a ticket the
-- caller can read (tickets_select is "any member of the account").
CREATE POLICY ticket_mentions_select ON public.ticket_mentions
  FOR SELECT
  USING (
    is_account_member(account_id)
    AND (
      mentioned_user_id = (SELECT auth.uid())
      OR requested_by = (SELECT auth.uid())
      OR EXISTS (SELECT 1 FROM public.tickets t WHERE t.id = ticket_mentions.ticket_id)
    )
  );
-- No INSERT / UPDATE / DELETE policy on purpose: only the service role (the
-- ticket comment API) writes, and the triggers below (owner rights).
REVOKE ALL ON public.ticket_mentions FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ticket_mentions FROM authenticated;
GRANT SELECT ON public.ticket_mentions TO authenticated;
GRANT ALL ON public.ticket_mentions TO service_role;

-- ------------------------------------------------------------
-- 2. ticket_comments.mention_teams, notifications.comment_id
-- ------------------------------------------------------------
ALTER TABLE public.ticket_comments
  ADD COLUMN IF NOT EXISTS mention_teams JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS comment_id UUID REFERENCES public.ticket_comments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_notifications_comment
  ON public.notifications (comment_id) WHERE comment_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3. The mention notification links to the comment (063's function, one
--    column added; behaviour is otherwise identical)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_ticket_comment_mentions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_ticket_number INTEGER;
  v_ticket_subject TEXT;
  v_actor_name TEXT;
  v_mentioned_id UUID;
BEGIN
  IF NEW.mentions IS NULL OR jsonb_array_length(NEW.mentions) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT account_id, ticket_number, subject
    INTO v_account_id, v_ticket_number, v_ticket_subject
  FROM tickets WHERE id = NEW.ticket_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  FOR v_mentioned_id IN
    SELECT DISTINCT (elem.value#>>'{}')::UUID
    FROM jsonb_array_elements(NEW.mentions) AS elem(value)
  LOOP
    IF v_mentioned_id IS NULL OR v_mentioned_id = NEW.author_id THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE user_id = v_mentioned_id AND account_id = v_account_id
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO notifications (
      account_id, user_id, type, ticket_id, comment_id,
      actor_user_id, title, body
    ) VALUES (
      v_account_id,
      v_mentioned_id,
      'ticket_mention',
      NEW.ticket_id,
      NEW.id,
      auth.uid(),
      'You were mentioned',
      COALESCE(v_actor_name, 'Someone') || ' mentioned you in a comment on ticket #'
        || v_ticket_number || ' — ' || v_ticket_subject
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create mention notification(s) for ticket comment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.notify_ticket_comment_mentions() OWNER TO postgres;

-- ------------------------------------------------------------
-- 4. ticket_activity.event_type: mention_requested / mention_done / mention_cancelled
--    (rebuilt from the LIVE definition, so every value another migration
--    added is kept)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ticket_mentions_check_values_095(p_def text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(DISTINCT v), ARRAY[]::text[])
    FROM (
      SELECT unnest(
               CASE WHEN m[1] ~ '^\{.*\}$'
                    THEN string_to_array(replace(btrim(m[1], '{}'), '"', ''), ',')
                    ELSE ARRAY[m[1]] END) AS v
        FROM regexp_matches(COALESCE(p_def, ''), '''([^'']+)''::text', 'g') AS m
    ) s;
$$;

DO $$
DECLARE
  c       RECORD;
  v_types TEXT[] := ARRAY[]::text[];
BEGIN
  FOR c IN
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'public.ticket_activity'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%event_type%'
  LOOP
    v_types := v_types || public.ticket_mentions_check_values_095(c.def);
    EXECUTE format('ALTER TABLE public.ticket_activity DROP CONSTRAINT %I', c.conname);
  END LOOP;

  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY['mention_requested', 'mention_done', 'mention_cancelled']) AS x);

  EXECUTE format(
    'ALTER TABLE public.ticket_activity ADD CONSTRAINT ticket_activity_event_type_check CHECK (event_type = ANY (%L::text[]))',
    v_types);
END $$;

DROP FUNCTION IF EXISTS public.ticket_mentions_check_values_095(text);

-- ------------------------------------------------------------
-- 5. Resolution triggers
--    A resolved row is written with status, resolved_at, resolved_by and
--    resolved_reason together (the table CHECK insists on it).
--    `vircle.mention_silent` = 'on' tells the row logger (section 6) that the
--    caller writes ONE summary history line itself.
-- ------------------------------------------------------------

-- 5a. The mentioned person comments on the ticket: their open requests on it
--     are answered. Jira notes (no author) never count.
CREATE OR REPLACE FUNCTION public.ticket_mentions_on_comment_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.author_id IS NULL OR COALESCE(NEW.source, 'vircle') = 'jira' THEN
    RETURN NEW;
  END IF;

  UPDATE ticket_mentions
     SET status = 'done',
         resolved_at = now(),
         resolved_by = NEW.author_id,
         resolved_reason = 'replied'
   WHERE ticket_id = NEW.ticket_id
     AND mentioned_user_id = NEW.author_id
     AND status = 'open'
     AND created_at <= NEW.created_at;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to resolve mentions for comment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.ticket_mentions_on_comment_insert() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_comment_resolve_mentions ON public.ticket_comments;
CREATE TRIGGER on_ticket_comment_resolve_mentions
  AFTER INSERT ON public.ticket_comments
  FOR EACH ROW EXECUTE FUNCTION public.ticket_mentions_on_comment_insert();

-- 5b. The comment is deleted: the requests it made are cancelled (one summary
--     line in the history). Runs BEFORE the delete, while comment_id is still set.
CREATE OR REPLACE FUNCTION public.ticket_mentions_on_comment_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ticket_mentions WHERE comment_id = OLD.id AND status = 'open') THEN
    RETURN OLD;
  END IF;

  PERFORM set_config('vircle.mention_silent', 'on', true);
  WITH c AS (
    UPDATE ticket_mentions
       SET status = 'cancelled',
           resolved_at = now(),
           resolved_by = auth.uid(),
           resolved_reason = 'cancelled'
     WHERE comment_id = OLD.id AND status = 'open'
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM c;
  PERFORM set_config('vircle.mention_silent', '', true);

  -- The ticket may be going away too (cascade): then there is nothing to log on.
  IF v_n > 0 AND EXISTS (SELECT 1 FROM tickets WHERE id = OLD.ticket_id) THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, detail)
    VALUES (OLD.ticket_id, OLD.account_id, COALESCE(auth.uid(), OLD.author_id),
            'mention_cancelled', 'comment_deleted', v_n::text);
  END IF;

  RETURN OLD;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vircle.mention_silent', '', true);
  RAISE WARNING 'Failed to cancel mentions of comment %: %', OLD.id, SQLERRM;
  RETURN OLD;
END;
$$;

ALTER FUNCTION public.ticket_mentions_on_comment_delete() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_comment_cancel_mentions ON public.ticket_comments;
CREATE TRIGGER on_ticket_comment_cancel_mentions
  BEFORE DELETE ON public.ticket_comments
  FOR EACH ROW EXECUTE FUNCTION public.ticket_mentions_on_comment_delete();

-- 5c. The ticket becomes resolved or closed: everything still open on it is done.
CREATE OR REPLACE FUNCTION public.ticket_mentions_on_ticket_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  IF NEW.status NOT IN ('resolved', 'closed') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ticket_mentions WHERE ticket_id = NEW.id AND status = 'open') THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('vircle.mention_silent', 'on', true);
  WITH c AS (
    UPDATE ticket_mentions
       SET status = 'done',
           resolved_at = now(),
           resolved_by = auth.uid(),
           resolved_reason = 'ticket_closed'
     WHERE ticket_id = NEW.id AND status = 'open'
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM c;
  PERFORM set_config('vircle.mention_silent', '', true);

  IF v_n > 0 THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, detail)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'mention_done', 'ticket_closed', v_n::text);
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('vircle.mention_silent', '', true);
  RAISE WARNING 'Failed to close mentions of ticket %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.ticket_mentions_on_ticket_status() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_status_close_mentions ON public.tickets;
CREATE TRIGGER on_ticket_status_close_mentions
  AFTER UPDATE OF status ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.ticket_mentions_on_ticket_status();

-- ------------------------------------------------------------
-- 6. Row logger: history lines + clearing the bell notification
-- ------------------------------------------------------------
--   mention_requested  to_value = the person (NULL for a request to a team),
--                      from_value = the team id, detail = the comment id
--   mention_done       to_value = the person, from_value = replied | marked_done,
--                      detail = the comment id  (ticket_closed: see 5c)
--   mention_cancelled  to_value = the person, from_value = cancelled,
--                      detail = the comment id  (comment deleted: see 5b)
CREATE OR REPLACE FUNCTION public.ticket_mentions_after_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind <> 'response' THEN
      RETURN NULL;
    END IF;
    -- A request to a team is one line, not one per member.
    IF NEW.via_team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM ticket_activity a
       WHERE a.ticket_id = NEW.ticket_id
         AND a.event_type = 'mention_requested'
         AND a.from_value = NEW.via_team_id::text
         AND a.detail IS NOT DISTINCT FROM NEW.comment_id::text
    ) THEN
      RETURN NULL;
    END IF;
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value, detail)
    VALUES (NEW.ticket_id, NEW.account_id, COALESCE(NEW.requested_by, auth.uid()), 'mention_requested',
            NEW.via_team_id::text,
            CASE WHEN NEW.via_team_id IS NULL THEN NEW.mentioned_user_id::text END,
            NEW.comment_id::text);
    RETURN NULL;
  END IF;

  -- UPDATE: open -> done / cancelled
  IF OLD.status = 'open' AND NEW.status <> 'open' THEN
    -- The bell notification for that comment is answered too.
    IF NEW.comment_id IS NOT NULL THEN
      UPDATE notifications
         SET read_at = now()
       WHERE user_id = NEW.mentioned_user_id
         AND type = 'ticket_mention'
         AND ticket_id = NEW.ticket_id
         AND comment_id = NEW.comment_id
         AND read_at IS NULL;
    END IF;

    IF COALESCE(current_setting('vircle.mention_silent', true), '') <> 'on'
       AND NEW.kind = 'response'
       AND EXISTS (SELECT 1 FROM tickets WHERE id = NEW.ticket_id) THEN
      INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value, detail)
      VALUES (NEW.ticket_id, NEW.account_id, COALESCE(auth.uid(), NEW.resolved_by),
              CASE WHEN NEW.status = 'done' THEN 'mention_done' ELSE 'mention_cancelled' END,
              NEW.resolved_reason, NEW.mentioned_user_id::text, NEW.comment_id::text);
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log ticket mention %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$$;

ALTER FUNCTION public.ticket_mentions_after_change() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_ticket_mention_change ON public.ticket_mentions;
CREATE TRIGGER on_ticket_mention_change
  AFTER INSERT OR UPDATE ON public.ticket_mentions
  FOR EACH ROW EXECUTE FUNCTION public.ticket_mentions_after_change();

-- Trigger functions are never called directly.
REVOKE ALL ON FUNCTION public.ticket_mentions_on_comment_insert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ticket_mentions_on_comment_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ticket_mentions_on_ticket_status()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ticket_mentions_after_change()      FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 7. Realtime: the sidebar bubble and the banner update live
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'ticket_mentions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ticket_mentions;
  END IF;
END $$;
