-- ============================================================
-- Web Widget: email-code verification (activates the `email_code`
-- mode of `web_widget_config.verification_mode`, stored since
-- migration 092 but never implemented — the API route only allowed
-- switching TO 'none' until now).
--
-- Flow: a visitor types a phone (and/or email) on the "I am already a
-- user" screen. The server looks the phone up against CRM contacts
-- WITHOUT creating or merging anything yet, and — only if it finds a
-- real match with an email on file — sends a 6-digit code to that
-- contact's email (not necessarily the email the visitor typed) and
-- stores this table's row. The visitor is granted nothing until they
-- prove they received it: entering the code is what makes the browser
-- `verified` (identity_source = 'code'), the same trust tier a signed
-- in-app token gets, and the same permission to auto-merge two real
-- contacts (see src/lib/widget/identity-resolve.ts's decision table).
--
-- Deliberately does NOT touch web_widget_config or widget_visitors —
-- both already have every column this needs (verification_mode since
-- 092; identity_level/identity_source/identity_verified_at since 092
-- already accept 'verified'/'code').
--
-- 1. widget_verification_codes — one pending code per browser
--    (widget_visitor_id is the PK: a new claim overwrites any
--    previous pending code for that browser, which is also how
--    "resend the code" works — no separate resend endpoint needed).
--    Service-role only, same as widget_visitors and
--    oauth_pending_connections: no client can read a hash or even
--    know a code exists for someone else's browser.
-- 2. widget_reply_notifications — one row per conversation, tracking
--    the last time we emailed a verified widget visitor "you have a
--    new reply" (see docs/web-chat-widget.md's new "Notifying a
--    visitor who has left" section). Also service-role only.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.widget_verification_codes (
  widget_visitor_id UUID PRIMARY KEY,
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  widget_config_id  UUID NOT NULL REFERENCES public.web_widget_config(id) ON DELETE CASCADE,
  contact_id        UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  destination_email TEXT NOT NULL,
  code_hash         TEXT NOT NULL,
  attempts          INT NOT NULL DEFAULT 0,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.widget_verification_codes ENABLE ROW LEVEL SECURITY;
-- No CREATE POLICY at all, on purpose: nothing but the service-role
-- key (the widget's own API routes) ever reads or writes this table.

CREATE TABLE IF NOT EXISTS public.widget_reply_notifications (
  conversation_id UUID PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  notified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.widget_reply_notifications ENABLE ROW LEVEL SECURITY;
-- Same as above: service-role only, no client policy.
