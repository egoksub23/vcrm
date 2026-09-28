-- ============================================================
-- Sembang Tasks v2 — status widened to a real 3-value workflow,
-- multiple assignees, subtasks, an activity log, and a comment thread.
-- Everything here reuses the existing "any channel member can act on
-- fields, creator/moderator/manager only for delete" gate sembang_tasks
-- already has (099/111) — no new capability key.
--
-- Bug fix included in this migration: sembang_tasks_guard() (099,
-- redefined by 103) only clears completed_at/completed_by on a
-- status = 'open' transition — with a third status value
-- ('in_progress') added here, a done -> in_progress move matched
-- neither branch and left a stale completion stamp on a task that's no
-- longer done. Fixed below to key off "leaving done", not "entering
-- open".
-- ============================================================

-- ------------------------------------------------------------
-- 1. sembang_tasks: status widen (lookup-by-definition, not a guessed
-- constraint name — same convention as 081/066) + description column
-- + the guard-function fix.
-- ------------------------------------------------------------
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.sembang_tasks'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.sembang_tasks DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.sembang_tasks ADD CONSTRAINT sembang_tasks_status_check
  CHECK (status IN ('open', 'in_progress', 'done'));

ALTER TABLE public.sembang_tasks ADD COLUMN IF NOT EXISTS description TEXT;

CREATE OR REPLACE FUNCTION public.sembang_tasks_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sembang_task_immutable_column_changed';
  END IF;
  IF NEW.ticket_id IS DISTINCT FROM OLD.ticket_id THEN
    IF OLD.ticket_id IS NOT NULL THEN
      RAISE EXCEPTION 'sembang_task_ticket_id_immutable_once_set';
    END IF;
    IF NEW.ticket_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.tickets t WHERE t.id = NEW.ticket_id AND t.account_id = NEW.account_id
    ) THEN
      RAISE EXCEPTION 'sembang_task_ticket_id_cross_account_or_missing';
    END IF;
  END IF;
  -- completed_at/completed_by follow status. Fixed to key off "leaving
  -- done" rather than "entering open" so a done -> in_progress move also
  -- clears the stamp (see migration header).
  IF NEW.status = 'done' AND OLD.status <> 'done' THEN
    NEW.completed_at := now();
    NEW.completed_by := auth.uid();
  ELSIF NEW.status <> 'done' AND OLD.status = 'done' THEN
    NEW.completed_at := NULL;
    NEW.completed_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sembang_tasks_guard() OWNER TO postgres;

-- ------------------------------------------------------------
-- 2. sembang_task_assignees — replaces sembang_tasks.assignee_id with a
-- real many-to-many table. Insert/delete use the same "any channel
-- member" gate sembang_tasks_update already has (not self-only like
-- sembang_task_watchers-style tables — today any channel member can
-- (re)assign any other member, and that stays true here).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sembang_task_assignees (
  task_id    UUID NOT NULL REFERENCES public.sembang_tasks(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  added_by   UUID NOT NULL REFERENCES auth.users(id),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sembang_task_assignees_user ON public.sembang_task_assignees(user_id);

-- Backfill before dropping the column — same transaction.
INSERT INTO public.sembang_task_assignees (task_id, user_id, account_id, added_by, added_at)
SELECT id, assignee_id, account_id, created_by, created_at
FROM public.sembang_tasks
WHERE assignee_id IS NOT NULL
ON CONFLICT (task_id, user_id) DO NOTHING;

ALTER TABLE public.sembang_tasks DROP COLUMN IF EXISTS assignee_id;

ALTER TABLE public.sembang_task_assignees ENABLE ROW LEVEL SECURITY;

CREATE POLICY sembang_task_assignees_select ON public.sembang_task_assignees FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.sembang_tasks t
    JOIN public.sembang_channels c ON c.id = t.channel_id
    WHERE t.id = task_id
      AND public.has_capability(t.account_id, 'menu.sembang')
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_sembang_manager(c.account_id))
  )
);
CREATE POLICY sembang_task_assignees_insert ON public.sembang_task_assignees FOR INSERT WITH CHECK (
  added_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.sembang_tasks t WHERE t.id = task_id AND t.account_id = account_id
      AND public.has_capability(t.account_id, 'menu.sembang')
      AND public.is_sembang_channel_member(t.channel_id)
  )
);
CREATE POLICY sembang_task_assignees_delete ON public.sembang_task_assignees FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.sembang_tasks t WHERE t.id = task_id
      AND public.has_capability(t.account_id, 'menu.sembang')
      AND public.is_sembang_channel_member(t.channel_id)
  )
);

