-- ============================================================
-- 138: shared rate-limit counters.
--
-- src/lib/rate-limit.ts keeps its counters in one Node process, so a second
-- app instance (or a restart) hands every caller a fresh budget, and nothing
-- bounds a workspace as a whole (one workspace could mint many API keys, or
-- have many agents, each under their own per-user limit). This adds a counter
-- every instance shares. The app calls rate_limit_hit() for the budgets that
-- protect the platform from a single workspace: sends, broadcasts, public API,
-- AI, widget traffic per token, and the per-day broadcast recipient cap. The
-- in-memory limiter stays for cheap per-user / per-IP checks, and is also the
-- fallback if this call ever fails.
--
-- The table is UNLOGGED (counters are disposable; a crash resets budgets, which
-- fails open, never blocks) and holds only expiring counters.
-- ============================================================

CREATE UNLOGGED TABLE IF NOT EXISTS public.rate_limit_buckets (
  key        TEXT PRIMARY KEY,
  window_end TIMESTAMPTZ NOT NULL,
  count      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_buckets_window_end_idx
  ON public.rate_limit_buckets (window_end);

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: only the function below touches the table.
REVOKE ALL ON public.rate_limit_buckets FROM PUBLIC, anon, authenticated;

-- Fixed-window counter, atomic under concurrency.
--   p_cost > 1 spends several units at once (a broadcast of N recipients).
--   A refused call spends nothing, so a batch that does not fit is not charged
--   and a smaller one can still go through.
--   A single call whose cost exceeds the whole limit is always refused.
CREATE OR REPLACE FUNCTION public.rate_limit_hit(
  p_key            TEXT,
  p_limit          INTEGER,
  p_window_seconds INTEGER,
  p_cost           INTEGER DEFAULT 1
)
RETURNS TABLE (allowed BOOLEAN, remaining INTEGER, reset_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now   timestamptz := clock_timestamp();
  v_end   timestamptz;
  v_count integer;
BEGIN
  IF p_key IS NULL OR p_key = '' OR p_limit < 1 OR p_window_seconds < 1 OR p_cost < 1 THEN
    RAISE EXCEPTION 'rate_limit_hit: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- Disposable housekeeping, about once per hundred calls.
  IF random() < 0.01 THEN
    DELETE FROM public.rate_limit_buckets WHERE window_end < v_now - interval '1 hour';
  END IF;

  IF p_cost > p_limit THEN
    SELECT b.window_end, b.count INTO v_end, v_count
    FROM public.rate_limit_buckets b WHERE b.key = p_key AND b.window_end > v_now;
    RETURN QUERY SELECT false, GREATEST(p_limit - COALESCE(v_count, 0), 0),
                        COALESCE(v_end, v_now + make_interval(secs => p_window_seconds));
    RETURN;
  END IF;

  INSERT INTO public.rate_limit_buckets AS b (key, window_end, count)
  VALUES (p_key, v_now + make_interval(secs => p_window_seconds), p_cost)
  ON CONFLICT (key) DO UPDATE
    SET window_end = CASE WHEN b.window_end <= v_now
                          THEN v_now + make_interval(secs => p_window_seconds)
                          ELSE b.window_end END,
        count      = CASE WHEN b.window_end <= v_now THEN p_cost ELSE b.count + p_cost END
    WHERE b.window_end <= v_now OR b.count + p_cost <= p_limit
  RETURNING b.window_end, b.count INTO v_end, v_count;

  IF FOUND THEN
    RETURN QUERY SELECT true, p_limit - v_count, v_end;
    RETURN;
  END IF;

  -- Over budget: report the open window without spending anything.
  SELECT b.window_end, b.count INTO v_end, v_count
  FROM public.rate_limit_buckets b WHERE b.key = p_key;
  RETURN QUERY SELECT false, GREATEST(p_limit - COALESCE(v_count, 0), 0),
                      COALESCE(v_end, v_now + make_interval(secs => p_window_seconds));
END;
$$;
ALTER FUNCTION public.rate_limit_hit(TEXT, INTEGER, INTEGER, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.rate_limit_hit(TEXT, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(TEXT, INTEGER, INTEGER, INTEGER) TO service_role;
