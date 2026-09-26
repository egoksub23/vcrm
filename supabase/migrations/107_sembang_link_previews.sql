-- ============================================================
-- Sembang — link unfurling (preview cards for pasted URLs).
--
-- One preview per message (the first http(s) URL found in the body —
-- matching how most chat apps only ever show one big unfurl per
-- message, not one per link). Populated by a server-side, SSRF-guarded
-- fetch AFTER the message itself is already sent (reuses
-- src/lib/webhooks/ssrf.ts's isDeliverableUrl() via the existing
-- Knowledge Base page-importer's fetchWebPage(), not a new fetcher) —
-- never blocks the send, and a failed/skipped fetch just means no row,
-- not an error surfaced to the sender.
--
-- Written only by the server (service-role, from the message-send
-- route's after() callback) — same "no client write policy" posture as
-- sembang_attachments has for SELECT scoping, but this table has no
-- INSERT/UPDATE/DELETE policy at all, since a client never writes it.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sembang_link_previews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   UUID NOT NULL UNIQUE REFERENCES public.sembang_messages(id) ON DELETE CASCADE,
  account_id   UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  title        TEXT,
  description  TEXT,
  image_url    TEXT,
  domain       TEXT,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.sembang_link_previews ENABLE ROW LEVEL SECURITY;

-- Same shape as sembang_attachments_select (098) — a member of the
-- channel (or an account admin) can read it; nothing more.
DROP POLICY IF EXISTS sembang_link_previews_select ON public.sembang_link_previews;
CREATE POLICY sembang_link_previews_select ON public.sembang_link_previews FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_messages m
    JOIN public.sembang_channels c ON c.id = m.channel_id
    WHERE m.id = message_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_account_member(c.account_id, 'admin'))
  )
);

-- Realtime — same idempotent-add pattern migration 099 used for
-- sembang_reactions/sembang_pins/sembang_tasks.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'sembang_link_previews'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sembang_link_previews;
  END IF;
END $$;
