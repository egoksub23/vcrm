-- ============================================================
-- 179: use a connected mailbox for the customer care inbox, or not, independently of whether the mailbox is paused.
--
-- Until now a connected mailbox (Settings > Channels > Email for Microsoft 365, > Gmail for Gmail) had ONE switch, `enabled` (migration 097): off
-- dropped the mail coming in AND blocked the mail going out. A workspace that wants its support@ address to send Halo's own email (Secure Sign,
-- invitations, notifications) but does NOT want that mailbox's mail in the Halo Inbox had no way to say so.
--
-- Two independent switches now:
--   inbox_enabled  NEW. "Use this mailbox for the customer care inbox." false = nothing new is ingested into the Inbox (the change-notification
--                  subscription / push watch is stopped by the application), and the Inbox does not offer email to reply with. Conversations and
--                  messages already in the Inbox stay as history. Turning it back on starts ingesting from that moment; nothing is back-filled.
--   enabled        (097) keeps its meaning as the MASTER pause for the whole mailbox: nothing in, nothing out. The saved token stays.
-- Halo may send its own email through the mailbox whenever it is connected, does not need reconnecting, and `enabled` is true, whatever
-- `inbox_enabled` says.
--
-- Every existing row reads true: a mailbox connected before this keeps receiving into the Inbox exactly as it did.
--
-- Also here:
--   * the audit triggers on email_config and gmail_config record the from/to of `enabled` and `inbox_enabled` (082 named only secrets and status,
--     so flipping either switch left no trace in the audit trail);
--   * onboarding_status() no longer counts a mailbox whose inbox is switched off as "a channel customers write to".
--
-- RLS and grants are unchanged and are the tables' own (056, 058, 079): any member reads, channels.manage writes, the service role does the rest.
-- Idempotent.
-- ============================================================

ALTER TABLE public.email_config ADD COLUMN IF NOT EXISTS inbox_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.gmail_config ADD COLUMN IF NOT EXISTS inbox_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.email_config.inbox_enabled IS 'Use this mailbox for the customer care inbox. false = no new mail is ingested (the Graph change-notification subscription is deleted and subscription_id is NULL), the Inbox does not offer email replies, existing conversations stay as history. Independent of enabled. Turning it on again creates a new subscription and ingests from then on; nothing is back-filled.';
COMMENT ON COLUMN public.email_config.enabled IS 'Master pause for the whole mailbox, independent of status and of inbox_enabled. false = nothing in (inbound notifications are dropped) and nothing out (Inbox replies and Halo''s own email are blocked). The token and subscription stay intact.';
COMMENT ON COLUMN public.gmail_config.inbox_enabled IS 'Use this mailbox for the customer care inbox. false = no new mail is ingested (the Gmail push watch is stopped and watch_expiration is NULL), the Inbox does not offer email replies, existing conversations stay as history. Independent of enabled. Turning it on again starts a new watch and ingests from then on; nothing is back-filled.';
COMMENT ON COLUMN public.gmail_config.enabled IS 'Master pause for the whole mailbox, independent of status and of inbox_enabled. false = nothing in (inbound push notifications are dropped) and nothing out (Inbox replies and Halo''s own email are blocked). The token and watch stay intact.';

-- ------------------------------------------------------------
-- Audit: the two switches are recorded with their from/to values (booleans, never a secret). The names-only list is 082's, unchanged.
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS audit_row_change ON public.email_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.email_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=Email', 'enabled,inbox_enabled',
    'mailbox_user_id,mailbox_address,refresh_token,status', '', 'connected_by_user_id');

DROP TRIGGER IF EXISTS audit_row_change ON public.gmail_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.gmail_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=Gmail', 'enabled,inbox_enabled',
    'email_address,refresh_token,pubsub_verify_token,status', '', 'connected_by_user_id');

-- ------------------------------------------------------------
-- First-run checklist: "a channel" is somewhere customers write to. A mailbox that only sends Halo's own email (inbox off) is not.
-- Everything else in this function is 155's, unchanged.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.onboarding_status(p_account UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_channel BOOLEAN := false;
  t         TEXT;
  v_inbox   TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_account_member(p_account) THEN
    RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
  END IF;

  -- A channel counts once it is connected: WhatsApp when its status says so, the web widget
  -- once it is switched on, every other channel as soon as its connection exists. A mailbox
  -- (Email, Gmail) counts only while it is used for the customer care inbox.
  v_channel := EXISTS (SELECT 1 FROM public.whatsapp_config c WHERE c.account_id = p_account AND c.status = 'connected')
            OR EXISTS (SELECT 1 FROM public.web_widget_config c WHERE c.account_id = p_account AND c.enabled);
  IF NOT v_channel THEN
    FOREACH t IN ARRAY ARRAY['messenger_config', 'instagram_config', 'email_config', 'gmail_config', 'tiktok_config', 'vircle_chat_config'] LOOP
      IF to_regclass('public.' || t) IS NOT NULL THEN
        v_inbox := CASE WHEN t IN ('email_config', 'gmail_config') THEN ' AND c.inbox_enabled' ELSE '' END;
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I c WHERE c.account_id = $1%s)', t, v_inbox) INTO v_channel USING p_account;
        EXIT WHEN v_channel;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'has_channel',   v_channel,
    'has_team',      (SELECT count(*) FROM public.profiles p WHERE p.account_id = p_account) > 1
                     OR EXISTS (SELECT 1 FROM public.account_invitations i WHERE i.account_id = p_account),
    'has_contacts',  EXISTS (SELECT 1 FROM public.contacts c WHERE c.account_id = p_account AND c.deleted_at IS NULL),
    'has_replies',   EXISTS (SELECT 1 FROM public.quick_replies q WHERE q.account_id = p_account AND q.deleted_at IS NULL),
    'has_hours',     EXISTS (SELECT 1 FROM public.business_hours_schedules s WHERE s.account_id = p_account),
    'has_knowledge', EXISTS (SELECT 1 FROM public.ai_knowledge_documents d WHERE d.account_id = p_account AND d.deleted_at IS NULL),
    'dismissed',     EXISTS (SELECT 1 FROM public.account_onboarding o WHERE o.account_id = p_account AND o.dismissed_at IS NOT NULL)
  );
END;
$$;
ALTER FUNCTION public.onboarding_status(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.onboarding_status(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.onboarding_status(UUID) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