-- Move the assignment notification off sembang_tasks (it watched
-- assignee_id) onto sembang_task_assignees (AFTER INSERT) — preserves
-- the "AND NOT m.muted" channel-membership check migration 101 added.
DROP TRIGGER IF EXISTS trg_sembang_task_assigned ON public.sembang_tasks;

CREATE OR REPLACE FUNCTION public.notify_sembang_task_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_task         public.sembang_tasks%ROWTYPE;
  v_channel_name TEXT;
  v_actor_name   TEXT;
BEGIN
  SELECT * INTO v_task FROM public.sembang_tasks WHERE id = NEW.task_id;
  IF NOT FOUND OR NEW.user_id = v_task.created_by THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.sembang_channel_members m
    WHERE m.channel_id = v_task.channel_id AND m.user_id = NEW.user_id AND NOT m.muted
  ) THEN
    RETURN NEW;
  END IF;

  SELECT name INTO v_channel_name FROM public.sembang_channels WHERE id = v_task.channel_id;
  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM public.profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO public.notifications (
    account_id, user_id, type, title, body, actor_user_id,
    sembang_channel_id, sembang_task_id
  ) VALUES (
    v_task.account_id, NEW.user_id, 'sembang_task_assigned',
    'You were assigned a task in #' || COALESCE(v_channel_name, 'a channel'),
    COALESCE(v_actor_name, 'Someone') || ' assigned you: ' || left(v_task.title, 140),
    COALESCE(auth.uid(), v_task.created_by), v_task.channel_id, v_task.id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create Sembang task-assignment notification for task %: %', NEW.task_id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.notify_sembang_task_assigned() OWNER TO postgres;

CREATE TRIGGER trg_sembang_task_assigned
  AFTER INSERT ON public.sembang_task_assignees
  FOR EACH ROW EXECUTE FUNCTION public.notify_sembang_task_assigned();

-- ------------------------------------------------------------
-- 3. sembang_subtasks — independent, single-assignee-per-subtask
-- checklist items. No auto-rollup onto the parent task's status.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sembang_subtasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      UUID NOT NULL REFERENCES public.sembang_tasks(id) ON DELETE CASCADE,
  account_id   UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  assignee_id  UUID REFERENCES auth.users(id),
  created_by   UUID NOT NULL REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES auth.users(id)
);
CREATE INDEX IF NOT EXISTS idx_sembang_subtasks_task ON public.sembang_subtasks(task_id);

CREATE OR REPLACE FUNCTION public.sembang_subtasks_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sembang_subtask_immutable_column_changed';
  END IF;
  IF NEW.status = 'done' AND OLD.status <> 'done' THEN
    NEW.completed_at := now();
    NEW.completed_by := auth.uid();
  ELSIF NEW.status = 'open' AND OLD.status = 'done' THEN
    NEW.completed_at := NULL;
    NEW.completed_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sembang_subtasks_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_sembang_subtasks_guard ON public.sembang_subtasks;
CREATE TRIGGER trg_sembang_subtasks_guard
  BEFORE UPDATE ON public.sembang_subtasks
  FOR EACH ROW EXECUTE FUNCTION public.sembang_subtasks_guard();

ALTER TABLE public.sembang_subtasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY sembang_subtasks_select ON public.sembang_subtasks FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.sembang_tasks t
    JOIN public.sembang_channels c ON c.id = t.channel_id
    WHERE t.id = task_id
      AND public.has_capability(t.account_id, 'menu.sembang')
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_sembang_manager(c.account_id))
  )
);
CREATE POLICY sembang_subtasks_insert ON public.sembang_subtasks FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.sembang_tasks t WHERE t.id = task_id AND t.account_id = account_id
      AND public.has_capability(t.account_id, 'menu.sembang')
      AND public.is_sembang_channel_member(t.channel_id)
  )
);
CREATE POLICY sembang_subtasks_update ON public.sembang_subtasks FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM public.sembang_tasks t WHERE t.id = task_id
      AND public.has_capability(t.account_id, 'menu.sembang')
      AND public.is_sembang_channel_member(t.channel_id)
  )
);
CREATE POLICY sembang_subtasks_delete ON public.sembang_subtasks FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM public.sembang_tasks t WHERE t.id = task_id
      AND public.has_capability(t.account_id, 'menu.sembang')
      AND (
        created_by = auth.uid()
        OR public.is_sembang_channel_moderator(t.channel_id)
        OR public.is_sembang_manager(t.account_id)
      )
  )
);

