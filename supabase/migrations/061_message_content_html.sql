-- ============================================================
-- 061_message_content_html
--
-- Email(MS365) and Gmail messages are almost always sent as HTML —
-- today only a plain-text derivation (content_text, tags stripped)
-- is stored, so a table-based marketing/order-notification email
-- reads as an unreadable wall of text with no layout. This column
-- carries the original HTML body alongside it, when the source
-- provided one, so the Inbox can offer a rendered view.
--
-- content_text stays authoritative for search, list previews, and
-- every non-email channel (never populated there) — content_html is
-- purely an enrichment, rendered client-side inside a sandboxed
-- iframe (no allow-scripts/allow-same-origin), never trusted as-is.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS content_html TEXT;
