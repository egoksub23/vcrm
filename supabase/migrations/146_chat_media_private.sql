-- ============================================================
-- 146_chat_media_private.sql
--
-- Wave C1, step 2 of 2: `chat-media` stops being a public bucket.
--
-- Until now anyone holding a file's URL could read it, and the bucket holds
-- customer media, ticket attachments and incident evidence. From here a file
-- is read through a short-lived signed link minted for someone allowed to see
-- it (the dashboard signs for the signed-in member, the chat widget asks the
-- server, outbound sends mint a link at send time).
--
-- APPLY THIS ONLY AFTER:
--   1. the app that signs links is deployed (the previous app reads raw
--      public URLs and every image, voice note and attachment would break),
--   2. scripts/move-public-assets.mjs has copied the files that must stay
--      public (knowledge-base files, workspace logos, template header
--      samples) into `public-assets`. This migration refuses to run if any is
--      missing a copy, instead of breaking them.
--
-- What it does:
--   * rewrites the URLs of the files that moved to `public-assets`
--     (knowledge-base images and attachments, logos, template headers),
--     including the HTML of articles, their older versions and sent emails;
--   * sets chat-media to private.
--
-- Files that stay in chat-media keep the stored URL they have: it is now an
-- identifier, not a link, and is signed whenever it is shown.
-- ============================================================

DO $guard$
DECLARE
  v_missing text;
BEGIN
  -- Knowledge-base files and logos: every object under account-*/kb/ and
  -- account-*/brand/ must already have a copy in public-assets.
  SELECT string_agg(o.name, ', ') INTO v_missing
  FROM storage.objects o
  WHERE o.bucket_id = 'chat-media'
    AND (o.name LIKE 'account-%/kb/%' OR o.name LIKE 'account-%/brand/%')
    AND NOT EXISTS (
      SELECT 1 FROM storage.objects c
      WHERE c.bucket_id = 'public-assets' AND c.name = o.name
    );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Copy these files to public-assets first (node scripts/move-public-assets.mjs): %', v_missing;
  END IF;

  -- Template header samples: the file each template points at.
  SELECT string_agg(t.header_media_url, ', ') INTO v_missing
  FROM public.message_templates t
  WHERE t.header_media_url LIKE '%/storage/v1/object/public/chat-media/%'
    AND NOT EXISTS (
      SELECT 1 FROM storage.objects c
      WHERE c.bucket_id = 'public-assets'
        AND c.name = substring(t.header_media_url from '/storage/v1/object/public/chat-media/([^?#]+)')
    );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Copy these template header files to public-assets first (node scripts/move-public-assets.mjs): %', v_missing;
  END IF;
END
$guard$;

-- Rewriting a stored URL is not an edit: keep the version history, audit
-- trail and realtime triggers out of it, for these statements only.
ALTER TABLE public.ai_knowledge_documents DISABLE TRIGGER USER;
ALTER TABLE public.messages DISABLE TRIGGER USER;

-- Article HTML (current text and every translation), older versions, and the
-- HTML of emails already sent from the inbox.
UPDATE public.ai_knowledge_documents
SET content_html = regexp_replace(
      content_html,
      '/storage/v1/object/public/chat-media/(account-[0-9a-f-]{36}/kb/)',
      '/storage/v1/object/public/public-assets/\1', 'g')
WHERE content_html LIKE '%/storage/v1/object/public/chat-media/account-%/kb/%';

UPDATE public.knowledge_document_versions
SET content_html = regexp_replace(
      content_html,
      '/storage/v1/object/public/chat-media/(account-[0-9a-f-]{36}/kb/)',
      '/storage/v1/object/public/public-assets/\1', 'g')
WHERE content_html LIKE '%/storage/v1/object/public/chat-media/account-%/kb/%';

UPDATE public.messages
SET content_html = regexp_replace(
      content_html,
      '/storage/v1/object/public/chat-media/(account-[0-9a-f-]{36}/kb/)',
      '/storage/v1/object/public/public-assets/\1', 'g')
WHERE content_html LIKE '%/storage/v1/object/public/chat-media/account-%/kb/%';

ALTER TABLE public.ai_knowledge_documents ENABLE TRIGGER USER;
ALTER TABLE public.messages ENABLE TRIGGER USER;

-- Each of these is rewritten only when the file really has a copy in
-- public-assets; a URL whose file stays in chat-media keeps its identifier
-- and is signed whenever it is shown.

-- Knowledge-base attachment links (the app also derives them at read time).
UPDATE public.knowledge_attachments
SET public_url = replace(public_url, '/storage/v1/object/public/chat-media/', '/storage/v1/object/public/public-assets/')
WHERE public_url LIKE '%/storage/v1/object/public/chat-media/%'
  AND EXISTS (
    SELECT 1 FROM storage.objects c
    WHERE c.bucket_id = 'public-assets'
      AND c.name = substring(public_url from '/storage/v1/object/public/chat-media/([^?#]+)')
  );

-- Workspace logos.
UPDATE public.accounts
SET brand_logo_url = replace(brand_logo_url, '/storage/v1/object/public/chat-media/', '/storage/v1/object/public/public-assets/')
WHERE brand_logo_url LIKE '%/storage/v1/object/public/chat-media/%'
  AND EXISTS (
    SELECT 1 FROM storage.objects c
    WHERE c.bucket_id = 'public-assets'
      AND c.name = substring(brand_logo_url from '/storage/v1/object/public/chat-media/([^?#]+)')
  );

-- Template header samples.
UPDATE public.message_templates
SET header_media_url = replace(header_media_url, '/storage/v1/object/public/chat-media/', '/storage/v1/object/public/public-assets/')
WHERE header_media_url LIKE '%/storage/v1/object/public/chat-media/%'
  AND EXISTS (
    SELECT 1 FROM storage.objects c
    WHERE c.bucket_id = 'public-assets'
      AND c.name = substring(header_media_url from '/storage/v1/object/public/chat-media/([^?#]+)')
  );

-- The switch.
UPDATE storage.buckets SET public = FALSE WHERE id = 'chat-media';
