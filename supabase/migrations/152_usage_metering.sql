-- ============================================================
-- 152: usage metering and plan limits beyond seats.
--
-- The operator layer (132) already holds a free-form `limits` object per
-- workspace, and enforces two of its keys (seats, broadcast_per_day). This adds
-- the numbers to compare them with, and four more limits:
--
--   contacts              people in the workspace's contact list
--   messages_per_month    outbound messages (agent and bot), calendar month UTC
--   storage_mb            files kept in the workspace's storage folders
--   ai_tokens_per_month   AI tokens, calendar month UTC (the tenant's own budget
--                         still applies; the lower of the two wins)
--
-- Behaviour, the same for every limit: an absent key means unlimited; from 80%
-- the workspace's admins see a notice and the operator sees the workspace flagged;
-- at 100% the app refuses to create MORE of that thing (a contact added by a
-- person, an outbound message, an AI call). A customer who writes in is never
-- refused: inbound contacts and messages are always accepted and only counted.
-- Storage is measured and flagged but not blocked, because browsers upload
-- straight to storage.
--
-- Counters:
--   account_usage_daily   one row per workspace per day, written by the daily
--                         usage_snapshot_run() job (fair, skips suspended
--                         workspaces); read by the workspace's admins and by the
--                         operator console.
--   account_usage()       the same numbers live, for the app's limit checks and
--                         the workspace's own usage card.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Outbound messages per month need an index to count
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_messages_account_created
  ON public.messages (account_id, created_at DESC);

-- ------------------------------------------------------------
-- 2. The daily history
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_usage_daily (
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  day             DATE NOT NULL,
  contacts        INTEGER NOT NULL DEFAULT 0,
  members         INTEGER NOT NULL DEFAULT 0,
  conversations   INTEGER NOT NULL DEFAULT 0,
  messages_out    INTEGER NOT NULL DEFAULT 0,  -- sent that day
  messages_month  INTEGER NOT NULL DEFAULT 0,  -- sent so far that month
  storage_bytes   BIGINT  NOT NULL DEFAULT 0,
  ai_tokens       BIGINT  NOT NULL DEFAULT 0,  -- used that day
  ai_tokens_month BIGINT  NOT NULL DEFAULT 0,  -- used so far that month
  measured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, day)
);

ALTER TABLE public.account_usage_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_usage_daily_select ON public.account_usage_daily;
CREATE POLICY account_usage_daily_select ON public.account_usage_daily
  FOR SELECT USING (public.has_capability(account_id, 'settings.workspace'));
-- No write policies: only usage_snapshot_run() writes.

-- ------------------------------------------------------------
-- 3. The live numbers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_usage(p_account UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month_start TIMESTAMPTZ := date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc';
  v_storage     BIGINT;
  v_measured    TIMESTAMPTZ;
BEGIN
  -- The service role (the app's own checks) has no auth.uid(); a person must be an
  -- admin of this workspace (the capability that also reads the daily table) or an operator.
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_capability(p_account, 'settings.workspace') OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT d.storage_bytes, d.measured_at INTO v_storage, v_measured
    FROM public.account_usage_daily d
   WHERE d.account_id = p_account
   ORDER BY d.day DESC LIMIT 1;

  RETURN jsonb_build_object(
    'contacts',        (SELECT count(*) FROM public.contacts c WHERE c.account_id = p_account AND c.deleted_at IS NULL),
    'members',         (SELECT count(*) FROM public.profiles p WHERE p.account_id = p_account),
    'conversations',   (SELECT count(*) FROM public.conversations v WHERE v.account_id = p_account),
    'messages_month',  (SELECT count(*) FROM public.messages m
                         WHERE m.account_id = p_account AND m.created_at >= v_month_start
                           AND m.sender_type IN ('agent', 'bot') AND NOT m.is_internal AND m.status <> 'failed'),
    'ai_tokens_month', COALESCE((SELECT sum(l.total_tokens) FROM public.ai_usage_log l
                                  WHERE l.account_id = p_account AND l.created_at >= v_month_start), 0),
    'storage_bytes',   COALESCE(v_storage, 0),
    'storage_measured_at', v_measured,
    'limits',          COALESCE((SELECT ap.limits FROM public.account_platform ap WHERE ap.account_id = p_account), '{}'::jsonb)
  );
END;
$$;
ALTER FUNCTION public.account_usage(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_usage(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_usage(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. The daily job: one row per active workspace per day
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.usage_snapshot_run(p_limit INTEGER DEFAULT 200)
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
  -- Storage per workspace in one pass: every private bucket keeps a workspace's files
  -- under an "account-<uuid>/" folder.
  CREATE TEMP TABLE IF NOT EXISTS _usage_storage (account_id UUID PRIMARY KEY, bytes BIGINT) ON COMMIT DROP;
  TRUNCATE _usage_storage;
  INSERT INTO _usage_storage (account_id, bytes)
  SELECT substring(o.name FROM '^account-([0-9a-f-]{36})/')::uuid,
         COALESCE(sum((o.metadata ->> 'size')::bigint), 0)
    FROM storage.objects o
   WHERE o.name ~ '^account-[0-9a-f-]{36}/'
   GROUP BY 1
  ON CONFLICT (account_id) DO NOTHING;

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
      COALESCE((SELECT s.bytes FROM _usage_storage s WHERE s.account_id = r.id), 0),
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
ALTER FUNCTION public.usage_snapshot_run(INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.usage_snapshot_run(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.usage_snapshot_run(INTEGER) TO service_role;

-- ------------------------------------------------------------
-- 5. The operator's overview: every workspace's latest numbers beside its limits
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_usage_overview()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.platform_require_admin();
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'account_id', a.id,
             'name', a.name,
             'plan', COALESCE(ap.plan, 'standard'),
             'limits', COALESCE(ap.limits, '{}'::jsonb),
             'day', d.day,
             'contacts', d.contacts,
             'members', d.members,
             'conversations', d.conversations,
             'messages_month', d.messages_month,
             'storage_bytes', d.storage_bytes,
             'ai_tokens_month', d.ai_tokens_month
           ) ORDER BY a.created_at DESC)
      FROM public.accounts a
      LEFT JOIN public.account_platform ap ON ap.account_id = a.id
      LEFT JOIN LATERAL (
        SELECT x.* FROM public.account_usage_daily x WHERE x.account_id = a.id ORDER BY x.day DESC LIMIT 1
      ) d ON true
  ), '[]'::jsonb);
END;
$$;
ALTER FUNCTION public.platform_usage_overview() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_usage_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_usage_overview() TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Contacts: the hard limit for people adding contacts by hand or by import
--    (the browser writes these rows straight to the table, so the table is the
--    one place that covers every route). Contacts created by a customer writing
--    in, by the API or by an integration run as the service role and are never
--    refused here.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.contacts_limit_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER;
  v_used  INTEGER;
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  SELECT (ap.limits ->> 'contacts')::integer INTO v_limit
    FROM public.account_platform ap WHERE ap.account_id = NEW.account_id;
  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO v_used FROM public.contacts c WHERE c.account_id = NEW.account_id AND c.deleted_at IS NULL;
  IF v_used >= v_limit THEN
    RAISE EXCEPTION 'contact_limit_reached' USING ERRCODE = '53400',
      DETAIL = format('%s of %s contacts used', v_used, v_limit);
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.contacts_limit_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.contacts_limit_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS contacts_limit_guard ON public.contacts;
CREATE TRIGGER contacts_limit_guard
  BEFORE INSERT ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_limit_guard();
