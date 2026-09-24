-- ============================================================
-- 098_sembang_p0.sql
--
-- Sembang P0: internal team chat, walled off from the customer
-- Inbox. Channels (public/private), membership with a moderator
-- role (creator auto-promoted), plain-text messages with
-- @mentions, file attachments in a new PRIVATE bucket, and
-- mention notifications.
--
-- Requirements doc: "Sembang Requirements" artifact (2026-09-24).
-- UX mockups: "Sembang UX — P0 & P1" canvas (2026-09-24).
--
-- Design decisions (confirmed with the user):
--   1. Any member with Sembang access can create a public or
--      private channel. The creator becomes its moderator
--      automatically (a trigger, so it works even for a brand
--      new private channel with no other members yet — a client
--      round-trip couldn't satisfy the membership-insert RLS
--      policy without this). Moderators can remove messages and
--      add people to a private channel. Account admins can see
--      and moderate every channel regardless of membership.
--   2. Tasks, threads, reactions, pins and code blocks are P1 —
--      out of scope here.
--   3. "Given access to use it" is enforced by ONE capability,
--      `menu.sembang`, checked BOTH at the app/route layer (like
--      every other menu capability) AND inside every Sembang
--      table's RLS via has_capability() — deliberately unlike
--      the rest of the `menus` group (whose app-only comment in
--      capabilities.ts says menu capabilities never guard a
--      table). Sembang's whole point is that broad account
--      membership is NOT enough to read it, so the capability has
--      to be a real data gate, not just a page-visibility toggle.
--      Default grant: owner + admin. An account admin can grant it
--      down to Agent from the existing Permissions screen — that
--      IS the "given access" mechanism, no new per-user grant
--      table needed.
--   4. Public vs private only affects default visibility/self-join
--      (RLS honours it correctly) — there is no "browse public
--      channels" discovery UI in this P0 pass; channels are
--      populated via the create-channel invite list or a
--      moderator's later "Add people". Noted as a fast-follow.
--   5. Unread counts are computed on read (a small aggregate RPC),
--      not a maintained counter — Sembang's message volume doesn't
--      warrant another trigger-maintained column.
--
-- Depends on: 017 (accounts, is_account_member, profiles),
-- 024 (member_presence — reused, untouched), 027 (notifications),
-- 079 (capability_catalogue, role_capability_defaults, has_capability).
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Capability: menu.sembang (database-enforced, see note 3 above)
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('menu.sembang', 'agent', 'database')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'menu.sembang'),
  ('admin', 'menu.sembang')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Tables
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sembang_channels (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  topic        TEXT,
  is_private   BOOLEAN NOT NULL DEFAULT false,
  created_by   UUID NOT NULL REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sembang_channels_account_name
  ON public.sembang_channels (account_id, lower(name)) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sembang_channels_account
  ON public.sembang_channels (account_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.sembang_channel_members (
  channel_id    UUID NOT NULL REFERENCES public.sembang_channels(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator')),
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sembang_channel_members_user
  ON public.sembang_channel_members (account_id, user_id);

CREATE TABLE IF NOT EXISTS public.sembang_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  UUID NOT NULL REFERENCES public.sembang_channels(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  author_id   UUID NOT NULL REFERENCES auth.users(id),
  body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  mentions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  deleted_at  TIMESTAMPTZ,
  deleted_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sembang_messages_channel_created
  ON public.sembang_messages (channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.sembang_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID NOT NULL REFERENCES public.sembang_messages(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  storage_path  TEXT NOT NULL,
  filename      TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  mime_type     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sembang_attachments_message
  ON public.sembang_attachments (message_id);

-- ------------------------------------------------------------
-- 3. Helper functions used by RLS
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_sembang_channel_member(p_channel_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sembang_channel_members
    WHERE channel_id = p_channel_id AND user_id = p_user_id
  );
$$;
ALTER FUNCTION public.is_sembang_channel_member(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.is_sembang_channel_member(UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_sembang_channel_moderator(p_channel_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sembang_channel_members
    WHERE channel_id = p_channel_id AND user_id = p_user_id AND role = 'moderator'
  );
$$;
ALTER FUNCTION public.is_sembang_channel_moderator(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.is_sembang_channel_moderator(UUID, UUID) TO authenticated, service_role;

-- Creator becomes moderator automatically. Runs as a trigger (not a
-- second client insert) because the membership-insert RLS policy
-- below requires the actor to ALREADY be a moderator of a private
-- channel — a chicken-and-egg problem for the very first member.
CREATE OR REPLACE FUNCTION public.sembang_add_creator_as_moderator()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.sembang_channel_members (channel_id, account_id, user_id, role)
  VALUES (NEW.id, NEW.account_id, NEW.created_by, 'moderator')
  ON CONFLICT (channel_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sembang_add_creator_as_moderator() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_sembang_channels_add_creator ON public.sembang_channels;
CREATE TRIGGER trg_sembang_channels_add_creator
  AFTER INSERT ON public.sembang_channels
  FOR EACH ROW EXECUTE FUNCTION public.sembang_add_creator_as_moderator();

-- ------------------------------------------------------------
-- 4. RLS
-- ------------------------------------------------------------
ALTER TABLE public.sembang_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sembang_channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sembang_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sembang_attachments ENABLE ROW LEVEL SECURITY;

-- ---- sembang_channels ----------------------------------------
DROP POLICY IF EXISTS sembang_channels_select ON public.sembang_channels;
CREATE POLICY sembang_channels_select ON public.sembang_channels FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    NOT is_private
    OR public.is_sembang_channel_member(id)
    OR public.is_account_member(account_id, 'admin')
  )
);

DROP POLICY IF EXISTS sembang_channels_insert ON public.sembang_channels;
CREATE POLICY sembang_channels_insert ON public.sembang_channels FOR INSERT WITH CHECK (
  public.has_capability(account_id, 'menu.sembang') AND created_by = auth.uid()
);

DROP POLICY IF EXISTS sembang_channels_update ON public.sembang_channels;
CREATE POLICY sembang_channels_update ON public.sembang_channels FOR UPDATE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (public.is_sembang_channel_moderator(id) OR public.is_account_member(account_id, 'admin'))
);

-- ---- sembang_channel_members -----------------------------------
-- No client UPDATE policy: role changes and last_read_at bumps go
-- through SECURITY DEFINER RPCs below, not a direct table write —
-- a plain USING/WITH CHECK pair can't stop a member from promoting
-- themselves via the same row they're allowed to touch.
DROP POLICY IF EXISTS sembang_channel_members_select ON public.sembang_channel_members;
CREATE POLICY sembang_channel_members_select ON public.sembang_channel_members FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    EXISTS (SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id AND NOT c.is_private)
    OR public.is_sembang_channel_member(channel_id)
    OR public.is_account_member(account_id, 'admin')
  )
);

DROP POLICY IF EXISTS sembang_channel_members_insert ON public.sembang_channel_members;
CREATE POLICY sembang_channel_members_insert ON public.sembang_channel_members FOR INSERT WITH CHECK (
  -- channel_id and account_id are two independently client-supplied
  -- values on the new row; without pinning them to the SAME real
  -- channel up front, each of the three branches below only validates
  -- ITS OWN half (a real channel_id membership/moderator fact, or
  -- has_capability on the caller's own account_id) and neither checks
  -- the other — so a caller could pair a genuine channel_id belonging
  -- to a DIFFERENT account with their own account_id (the only account
  -- has_capability() below can ever pass for them) and land a
  -- membership row whose account_id doesn't match its channel's real
  -- account. has_capability() elsewhere still stops any actual
  -- cross-account READ (it's re-checked against the caller's own
  -- single account on every table, using the row's real values), so
  -- this was a data-hygiene gap, not a read leak — but the fix belongs
  -- here, once, rather than duplicated into every branch.
  EXISTS (SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id AND c.account_id = account_id)
  AND public.has_capability(account_id, 'menu.sembang')
  AND (
    (
      user_id = auth.uid()
      AND EXISTS (SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id AND NOT c.is_private)
    )
    OR public.is_sembang_channel_moderator(channel_id)
    OR public.is_account_member(account_id, 'admin')
  )
);

DROP POLICY IF EXISTS sembang_channel_members_delete ON public.sembang_channel_members;
CREATE POLICY sembang_channel_members_delete ON public.sembang_channel_members FOR DELETE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    user_id = auth.uid()
    OR public.is_sembang_channel_moderator(channel_id)
    OR public.is_account_member(account_id, 'admin')
  )
);

-- ---- sembang_messages --------------------------------------------
DROP POLICY IF EXISTS sembang_messages_select ON public.sembang_messages;
CREATE POLICY sembang_messages_select ON public.sembang_messages FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_channels c
    WHERE c.id = channel_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_account_member(c.account_id, 'admin'))
  )
);

DROP POLICY IF EXISTS sembang_messages_insert ON public.sembang_messages;
CREATE POLICY sembang_messages_insert ON public.sembang_messages FOR INSERT WITH CHECK (
  public.has_capability(account_id, 'menu.sembang')
  AND author_id = auth.uid()
  AND public.is_sembang_channel_member(channel_id)
);

-- Moderator/admin "remove message" (soft delete). Editing/deleting
-- one's own message is P1 — not covered here.
DROP POLICY IF EXISTS sembang_messages_moderate ON public.sembang_messages;
CREATE POLICY sembang_messages_moderate ON public.sembang_messages FOR UPDATE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (public.is_sembang_channel_moderator(channel_id) OR public.is_account_member(account_id, 'admin'))
);

-- ---- sembang_attachments ------------------------------------------
DROP POLICY IF EXISTS sembang_attachments_select ON public.sembang_attachments;
CREATE POLICY sembang_attachments_select ON public.sembang_attachments FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_messages m
    JOIN public.sembang_channels c ON c.id = m.channel_id
    WHERE m.id = message_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_account_member(c.account_id, 'admin'))
  )
);

