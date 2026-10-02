-- ============================================================
-- 145_public_assets_bucket.sql
--
-- Wave C1, step 1 of 2: a place for the files that are meant to be public.
--
-- `chat-media` has been a public bucket since migration 023: anyone holding
-- a file's URL can read it, and customer media, ticket attachments and
-- incident evidence all live there. Step 2 (migration 146) makes it private.
-- Before that, the files that genuinely must stay fetchable by anyone get
-- their own bucket:
--
--   public-assets   knowledge-base images and attachments (they go out in
--                   emails and chat messages), the workspace logo, and
--                   WhatsApp template header samples (Meta fetches them on
--                   every send).
--
-- Same account-scoped layout and write rules as chat-media: the first path
-- segment is `account-<account_id>`, and only a member of that workspace
-- may write under it. There is deliberately NO anonymous SELECT policy: a
-- public bucket serves an object by URL without one, and without one nobody
-- can LIST another workspace's folder (migration 130's lesson).
--
-- This migration is additive and safe to apply while the old app is live.
-- Idempotent.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'public-assets',
  'public-assets',
  TRUE,
  16777216, -- 16 MB, same ceiling as chat-media
  ARRAY[
    -- Images
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'image/heic', 'image/heif', 'image/bmp', 'image/tiff',
    -- Videos
    'video/mp4', 'video/3gpp', 'video/3gp', 'video/quicktime',
    -- Documents
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'application/rtf', 'text/rtf',
    'text/plain', 'text/csv', 'text/markdown',
    'application/zip', 'application/x-zip-compressed',
    'application/octet-stream',
    -- Audio
    'audio/ogg', 'audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/amr', 'audio/opus',
    'audio/wav', 'audio/x-wav'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- A member lists / reads / writes / removes only their own workspace's folder.
DROP POLICY IF EXISTS "Members can read their account's public assets" ON storage.objects;
CREATE POLICY "Members can read their account's public assets"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'public-assets'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can upload public assets" ON storage.objects;
CREATE POLICY "Members can upload public assets"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'public-assets'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update public assets" ON storage.objects;
CREATE POLICY "Members can update public assets"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'public-assets'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete public assets" ON storage.objects;
CREATE POLICY "Members can delete public assets"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'public-assets'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
