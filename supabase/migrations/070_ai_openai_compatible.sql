-- ============================================================
-- 070_ai_openai_compatible
--
-- AI Connections, phase 1: let an account link Vircle to any provider
-- that speaks the OpenAI chat-completions dialect (Kimi / Moonshot,
-- DeepSeek, a self-hosted gateway…), not just OpenAI and Anthropic.
--
--   ai_configs.provider   gains 'openai_compatible'.
--   ai_configs.base_url   the provider's API root ("https://api.moonshot.ai/v1").
--                         Required for 'openai_compatible', NULL otherwise.
--                         https only — the app also refuses private hosts
--                         before saving or testing (SSRF guard).
--   data_notice_ack_*     an admin acknowledged that customer messages
--                         will be sent to that third party. Recorded once
--                         per host; the API refuses to save a compatible
--                         provider without it.
--   ai_usage_log.provider gains the same value, otherwise usage rows for
--                         a compatible provider would be rejected.
--
-- The existing provider CHECK constraints are found in pg_constraint and
-- dropped by name lookup rather than guessing their generated names.
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.ai_configs'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%provider%'
  LOOP
    EXECUTE format('ALTER TABLE public.ai_configs DROP CONSTRAINT %I', c.conname);
  END LOOP;

  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.ai_usage_log'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%provider%'
  LOOP
    EXECUTE format('ALTER TABLE public.ai_usage_log DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS base_url TEXT,
  ADD COLUMN IF NOT EXISTS data_notice_ack_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS data_notice_ack_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openai_compatible'));

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_base_url_shape;
-- COALESCE matters: a CHECK passes when it evaluates to NULL, and a missing
-- base_url makes the regex test NULL, which would let a compatible
-- provider be saved with no URL at all.
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_base_url_shape
  CHECK (
    CASE WHEN provider = 'openai_compatible'
         THEN COALESCE(base_url ~ '^https://[^\s]+$', FALSE)
         ELSE base_url IS NULL
    END
  );

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openai_compatible'));
