-- Verify migration 138. Self-contained, so it runs against an empty database as well as
-- production. Concatenate 138's migration text in front when the database does not have
-- it yet, then run it. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  r record;
  v_n int;
  v_ok boolean;
BEGIN
  -- 1. A budget of 3: three allowed, the fourth refused, remaining counts down.
  FOR i IN 1..3 LOOP
    SELECT * INTO r FROM public.rate_limit_hit('verify-138:a', 3, 60);
    IF NOT r.allowed OR r.remaining <> 3 - i THEN
      RAISE EXCEPTION 'FAIL call % allowed=% remaining=%', i, r.allowed, r.remaining;
    END IF;
  END LOOP;
  SELECT * INTO r FROM public.rate_limit_hit('verify-138:a', 3, 60);
  IF r.allowed OR r.remaining <> 0 THEN
    RAISE EXCEPTION 'FAIL fourth call should be refused with 0 remaining (allowed=% remaining=%)', r.allowed, r.remaining;
  END IF;
  IF r.reset_at <= now() THEN RAISE EXCEPTION 'FAIL reset_at should be in the future'; END IF;

  -- 2. Keys are independent.
  SELECT * INTO r FROM public.rate_limit_hit('verify-138:b', 3, 60);
  IF NOT r.allowed THEN RAISE EXCEPTION 'FAIL a different key shared the first key''s budget'; END IF;

  -- 3. A refused call spends nothing: a cost-5 call against a budget of 10 that has 8 used is
  --    refused, and a cost-2 call still fits afterwards.
  SELECT * INTO r FROM public.rate_limit_hit('verify-138:c', 10, 60, 8);
  IF NOT r.allowed OR r.remaining <> 2 THEN RAISE EXCEPTION 'FAIL cost 8 (allowed=% remaining=%)', r.allowed, r.remaining; END IF;
  SELECT * INTO r FROM public.rate_limit_hit('verify-138:c', 10, 60, 5);
  IF r.allowed THEN RAISE EXCEPTION 'FAIL cost 5 should not fit with 2 remaining'; END IF;
  IF r.remaining <> 2 THEN RAISE EXCEPTION 'FAIL a refused call changed the counter (remaining=%)', r.remaining; END IF;
  SELECT * INTO r FROM public.rate_limit_hit('verify-138:c', 10, 60, 2);
  IF NOT r.allowed OR r.remaining <> 0 THEN RAISE EXCEPTION 'FAIL cost 2 should still fit (allowed=% remaining=%)', r.allowed, r.remaining; END IF;

  -- 4. A single call bigger than the whole budget is refused and writes nothing.
  SELECT * INTO r FROM public.rate_limit_hit('verify-138:d', 5, 60, 6);
  IF r.allowed THEN RAISE EXCEPTION 'FAIL cost above the whole limit was allowed'; END IF;
  SELECT count(*) INTO v_n FROM public.rate_limit_buckets WHERE key = 'verify-138:d';
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL an oversized call left a counter row'; END IF;

  -- 5. An expired window starts a new budget.
  UPDATE public.rate_limit_buckets SET window_end = now() - interval '1 second' WHERE key = 'verify-138:a';
  SELECT * INTO r FROM public.rate_limit_hit('verify-138:a', 3, 60);
  IF NOT r.allowed OR r.remaining <> 2 THEN RAISE EXCEPTION 'FAIL expired window did not reset (allowed=% remaining=%)', r.allowed, r.remaining; END IF;

  -- 6. Bad arguments are rejected.
  BEGIN
    PERFORM * FROM public.rate_limit_hit('', 3, 60);
    RAISE EXCEPTION 'FAIL empty key accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.rate_limit_hit('verify-138:e', 0, 60);
    RAISE EXCEPTION 'FAIL zero limit accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- 7. Only the service role can call it, and nobody can read the table.
  SELECT has_function_privilege('anon', 'public.rate_limit_hit(text,integer,integer,integer)', 'EXECUTE')
      OR has_function_privilege('authenticated', 'public.rate_limit_hit(text,integer,integer,integer)', 'EXECUTE')
    INTO v_ok;
  IF v_ok THEN RAISE EXCEPTION 'FAIL anon or authenticated can execute rate_limit_hit'; END IF;
  IF NOT has_function_privilege('service_role', 'public.rate_limit_hit(text,integer,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL service_role cannot execute rate_limit_hit';
  END IF;
  IF has_table_privilege('authenticated', 'public.rate_limit_buckets', 'SELECT')
     OR has_table_privilege('anon', 'public.rate_limit_buckets', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL a client role can read rate_limit_buckets';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: fixed-window counter counts down and refuses at the limit; keys are independent; a refused call spends nothing; an oversized call writes nothing; expired windows reset; only service_role can call it';
END
$verify$;
