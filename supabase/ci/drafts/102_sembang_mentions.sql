-- ============================================================
-- Sembang — per-channel unread-mention count, feeding a channel-list
-- badge and a global "Mentions" view (things @mentioning you, or DM
-- messages, that you haven't read yet — task assignments are excluded,
-- they already have their own Tasks affordance per channel).
--
-- Purely additive: one more computed column on the existing
-- list_sembang_channels_for_current_user RPC, reading the notifications
-- table that already exists (migration 027) and is already populated by
-- the sembang_mention/sembang_dm_message triggers (098/100). No new
-- table, no new RLS policy — the /api/sembang/mentions route this feeds
-- reads `notifications` directly, already RLS-scoped to the caller's
-- own rows (migration 027's notifications_select policy).
-- ============================================================

DROP FUNCTION IF EXISTS public.list_sembang_channels_for_current_user(UUID);
CREATE FUNCTION public.list_sembang_channels_for_current_user(p_account_id UUID)
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
  ORDER BY COALESCE(lm.created_at, c.created_at) DESC;
$$;
ALTER FUNCTION public.list_sembang_channels_for_current_user(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.list_sembang_channels_for_current_user(UUID) TO authenticated;
