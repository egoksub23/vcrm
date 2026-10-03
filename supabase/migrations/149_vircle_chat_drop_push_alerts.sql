-- ============================================================
-- 149_vircle_chat_drop_push_alerts.sql
--
-- Owner decision, 3 Oct 2026: for Vircle Chat the GATEWAY alone decides between a
-- live socket and a push, and calls the Vircle push API itself. Halo never sends a
-- push for Vircle Chat (docs/vircle-chat-contract.md, section 7), so the
-- "Push alerts from Halo" setting that migration 147 added has nothing left to
-- control.
--
--   1. Drop vircle_chat_config.push_alerts_enabled.
--   2. Re-create the audit trigger on vircle_chat_config without that column in
--      its tracked-column list (migration 147 named it).
--
-- Migration 147 itself is not edited. Idempotent.
-- ============================================================

ALTER TABLE public.vircle_chat_config DROP COLUMN IF EXISTS push_alerts_enabled;

DROP TRIGGER IF EXISTS audit_row_change ON public.vircle_chat_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.vircle_chat_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=Vircle Chat', '',
    'workspace_key,gateway_base_url,signing_secret,api_token,enabled',
    '', 'connected_by_user_id');

NOTIFY pgrst, 'reload schema';
