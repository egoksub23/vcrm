-- ============================================================
-- Sembang P2 — direct messages, cross-conversation search,
-- starred messages, archive-channel UI (backend already existed).
--
-- Direct messages are NOT a new table family: a DM is just a
-- sembang_channels row with is_dm = true. Every existing table —
-- messages, reactions, pins, tasks, attachments — and every existing
-- RLS policy on those tables already scopes by channel_id/membership,
-- so DMs get threads, reactions, pins and tasks for free with zero
-- schema changes to those tables. Only sembang_channels itself needs
-- new columns (is_dm, dm_key) plus a few adjusted constraints, and
-- the moderate policy on sembang_messages needs one carve-out so a
-- DM's creator can't unilaterally delete the other participant's
-- messages the way a channel moderator legitimately can.
-- ============================================================

-- ------------------------------------------------------------
-- 1. sembang_channels: DM support
-- ------------------------------------------------------------
ALTER TABLE public.sembang_channels
  ADD COLUMN IF NOT EXISTS is_dm BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dm_key TEXT;

-- A DM has no name (participants are shown client-side instead) and
-- is always private. A regular channel still requires a name. Note:
-- a CHECK constraint is satisfied (not violated) when its expression
-- evaluates to NULL, so dropping NOT NULL below is what actually
-- allows a NULL name — the length CHECK never blocked NULL to begin
-- with, but is rewritten anyway for clarity now that NULL is a real,
-- intentional case rather than an accident.
ALTER TABLE public.sembang_channels ALTER COLUMN name DROP NOT NULL;
ALTER TABLE public.sembang_channels DROP CONSTRAINT IF EXISTS sembang_channels_name_check;
ALTER TABLE public.sembang_channels
  ADD CONSTRAINT sembang_channels_name_length_check CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 80);
ALTER TABLE public.sembang_channels
  ADD CONSTRAINT sembang_channels_dm_name_check CHECK (is_dm OR name IS NOT NULL);
ALTER TABLE public.sembang_channels
  ADD CONSTRAINT sembang_channels_dm_private_check CHECK (NOT is_dm OR is_private);
ALTER TABLE public.sembang_channels
  ADD CONSTRAINT sembang_channels_dm_key_check CHECK (is_dm = (dm_key IS NOT NULL));

-- The old named-channel dedup index now excludes DMs (which have no
-- name to dedupe on); a separate index dedupes DMs by participant set
-- instead. dm_key is a stable, app-computed digest of the sorted
-- participant user ids (e.g. "uid1,uid2" or "uid1,uid2,uid3") — this
-- migration doesn't compute it, the API route that creates a DM does,
-- the same way every other "find or create" flow in this app works.
DROP INDEX IF EXISTS idx_sembang_channels_account_name;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sembang_channels_account_name
  ON public.sembang_channels (account_id, lower(name)) WHERE archived_at IS NULL AND NOT is_dm;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sembang_channels_account_dmkey
  ON public.sembang_channels (account_id, dm_key) WHERE is_dm AND archived_at IS NULL;

-- No changes needed to sembang_channels_select/_insert or to
-- sembang_channel_members_select/_insert/_delete: a DM is always
-- is_private = true, so the existing "member OR moderator OR admin"
-- visibility/membership policies already do the right thing —
-- including admins being able to see every DM, which is a deliberate
-- continuation of the P0 decision ("every account admin can see into
-- and moderate every channel regardless of membership"), not a new
-- privacy exception carved out for this feature.

-- ------------------------------------------------------------
-- 2. sembang_messages_moderate: DM carve-out
-- ------------------------------------------------------------
-- The channel-moderator branch of this policy lets a channel's
-- moderator remove ANY member's message — correct for a real channel,
-- wrong for a DM, where the "moderator" is just whichever participant
-- happened to create it and a real DM shouldn't let one participant
-- unilaterally delete the other's messages. The admin branch is left
-- untouched (admins moderate everything, same as every other table).
DROP POLICY IF EXISTS sembang_messages_moderate ON public.sembang_messages;
CREATE POLICY sembang_messages_moderate ON public.sembang_messages FOR UPDATE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    (
      public.is_sembang_channel_moderator(channel_id)
      AND NOT EXISTS (SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id AND c.is_dm)
    )
    OR public.is_account_member(account_id, 'admin')
  )
);

