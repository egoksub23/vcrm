-- ============================================================
-- 127_message_send_followups
--
-- Two follow-up gaps on the failed-send feature (094):
--
--   1. conversations.last_message_failed — the conversation list has no
--      way to show "Not sent" today, because failSend() deliberately
--      never touches last_message_text/at (a message that didn't go
--      out must not read as a reply). This is a separate flag, set only
--      by the new shared insertFailedMessageRow() helper and cleared on
--      the next successful send — it never changes what the preview
--      text itself says.
--
--   2. messages.sending_locked_at + sweep_stuck_sending_messages() — the
--      Resend route's claim step (failed -> sending) can leave a row
--      stuck at 'sending' forever if the server dies between the claim
--      and the outcome. Mirrors broadcast_resume.ts's existing
--      staleness-lock pattern for the identical class of bug (an
--      abandoned in-flight state from a closed tab/crashed process).
--
-- Idempotent — safe to run more than once.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_message_failed BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS sending_locked_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.sweep_stuck_sending_messages(p_stale_minutes integer DEFAULT 10)
RETURNS TABLE (recovered integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH stuck AS (
    SELECT id FROM messages
     WHERE status = 'sending'
       AND sending_locked_at IS NOT NULL
       AND sending_locked_at < now() - make_interval(mins => GREATEST(p_stale_minutes, 1))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE messages m
     SET status = 'failed',
         error_code = NULL,
         error_title = 'Send was interrupted',
         error_details = 'The server did not confirm this send finished in time. You can resend it.',
         sending_locked_at = NULL
    FROM stuck
   WHERE m.id = stuck.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN QUERY SELECT v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_stuck_sending_messages(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_stuck_sending_messages(integer) TO service_role;

NOTIFY pgrst, 'reload schema';
