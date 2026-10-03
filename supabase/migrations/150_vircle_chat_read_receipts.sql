-- ============================================================
-- 150_vircle_chat_read_receipts.sql
--
-- "Read" ticks back to the Vircle app (docs/vircle-chat-contract.md, version 1.2,
-- section 4.1).
--
--   1. public.widget_customer_messages_read() (migration 092) flips a conversation's
--      customer messages to `read` when an agent opens it (unread_count goes to 0).
--      It did that for the web widget only; it now does it for Vircle Chat too.
--      Same function, same trigger, same owner and grants: only the channel list grows.
--   2. messages.read_receipt_sent_at: when Halo told the gateway a customer message was
--      read. Null means "not told yet", so a call that failed is simply tried again and
--      a message is never reported twice.
--   3. A partial index on exactly the rows Halo looks for ("read here, gateway not told
--      yet", per conversation), so the lookup stays cheap however large `messages` grows.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Read ticks for Vircle Chat customer messages too
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.widget_customer_messages_read()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.messages
     SET status = 'read'
   WHERE conversation_id = NEW.id
     AND sender_type = 'customer'
     AND channel_type IN ('web_widget', 'vircle_chat')
     AND status IN ('sent', 'delivered');
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Ticks are cosmetic: never block the agent marking a chat read.
  RAISE WARNING 'widget_customer_messages_read failed for %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.widget_customer_messages_read() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.widget_customer_messages_read() TO service_role;

-- The trigger already exists (migration 092); re-created so this file also stands on its own.
DROP TRIGGER IF EXISTS conversations_widget_read_ticks ON public.conversations;
CREATE TRIGGER conversations_widget_read_ticks
  AFTER UPDATE OF unread_count ON public.conversations
  FOR EACH ROW
  WHEN (COALESCE(OLD.unread_count, 0) > 0 AND COALESCE(NEW.unread_count, 0) = 0)
  EXECUTE FUNCTION public.widget_customer_messages_read();

-- ------------------------------------------------------------
-- 2. When the gateway was told
-- ------------------------------------------------------------
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS read_receipt_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.messages.read_receipt_sent_at IS
  'Vircle Chat: when Halo told the gateway an agent had read this customer message (POST /v1/receipts). NULL = not told yet.';

-- ------------------------------------------------------------
-- 3. The lookup: read here, gateway not told yet
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS messages_vircle_read_receipt_pending_idx
  ON public.messages (conversation_id, created_at)
  WHERE channel_type = 'vircle_chat'
    AND sender_type = 'customer'
    AND status = 'read'
    AND read_receipt_sent_at IS NULL;

NOTIFY pgrst, 'reload schema';
