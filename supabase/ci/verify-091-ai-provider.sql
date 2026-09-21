-- Run together with the migration (concatenate the two files); ends in a
-- deliberate error so nothing is kept.
DO $$
DECLARE
  v_account uuid;
  v_total   bigint;
  v_type    text;
BEGIN
  -- Both columns exist, are integer and nullable.
  SELECT count(*) INTO v_total
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'ai_usage_log'
     AND column_name IN ('cache_read_tokens', 'cache_write_tokens')
     AND data_type = 'integer' AND is_nullable = 'YES';
  IF v_total <> 2 THEN
    RAISE EXCEPTION 'FAIL expected 2 nullable integer cache columns, found %', v_total;
  END IF;

  -- Idempotent: the migration can be applied twice.
  ALTER TABLE ai_usage_log
    ADD COLUMN IF NOT EXISTS cache_read_tokens  integer,
    ADD COLUMN IF NOT EXISTS cache_write_tokens integer;

  -- The budget sum ignores the cache columns: it counts total_tokens only.
  SELECT id INTO v_account FROM accounts LIMIT 1;
  IF v_account IS NOT NULL THEN
    v_total := ai_tokens_this_month(v_account);
    INSERT INTO ai_usage_log (account_id, mode, provider, model,
                              prompt_tokens, completion_tokens, total_tokens,
                              cache_read_tokens, cache_write_tokens)
    VALUES (v_account, 'draft', 'anthropic', 'claude-haiku-4-5', 5000, 100, 5100, 4000, 900);
    IF ai_tokens_this_month(v_account) <> v_total + 5100 THEN
      RAISE EXCEPTION 'FAIL budget must count total_tokens only (cache columns must not add to it)';
    END IF;
    -- A row without cache numbers still inserts (NULLs).
    INSERT INTO ai_usage_log (account_id, mode, provider, model,
                              prompt_tokens, completion_tokens, total_tokens)
    VALUES (v_account, 'draft', 'openai', 'gpt-5-mini', 10, 5, 15);
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: cache columns added, budget sum unchanged';
END $$;
