-- ============================================================
-- Sembang P4: channel Bookmarks — a shared, curated list of URLs per
-- channel (Slack's channel-bookmarks bar), distinct from the existing
-- personal Stars (migration 100, private per-user) and from Pins
-- (migration 099, pin a specific MESSAGE — a bookmark is an arbitrary
-- URL, not necessarily one ever posted in the channel).
--
-- Modeled directly on sembang_pins (099): any member can add, the
-- adder/a moderator/an admin can remove, same cross-account hygiene
-- check on insert. Not added to the supabase_realtime publication —
-- unlike Pins/Tasks this is a fetch-on-open list, not something that
-- needs to update live while the panel is already open (kept lean;
-- can be added later if that turns out to matter).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sembang_bookmarks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  UUID NOT NULL REFERENCES public.sembang_channels(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  url         TEXT NOT NULL CHECK (url ~* '^https?://' AND char_length(url) <= 2000),
  title       TEXT CHECK (title IS NULL OR char_length(title) <= 200),
  added_by    UUID NOT NULL REFERENCES auth.users(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sembang_bookmarks_channel ON public.sembang_bookmarks (channel_id, added_at DESC);

ALTER TABLE public.sembang_bookmarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sembang_bookmarks_select ON public.sembang_bookmarks;
CREATE POLICY sembang_bookmarks_select ON public.sembang_bookmarks FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_account_member(c.account_id, 'admin'))
  )
);

DROP POLICY IF EXISTS sembang_bookmarks_insert ON public.sembang_bookmarks;
CREATE POLICY sembang_bookmarks_insert ON public.sembang_bookmarks FOR INSERT WITH CHECK (
  public.has_capability(account_id, 'menu.sembang')
  AND added_by = auth.uid()
  AND public.is_sembang_channel_member(channel_id)
  AND EXISTS (SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id AND c.account_id = account_id)
);

DROP POLICY IF EXISTS sembang_bookmarks_delete ON public.sembang_bookmarks;
CREATE POLICY sembang_bookmarks_delete ON public.sembang_bookmarks FOR DELETE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    added_by = auth.uid()
    OR public.is_sembang_channel_moderator(channel_id)
    OR public.is_account_member(account_id, 'admin')
  )
);
