-- A GIF is sent as a looping MP4 (as WhatsApp does: GIFs are never sent as .gif files). `animated` tells every
-- screen to play it as a muted loop with no controls instead of as a video.
ALTER TABLE files ADD COLUMN animated BOOLEAN NOT NULL DEFAULT false;