-- ------------------------------------------------------------
-- 3. sembang_stars — personal, cross-channel saved messages
-- ------------------------------------------------------------
-- Deliberately separate from sembang_pins: a pin is a shared,
-- channel-level "important message" any member can set and a
-- moderator/admin can clear; a star is a private "save for later"
-- list, visible only to the person who starred it, same shape as
-- Slack's Starred sidebar. No realtime publication entry — a user
-- only stars from their own client and can update local state
-- immediately, no cross-client sync requirement.
CREATE TABLE IF NOT EXISTS public.sembang_stars (
  message_id  UUID NOT NULL REFERENCES public.sembang_messages(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  starred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sembang_stars_user ON public.sembang_stars (account_id, user_id, starred_at DESC);

ALTER TABLE public.sembang_stars ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sembang_stars_select ON public.sembang_stars;
CREATE POLICY sembang_stars_select ON public.sembang_stars FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang') AND user_id = auth.uid()
);

DROP POLICY IF EXISTS sembang_stars_insert ON public.sembang_stars;
CREATE POLICY sembang_stars_insert ON public.sembang_stars FOR INSERT WITH CHECK (
  public.has_capability(account_id, 'menu.sembang')
  AND user_id = auth.uid()
  -- Two separate single-table EXISTS blocks, not one joined EXISTS —
  -- a joined subquery exposing both sembang_messages.account_id and
  -- sembang_channels.account_id makes the bare `account_id` reference
  -- (meaning this NEW row's own column) genuinely ambiguous to
  -- Postgres, which resolves names in the innermost scope first.
  AND EXISTS (
    SELECT 1 FROM public.sembang_messages m
    WHERE m.id = message_id AND m.account_id = account_id AND m.deleted_at IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM public.sembang_messages m
    JOIN public.sembang_channels c ON c.id = m.channel_id
    WHERE m.id = message_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_account_member(c.account_id, 'admin'))
  )
);

DROP POLICY IF EXISTS sembang_stars_delete ON public.sembang_stars;
CREATE POLICY sembang_stars_delete ON public.sembang_stars FOR DELETE USING (
  public.has_capability(account_id, 'menu.sembang') AND user_id = auth.uid()
);

-- ------------------------------------------------------------
-- 4. list_sembang_channels_for_current_user — DM-aware
-- ------------------------------------------------------------
-- Adding output columns to a RETURNS TABLE function needs an explicit
-- DROP first (CREATE OR REPLACE can't change the return shape).
DROP FUNCTION IF EXISTS public.list_sembang_channels_for_current_user(UUID);
CREATE FUNCTION public.list_sembang_channels_for_current_user(p_account_id UUID)
RETURNS TABLE (
  id UUID, name TEXT, topic TEXT, is_private BOOLEAN, is_dm BOOLEAN, created_by UUID, created_at TIMESTAMPTZ,
  member_role TEXT, last_read_at TIMESTAMPTZ, unread_count BIGINT,
  last_message_body TEXT, last_message_at TIMESTAMPTZ, last_message_author_id UUID,
  dm_participant_names TEXT[], dm_participant_avatar_urls TEXT[]
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
    dp.names, dp.avatar_urls
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
-- 5. DM message notifications
-- ------------------------------------------------------------
-- Every DM message notifies the other participant(s), not just
-- @mentions (a plain DM reply has no reason to require an @mention to
-- surface a notification the way a busy shared channel does). Skips a
-- recipient who's already getting a mention notification for this
-- same message, so one DM reply that happens to also @mention the
-- recipient doesn't double-ping them.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS sembang_channel_id UUID REFERENCES public.sembang_channels(id) ON DELETE CASCADE;
-- (sembang_channel_id/sembang_message_id already exist from migration
-- 098 — the ADD COLUMN IF NOT EXISTS above is a no-op safety net, not
-- a real change; sembang_message_id needs the same treatment.)
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS sembang_message_id UUID REFERENCES public.sembang_messages(id) ON DELETE CASCADE;

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
    WHERE cm.channel_id = NEW.channel_id AND cm.user_id <> NEW.author_id
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

DROP TRIGGER IF EXISTS trg_sembang_dm_message ON public.sembang_messages;
CREATE TRIGGER trg_sembang_dm_message
AFTER INSERT ON public.sembang_messages
FOR EACH ROW EXECUTE FUNCTION public.notify_sembang_dm_message();

-- notifications.type: add 'sembang_dm_message', keeping every
-- existing value from the live constraint. Throwaway helper, same
-- shape as migration 098's sembang_check_values_098 (dropped again at
-- the end) — a fresh copy per migration, never reused across files.
CREATE OR REPLACE FUNCTION public.sembang_check_values_100(p_def text)
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

  v_types := public.sembang_check_values_100(v_def);

  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY['sembang_dm_message']) AS x);

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

DROP FUNCTION IF EXISTS public.sembang_check_values_100(text);
