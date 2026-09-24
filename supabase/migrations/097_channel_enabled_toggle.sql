-- ============================================================
-- 097: "Disable without disconnecting" for every DM/comment channel.
--
-- Every channel config table already has a `status` column
-- (connected/disconnected/error) or, for WhatsApp, a status of its own
-- — but that column tracks OAuth/connection HEALTH: it's mutated by the
-- app itself on reauth failures, and Disconnect hard-deletes the whole
-- row rather than flipping it. None of that is a manual pause switch.
--
-- This adds a new, separate `enabled` boolean to every channel table
-- that doesn't already have one (web_widget_config already got this in
-- migration 046) — orthogonal to connection health, defaulting to true
-- so every existing connected channel keeps working unchanged. The
-- owner turns it off to pause a channel (no inbound stored, no
-- outbound sent) without losing the saved token/credentials, and back
-- on to resume instantly.
-- ============================================================

ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE messenger_config ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE instagram_config ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE email_config ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE gmail_config ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE tiktok_config ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN whatsapp_config.enabled IS 'Manual pause switch, independent of status. false = inbound webhooks are ack''d and dropped, outbound sends are blocked with a clear error. The token/credentials stay intact.';
COMMENT ON COLUMN messenger_config.enabled IS 'Manual pause switch, independent of status. false = inbound DMs and comments are dropped, outbound sends and comment actions are blocked. The token/credentials stay intact.';
COMMENT ON COLUMN instagram_config.enabled IS 'Manual pause switch, independent of status. false = inbound DMs and comments are dropped, outbound sends and comment actions are blocked. The token/credentials stay intact.';
COMMENT ON COLUMN email_config.enabled IS 'Manual pause switch, independent of status. false = inbound mail notifications are dropped, outbound sends are blocked. The token/subscription stays intact.';
COMMENT ON COLUMN gmail_config.enabled IS 'Manual pause switch, independent of status. false = inbound push notifications are dropped, outbound sends are blocked. The token/watch stays intact.';
COMMENT ON COLUMN tiktok_config.enabled IS 'Manual pause switch, independent of status. false = inbound comment events are dropped, comment actions are blocked. The token stays intact.';
