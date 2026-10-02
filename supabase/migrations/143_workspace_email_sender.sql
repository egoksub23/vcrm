-- ============================================================
-- 143: a sender name and reply-to per workspace (plan item B2).
--
-- Invites, widget verification codes and widget reply notifications all left
-- from one address with no workspace identity. The sending address stays the
-- deployment's verified one (RESEND_FROM_EMAIL: a domain has to be verified with
-- the mail provider before anyone can send as it), but each workspace now sets:
--   email_sender_name  the display name people see ("Acme Support")
--   email_reply_to     where replies go (the workspace's own inbox)
-- Both are optional. With no sender name the app falls back to the workspace's
-- brand name, then its company name.
--
-- Changing them needs settings.workspace like every other column of accounts
-- (accounts_capability_guard, migration 132). The checks keep both values safe to
-- put in a mail header: no quotes, angle brackets, commas, semicolons or line
-- breaks in the name; a plain single address for the reply-to.
-- ============================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS email_sender_name TEXT,
  ADD COLUMN IF NOT EXISTS email_reply_to    TEXT;

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_email_sender_name_check;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_email_sender_name_check
  CHECK (email_sender_name IS NULL
         OR (length(btrim(email_sender_name)) BETWEEN 1 AND 60
             AND email_sender_name !~ '[\r\n"<>;,]'));

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_email_reply_to_check;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_email_reply_to_check
  CHECK (email_reply_to IS NULL
         OR (length(email_reply_to) <= 254
             AND email_reply_to ~ '^[^@[:space:]<>",;]+@[^@[:space:]<>",;]+\.[^@[:space:]<>",;]+$'));
