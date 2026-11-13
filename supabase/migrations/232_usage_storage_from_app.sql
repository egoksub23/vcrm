-- ============================================================
-- 232: the daily usage job no longer reads Supabase's storage.objects.
--
-- Migration 152 added up each workspace's stored files with a query on
-- storage.objects, which only exists on Supabase. On our own server files live on
-- disk (or in MinIO), so that query failed every night with
--   relation "storage.objects" does not exist
-- and NO usage row was written at all (contacts, messages and AI tokens included).
--
-- Now the app measures the files itself (src/lib/storage/usage-measure.ts) and
-- hands the result to the job as one JSON object { "<workspace id>": bytes }.
--
--   p_storage given   -> each workspace gets its number (0 if it has no files)
--   p_storage NULL    -> measuring failed this time: the workspace keeps its
--                        last known storage figure, and every other counter is
--                        still written
--
-- The old one-argument function is dropped so there is a single usage_snapshot_run.
-- Everything else in the job is exactly as in 152.
--
-- Idempotent.
-- ============================================================

DROP FUNCTION IF EXISTS public.usage_snapshot_run(INTEGER);

CREATE OR REPLACE FUNCTION public.usage_snapshot_run(
  p_limit   INTEGER DEFAULT 200,
  p_storage JSONB   DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today       DATE := (now() AT TIME ZONE 'utc')::date;
  v_day_start   TIMESTAMPTZ := (now() AT TIME ZONE 'utc')::date::timestamp AT TIME ZONE 'utc';
  v_month_start TIMESTAMPTZ := date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc';
  v_done        INTEGER := 0;
  r             RECORD;
BEGIN
  -- Workspaces not yet measured today, the longest-unmeasured first (fair across many).
  FOR r IN
    SELECT a.id
      FROM public.accounts a
     WHERE public.account_is_active(a.id)
       AND NOT EXISTS (SELECT 1 FROM public.account_usage_daily d WHERE d.account_id = a.id AND d.day = v_today)
     ORDER BY (SELECT max(d.day) FROM public.account_usage_daily d WHERE d.account_id = a.id) NULLS FIRST, a.id
     LIMIT GREATEST(p_limit, 1)
  LOOP
    INSERT INTO public.account_usage_daily AS d
      (account_id, day, contacts, members, conversations, messages_out, messages_month,
       storage_bytes, ai_tokens, ai_tokens_month, measured_at)
    VALUES (
      r.id, v_today,
      (SELECT count(*) FROM public.contacts c WHERE c.account_id = r.id AND c.deleted_at IS NULL),
      (SELECT count(*) FROM public.profiles p WHERE p.account_id = r.id),
      (SELECT count(*) FROM public.conversations v WHERE v.account_id = r.id),
      (SELECT count(*) FROM public.messages m
        WHERE m.account_id = r.id AND m.created_at >= v_day_start
          AND m.sender_type IN ('agent', 'bot') AND NOT m.is_internal AND m.status <> 'failed'),
      (SELECT count(*) FROM public.messages m
        WHERE m.account_id = r.id AND m.created_at >= v_month_start
          AND m.sender_type IN ('agent', 'bot') AND NOT m.is_internal AND m.status <> 'failed'),
      CASE
        WHEN p_storage IS NULL THEN
          COALESCE((SELECT x.storage_bytes FROM public.account_usage_daily x
                     WHERE x.account_id = r.id ORDER BY x.day DESC LIMIT 1), 0)
        ELSE COALESCE((p_storage ->> r.id::text)::bigint, 0)
      END,
      COALESCE((SELECT sum(l.total_tokens) FROM public.ai_usage_log l WHERE l.account_id = r.id AND l.created_at >= v_day_start), 0),
      COALESCE((SELECT sum(l.total_tokens) FROM public.ai_usage_log l WHERE l.account_id = r.id AND l.created_at >= v_month_start), 0),
      now()
    )
    ON CONFLICT (account_id, day) DO NOTHING;
    v_done := v_done + 1;
  END LOOP;

  -- Keep two years of history; nothing reads further back.
  DELETE FROM public.account_usage_daily WHERE day < v_today - 731;
  RETURN v_done;
END;
$$;

REVOKE ALL ON FUNCTION public.usage_snapshot_run(INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.usage_snapshot_run(INTEGER, JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';
