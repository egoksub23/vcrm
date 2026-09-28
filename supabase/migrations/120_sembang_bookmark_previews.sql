-- ============================================================
-- Sembang — unfurl previews for channel Bookmarks (migration 104),
-- so the Bookmarks tab can show a title/description/image card
-- instead of a bare URL, matching how a pasted link already unfurls
-- inside a message (migration 107). Best-effort, fetched server-side
-- when the bookmark is added (reuses fetchLinkPreview() — the same
-- SSRF-guarded fetch the message-unfurl pipeline already uses); null
-- when the fetch failed, timed out, or the page had nothing worth
-- showing.
-- ============================================================

ALTER TABLE public.sembang_bookmarks
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS domain TEXT;
