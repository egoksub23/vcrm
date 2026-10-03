-- Verify migration 146 (held until the signing app is deployed; see the header of 146).
-- Concatenate 146's migration text in front, then run. Ends in a deliberate error so nothing
-- is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  v_s text;
BEGIN
  -- 1. The switch: chat-media is private, public-assets and the older buckets are not touched.
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media' AND public) THEN
    RAISE EXCEPTION 'FAIL chat-media should be private';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'public-assets' AND public) THEN
    RAISE EXCEPTION 'FAIL public-assets should stay public';
  END IF;

  -- 2. Nothing that must stay public still points into the private bucket.
  IF EXISTS (SELECT 1 FROM public.ai_knowledge_documents WHERE content_html LIKE '%/object/public/chat-media/account-%/kb/%')
     OR EXISTS (SELECT 1 FROM public.knowledge_document_versions WHERE content_html LIKE '%/object/public/chat-media/account-%/kb/%')
     OR EXISTS (SELECT 1 FROM public.messages WHERE content_html LIKE '%/object/public/chat-media/account-%/kb/%')
  THEN
    RAISE EXCEPTION 'FAIL a knowledge-base image still points into chat-media';
  END IF;
  IF EXISTS (SELECT 1 FROM public.message_templates WHERE header_media_url LIKE '%/object/public/chat-media/%')
     OR EXISTS (SELECT 1 FROM public.accounts WHERE brand_logo_url LIKE '%/object/public/chat-media/%')
  THEN
    RAISE EXCEPTION 'FAIL a logo or template header still points into chat-media';
  END IF;

  -- 3. The rewrite expression leaves other files and other workspaces' paths alone.
  v_s := regexp_replace(
    '<img src="https://x.supabase.co/storage/v1/object/public/chat-media/account-11111111-1111-1111-1111-111111111111/kb/a.png"> '
    || '<img src="https://x.supabase.co/storage/v1/object/public/chat-media/account-11111111-1111-1111-1111-111111111111/inbound/b.png">',
    '/storage/v1/object/public/chat-media/(account-[0-9a-f-]{36}/kb/)',
    '/storage/v1/object/public/public-assets/\1', 'g');
  IF v_s NOT LIKE '%public-assets/account-11111111-1111-1111-1111-111111111111/kb/a.png%'
     OR v_s NOT LIKE '%chat-media/account-11111111-1111-1111-1111-111111111111/inbound/b.png%' THEN
    RAISE EXCEPTION 'FAIL rewrite touched the wrong files: %', v_s;
  END IF;

  -- 4. Anonymous callers can neither list nor read the private bucket through the API.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'SELECT'
      AND (qual LIKE '%chat-media%') AND roles::text LIKE '%anon%'
  ) THEN
    RAISE EXCEPTION 'FAIL a policy lets anon read chat-media';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: chat-media is private and nothing public still depends on it';
END
$verify$;
