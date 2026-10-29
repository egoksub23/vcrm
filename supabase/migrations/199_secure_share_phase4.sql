-- ============================================================
-- 199_secure_share_phase4.sql
--
-- Adds three columns to share_links for Phase 4:
--   kind            — 'file' (default) or 'url' redirect
--   redirect_url    — the target URL for kind='url' shares
--   watermark_enabled — PDF watermarking flag
--
-- Makes file_path nullable (kind='url' has no file).
-- Adds a per-kind CHECK constraint.
-- Adds text/html to the share-files bucket MIME allowlist
-- (for DOCX→HTML converted shares stored as HTML).
-- ============================================================

-- 1. Add columns
ALTER TABLE public.share_links
  ADD COLUMN kind             text    NOT NULL DEFAULT 'file'
    CHECK (kind IN ('file', 'url')),
  ADD COLUMN redirect_url     text,
  ADD COLUMN watermark_enabled boolean NOT NULL DEFAULT false;

-- 2. Make file_path nullable (url shares have none)
ALTER TABLE public.share_links
  ALTER COLUMN file_path DROP NOT NULL;

-- 3. Per-kind integrity: file shares need file_path, url shares need redirect_url
ALTER TABLE public.share_links
  ADD CONSTRAINT share_links_kind_check CHECK (
    (kind = 'file' AND file_path IS NOT NULL)
    OR
    (kind = 'url' AND redirect_url IS NOT NULL)
  );

-- 4. Allow text/html in the share-files bucket (DOCX→HTML output)
UPDATE storage.buckets
SET allowed_mime_types = array_append(allowed_mime_types, 'text/html')
WHERE id = 'share-files'
  AND NOT ('text/html' = ANY(allowed_mime_types));
