-- ============================================================
-- 094_message_failed_sends — keep a message that could not be sent, show
-- why, and let an agent resend it
--
-- Until now, when the channel (Meta Cloud API, Messenger, Instagram, mail)
-- rejected a send while the agent clicked Send, the message was never saved:
-- the agent saw a toast that disappeared and nothing in the chat. The app now
-- saves that message as a row with status = 'failed' plus the reason in the
-- columns migration 042 already added (error_code / error_title /
-- error_details), so it stays in the chat as a red "Not sent" bubble with
-- Resend and Delete. Nothing to widen for that: messages.status already allows
-- 'failed' (migration 001), message_id stays NULL for such a row (the unique
-- index of migration 037 treats NULLs as distinct), and the write policies
-- (088: messages.send) already cover the resend's update and delete.
--
-- What this migration does
--   1. messages.send_payload (JSONB, nullable): what a resend needs that the
--      existing columns do not carry — a template's language and parameters, a
--      document's file name. Written by the app only when there is something to
--      store (plain text never touches it), so text sends keep working even if
--      this is applied late.
--   2. The web-widget visitor's read policy on messages now hides 'failed'
--      rows. A merged conversation can hold WhatsApp and web-chat messages, and
--      the visitor reads every non-internal message in their own conversation
--      (048). A message that never left the WhatsApp channel must not appear in
--      the visitor's chat, and its provider error text is for agents only.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS send_payload JSONB;

COMMENT ON COLUMN public.messages.send_payload IS
  'What a resend of this outbound message needs beyond the other columns: '
  'template_language, template_params, template_message_params, filename. '
  'NULL for plain messages. Never shown to the customer.';

-- Same policy as migration 048, with 'failed' rows excluded.
DROP POLICY IF EXISTS messages_widget_visitor_select ON public.messages;
CREATE POLICY messages_widget_visitor_select ON public.messages FOR SELECT USING (
  is_internal IS NOT TRUE
  AND status IS DISTINCT FROM 'failed'
  AND EXISTS (
    SELECT 1 FROM conversations c
    JOIN widget_visitors wv ON wv.contact_id = c.contact_id
    WHERE c.id = messages.conversation_id
      AND wv.id = auth.uid()
  )
);
