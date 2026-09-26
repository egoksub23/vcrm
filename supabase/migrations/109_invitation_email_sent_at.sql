-- ============================================================
-- Track whether an email-targeted invite (108) actually got a
-- transactional email sent for it.
--
-- 108 shipped invite-by-email as auto-join-only, explicitly stating "no
-- email is sent" because no outbound mail sender existed anywhere in
-- the app. This adds one: POST /api/account/invitations now calls
-- Resend (src/lib/email/resend.ts) when `email` is set and
-- RESEND_API_KEY is configured, and stamps this column on success so
-- the admin's invite-created dialog and the Members list can show
-- "email sent" vs. "share this link yourself" instead of always
-- assuming the latter.
--
-- Nullable, no backfill needed: every existing row (created before
-- this feature existed) simply has no email ever sent for it, which
-- NULL already expresses correctly.
-- ============================================================

ALTER TABLE public.account_invitations
  ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
