-- ============================================================
-- 099_sembang_p1.sql
--
-- Sembang P1: threaded replies, emoji reactions, pinned messages,
-- edit/delete your own message, and a per-channel task list.
-- Builds directly on 098 (Sembang P0) — read that migration first,
-- nothing here re-derives its schema/RLS shape, it extends it.
--
-- Explicitly NOT in this pass (still P2, per the requirements doc):
--   typing indicators, a "browse public channels" discovery screen,
--   real calendar scheduling (the meeting quick-link is client-only,
--   no schema), search across every channel, audit/export, and
--   turning a Sembang task into a real Ticket.
--
-- Depends on: 098 (sembang_channels/sembang_channel_members/
-- sembang_messages, has_capability(), is_sembang_channel_member(),
-- is_sembang_channel_moderator()).
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. sembang_messages: threading + edit tracking
-- ------------------------------------------------------------
ALTER TABLE public.sembang_messages
  ADD COLUMN IF NOT EXISTS parent_message_id UUID REFERENCES public.sembang_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sembang_messages_parent
  ON public.sembang_messages (parent_message_id) WHERE parent_message_id IS NOT NULL;

-- BEFORE INSERT: a reply's parent must be a real, TOP-LEVEL message
-- (flat one-level threads, same as Slack — no threads-on-threads) in
-- the SAME channel.
-- BEFORE UPDATE: locks the columns that must never change once a
-- message exists. Both concerns live in one trigger function rather
-- than duplicated across the several UPDATE policies below (the
-- author's own edit, and the moderator's removal) that all touch this
-- table — see 098's own comment on why an INSERT-time WITH CHECK
-- can't express "unchanged from OLD", only a trigger can.
CREATE OR REPLACE FUNCTION public.sembang_messages_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_parent_channel UUID;
  v_parent_is_reply BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_message_id IS NOT NULL THEN
      SELECT channel_id, (parent_message_id IS NOT NULL)
        INTO v_parent_channel, v_parent_is_reply
        FROM public.sembang_messages WHERE id = NEW.parent_message_id;
      IF v_parent_channel IS NULL THEN
        RAISE EXCEPTION 'sembang_reply_parent_missing';
      END IF;
      IF v_parent_channel <> NEW.channel_id THEN
        RAISE EXCEPTION 'sembang_reply_parent_wrong_channel';
      END IF;
      IF v_parent_is_reply THEN
        RAISE EXCEPTION 'sembang_reply_parent_is_itself_a_reply';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.parent_message_id IS DISTINCT FROM OLD.parent_message_id THEN
    RAISE EXCEPTION 'sembang_message_immutable_column_changed';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sembang_messages_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_sembang_messages_guard ON public.sembang_messages;
CREATE TRIGGER trg_sembang_messages_guard
  BEFORE INSERT OR UPDATE ON public.sembang_messages
  FOR EACH ROW EXECUTE FUNCTION public.sembang_messages_guard();

-- Author can edit their own message's body (sets edited_at) or delete
-- it themselves (sets deleted_at) — a SECOND, permissive UPDATE policy
-- alongside 098's moderator-removal one (Postgres ORs multiple
-- permissive policies for the same command together). The immutability
-- trigger above is what actually stops this from being abused to
-- rewrite channel_id/author_id/etc; this policy only needs to gate WHO.
-- USING gates which EXISTING rows the author can touch (must not
-- already be deleted). WITH CHECK is given EXPLICITLY and deliberately
-- does NOT repeat "deleted_at IS NULL" — without that, Postgres's
-- default (WITH CHECK = USING when omitted) would re-run the same
-- "not deleted" test against the NEW row too, which rejects the exact
-- not-deleted -> deleted transition a self-delete needs to make.
DROP POLICY IF EXISTS sembang_messages_edit_own ON public.sembang_messages;
CREATE POLICY sembang_messages_edit_own ON public.sembang_messages FOR UPDATE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND author_id = auth.uid()
  AND deleted_at IS NULL
) WITH CHECK (
  public.has_capability(account_id, 'menu.sembang')
  AND author_id = auth.uid()
);

