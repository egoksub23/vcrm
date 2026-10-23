-- ============================================================
-- 193_vircle_chat_history_days.sql
--
-- Vircle Chat: older messages for the app. The app asks the gateway for messages older than what it holds on the phone and the gateway asks Halo
-- (POST /api/vircle-chat/history, docs/vircle-chat-contract.md section 3.5). How far back Halo answers is a setting of the workspace's Vircle Chat connection:
--
--   * history_days: whole days from now. 90 by default (the owner's decision, 21 Oct 2026), 1 to 365. A message older than that is never returned and the app
--     is told the conversation goes further back than it may show ("window").
--
-- Nothing else changes: no table, policy or grant is added (the column is read and written through the connection's own policies, channels.manage). The audit
-- trigger of the connection now also records a change of the setting. Apply BEFORE the code that reads the column is deployed. Idempotent.
-- ============================================================

ALTER TABLE public.vircle_chat_config
  ADD COLUMN IF NOT EXISTS history_days integer NOT NULL DEFAULT 90;

ALTER TABLE public.vircle_chat_config DROP CONSTRAINT IF EXISTS vircle_chat_config_history_days_check;
ALTER TABLE public.vircle_chat_config
  ADD CONSTRAINT vircle_chat_config_history_days_check CHECK (history_days BETWEEN 1 AND 365);

COMMENT ON COLUMN public.vircle_chat_config.history_days IS
  'How many days back Halo answers the app''s requests for older messages (contract 3.5). 90 by default, 1 to 365.';

DROP TRIGGER IF EXISTS audit_row_change ON public.vircle_chat_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.vircle_chat_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=Vircle Chat', '',
    'workspace_key,gateway_base_url,signing_secret,api_token,enabled,history_days',
    '', 'connected_by_user_id');

NOTIFY pgrst, 'reload schema';
