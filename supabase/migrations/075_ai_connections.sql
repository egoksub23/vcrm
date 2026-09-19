-- ============================================================
-- 075_ai_connections
--
-- AI Connections, phase 2: more than one provider connection, a routing
-- table that sends each AI job to the connection (and model) that suits
-- it, a monthly token budget, and a health status per connection.
--
--   ai_configs (existing)   stays the account's DEFAULT connection and
--                           its shared settings (business context,
--                           auto-reply, handoff, embeddings). Nothing is
--                           migrated, so nothing existing can break.
--   ai_connections          additional named connections (encrypted key).
--   ai_task_routing         per job: which connection, an optional model
--                           override, on/off. No row = default connection.
--                           Jobs: draft, auto_reply, auto_label,
--                           closing_note, summary.
--   budget                  ai_configs.monthly_token_budget; usage is
--                           summed from ai_usage_log for the month, with a
--                           one-time admin notification at 80%.
--   health                  last test result per connection, so a revoked
--                           key shows up before an agent hits it.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- Additional connections
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name                text NOT NULL,
  provider            text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'openai_compatible')),
  base_url            text,
  model               text NOT NULL,
  -- AES-256-GCM, same as ai_configs.api_key.
  api_key             text NOT NULL,
  data_notice_ack_at  timestamptz,
  health_status       text NOT NULL DEFAULT 'untested' CHECK (health_status IN ('untested', 'ok', 'error')),
  health_checked_at   timestamptz,
  health_error        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- An OpenAI-compatible connection needs an https URL. NULL passes a CHECK,
-- so the expression is made non-NULL (the lesson of migration 071).
ALTER TABLE ai_connections DROP CONSTRAINT IF EXISTS ai_connections_base_url_check;
ALTER TABLE ai_connections ADD CONSTRAINT ai_connections_base_url_check CHECK (
  CASE WHEN provider = 'openai_compatible'
       THEN COALESCE(base_url ~ '^https://[^\s]+$', FALSE)
       ELSE base_url IS NULL END
);

CREATE INDEX IF NOT EXISTS ai_connections_account_idx ON ai_connections (account_id);

ALTER TABLE ai_connections ENABLE ROW LEVEL SECURITY;
-- Admin+ only: even encrypted, keys are settings-class.
DROP POLICY IF EXISTS ai_connections_select ON ai_connections;
CREATE POLICY ai_connections_select ON ai_connections FOR SELECT USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_connections_insert ON ai_connections;
CREATE POLICY ai_connections_insert ON ai_connections FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_connections_update ON ai_connections;
CREATE POLICY ai_connections_update ON ai_connections FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_connections_delete ON ai_connections;
CREATE POLICY ai_connections_delete ON ai_connections FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS ai_connections_touch_updated_at ON ai_connections;
CREATE TRIGGER ai_connections_touch_updated_at BEFORE UPDATE ON ai_connections
  FOR EACH ROW EXECUTE FUNCTION public.touch_comments_updated_at();

-- ------------------------------------------------------------
-- Task routing
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_task_routing (
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  task            text NOT NULL CHECK (task IN ('draft', 'auto_reply', 'auto_label', 'closing_note', 'summary')),
  -- NULL = the account's default connection (ai_configs).
  connection_id   uuid REFERENCES ai_connections(id) ON DELETE SET NULL,
  -- Use this model instead of the connection's default for this job.
  model_override  text,
  enabled         boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, task)
);

ALTER TABLE ai_task_routing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_task_routing_select ON ai_task_routing;
CREATE POLICY ai_task_routing_select ON ai_task_routing FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS ai_task_routing_insert ON ai_task_routing;
CREATE POLICY ai_task_routing_insert ON ai_task_routing FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_task_routing_update ON ai_task_routing;
CREATE POLICY ai_task_routing_update ON ai_task_routing FOR UPDATE USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_task_routing_delete ON ai_task_routing;
CREATE POLICY ai_task_routing_delete ON ai_task_routing FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- Budget + health on the default connection
-- ------------------------------------------------------------
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS monthly_token_budget bigint,
  ADD COLUMN IF NOT EXISTS budget_alert_month   text,
  ADD COLUMN IF NOT EXISTS health_status        text NOT NULL DEFAULT 'untested',
  ADD COLUMN IF NOT EXISTS health_checked_at    timestamptz,
  ADD COLUMN IF NOT EXISTS health_error         text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_configs_budget_check') THEN
    ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_budget_check
      CHECK (monthly_token_budget IS NULL OR monthly_token_budget > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_configs_health_check') THEN
    ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_health_check
      CHECK (health_status IN ('untested', 'ok', 'error'));
  END IF;
END $$;

-- ------------------------------------------------------------
-- Usage log: which connection, and the two new jobs
-- ------------------------------------------------------------
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS connection_id uuid REFERENCES ai_connections(id) ON DELETE SET NULL;

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'ai_usage_log'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%mode%'
  LOOP
    EXECUTE format('ALTER TABLE ai_usage_log DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'auto_label', 'closing_note', 'summary'));

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_connection
  ON ai_usage_log (account_id, connection_id, created_at DESC);

-- Tokens spent so far this calendar month (UTC), for the budget check.
-- SECURITY INVOKER: RLS limits an admin caller to their own account; the
-- service role (bot, routes) bypasses RLS and passes the account id.
CREATE OR REPLACE FUNCTION public.ai_tokens_this_month(p_account_id uuid)
RETURNS bigint AS $$
  SELECT COALESCE(SUM(total_tokens), 0)::bigint
    FROM ai_usage_log
   WHERE account_id = p_account_id
     AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.ai_tokens_this_month(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_tokens_this_month(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Budget alert notification type
-- ------------------------------------------------------------
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'notifications'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%conversation_assigned%'
  LOOP
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'mention', 'ticket_assigned', 'ticket_mention', 'ai_budget'));
