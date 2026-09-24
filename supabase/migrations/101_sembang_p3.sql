-- ============================================================
-- Sembang P3 — per-channel/DM notification mute, and letting a
-- thread reply also post into the main channel timeline ("Also send
-- to #channel", matching Slack). The other P3 items (global Threads
-- view, member directory, "browse public channels", rich-text-lite
-- composer + emoji toolbar button) are pure reads/frontend work on
-- EXISTING tables and RLS — no schema changes needed for those, so
-- this migration only covers the two pieces that do need one.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Mute
-- ------------------------------------------------------------
-- sembang_channel_members has no client UPDATE policy by design (see
-- 098's comment above its RLS block) — role changes and last_read_at
-- bumps go through SECURITY DEFINER RPCs only, never a direct table
-- write, so a member can't promote themselves via the same row they're
-- allowed to touch. Mute follows the exact same shape.
ALTER TABLE public.sembang_channel_members
  ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.set_sembang_channel_muted(p_channel_id UUID, p_muted BOOLEAN)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE public.sembang_channel_members
  SET muted = p_muted
  WHERE channel_id = p_channel_id AND user_id = auth.uid();
$$;
ALTER FUNCTION public.set_sembang_channel_muted(UUID, BOOLEAN) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.set_sembang_channel_muted(UUID, BOOLEAN) TO authenticated;

-- Every notification-producing trigger gets a matching "recipient has
-- this channel muted" skip, right alongside its existing membership
-- check — muting suppresses ALL Sembang notifications from that
-- channel/DM (mentions included), not just ambient activity. That's a
-- deliberate simplification over Slack's "mute except @mentions"
-- default: predictable single meaning ("stop telling me about this
-- conversation") over a second per-channel sub-setting nobody asked
-- for yet.

CREATE OR REPLACE FUNCTION public.notify_sembang_message_mentions()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_channel_name TEXT;
  v_actor_name   TEXT;
  v_mentioned_id UUID;
BEGIN
  IF NEW.mentions IS NULL OR jsonb_array_length(NEW.mentions) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT name INTO v_channel_name FROM public.sembang_channels WHERE id = NEW.channel_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM public.profiles WHERE user_id = auth.uid();
  END IF;

  FOR v_mentioned_id IN
    SELECT DISTINCT (elem.value #>> '{}')::UUID
    FROM jsonb_array_elements(NEW.mentions) AS elem(value)
  LOOP
    IF v_mentioned_id IS NULL OR v_mentioned_id = NEW.author_id THEN
      CONTINUE;
    END IF;
    -- Only notify people who can actually read the message (i.e.
    -- are a member of this channel already) and haven't muted it.
    IF NOT EXISTS (
      SELECT 1 FROM public.sembang_channel_members m
      WHERE m.channel_id = NEW.channel_id AND m.user_id = v_mentioned_id AND NOT m.muted
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.notifications (
      account_id, user_id, type, title, body, actor_user_id,
      sembang_channel_id, sembang_message_id
    ) VALUES (
      NEW.account_id, v_mentioned_id, 'sembang_mention',
      'You were mentioned in #' || COALESCE(v_channel_name, 'a channel'),
      COALESCE(v_actor_name, 'Someone') || ' mentioned you: ' || left(NEW.body, 140),
      NEW.author_id, NEW.channel_id, NEW.id
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create Sembang mention notification(s) for message %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.notify_sembang_message_mentions() OWNER TO postgres;

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
    WHERE m.channel_id = NEW.channel_id AND m.user_id = NEW.assignee_id AND NOT m.muted
  ) THEN
    RETURN NEW; -- only notify people who can actually see the channel and haven't muted it
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

CREATE OR REPLACE FUNCTION public.notify_sembang_dm_message()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_is_dm        BOOLEAN;
  v_sender_name  TEXT;
  v_recipient_id UUID;
BEGIN
  SELECT is_dm INTO v_is_dm FROM public.sembang_channels WHERE id = NEW.channel_id;
  IF NOT COALESCE(v_is_dm, false) THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_sender_name FROM public.profiles WHERE user_id = auth.uid();
  END IF;

  FOR v_recipient_id IN
    SELECT cm.user_id
    FROM public.sembang_channel_members cm
    WHERE cm.channel_id = NEW.channel_id AND cm.user_id <> NEW.author_id AND NOT cm.muted
  LOOP
    IF NEW.mentions IS NOT NULL AND NEW.mentions ? v_recipient_id::text THEN
      CONTINUE;
    END IF;

    INSERT INTO public.notifications (
      account_id, user_id, type, title, body, actor_user_id,
      sembang_channel_id, sembang_message_id
    ) VALUES (
      NEW.account_id, v_recipient_id, 'sembang_dm_message',
      COALESCE(v_sender_name, 'Someone') || ' sent you a message',
      left(NEW.body, 140),
      NEW.author_id, NEW.channel_id, NEW.id
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create Sembang DM notification(s) for message %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.notify_sembang_dm_message() OWNER TO postgres;

-- list_sembang_channels_for_current_user gains `muted` so the sidebar
-- can show a muted indicator without a second round-trip. Adding an
-- output column to a RETURNS TABLE function needs an explicit DROP
-- first (CREATE OR REPLACE can't change the return shape) — same as
-- migration 100's own change to this same function.
DROP FUNCTION IF EXISTS public.list_sembang_channels_for_current_user(UUID);
CREATE FUNCTION public.list_sembang_channels_for_current_user(p_account_id UUID)
RETURNS TABLE (
  id UUID, name TEXT, topic TEXT, is_private BOOLEAN, is_dm BOOLEAN, created_by UUID, created_at TIMESTAMPTZ,
  member_role TEXT, last_read_at TIMESTAMPTZ, unread_count BIGINT,
  last_message_body TEXT, last_message_at TIMESTAMPTZ, last_message_author_id UUID,
  dm_participant_names TEXT[], dm_participant_avatar_urls TEXT[], muted BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    c.id, c.name, c.topic, c.is_private, c.is_dm, c.created_by, c.created_at,
    cm.role, cm.last_read_at,
    (
      SELECT count(*) FROM public.sembang_messages msg
      WHERE msg.channel_id = c.id AND msg.deleted_at IS NULL
        AND msg.created_at > cm.last_read_at AND msg.author_id <> auth.uid()
    ) AS unread_count,
    lm.body, lm.created_at, lm.author_id,
    dp.names, dp.avatar_urls, cm.muted
  FROM public.sembang_channels c
  JOIN public.sembang_channel_members cm ON cm.channel_id = c.id AND cm.user_id = auth.uid()
  LEFT JOIN LATERAL (
    SELECT body, created_at, author_id FROM public.sembang_messages
    WHERE channel_id = c.id AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  ) lm ON true
  LEFT JOIN LATERAL (
    SELECT
      array_agg(p.full_name ORDER BY p.full_name) AS names,
      array_agg(p.avatar_url ORDER BY p.full_name) AS avatar_urls
    FROM public.sembang_channel_members ocm
    JOIN public.profiles p ON p.user_id = ocm.user_id
    WHERE ocm.channel_id = c.id AND ocm.user_id <> auth.uid()
  ) dp ON c.is_dm
  WHERE c.account_id = p_account_id
    AND c.archived_at IS NULL
    AND public.has_capability(p_account_id, 'menu.sembang')
  ORDER BY COALESCE(lm.created_at, c.created_at) DESC;
$$;
ALTER FUNCTION public.list_sembang_channels_for_current_user(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.list_sembang_channels_for_current_user(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 2. "Also send to #channel" — a thread reply that also appears in
--    the main channel timeline (Slack's behavior, shown in the
--    reference screenshot the owner shared: a reply row reading
--    "X replied to a thread: <parent snippet>").
-- ------------------------------------------------------------
ALTER TABLE public.sembang_messages
  ADD COLUMN IF NOT EXISTS also_in_channel BOOLEAN NOT NULL DEFAULT false;

-- A compose-time-only decision, same immutability posture as every
-- other structural column on this table — extend the existing guard
-- rather than add a second trigger.
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
    IF NEW.also_in_channel AND NEW.parent_message_id IS NULL THEN
      RAISE EXCEPTION 'sembang_also_in_channel_requires_a_reply';
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.parent_message_id IS DISTINCT FROM OLD.parent_message_id
     OR NEW.also_in_channel IS DISTINCT FROM OLD.also_in_channel THEN
    RAISE EXCEPTION 'sembang_message_immutable_column_changed';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sembang_messages_guard() OWNER TO postgres;
-- Trigger attachment is unchanged (BEFORE INSERT OR UPDATE, same
-- function name) — no DROP/CREATE TRIGGER needed, CREATE OR REPLACE
-- FUNCTION above already updates the body the existing trigger calls.