-- ------------------------------------------------------------
-- 2. sembang_reactions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sembang_reactions (
  message_id  UUID NOT NULL REFERENCES public.sembang_messages(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_sembang_reactions_message ON public.sembang_reactions (message_id);

ALTER TABLE public.sembang_reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sembang_reactions_select ON public.sembang_reactions;
CREATE POLICY sembang_reactions_select ON public.sembang_reactions FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_messages m
    JOIN public.sembang_channels c ON c.id = m.channel_id
    WHERE m.id = message_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_account_member(c.account_id, 'admin'))
  )
);

DROP POLICY IF EXISTS sembang_reactions_insert ON public.sembang_reactions;
CREATE POLICY sembang_reactions_insert ON public.sembang_reactions FOR INSERT WITH CHECK (
  public.has_capability(account_id, 'menu.sembang')
  AND user_id = auth.uid()
  AND EXISTS (SELECT 1 FROM public.sembang_messages m WHERE m.id = message_id AND m.account_id = account_id AND m.deleted_at IS NULL)
  AND EXISTS (SELECT 1 FROM public.sembang_messages m WHERE m.id = message_id AND public.is_sembang_channel_member(m.channel_id))
);

DROP POLICY IF EXISTS sembang_reactions_delete ON public.sembang_reactions;
CREATE POLICY sembang_reactions_delete ON public.sembang_reactions FOR DELETE USING (
  public.has_capability(account_id, 'menu.sembang') AND user_id = auth.uid()
);

-- ------------------------------------------------------------
-- 3. sembang_pins — any channel MEMBER can pin/unpin (not a
-- moderator-only action; matches how pinning actually works in
-- Slack, and there was no user decision restricting it further).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sembang_pins (
  channel_id  UUID NOT NULL REFERENCES public.sembang_channels(id) ON DELETE CASCADE,
  message_id  UUID NOT NULL REFERENCES public.sembang_messages(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  pinned_by   UUID NOT NULL REFERENCES auth.users(id),
  pinned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_sembang_pins_channel ON public.sembang_pins (channel_id);

ALTER TABLE public.sembang_pins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sembang_pins_select ON public.sembang_pins;
CREATE POLICY sembang_pins_select ON public.sembang_pins FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_account_member(c.account_id, 'admin'))
  )
);

DROP POLICY IF EXISTS sembang_pins_insert ON public.sembang_pins;
CREATE POLICY sembang_pins_insert ON public.sembang_pins FOR INSERT WITH CHECK (
  public.has_capability(account_id, 'menu.sembang')
  AND pinned_by = auth.uid()
  AND public.is_sembang_channel_member(channel_id)
  AND EXISTS (SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id AND c.account_id = account_id)
  AND EXISTS (SELECT 1 FROM public.sembang_messages m WHERE m.id = message_id AND m.channel_id = channel_id AND m.deleted_at IS NULL)
);

DROP POLICY IF EXISTS sembang_pins_delete ON public.sembang_pins;
CREATE POLICY sembang_pins_delete ON public.sembang_pins FOR DELETE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    pinned_by = auth.uid()
    OR public.is_sembang_channel_moderator(channel_id)
    OR public.is_account_member(account_id, 'admin')
  )
);

-- ------------------------------------------------------------
-- 4. sembang_tasks — a standalone, per-channel checklist (decided
-- scope: Sembang-only, no FK into tickets; see the requirements doc).
-- Any channel member can create/update; delete is creator or
-- moderator/admin (mirrors messages: anyone can add, removal is a
-- lighter-weight moderation-flavoured action).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sembang_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    UUID NOT NULL REFERENCES public.sembang_channels(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  message_id    UUID REFERENCES public.sembang_messages(id) ON DELETE SET NULL,
  title         TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  assignee_id   UUID REFERENCES auth.users(id),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  due_at        TIMESTAMPTZ,
  created_by    UUID NOT NULL REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  completed_by  UUID REFERENCES auth.users(id)
);
CREATE INDEX IF NOT EXISTS idx_sembang_tasks_channel ON public.sembang_tasks (channel_id, status);