-- ------------------------------------------------------------
-- 4. sembang_task_activity — append-only audit trail, same shape as
-- ticket_activity (064): SECURITY DEFINER triggers only, no client
-- INSERT policy, each wrapped so a logging failure never blocks the
-- real write.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sembang_task_activity (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    UUID NOT NULL REFERENCES public.sembang_tasks(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  actor_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'status_changed', 'description_changed', 'due_changed', 'title_changed',
    'assignee_added', 'assignee_removed',
    'subtask_added', 'subtask_completed', 'subtask_reopened', 'subtask_deleted',
    'ticket_linked'
  )),
  from_value TEXT,
  to_value   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sembang_task_activity_task_created ON public.sembang_task_activity(task_id, created_at);

ALTER TABLE public.sembang_task_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY sembang_task_activity_select ON public.sembang_task_activity FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.sembang_tasks t
    JOIN public.sembang_channels c ON c.id = t.channel_id
    WHERE t.id = task_id
      AND public.has_capability(t.account_id, 'menu.sembang')
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_sembang_manager(c.account_id))
  )
);

CREATE OR REPLACE FUNCTION public.log_sembang_task_created()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.sembang_task_activity (task_id, account_id, actor_id, event_type, to_value)
  VALUES (NEW.id, NEW.account_id, COALESCE(auth.uid(), NEW.created_by), 'created', NEW.status);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log Sembang task creation for task %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.log_sembang_task_created() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_sembang_task_created_activity ON public.sembang_tasks;
CREATE TRIGGER on_sembang_task_created_activity
  AFTER INSERT ON public.sembang_tasks
  FOR EACH ROW EXECUTE FUNCTION public.log_sembang_task_created();

CREATE OR REPLACE FUNCTION public.log_sembang_task_activity()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.sembang_task_activity (task_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'status_changed', OLD.status, NEW.status);
  END IF;
  IF NEW.description IS DISTINCT FROM OLD.description THEN
    INSERT INTO public.sembang_task_activity (task_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'description_changed', OLD.description, NEW.description);
  END IF;
  IF NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    INSERT INTO public.sembang_task_activity (task_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'due_changed', OLD.due_at::text, NEW.due_at::text);
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    INSERT INTO public.sembang_task_activity (task_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'title_changed', OLD.title, NEW.title);
  END IF;
  IF NEW.ticket_id IS DISTINCT FROM OLD.ticket_id THEN
    INSERT INTO public.sembang_task_activity (task_id, account_id, actor_id, event_type, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'ticket_linked', NEW.ticket_id::text);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log Sembang task activity for task %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.log_sembang_task_activity() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_sembang_task_activity ON public.sembang_tasks;
CREATE TRIGGER on_sembang_task_activity
  AFTER UPDATE ON public.sembang_tasks
  FOR EACH ROW EXECUTE FUNCTION public.log_sembang_task_activity();

CREATE OR REPLACE FUNCTION public.log_sembang_task_assignee_activity()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.sembang_task_activity (task_id, account_id, actor_id, event_type, to_value)
    VALUES (NEW.task_id, NEW.account_id, COALESCE(auth.uid(), NEW.added_by), 'assignee_added', NEW.user_id::text);
    RETURN NEW;
  ELSE
    INSERT INTO public.sembang_task_activity (task_id, account_id, actor_id, event_type, from_value)
    VALUES (OLD.task_id, OLD.account_id, auth.uid(), 'assignee_removed', OLD.user_id::text);
    RETURN OLD;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log Sembang task assignee activity for task %: %', COALESCE(NEW.task_id, OLD.task_id), SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;
ALTER FUNCTION public.log_sembang_task_assignee_activity() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_sembang_task_assignee_activity ON public.sembang_task_assignees;
CREATE TRIGGER on_sembang_task_assignee_activity
  AFTER INSERT OR DELETE ON public.sembang_task_assignees
  FOR EACH ROW EXECUTE FUNCTION public.log_sembang_task_assignee_activity();

CREATE OR REPLACE FUNCTION public.log_sembang_subtask_activity()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.sembang_task_activity (task_id, account_id, actor_id, event_type, to_value)
    VALUES (NEW.task_id, NEW.account_id, COALESCE(auth.uid(), NEW.created_by), 'subtask_added', NEW.title);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO public.sembang_task_activity (task_id, account_id, actor_id, event_type, to_value)
      VALUES (NEW.task_id, NEW.account_id, auth.uid(),
        CASE WHEN NEW.status = 'done' THEN 'subtask_completed' ELSE 'subtask_reopened' END, NEW.title);
    END IF;
    RETURN NEW;
  ELSE
    INSERT INTO public.sembang_task_activity (task_id, account_id, actor_id, event_type, from_value)
    VALUES (OLD.task_id, OLD.account_id, auth.uid(), 'subtask_deleted', OLD.title);
    RETURN OLD;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log Sembang subtask activity for task %: %', COALESCE(NEW.task_id, OLD.task_id), SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;
