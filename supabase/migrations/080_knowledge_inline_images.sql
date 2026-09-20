-- ============================================================
-- 080_knowledge_inline_images
--
-- Images can now be pasted or dropped straight into an article's body. An
-- inline image is still an attachment (so the per-file "send with AI answers"
-- switch, the size and count caps and the cleanup on removal all apply); two
-- new columns say how it is used:
--
--   inline   true = the file is shown inside the article body (an <img> in
--            content_html) rather than only listed under the article.
--   caption  optional text for the image: the caption when it is sent as a
--            chat media message, and the alt text in the article HTML.
--
-- Nothing else changes: the object path CHECK, the RLS policies and the
-- chat-media bucket are untouched. Idempotent - safe to re-run.
-- ============================================================
ALTER TABLE knowledge_attachments
  ADD COLUMN IF NOT EXISTS inline boolean NOT NULL DEFAULT false;
ALTER TABLE knowledge_attachments
  ADD COLUMN IF NOT EXISTS caption text;

-- Meta caps a media caption at 1024 characters.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'knowledge_attachments_caption_len'
       AND conrelid = 'public.knowledge_attachments'::regclass
  ) THEN
    ALTER TABLE knowledge_attachments
      ADD CONSTRAINT knowledge_attachments_caption_len
      CHECK (caption IS NULL OR char_length(caption) <= 1024);
  END IF;
END
$$;

COMMENT ON COLUMN knowledge_attachments.inline IS
  'true = the file is an image shown inside the article body (an <img> in content_html), not only listed under it.';
COMMENT ON COLUMN knowledge_attachments.caption IS
  'Optional caption: sent as the media caption on chat channels and used as alt text in the article HTML. At most 1024 characters.';
