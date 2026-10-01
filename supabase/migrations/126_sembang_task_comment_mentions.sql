-- ============================================================
-- 126_sembang_task_comment_mentions
--
-- sembang_task_comments.mentions (migration 121) has carried the same
-- flat JSONB array shape as incident_comments.mentions since it
-- shipped, but nothing ever notified a mentioned person — the POST
-- route always stored `[]`, and no trigger existed. RichTextEditor now
-- has a real Tiptap mention node (@tiptap/extension-mention) wired into
-- the task-comment composer, scoped to the task's own channel members,
-- so this migration adds the DB half: a notify trigger mirroring
-- notify_incident_comment_mentions() (116), and widens
-- notifications.type for the new notification kind.
--
-- Idempotent — safe to run more than once.
-- ============================================================

CREATE OR REPLACE FUNCTION public.notify_sembang_task_comment_mentions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task         public.sembang_tasks%ROWTYPE;
  v_actor_name   TEXT;
  v_mentioned_id UUID;
BEGIN
  IF NEW.mentions IS NULL OR jsonb_array_length(NEW.mentions) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_task FROM public.sembang_tasks WHERE id = NEW.task_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT full_name INTO v_actor_name FROM public.profiles WHERE user_id = COALESCE(NEW.author_id, auth.uid());

  FOR v_mentioned_id IN
    SELECT DISTINCT (elem.value#>>'{}')::UUID
    FROM jsonb_array_elements(NEW.mentions) AS elem(value)
  LOOP
    IF v_mentioned_id IS NULL OR v_mentioned_id = NEW.author_id THEN
      CONTINUE;
    END IF;
    -- Defense-in-depth: the route already validates against real channel
    -- membership before insert, but a direct insert (or a channel
    -- membership change since) could still slip through here.
    IF NOT EXISTS (
      SELECT 1 FROM public.sembang_channel_members
       WHERE channel_id = v_task.channel_id AND user_id = v_mentioned_id
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.notifications (
      account_id, user_id, type, title, body, actor_user_id,
      sembang_channel_id, sembang_task_id
    ) VALUES (
      v_task.account_id, v_mentioned_id, 'sembang_task_mention',
      'You were mentioned',
      COALESCE(v_actor_name, 'Someone') || ' mentioned you on a task: ' || left(NEW.body, 140),
      COALESCE(NEW.author_id, auth.uid()), v_task.channel_id, v_task.id
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create Sembang task-mention notification(s) for comment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.notify_sembang_task_comment_mentions() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_sembang_task_comment_mentions_notify ON public.sembang_task_comments;
CREATE TRIGGER trg_sembang_task_comment_mentions_notify
  AFTER INSERT ON public.sembang_task_comments
  FOR EACH ROW EXECUTE FUNCTION public.notify_sembang_task_comment_mentions();

-- notifications.type widen — read-live-constraint-and-append, same
-- pattern used repeatedly for this table (099, 101, 084, 085, 087, 121).
CREATE OR REPLACE FUNCTION public.sembang_check_values_126(p_def text)
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

  v_types := public.sembang_check_values_126(v_def);

  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY['sembang_task_mention']) AS x);

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

NOTIFY pgrst, 'reload schema';
