-- ============================================================
-- 071_ai_base_url_check_fix
--
-- Corrects the base_url CHECK added in 070. As first written it let an
-- OpenAI-compatible provider be saved with base_url NULL: the regex test
-- evaluated to NULL, and a CHECK that evaluates to NULL passes. The
-- constraint is re-created with the NULL handled explicitly (070's own
-- text now carries the same fix for fresh installs).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_base_url_shape;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_base_url_shape
  CHECK (
    CASE WHEN provider = 'openai_compatible'
         THEN COALESCE(base_url ~ '^https://[^\s]+$', FALSE)
         ELSE base_url IS NULL
    END
  );
