-- ============================================================
-- Sembang — "remove from sidebar" (an "X" on a DM row in the sidebar).
-- Owner request: DMs pile up in the sidebar with no way to clear one out.
--
-- Modeled directly on migration 101's mute column/RPC (same "no client
-- UPDATE policy on sembang_channel_members — go through a self-scoped
-- SECURITY DEFINER RPC" posture): a member hides their OWN membership
-- row for a channel/DM. This never deletes the membership, the channel,
-- or any messages — it only stops that one channel from being returned
-- by list_sembang_channels_for_current_user, until either the member
-- un-hides it or a new message arrives (mirrors Slack's own "close a DM"
-- behavior: closing it isn't "leaving" it, and new activity brings it
-- back automatically rather than silently swallowing a reply).
--
-- Kept generic (any channel, not DM-only) at the schema/RPC layer, same
-- as `muted` — the frontend is the one that only ever offers the "X" on
-- DM rows for v1.
-- ============================================================

ALTER TABLE public.sembang_channel_members
  ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;

-- Opening/reading a channel is itself a strong enough signal to also
-- un-hide it — otherwise re-opening a hidden DM via "New message"'s
-- get-or-create (before either side has sent a fresh message) would show
-- the thread while it stays invisible in the sidebar, which is confusing
-- rather than useful.
CREATE OR REPLACE FUNCTION public.mark_sembang_channel_read(p_channel_id UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE public.sembang_channel_members
  SET last_read_at = now(), hidden_at = NULL
  WHERE channel_id = p_channel_id AND user_id = auth.uid();
$$;
ALTER FUNCTION public.mark_sembang_channel_read(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.mark_sembang_channel_read(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_sembang_channel_hidden(p_channel_id UUID, p_hidden BOOLEAN)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE public.sembang_channel_members
  SET hidden_at = CASE WHEN p_hidden THEN now() ELSE NULL END
  WHERE channel_id = p_channel_id AND user_id = auth.uid();
$$;
ALTER FUNCTION public.set_sembang_channel_hidden(UUID, BOOLEAN) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.set_sembang_channel_hidden(UUID, BOOLEAN) TO authenticated;

-- Same return shape as the migration-102 version — only the WHERE clause
-- gains one more condition, so CREATE OR REPLACE (not DROP+CREATE) is
-- enough this time.
CREATE OR REPLACE FUNCTION public.list_sembang_channels_for_current_user(p_account_id UUID)
RETURNS TABLE (
  id UUID, name TEXT, topic TEXT, is_private BOOLEAN, is_dm BOOLEAN, created_by UUID, created_at TIMESTAMPTZ,
  member_role TEXT, last_read_at TIMESTAMPTZ, unread_count BIGINT,
  last_message_body TEXT, last_message_at TIMESTAMPTZ, last_message_author_id UUID,
  dm_participant_names TEXT[], dm_participant_avatar_urls TEXT[], muted BOOLEAN,
  unread_mention_count BIGINT
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
    dp.names, dp.avatar_urls, cm.muted,
    (
      SELECT count(*) FROM public.notifications n
      WHERE n.user_id = auth.uid() AND n.sembang_channel_id = c.id
        AND n.type IN ('sembang_mention', 'sembang_dm_message')
        AND n.read_at IS NULL
    ) AS unread_mention_count
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
    -- Hidden (an "X"-closed DM) stays out of the list unless a message
    -- has landed since it was hidden — closing it isn't leaving it.
    AND (cm.hidden_at IS NULL OR COALESCE(lm.created_at, c.created_at) > cm.hidden_at)
  ORDER BY COALESCE(lm.created_at, c.created_at) DESC;
$$;
ALTER FUNCTION public.list_sembang_channels_for_current_user(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.list_sembang_channels_for_current_user(UUID) TO authenticated;
