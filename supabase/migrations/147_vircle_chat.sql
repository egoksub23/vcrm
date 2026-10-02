-- ============================================================
-- 147_vircle_chat.sql
--
-- Vircle Chat, phase 1: a channel for the in-app customer chat of the Vircle
-- app, carried by a gateway the Vircle app backend runs
-- (docs/vircle-chat-contract.md).
--
--   1. `vircle_chat` becomes a channel type on messages and conversations.
--   2. `vircle_chat_config`: one connection per workspace (the workspace key,
--      the gateway address, the signing secret Halo verifies webhooks with and
--      the API token Halo calls the gateway with; both encrypted by the app).
--      Same `enabled` pause switch as every channel.
--   3. `vircle_chat_events`: the event ids already handled, so a retried or
--      replayed webhook does nothing twice.
--   4. `conversations.vircle_conversation_id`: the gateway's id for the
--      conversation, so a later outbound message carries it.
--   5. A platform feature flag `vircle_chat`: off for every new workspace
--      (only a customer with its own app and gateway can use it), on for the
--      workspaces that exist today. The operator switches it per workspace.
--   6. Suspending a workspace pauses this channel too (migration 132's
--      function, with the new table in its list).
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Channel type
-- ------------------------------------------------------------
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_channel_type_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_channel_type_check
  CHECK (channel_type IN ('whatsapp', 'web_widget', 'messenger', 'instagram', 'email', 'gmail', 'vircle_chat'));

ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_last_channel_type_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_last_channel_type_check
  CHECK (last_channel_type IN ('whatsapp', 'web_widget', 'messenger', 'instagram', 'email', 'gmail', 'vircle_chat'));

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS vircle_conversation_id TEXT;
COMMENT ON COLUMN public.conversations.vircle_conversation_id IS
  'The chat gateway''s id for this conversation (Vircle Chat). Learned from an inbound event, sent with outbound messages.';

-- ------------------------------------------------------------
-- 2. Per-workspace connection
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vircle_chat_config (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Public identifier the gateway puts in every event; the workspace is found from it,
  -- never from anything else in the body.
  workspace_key        TEXT NOT NULL,
  gateway_base_url     TEXT NOT NULL CHECK (gateway_base_url ~ '^https?://' AND length(gateway_base_url) <= 300),
  -- Encrypted by the app (same key ring as every channel secret).
  signing_secret       TEXT NOT NULL,
  api_token            TEXT NOT NULL,
  -- Ask the Vircle push API to alert a user whose message was only queued (contract section 7).
  push_alerts_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Manual pause switch, like every channel (097). false = inbound events are acknowledged and
  -- dropped, outbound sends are refused. Suspending a workspace sets it (132).
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  last_inbound_at      TIMESTAMPTZ,
  last_error           TEXT,
  connected_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vircle_chat_config_account_key UNIQUE (account_id),
  CONSTRAINT vircle_chat_config_workspace_key_key UNIQUE (workspace_key),
  CONSTRAINT vircle_chat_config_workspace_key_check CHECK (workspace_key ~ '^vcw_[A-Za-z0-9_-]{16,64}$')
);

ALTER TABLE public.vircle_chat_config ENABLE ROW LEVEL SECURITY;

-- The ciphertexts are only readable by people who may manage channels.
DROP POLICY IF EXISTS vircle_chat_config_select ON public.vircle_chat_config;
DROP POLICY IF EXISTS vircle_chat_config_insert ON public.vircle_chat_config;
DROP POLICY IF EXISTS vircle_chat_config_update ON public.vircle_chat_config;
DROP POLICY IF EXISTS vircle_chat_config_delete ON public.vircle_chat_config;
CREATE POLICY vircle_chat_config_select ON public.vircle_chat_config
  FOR SELECT USING (has_capability(account_id, 'channels.manage'));
CREATE POLICY vircle_chat_config_insert ON public.vircle_chat_config
  FOR INSERT WITH CHECK (has_capability(account_id, 'channels.manage'));
CREATE POLICY vircle_chat_config_update ON public.vircle_chat_config
  FOR UPDATE USING (has_capability(account_id, 'channels.manage'));
CREATE POLICY vircle_chat_config_delete ON public.vircle_chat_config
  FOR DELETE USING (has_capability(account_id, 'channels.manage'));

