-- ============================================================
-- 154: audited support access.
--
-- When a customer needs help, the platform operator can look at what is wrong with
-- their workspace, WITHOUT being able to read their conversations, contacts or
-- anything they wrote. Rules:
--
--   * Only the workspace OWNER can allow it, for 1 hour to 7 days, optionally for one
--     named operator. It ends by itself, and the owner can end it sooner.
--   * It is READ ONLY and DIAGNOSTIC: plan and limits, which channels are connected
--     and healthy, counts of failed sends by error, background job counts, usage,
--     member counts by role. Never message text, contact details, names, emails,
--     tokens or secrets: every answer is a fixed list of fields chosen inside the
--     function, and the verification script fails if a planted secret, message or
--     contact name appears in any of them.
--   * Every look is written to support_access_log in the SAME statement that returns
--     the answer, with no error swallowing: if the log cannot be written, nothing is
--     returned. The workspace's admins read that log in Settings > Workspace.
--   * The operator reaches data only through these functions; the table policies
--     that keep one workspace out of another are untouched.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Grants and the log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.support_access_grants (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  granted_by       UUID NOT NULL,
  operator_user_id UUID,                          -- NULL = any platform operator
  reason           TEXT,
  scope            TEXT NOT NULL DEFAULT 'diagnostics' CHECK (scope = 'diagnostics'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  revoked_by       UUID,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days 1 minute')
);
CREATE INDEX IF NOT EXISTS idx_support_access_grants_account ON public.support_access_grants (account_id, expires_at DESC);

ALTER TABLE public.support_access_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS support_access_grants_select ON public.support_access_grants;
CREATE POLICY support_access_grants_select ON public.support_access_grants
  FOR SELECT USING (public.has_capability(account_id, 'settings.workspace'));
-- No write policies: only the functions below write.

CREATE TABLE IF NOT EXISTS public.support_access_log (
  id               BIGSERIAL PRIMARY KEY,
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  grant_id         UUID NOT NULL,
  operator_user_id UUID NOT NULL,
  operator_label   TEXT NOT NULL,                 -- who, as they were called at the time
  section          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_access_log_account ON public.support_access_log (account_id, created_at DESC);

ALTER TABLE public.support_access_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS support_access_log_select ON public.support_access_log;
CREATE POLICY support_access_log_select ON public.support_access_log
  FOR SELECT USING (public.has_capability(account_id, 'settings.workspace'));

-- Append-only, like the audit trail: nobody updates or deletes a row. The one way a row
-- goes is with its workspace (the cascade, or a workspace deletion).
CREATE OR REPLACE FUNCTION public.support_access_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW'
     AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = OLD.account_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'support_access_log is append-only' USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.support_access_log_append_only() OWNER TO postgres;

DROP TRIGGER IF EXISTS support_access_log_no_change ON public.support_access_log;
CREATE TRIGGER support_access_log_no_change
  BEFORE UPDATE OR DELETE ON public.support_access_log
  FOR EACH ROW EXECUTE FUNCTION public.support_access_log_append_only();
DROP TRIGGER IF EXISTS support_access_log_no_truncate ON public.support_access_log;
CREATE TRIGGER support_access_log_no_truncate
  BEFORE TRUNCATE ON public.support_access_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_access_log_append_only();

-- ------------------------------------------------------------
-- 2. The owner allows and ends it
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_grant_access(
  p_account  UUID,
  p_hours    INTEGER,
  p_reason   TEXT DEFAULT NULL,
  p_operator UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_account_member(p_account, 'owner') THEN
    RAISE EXCEPTION 'Only the workspace owner can allow support access' USING ERRCODE = '42501';
  END IF;
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > 168 THEN
    RAISE EXCEPTION 'Support access lasts from 1 hour to 7 days' USING ERRCODE = '22023';
  END IF;
  IF p_operator IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = p_operator) THEN
    RAISE EXCEPTION 'That person is not a platform operator' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.support_access_grants (account_id, granted_by, operator_user_id, reason, expires_at)
  VALUES (p_account, auth.uid(), p_operator, left(NULLIF(trim(p_reason), ''), 500), now() + make_interval(hours => p_hours))
  RETURNING id INTO v_id;

  BEGIN
    PERFORM public.log_audit(p_account, 'created', 'support_access', v_id, 'Support access',
      jsonb_build_object('hours', p_hours, 'reason', left(NULLIF(trim(p_reason), ''), 200)), auth.uid(), 0);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'support_grant_access: audit failed: %', SQLERRM;
  END;
  RETURN v_id;
END;
$$;
ALTER FUNCTION public.support_grant_access(UUID, INTEGER, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.support_grant_access(UUID, INTEGER, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.support_grant_access(UUID, INTEGER, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.support_revoke_access(p_grant UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
BEGIN
  SELECT g.account_id INTO v_account FROM public.support_access_grants g WHERE g.id = p_grant;
  IF v_account IS NULL OR auth.uid() IS NULL OR NOT public.is_account_member(v_account, 'owner') THEN
    RAISE EXCEPTION 'Only the workspace owner can end support access' USING ERRCODE = '42501';
  END IF;
  UPDATE public.support_access_grants
     SET revoked_at = now(), revoked_by = auth.uid()
   WHERE id = p_grant AND revoked_at IS NULL;
  IF FOUND THEN
    BEGIN
      PERFORM public.log_audit(v_account, 'deleted', 'support_access', p_grant, 'Support access', '{}'::jsonb, auth.uid(), 0);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'support_revoke_access: audit failed: %', SQLERRM;
    END;
  END IF;
END;
$$;
ALTER FUNCTION public.support_revoke_access(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.support_revoke_access(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.support_revoke_access(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. The operator's side
-- ------------------------------------------------------------
-- The workspaces this operator may look at right now.
CREATE OR REPLACE FUNCTION public.platform_support_grants()
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
             'grant_id', g.id, 'account_id', g.account_id, 'account_name', a.name,
             'reason', g.reason, 'expires_at', g.expires_at
           ) ORDER BY g.expires_at)
      FROM public.support_access_grants g
      JOIN public.accounts a ON a.id = g.account_id
     WHERE g.revoked_at IS NULL AND g.expires_at > now()
       AND (g.operator_user_id IS NULL OR g.operator_user_id = auth.uid())
  ), '[]'::jsonb);
END;
$$;
ALTER FUNCTION public.platform_support_grants() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_support_grants() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_support_grants() TO authenticated, service_role;

-- One diagnostic section of one workspace. Needs an active grant for this operator, writes the log
-- row first (no exception handling: a log that cannot be written means nothing is returned), then
-- answers from a fixed list of fields. Sections: overview, channels, failures, members, jobs, usage.
CREATE OR REPLACE FUNCTION public.platform_support_view(p_account UUID, p_section TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grant  UUID;
  v_label  TEXT;
  v_result JSONB;
  v_tables TEXT[] := ARRAY['whatsapp_config', 'messenger_config', 'instagram_config', 'email_config',
                           'gmail_config', 'tiktok_config', 'web_widget_config', 'vircle_chat_config'];
  v_allowed TEXT[] := ARRAY['enabled', 'status', 'needs_reauth', 'last_inbound_at', 'subscription_expires_at',
                            'watch_expiration', 'access_token_expires_at', 'last_synced_at', 'updated_at'];
  t        TEXT;
  v_rows   JSONB;
  v_channels JSONB := '{}'::jsonb;
BEGIN
  PERFORM public.platform_require_admin();
  IF p_section IS NULL OR p_section NOT IN ('overview', 'channels', 'failures', 'members', 'jobs', 'usage') THEN
    RAISE EXCEPTION 'Unknown section' USING ERRCODE = '22023';
  END IF;

  SELECT g.id INTO v_grant
    FROM public.support_access_grants g
   WHERE g.account_id = p_account AND g.revoked_at IS NULL AND g.expires_at > now()
     AND (g.operator_user_id IS NULL OR g.operator_user_id = auth.uid())
   ORDER BY g.expires_at DESC LIMIT 1;
  IF v_grant IS NULL THEN
    -- the same answer whether the workspace exists or not
    RAISE EXCEPTION 'No active support access for this workspace' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(NULLIF(p.full_name, ''), u.email, auth.uid()::text) INTO v_label
    FROM auth.users u LEFT JOIN public.profiles p ON p.user_id = u.id WHERE u.id = auth.uid();
  INSERT INTO public.support_access_log (account_id, grant_id, operator_user_id, operator_label, section)
  VALUES (p_account, v_grant, auth.uid(), COALESCE(v_label, auth.uid()::text), p_section);

  IF p_section = 'overview' THEN
    SELECT jsonb_build_object(
             'workspace_created_at', a.created_at,
             'status', ap.status, 'suspended_reason', ap.suspended_reason, 'plan', ap.plan,
             'limits', ap.limits, 'features', ap.features, 'deletion_due_at', ap.deletion_due_at,
             'members', (SELECT count(*) FROM public.profiles p WHERE p.account_id = p_account),
             'contacts', (SELECT count(*) FROM public.contacts c WHERE c.account_id = p_account AND c.deleted_at IS NULL),
             'conversations', (SELECT count(*) FROM public.conversations v WHERE v.account_id = p_account),
             'ticket_types', (SELECT count(*) FROM public.ticket_types x WHERE x.account_id = p_account),
             'ticket_resolutions', (SELECT count(*) FROM public.ticket_resolutions x WHERE x.account_id = p_account)
           ) INTO v_result
      FROM public.accounts a LEFT JOIN public.account_platform ap ON ap.account_id = a.id
     WHERE a.id = p_account;

  ELSIF p_section = 'channels' THEN
    FOREACH t IN ARRAY v_tables LOOP
      IF to_regclass('public.' || t) IS NOT NULL THEN
        EXECUTE format(
          'SELECT COALESCE(jsonb_agg((SELECT COALESCE(jsonb_object_agg(k, v), ''{}''::jsonb) FROM jsonb_each(to_jsonb(c)) AS e(k, v) WHERE k = ANY ($2))), ''[]''::jsonb) '
          'FROM public.%I c WHERE c.account_id = $1', t)
          INTO v_rows USING p_account, v_allowed;
        IF jsonb_array_length(v_rows) > 0 THEN v_channels := v_channels || jsonb_build_object(t, v_rows); END IF;
      END IF;
    END LOOP;
    v_result := v_channels;

  ELSIF p_section = 'failures' THEN
    -- the last 7 days of failed sends, grouped: which channel, which error, how many, when last. No text.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'channel', f.channel_type, 'error_code', f.error_code, 'error_title', f.error_title,
             'count', f.n, 'last_at', f.last_at) ORDER BY f.n DESC), '[]'::jsonb) INTO v_result
      FROM (
        SELECT m.channel_type, m.error_code, m.error_title, count(*) AS n, max(m.created_at) AS last_at
          FROM public.messages m
         WHERE m.account_id = p_account AND m.status = 'failed' AND m.created_at > now() - interval '7 days'
         GROUP BY m.channel_type, m.error_code, m.error_title
         ORDER BY count(*) DESC LIMIT 50
      ) f;

  ELSIF p_section = 'members' THEN
    SELECT jsonb_build_object(
             'by_role', COALESCE((SELECT jsonb_object_agg(r.account_role::text, r.n)
                                    FROM (SELECT account_role, count(*) AS n FROM public.profiles WHERE account_id = p_account GROUP BY account_role) r), '{}'::jsonb),
             'seen_last_7_days', (SELECT count(*) FROM public.member_presence mp WHERE mp.account_id = p_account AND mp.last_seen_at > now() - interval '7 days'),
             'pending_invitations', (SELECT count(*) FROM public.account_invitations i WHERE i.account_id = p_account AND i.accepted_at IS NULL)
           ) INTO v_result;

  ELSIF p_section = 'jobs' THEN
    SELECT jsonb_build_object(
             'automation_waits', COALESCE((SELECT jsonb_object_agg(x.status, x.n) FROM (SELECT COALESCE(status::text, 'unknown') AS status, count(*) AS n FROM public.automation_pending_executions WHERE account_id = p_account GROUP BY 1) x), '{}'::jsonb),
             'jira_sync', COALESCE((SELECT jsonb_object_agg(x.status, x.n) FROM (SELECT COALESCE(status::text, 'unknown') AS status, count(*) AS n FROM public.jira_sync_jobs WHERE account_id = p_account GROUP BY 1) x), '{}'::jsonb),
             'broadcasts', COALESCE((SELECT jsonb_object_agg(x.status, x.n) FROM (SELECT COALESCE(status::text, 'unknown') AS status, count(*) AS n FROM public.broadcasts WHERE account_id = p_account GROUP BY 1) x), '{}'::jsonb)
           ) INTO v_result;

  ELSE -- usage
    v_result := public.account_usage(p_account);
  END IF;

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;
ALTER FUNCTION public.platform_support_view(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_support_view(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_support_view(UUID, TEXT) TO authenticated, service_role;
