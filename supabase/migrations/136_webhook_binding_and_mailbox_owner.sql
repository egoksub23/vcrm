-- ============================================================
-- 136_webhook_binding_and_mailbox_owner.sql
--
-- Audit item A3.
--
-- 1. WhatsApp webhook signatures bound to a workspace.
--    Meta signs each delivery with the secret of the Meta App the WABA is
--    subscribed to. A deployment that serves WABAs under several Meta Apps
--    listed every app's secret in one environment variable and accepted a
--    delivery signed with ANY of them for ANY phone number, so a customer
--    who owns their own Meta App could sign a payload naming another
--    workspace's number and have it stored there.
--    `whatsapp_config.app_secret_enc` lets a workspace register the secret
--    of its OWN app (encrypted like every other channel credential). A
--    delivery signed with that secret is accepted only for the numbers and
--    WABA that workspace holds. Secrets in the environment variable stay
--    "operator-owned": valid for every number, as before.
--
-- 2. One workspace per mailbox.
--    Two workspaces could connect the same Gmail address or Microsoft 365
--    mailbox, which made incoming-mail routing ambiguous (a lookup that
--    expects one row, finding two, drops the message for both). Unique
--    indexes make a mailbox belong to exactly one workspace.
-- Idempotent.
-- ============================================================

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS app_secret_enc TEXT;

COMMENT ON COLUMN public.whatsapp_config.app_secret_enc IS
  'Optional, encrypted. The Meta App Secret of the Meta App this workspace''s WABA is subscribed to, when that app is not one of the operator''s. A delivery signed with it is accepted only for this workspace''s own phone number / WABA.';

CREATE UNIQUE INDEX IF NOT EXISTS gmail_config_email_address_unique
  ON public.gmail_config (lower(email_address));

CREATE UNIQUE INDEX IF NOT EXISTS email_config_mailbox_user_id_unique
  ON public.email_config (mailbox_user_id);
