-- A GIF from the Vircle app arrives as a looping MP4 flagged "animated" (contract 1.3, the way WhatsApp sends GIFs).
-- The flag tells the inbox to play it as a muted loop with no controls instead of as a video.
-- A plain column with a constant default: no rewrite of the table, nothing else changes.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_animated boolean NOT NULL DEFAULT false;