ALTER FUNCTION public.log_sembang_subtask_activity() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_sembang_subtask_activity ON public.sembang_subtasks;
CREATE TRIGGER on_sembang_subtask_activity
  AFTER INSERT OR UPDATE OR DELETE ON public.sembang_subtasks
  FOR EACH ROW EXECUTE FUNCTION public.log_sembang_subtask_activity();

-- ------------------------------------------------------------
-- 5. sembang_task_comments — mirrors incident_comments (116) exactly:
-- mentions JSONB + edited_at trigger included for schema parity, left
-- inert in this pass (no @mention picker, no comment-edit UI yet — see
-- plan). Insert-only RLS, matching incident_comments' own scope.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sembang_task_comments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    UUID NOT NULL REFERENCES public.sembang_tasks(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  author_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  mentions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sembang_task_comments_task_created ON public.sembang_task_comments(task_id, created_at);

ALTER TABLE public.sembang_task_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY sembang_task_comments_select ON public.sembang_task_comments FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.sembang_tasks t
    JOIN public.sembang_channels c ON c.id = t.channel_id
    WHERE t.id = task_id
      AND public.has_capability(t.account_id, 'menu.sembang')
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_sembang_manager(c.account_id))
  )
);
CREATE POLICY sembang_task_comments_insert ON public.sembang_task_comments FOR INSERT WITH CHECK (
  author_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.sembang_tasks t WHERE t.id = task_id AND t.account_id = account_id
      AND public.has_capability(t.account_id, 'menu.sembang')
      AND public.is_sembang_channel_member(t.channel_id)
  )
);

CREATE OR REPLACE FUNCTION public.set_sembang_task_comment_edited_at()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.edited_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_sembang_task_comment_edited ON public.sembang_task_comments;
CREATE TRIGGER on_sembang_task_comment_edited BEFORE UPDATE ON public.sembang_task_comments
  FOR EACH ROW EXECUTE FUNCTION public.set_sembang_task_comment_edited_at();

-- Notify every current assignee except the comment's own author.
-- Sembang has no per-task watcher table, so "assignees" stands in for
-- "people who should hear about new activity."
CREATE OR REPLACE FUNCTION public.notify_sembang_task_comment()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_task       public.sembang_tasks%ROWTYPE;
  v_actor_name TEXT;
  v_assignee   UUID;
BEGIN
  SELECT * INTO v_task FROM public.sembang_tasks WHERE id = NEW.task_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT full_name INTO v_actor_name FROM public.profiles WHERE user_id = COALESCE(NEW.author_id, auth.uid());

  FOR v_assignee IN
    SELECT user_id FROM public.sembang_task_assignees
    WHERE task_id = NEW.task_id AND user_id IS DISTINCT FROM NEW.author_id
  LOOP
    INSERT INTO public.notifications (
      account_id, user_id, type, title, body, actor_user_id,
      sembang_channel_id, sembang_task_id
    ) VALUES (
      v_task.account_id, v_assignee, 'sembang_task_comment',
      'New comment on a task',
      COALESCE(v_actor_name, 'Someone') || ' commented: ' || left(NEW.body, 140),
      COALESCE(NEW.author_id, auth.uid()), v_task.channel_id, v_task.id
    );
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create Sembang task-comment notification(s) for task %: %', NEW.task_id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.notify_sembang_task_comment() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_sembang_task_comment_notify ON public.sembang_task_comments;
CREATE TRIGGER trg_sembang_task_comment_notify
  AFTER INSERT ON public.sembang_task_comments
  FOR EACH ROW EXECUTE FUNCTION public.notify_sembang_task_comment();

-- ------------------------------------------------------------
-- 6. notifications.type widen — read-live-constraint-and-append, same
-- pattern used repeatedly for this table (099, 101, 084, 085, 087).
-- 'sembang_task_assigned' already exists from 099; only the new
-- comment-notification type needs adding.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sembang_check_values_121(p_def text)
RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = public
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
  v_def   TEXT;
  v_types TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';

  v_types := public.sembang_check_values_121(v_def);

  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY['sembang_task_comment']) AS x);

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

DROP FUNCTION IF EXISTS public.sembang_check_values_121(text);

-- ------------------------------------------------------------
-- 7. Realtime — assignees/subtasks/comments live-sync (matches every
-- other Sembang child table). Activity deliberately excluded: the
-- detail dialog self-fetches on open and refetches after its own
-- mutations, it isn't a long-lived page the way ticket detail is.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sembang_task_assignees'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sembang_task_assignees;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sembang_subtasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sembang_subtasks;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sembang_task_comments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sembang_task_comments;
  END IF;
END $$;