DROP POLICY IF EXISTS sembang_attachments_insert ON public.sembang_attachments;
CREATE POLICY sembang_attachments_insert ON public.sembang_attachments FOR INSERT WITH CHECK (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (SELECT 1 FROM public.sembang_messages m WHERE m.id = message_id AND m.author_id = auth.uid())
);

-- ------------------------------------------------------------
-- 5. RPCs: read-marking and the sidebar channel list (with
-- computed unread counts — see note 5 at the top).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_sembang_channel_read(p_channel_id UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE public.sembang_channel_members
  SET last_read_at = now()
  WHERE channel_id = p_channel_id AND user_id = auth.uid();
$$;
ALTER FUNCTION public.mark_sembang_channel_read(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.mark_sembang_channel_read(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_sembang_channels_for_current_user(p_account_id UUID)
RETURNS TABLE (
  id UUID, name TEXT, topic TEXT, is_private BOOLEAN, created_by UUID, created_at TIMESTAMPTZ,
  member_role TEXT, last_read_at TIMESTAMPTZ, unread_count BIGINT,
  last_message_body TEXT, last_message_at TIMESTAMPTZ, last_message_author_id UUID
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    c.id, c.name, c.topic, c.is_private, c.created_by, c.created_at,
    cm.role, cm.last_read_at,
    (
      SELECT count(*) FROM public.sembang_messages msg
      WHERE msg.channel_id = c.id AND msg.deleted_at IS NULL
        AND msg.created_at > cm.last_read_at AND msg.author_id <> auth.uid()
    ) AS unread_count,
    lm.body, lm.created_at, lm.author_id
  FROM public.sembang_channels c
  JOIN public.sembang_channel_members cm ON cm.channel_id = c.id AND cm.user_id = auth.uid()
  LEFT JOIN LATERAL (
    SELECT body, created_at, author_id FROM public.sembang_messages
    WHERE channel_id = c.id AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  ) lm ON true
  WHERE c.account_id = p_account_id
    AND c.archived_at IS NULL
    AND public.has_capability(p_account_id, 'menu.sembang')
  ORDER BY COALESCE(lm.created_at, c.created_at) DESC;
$$;
ALTER FUNCTION public.list_sembang_channels_for_current_user(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.list_sembang_channels_for_current_user(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 6. Mention notifications
-- ------------------------------------------------------------
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS sembang_channel_id UUID REFERENCES public.sembang_channels(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS sembang_message_id UUID REFERENCES public.sembang_messages(id) ON DELETE CASCADE;

-- notifications.type: add 'sembang_mention', keeping every existing
-- value from the live constraint. Throwaway helper, same shape as
-- migration 087's jira_check_values_087 (dropped again at the end).
CREATE OR REPLACE FUNCTION public.sembang_check_values_098(p_def text)
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

  v_types := public.sembang_check_values_098(v_def);

  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY['sembang_mention']) AS x);

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

DROP FUNCTION IF EXISTS public.sembang_check_values_098(text);

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
    -- are a member of this channel already).
    IF NOT EXISTS (
      SELECT 1 FROM public.sembang_channel_members m
      WHERE m.channel_id = NEW.channel_id AND m.user_id = v_mentioned_id
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

DROP TRIGGER IF EXISTS trg_sembang_message_mentions ON public.sembang_messages;
CREATE TRIGGER trg_sembang_message_mentions
  AFTER INSERT ON public.sembang_messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_sembang_message_mentions();

-- ------------------------------------------------------------
-- 7. Private storage bucket for Sembang attachments
--
-- Unlike chat-media (public, so Meta can fetch it with no auth),
-- this bucket is PRIVATE — reads need a signed URL, not a public
-- one. Same account-scoped path convention and write-policy shape
-- as chat-media (023), plus a read policy scoped the same way
-- (chat-media's read policy is unconditional; this one is not).
-- Mime allowlist mirrors chat-media, broadened for engineering
-- content (zip, csv, json).
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sembang-files',
  'sembang-files',
  FALSE,
  16777216, -- 16 MB — matches chat-media (decision: same cap for v1)
  ARRAY[
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm', 'video/quicktime',
    'application/pdf',
    'application/zip',
    'application/json',
    'text/csv',
    'application/vnd.ms-powerpoint',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/markdown'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Members can read their account's Sembang files" ON storage.objects;
CREATE POLICY "Members can read their account's Sembang files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'sembang-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
        AND public.has_capability(p.account_id, 'menu.sembang')
    )
  );

DROP POLICY IF EXISTS "Members can upload Sembang files" ON storage.objects;
CREATE POLICY "Members can upload Sembang files"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'sembang-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
        AND public.has_capability(p.account_id, 'menu.sembang')
    )
  );

DROP POLICY IF EXISTS "Members can delete their account's Sembang files" ON storage.objects;
CREATE POLICY "Members can delete their account's Sembang files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'sembang-files'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
        AND public.has_capability(p.account_id, 'menu.sembang')
    )
  );

-- ------------------------------------------------------------
-- 8. Realtime
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sembang_channels'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sembang_channels;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sembang_channel_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sembang_channel_members;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sembang_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sembang_messages;
  END IF;
END $$;
