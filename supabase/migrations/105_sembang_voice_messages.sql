-- ============================================================
-- Sembang voice messages (P4).
--
-- Two independent, additive changes so a channel/thread message can be
-- a voice note recorded client-side (Ogg/Opus via opus-recorder, the
-- exact same encoder path the Inbox composer and the web widget already
-- use — see src/lib/media/use-voice-recorder.ts):
--
-- 1. `sembang-files` (migration 098) doesn't allow-list `audio/ogg` yet
--    (it only ever needed to accept picked files, never a recording) —
--    add it. Bucket stays private; the 16 MB cap already covers a full
--    5-minute VOIP-quality take (matches MEDIA_MAX_BYTES_BY_KIND.audio).
--
-- 2. `sembang_messages.body` currently requires 1-8000 chars
--    (`sembang_messages_body_check`), so an attachment-only send (a
--    voice note has no caption, same as WhatsApp's) fails outright.
--    Relax to 0-8000 — the "body OR at least one attachment" rule is
--    enforced at the API layer (route.ts), same as it already reads
--    attachments from a separate insert after the message row exists,
--    so the DB itself can't see them at CHECK-time anyway.
-- ============================================================

UPDATE storage.buckets
SET allowed_mime_types = allowed_mime_types || ARRAY['audio/ogg']::text[]
WHERE id = 'sembang-files'
  AND NOT ('audio/ogg' = ANY(allowed_mime_types));

ALTER TABLE public.sembang_messages
  DROP CONSTRAINT sembang_messages_body_check;

ALTER TABLE public.sembang_messages
  ADD CONSTRAINT sembang_messages_body_check CHECK (char_length(body) BETWEEN 0 AND 8000);
