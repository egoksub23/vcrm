-- ============================================================
-- 091_ai_provider
--
-- Anthropic prompt caching: record how many input tokens of a call were
-- served from the cache (read) and written to it (write).
--
-- Both are SUBSETS of prompt_tokens, kept for the usage report only. The
-- monthly budget is unchanged: ai_tokens_this_month() sums total_tokens, and
-- prompt_tokens (hence total_tokens) already includes every cached token, so
-- the budget stays as conservative as before caching.
--
-- Nullable, no default: existing rows and calls with no caching stay NULL.
-- Additive and idempotent. The app tolerates a database without these columns
-- (it logs the row without them), so the order of deploy and migration does
-- not matter.
-- ============================================================

ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS cache_read_tokens  integer,
  ADD COLUMN IF NOT EXISTS cache_write_tokens integer;

COMMENT ON COLUMN ai_usage_log.cache_read_tokens IS
  'Input tokens served from the provider prompt cache (subset of prompt_tokens).';
COMMENT ON COLUMN ai_usage_log.cache_write_tokens IS
  'Input tokens written to the provider prompt cache (subset of prompt_tokens).';