-- Same immutability concern as messages: without a trigger, any
-- permissive UPDATE policy lets the actor rewrite channel_id/
-- account_id/created_by too. One BEFORE UPDATE guard, same shape as
-- sembang_messages_guard().
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
  -- completed_at/completed_by follow status, so a client can't fake
  -- "done since last week" or credit someone else with completing it.
  IF NEW.status = 'done' AND OLD.status <> 'done' THEN
    NEW.completed_at := now();
    NEW.completed_by := auth.uid();
  ELSIF NEW.status = 'open' AND OLD.status <> 'open' THEN
    NEW.completed_at := NULL;
    NEW.completed_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sembang_tasks_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_sembang_tasks_guard ON public.sembang_tasks;
CREATE TRIGGER trg_sembang_tasks_guard
  BEFORE UPDATE ON public.sembang_tasks
  FOR EACH ROW EXECUTE FUNCTION public.sembang_tasks_guard();

ALTER TABLE public.sembang_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sembang_tasks_select ON public.sembang_tasks;
CREATE POLICY sembang_tasks_select ON public.sembang_tasks FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_account_member(c.account_id, 'admin'))
  )
);

DROP POLICY IF EXISTS sembang_tasks_insert ON public.sembang_tasks;
CREATE POLICY sembang_tasks_insert ON public.sembang_tasks FOR INSERT WITH CHECK (
  public.has_capability(account_id, 'menu.sembang')
  AND created_by = auth.uid()
  AND public.is_sembang_channel_member(channel_id)
  AND EXISTS (SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id AND c.account_id = account_id)
  AND (message_id IS NULL OR EXISTS (SELECT 1 FROM public.sembang_messages m WHERE m.id = message_id AND m.channel_id = channel_id))
);

DROP POLICY IF EXISTS sembang_tasks_update ON public.sembang_tasks;
CREATE POLICY sembang_tasks_update ON public.sembang_tasks FOR UPDATE USING (
  public.has_capability(account_id, 'menu.sembang') AND public.is_sembang_channel_member(channel_id)
);

DROP POLICY IF EXISTS sembang_tasks_delete ON public.sembang_tasks;
CREATE POLICY sembang_tasks_delete ON public.sembang_tasks FOR DELETE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    created_by = auth.uid()
    OR public.is_sembang_channel_moderator(channel_id)
    OR public.is_account_member(account_id, 'admin')
  )
);

-- ------------------------------------------------------------
-- 5. Task-assignment notifications — same shape as 098's mention
-- trigger: SECURITY DEFINER, resolves names itself, wrapped so a
-- notification failure never blocks the underlying write.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sembang_check_values_099(p_def text)
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

  v_types := public.sembang_check_values_099(v_def);

  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY['sembang_task_assigned']) AS x);

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

DROP FUNCTION IF EXISTS public.sembang_check_values_099(text);

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS sembang_task_id UUID REFERENCES public.sembang_tasks(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.notify_sembang_task_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_channel_name TEXT;
  v_actor_name   TEXT;
BEGIN
  IF NEW.assignee_id IS NULL OR NEW.assignee_id = NEW.created_by THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.assignee_id IS NOT DISTINCT FROM OLD.assignee_id THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.sembang_channel_members m
    WHERE m.channel_id = NEW.channel_id AND m.user_id = NEW.assignee_id
  ) THEN
    RETURN NEW; -- only notify people who can actually see the channel
  END IF;

  SELECT name INTO v_channel_name FROM public.sembang_channels WHERE id = NEW.channel_id;
  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM public.profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO public.notifications (
    account_id, user_id, type, title, body, actor_user_id,
    sembang_channel_id, sembang_task_id
  ) VALUES (
    NEW.account_id, NEW.assignee_id, 'sembang_task_assigned',
    'You were assigned a task in #' || COALESCE(v_channel_name, 'a channel'),
    COALESCE(v_actor_name, 'Someone') || ' assigned you: ' || left(NEW.title, 140),
    COALESCE(auth.uid(), NEW.created_by), NEW.channel_id, NEW.id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create Sembang task-assignment notification for task %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.notify_sembang_task_assigned() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_sembang_task_assigned ON public.sembang_tasks;
CREATE TRIGGER trg_sembang_task_assigned
  AFTER INSERT OR UPDATE ON public.sembang_tasks
  FOR EACH ROW EXECUTE FUNCTION public.notify_sembang_task_assigned();

-- ------------------------------------------------------------
-- 6. Realtime
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sembang_reactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sembang_reactions;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sembang_pins'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sembang_pins;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sembang_tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sembang_tasks;
  END IF;
END $$;