DROP TRIGGER IF EXISTS set_updated_at ON public.vircle_chat_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.vircle_chat_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS audit_row_change ON public.vircle_chat_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.vircle_chat_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=Vircle Chat', '',
    'workspace_key,gateway_base_url,signing_secret,api_token,push_alerts_enabled,enabled',
    '', 'connected_by_user_id');

-- ------------------------------------------------------------
-- 3. Events already handled (service role only: RLS on, no policy)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vircle_chat_events (
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, event_id)
);
CREATE INDEX IF NOT EXISTS vircle_chat_events_received_idx ON public.vircle_chat_events (received_at);
ALTER TABLE public.vircle_chat_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vircle_chat_events FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Feature flag
-- ------------------------------------------------------------
UPDATE public.account_platform
SET features = features || '{"vircle_chat": true}'::jsonb
WHERE NOT (features ? 'vircle_chat');

CREATE OR REPLACE FUNCTION public.account_platform_seed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.account_platform (account_id, features)
  VALUES (NEW.id, '{"incidents": false, "jira": false, "vircle_chat": false}'::jsonb)
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block signup; readers treat a missing row as active/all-features.
  RAISE WARNING 'account_platform_seed failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.account_platform_seed() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_platform_seed() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 6. Suspension pauses this channel too (migration 132's function, one more table)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_set_account_status(
  p_account UUID,
  p_status  TEXT,
  p_reason  TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tbl      TEXT;
  v_ids      UUID[];
  v_snapshot JSONB := '{}'::jsonb;
  v_prev     JSONB;
  v_current  TEXT;
BEGIN
  PERFORM public.platform_require_admin();
  IF p_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'status must be active or suspended' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account) THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = '22023';
  END IF;

  -- An operator must not lock themselves out of the console.
  IF p_status = 'suspended' AND EXISTS (
    SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND account_id = p_account
  ) THEN
    RAISE EXCEPTION 'You cannot suspend your own workspace' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.account_platform (account_id) VALUES (p_account)
  ON CONFLICT (account_id) DO NOTHING;

  SELECT status, paused_channels INTO v_current, v_prev
    FROM public.account_platform WHERE account_id = p_account FOR UPDATE;

  IF v_current = p_status THEN
    RETURN;  -- already there; do not overwrite the snapshot
  END IF;

  IF p_status = 'suspended' THEN
    FOREACH v_tbl IN ARRAY ARRAY['whatsapp_config', 'messenger_config', 'instagram_config',
                                 'email_config', 'gmail_config', 'tiktok_config', 'web_widget_config',
                                 'vircle_chat_config']
    LOOP
      EXECUTE format('SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) FROM public.%I WHERE account_id = $1 AND enabled', v_tbl)
        INTO v_ids USING p_account;
      v_snapshot := v_snapshot || jsonb_build_object(v_tbl, to_jsonb(v_ids));
      EXECUTE format('UPDATE public.%I SET enabled = false WHERE account_id = $1 AND enabled', v_tbl)
        USING p_account;
    END LOOP;

    UPDATE public.account_platform
       SET status = 'suspended', suspended_at = NOW(), suspended_reason = NULLIF(btrim(p_reason), ''),
           paused_channels = v_snapshot
     WHERE account_id = p_account;
  ELSE
    IF v_prev IS NOT NULL THEN
      FOR v_tbl IN SELECT jsonb_object_keys(v_prev) LOOP
        SELECT COALESCE(array_agg(x::uuid), ARRAY[]::uuid[])
          INTO v_ids FROM jsonb_array_elements_text(v_prev -> v_tbl) AS x;
        EXECUTE format('UPDATE public.%I SET enabled = true WHERE account_id = $1 AND id = ANY ($2)', v_tbl)
          USING p_account, v_ids;
      END LOOP;
    END IF;

    UPDATE public.account_platform
       SET status = 'active', suspended_at = NULL, suspended_reason = NULL, paused_channels = NULL
     WHERE account_id = p_account;
  END IF;

  BEGIN
    PERFORM public.log_audit(
      p_account, 'updated', 'account_platform', p_account, 'Account ' || p_status,
      jsonb_build_object('status', p_status, 'reason', NULLIF(btrim(p_reason), '')));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'platform_set_account_status audit failed: %', SQLERRM;
  END;
END;
$$;
ALTER FUNCTION public.platform_set_account_status(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_set_account_status(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_account_status(UUID, TEXT, TEXT) TO authenticated, service_role;
