-- ============================================================
-- 153: workspace export and deletion (PDPA: access and erasure).
--
-- Export: everything a workspace owns, as one zip, built by the app from the
-- functions below. The list of tables is DISCOVERED (every public table with an
-- account_id, plus the child tables reached through a parent), so a table added
-- later is exported without anyone remembering to list it. Secrets are never
-- exported (tokens, signing secrets, hashes, embeddings; see section 5).
--
-- Deletion, in four parts:
--   1. A request (by the owner, or by the operator): the workspace stays usable
--      for 30 days and can be cancelled (account_platform.deletion_*).
--   2. When it falls due a job runs the teardown (the app: channels, mailbox
--      watches, Jira webhooks, stored files), then
--   3. delete_workspace_data(): one transaction that removes every row of the
--      workspace, including the append-only logs (see section 3), and
--   4. the app deletes the workspace's logins (members and anonymous widget
--      visitors).
-- A tombstone row with no personal data (workspace_deletions) outlives it.
--
-- Found while reading the schema, fixed here:
--   * role_capability_log is append-only by trigger, but its account_role_id
--     cascade and its actor SET NULL both write to it, so deleting a custom role
--     (or a member who changed a capability) failed once a log row existed.
--   * ticket_sla_policies and incident_escalation_policies RESTRICT the business
--     hours they use, so the workspace's cascade could trip on them.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The request, on the workspace's platform row
-- ------------------------------------------------------------
ALTER TABLE public.account_platform
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_due_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_requested_by UUID,
  ADD COLUMN IF NOT EXISTS deletion_note         TEXT;

-- ------------------------------------------------------------
-- 2. The tombstone: what was deleted, with no personal data once finished.
--    No FK on account_id: it must outlive the workspace.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_deletions (
  account_id              UUID PRIMARY KEY,
  account_name            TEXT NOT NULL,
  owner_email             TEXT,            -- cleared when the deletion finishes
  requested_at            TIMESTAMPTZ,
  requested_by_email      TEXT,            -- cleared when the deletion finishes
  began_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ,
  step                    TEXT NOT NULL DEFAULT 'started',
  member_user_ids         UUID[] NOT NULL DEFAULT '{}',   -- logins still to delete; cleared when done
  visitor_user_ids        UUID[] NOT NULL DEFAULT '{}',
  row_counts              JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_objects_removed INTEGER NOT NULL DEFAULT 0,
  teardown                JSONB NOT NULL DEFAULT '{}'::jsonb,
  error                   TEXT
);
ALTER TABLE public.workspace_deletions ENABLE ROW LEVEL SECURITY;
-- No policies: only the functions below (service role) touch it.
REVOKE ALL ON public.workspace_deletions FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. The append-only logs
--    audit_log and role_capability_log refuse every UPDATE and DELETE. Three
--    narrow exceptions, nothing else:
--      * a workspace being purged by delete_workspace_data() (it sets
--        vircle.purge_account to its own id, only a database owner role can)
--      * role_capability_log: the row's actor set to NULL because that login was
--        deleted (the ON DELETE SET NULL of the FK), changing nothing else
--      * role_capability_log: the row of a custom role that no longer exists (the
--        ON DELETE CASCADE of account_role_id)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW'
     AND current_user NOT IN ('anon', 'authenticated', 'service_role')
     AND current_setting('vircle.purge_account', true) = OLD.account_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE FUNCTION public.role_capability_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_LEVEL = 'ROW' THEN
    IF TG_OP = 'DELETE' THEN
      IF current_user NOT IN ('anon', 'authenticated', 'service_role')
         AND current_setting('vircle.purge_account', true) = OLD.account_id::text THEN
        RETURN OLD;
      END IF;
      -- the cascade from a deleted custom role: the parent row is already gone
      IF OLD.account_role_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.account_roles r WHERE r.id = OLD.account_role_id) THEN
        RETURN OLD;
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      -- the actor's login was deleted (FK ON DELETE SET NULL): nothing else may change
      IF OLD.actor IS NOT NULL AND NEW.actor IS NULL
         AND (to_jsonb(NEW) - 'actor') = (to_jsonb(OLD) - 'actor') THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'role_capability_log is append-only' USING ERRCODE = '42501';
END;
$$;

-- ------------------------------------------------------------
-- 4. The request: the owner (or the operator) asks, and can cancel
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.workspace_deletion_request(
  p_account UUID,
  p_days    INTEGER DEFAULT 30,
  p_note    TEXT DEFAULT NULL
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operator BOOLEAN := public.is_platform_admin();
  v_days     INTEGER;
  v_due      TIMESTAMPTZ;
  v_name     TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_account_member(p_account, 'owner') OR v_operator) THEN
    RAISE EXCEPTION 'Only the workspace owner can delete it' USING ERRCODE = '42501';
  END IF;
  -- The owner always gets the full 30 days; the operator may shorten it (0 = now).
  v_days := CASE WHEN v_operator THEN LEAST(GREATEST(COALESCE(p_days, 30), 0), 90) ELSE 30 END;

  IF EXISTS (SELECT 1 FROM public.workspace_deletions d WHERE d.account_id = p_account) THEN
    RAISE EXCEPTION 'Deletion has already started' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.platform_admins pa ON pa.user_id = p.user_id
     WHERE p.account_id = p_account
  ) THEN
    RAISE EXCEPTION 'A platform operator works in this workspace; it cannot be deleted' USING ERRCODE = '22023';
  END IF;

  v_due := now() + make_interval(days => v_days);
  UPDATE public.account_platform
     SET deletion_requested_at = now(), deletion_due_at = v_due,
         deletion_requested_by = auth.uid(), deletion_note = left(NULLIF(trim(p_note), ''), 500)
   WHERE account_id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = '22023';
  END IF;

  SELECT name INTO v_name FROM public.accounts WHERE id = p_account;
  BEGIN
    PERFORM public.log_audit(p_account, 'updated', 'workspace', p_account, v_name,
      jsonb_build_object('deletion_due', v_due), auth.uid(), 0);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'workspace_deletion_request: audit failed: %', SQLERRM;
  END;
  RETURN v_due;
END;
$$;
ALTER FUNCTION public.workspace_deletion_request(UUID, INTEGER, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workspace_deletion_request(UUID, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workspace_deletion_request(UUID, INTEGER, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.workspace_deletion_cancel(p_account UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_account_member(p_account, 'owner') OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'Only the workspace owner can cancel the deletion' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workspace_deletions d WHERE d.account_id = p_account) THEN
    RAISE EXCEPTION 'Deletion has already started' USING ERRCODE = '22023';
  END IF;
  UPDATE public.account_platform
     SET deletion_requested_at = NULL, deletion_due_at = NULL, deletion_requested_by = NULL, deletion_note = NULL
   WHERE account_id = p_account AND deletion_due_at IS NOT NULL;
  IF FOUND THEN
    SELECT name INTO v_name FROM public.accounts WHERE id = p_account;
    BEGIN
      PERFORM public.log_audit(p_account, 'updated', 'workspace', p_account, v_name,
        jsonb_build_object('deletion_cancelled', true), auth.uid(), 0);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'workspace_deletion_cancel: audit failed: %', SQLERRM;
    END;
  END IF;
END;
$$;
ALTER FUNCTION public.workspace_deletion_cancel(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workspace_deletion_cancel(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.workspace_deletion_cancel(UUID) TO authenticated, service_role;

-- The operator's list: which workspaces have a deletion pending or running.
CREATE OR REPLACE FUNCTION public.platform_deletion_overview()
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
             'account_id', ap.account_id,
             'requested_at', ap.deletion_requested_at,
             'due_at', ap.deletion_due_at,
             'note', ap.deletion_note,
             'started', EXISTS (SELECT 1 FROM public.workspace_deletions d WHERE d.account_id = ap.account_id)
           ))
      FROM public.account_platform ap
     WHERE ap.deletion_due_at IS NOT NULL
  ), '[]'::jsonb);
END;
$$;
ALTER FUNCTION public.platform_deletion_overview() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_deletion_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_deletion_overview() TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. What the export contains
-- ------------------------------------------------------------
-- Child tables that have no account_id of their own: (table, parent, column that points at the parent's id).
CREATE OR REPLACE FUNCTION public.workspace_export_children()
RETURNS TABLE (child TEXT, parent TEXT, fk TEXT)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  VALUES
    ('account_role_capabilities', 'account_roles',  'account_role_id'),
    ('automation_steps',          'automations',    'automation_id'),
    ('broadcast_recipients',      'broadcasts',     'broadcast_id'),
    ('contact_custom_values',     'contacts',       'contact_id'),
    ('contact_tags',              'contacts',       'contact_id'),
    ('conversation_events',       'conversations',  'conversation_id'),
    ('conversation_labels',       'conversations',  'conversation_id'),
    ('flow_nodes',                'flows',          'flow_id'),
    ('flow_run_events',           'flow_runs',      'flow_run_id'),
    ('jira_webhook_events',       'jira_connections', 'connection_id'),
    ('message_reactions',         'conversations',  'conversation_id'),
    ('pipeline_stages',           'pipelines',      'pipeline_id'),
    ('team_members',              'teams',          'team_id');
$$;
ALTER FUNCTION public.workspace_export_children() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workspace_export_children() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_export_children() TO service_role;

-- Tables that are not exported at all: secrets, one-time codes, raw provider events, derived vectors.
CREATE OR REPLACE FUNCTION public.workspace_export_excluded()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ARRAY[
    'jira_connection_secrets', 'oauth_pending_connections', 'tiktok_oauth_states',
    'widget_verification_codes', 'vircle_chat_events', 'ai_knowledge_chunks',
    'account_usage_daily'
  ];
$$;
ALTER FUNCTION public.workspace_export_excluded() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workspace_export_excluded() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_export_excluded() TO service_role;

-- Every table to export with its exportable columns: [{table, columns[], parent?, fk?}].
-- Columns whose name says secret (token, secret, hash, password, api_key, embedding,
-- client_state, signing, an _enc suffix) are left out.
CREATE OR REPLACE FUNCTION public.workspace_export_manifest()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH tbl AS (
    SELECT c.table_name::text AS t, NULL::text AS parent, NULL::text AS fk
      FROM information_schema.columns c
      JOIN information_schema.tables x
        ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'account_id'
       AND NOT (c.table_name = ANY (public.workspace_export_excluded()))
    UNION ALL
    SELECT child, parent, fk FROM public.workspace_export_children()
    UNION ALL
    SELECT 'accounts', NULL, NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'table', tbl.t,
           'parent', tbl.parent,
           'fk', tbl.fk,
           'columns', (
             SELECT jsonb_agg(col.column_name ORDER BY col.ordinal_position)
               FROM information_schema.columns col
              WHERE col.table_schema = 'public' AND col.table_name = tbl.t
                AND col.column_name !~* '(token|secret|hash|password|api_key|embedding|client_state|signing|_enc$)'
           )
         ) ORDER BY tbl.t), '[]'::jsonb)
    FROM tbl;
$$;
ALTER FUNCTION public.workspace_export_manifest() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workspace_export_manifest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_export_manifest() TO service_role;

-- One page of one table's rows for a workspace, in physical order, as {rows:[...], last:'(page,row)'}.
-- p_after is the previous page's `last`. Only manifest tables, only manifest columns.
CREATE OR REPLACE FUNCTION public.workspace_export_rows(
  p_account UUID,
  p_table   TEXT,
  p_after   TEXT DEFAULT NULL,
  p_limit   INTEGER DEFAULT 500
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry   JSONB;
  v_cols    TEXT;
  v_where   TEXT;
  v_after   TEXT := '';
  v_rows    JSONB;
  v_last    TEXT;
BEGIN
  SELECT e INTO v_entry FROM jsonb_array_elements(public.workspace_export_manifest()) e WHERE e ->> 'table' = p_table;
  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'Not an exportable table' USING ERRCODE = '22023';
  END IF;

  SELECT string_agg(format('%L, t.%I', c, c), ', ') INTO v_cols
    FROM jsonb_array_elements_text(v_entry -> 'columns') c;
  IF v_cols IS NULL THEN
    RETURN jsonb_build_object('rows', '[]'::jsonb, 'last', NULL);
  END IF;

  v_where := CASE
    WHEN p_table = 'accounts' THEN 't.id = $2'
    WHEN v_entry ->> 'parent' IS NOT NULL THEN
      format('t.%I IN (SELECT p.id FROM public.%I p WHERE p.account_id = $2)', v_entry ->> 'fk', v_entry ->> 'parent')
    ELSE 't.account_id = $2'
  END;
  -- account_roles / account_role_capabilities, flow_runs, jira_connections and the rest all carry an account_id
  IF p_after IS NOT NULL THEN v_after := ' AND t.ctid > $1::tid'; END IF;

  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(x.j ORDER BY x.c), ''[]''::jsonb), (array_agg(x.c ORDER BY x.c DESC))[1]::text '
    'FROM (SELECT t.ctid AS c, jsonb_build_object(%s) AS j FROM public.%I t WHERE %s%s ORDER BY t.ctid LIMIT %s) x',
    v_cols, p_table, v_where, v_after, LEAST(GREATEST(COALESCE(p_limit, 500), 1), 2000))
    INTO v_rows, v_last
    USING p_after, p_account;
  RETURN jsonb_build_object('rows', v_rows, 'last', v_last);
END;
$$;
ALTER FUNCTION public.workspace_export_rows(UUID, TEXT, TEXT, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workspace_export_rows(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_export_rows(UUID, TEXT, TEXT, INTEGER) TO service_role;

-- Stored files under a prefix ("account-<uuid>/" for a workspace, "<user uuid>/" for a person's
-- avatar), in (bucket, name) order, after the given position.
CREATE OR REPLACE FUNCTION public.storage_objects_by_prefix(
  p_prefix       TEXT,
  p_after_bucket TEXT DEFAULT NULL,
  p_after_name   TEXT DEFAULT NULL,
  p_limit        INTEGER DEFAULT 500
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', o.bucket_id, 'name', o.name,
                                               'size', COALESCE((o.metadata ->> 'size')::bigint, 0))
                            ORDER BY o.bucket_id, o.name), '[]'::jsonb)
    FROM (
      SELECT bucket_id, name, metadata
        FROM storage.objects
       WHERE starts_with(name, p_prefix)
         AND length(p_prefix) >= 37
         AND (p_after_bucket IS NULL OR (bucket_id, name) > (p_after_bucket, p_after_name))
       ORDER BY bucket_id, name
       LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 2000)
    ) o;
$$;
ALTER FUNCTION public.storage_objects_by_prefix(TEXT, TEXT, TEXT, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.storage_objects_by_prefix(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storage_objects_by_prefix(TEXT, TEXT, TEXT, INTEGER) TO service_role;

-- ------------------------------------------------------------
-- 6. The deletion itself
-- ------------------------------------------------------------
-- Step 1: claim the workspace. Needs a due request (or p_force, for the operator's "delete now").
-- Suspends it, switches every channel off, records the tombstone, and returns what the
-- app still has to clean up outside the database.
CREATE OR REPLACE FUNCTION public.workspace_deletion_begin(p_account UUID, p_force BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ap        public.account_platform%ROWTYPE;
  v_name    TEXT;
  v_owner   TEXT;
  v_by      TEXT;
  v_members UUID[];
  v_visitors UUID[];
  v_counts  JSONB := '{}'::jsonb;
  v_n       BIGINT;
  r         RECORD;
BEGIN
  SELECT * INTO ap FROM public.account_platform WHERE account_id = p_account;
  IF NOT FOUND OR ap.deletion_due_at IS NULL THEN
    RAISE EXCEPTION 'No deletion was requested for this workspace' USING ERRCODE = '22023';
  END IF;
  IF ap.deletion_due_at > now() AND NOT COALESCE(p_force, false) THEN
    RAISE EXCEPTION 'This deletion is not due yet' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.platform_admins pa ON pa.user_id = p.user_id
     WHERE p.account_id = p_account
  ) THEN
    RAISE EXCEPTION 'A platform operator works in this workspace; it cannot be deleted' USING ERRCODE = '22023';
  END IF;

  SELECT a.name, u.email INTO v_name, v_owner
    FROM public.accounts a LEFT JOIN auth.users u ON u.id = a.owner_user_id WHERE a.id = p_account;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = '22023';
  END IF;
  SELECT u.email INTO v_by FROM auth.users u WHERE u.id = ap.deletion_requested_by;
  SELECT COALESCE(array_agg(p.user_id), '{}') INTO v_members FROM public.profiles p WHERE p.account_id = p_account;
  SELECT COALESCE(array_agg(w.id), '{}') INTO v_visitors FROM public.widget_visitors w WHERE w.account_id = p_account;

  -- Stop everything from acting for it while it is taken apart.
  UPDATE public.account_platform
     SET status = 'suspended', suspended_at = COALESCE(suspended_at, now()),
         suspended_reason = 'Workspace deletion in progress'
   WHERE account_id = p_account;
  FOR r IN
    SELECT unnest(ARRAY['whatsapp_config', 'messenger_config', 'instagram_config', 'email_config',
                        'gmail_config', 'tiktok_config', 'web_widget_config', 'vircle_chat_config']) AS t
  LOOP
    IF to_regclass('public.' || r.t) IS NOT NULL THEN
      EXECUTE format('UPDATE public.%I SET enabled = false WHERE account_id = $1', r.t) USING p_account;
    END IF;
  END LOOP;

  -- How many rows each table holds, for the record (counts only, no content).
  FOR r IN
    SELECT c.table_name::text AS t
      FROM information_schema.columns c
      JOIN information_schema.tables x
        ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'account_id'
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE account_id = $1', r.t) INTO v_n USING p_account;
    IF v_n > 0 THEN v_counts := v_counts || jsonb_build_object(r.t, v_n); END IF;
  END LOOP;

  INSERT INTO public.workspace_deletions AS d
    (account_id, account_name, owner_email, requested_at, requested_by_email,
     member_user_ids, visitor_user_ids, row_counts)
  VALUES (p_account, v_name, v_owner, ap.deletion_requested_at, v_by, v_members, v_visitors, v_counts)
  ON CONFLICT (account_id) DO NOTHING;

  RETURN jsonb_build_object(
    'account_id', p_account, 'name', v_name,
    'member_user_ids', to_jsonb(v_members), 'visitor_user_ids', to_jsonb(v_visitors)
  );
END;
$$;
ALTER FUNCTION public.workspace_deletion_begin(UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workspace_deletion_begin(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_deletion_begin(UUID, BOOLEAN) TO service_role;

-- Progress notes from the app (teardown results, files removed, a failure) so a run can be resumed.
CREATE OR REPLACE FUNCTION public.workspace_deletion_note(
  p_account  UUID,
  p_step     TEXT,
  p_teardown JSONB DEFAULT NULL,
  p_storage_removed INTEGER DEFAULT NULL,
  p_error    TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.workspace_deletions
     SET step = p_step,
         teardown = CASE WHEN p_teardown IS NULL THEN teardown ELSE teardown || p_teardown END,
         storage_objects_removed = COALESCE(p_storage_removed, storage_objects_removed),
         error = left(p_error, 500)
   WHERE account_id = p_account;
$$;
ALTER FUNCTION public.workspace_deletion_note(UUID, TEXT, JSONB, INTEGER, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workspace_deletion_note(UUID, TEXT, JSONB, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_deletion_note(UUID, TEXT, JSONB, INTEGER, TEXT) TO service_role;

-- Step 3: every row of the workspace, in one transaction. Safe to run twice.
CREATE OR REPLACE FUNCTION public.delete_workspace_data(p_account UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_logs BIGINT := 0;
  v_n    BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspace_deletions d WHERE d.account_id = p_account) THEN
    RAISE EXCEPTION 'The deletion has not been started' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.platform_admins pa ON pa.user_id = p.user_id
     WHERE p.account_id = p_account
  ) THEN
    RAISE EXCEPTION 'A platform operator works in this workspace; it cannot be deleted' USING ERRCODE = '22023';
  END IF;

  -- A big workspace can take a while; the cascade is one statement.
  PERFORM set_config('statement_timeout', '0', true);
  -- The soft-delete triggers (082, 125) step aside; the append-only logs allow this workspace's own rows.
  PERFORM set_config('vircle.hard_delete', 'on', true);
  PERFORM set_config('vircle.purge_account', p_account::text, true);

  -- Things that RESTRICT the rows they point at, removed first so the cascade cannot trip on them.
  DELETE FROM public.ticket_sla_policies WHERE account_id = p_account;
  DELETE FROM public.incident_escalation_policies WHERE account_id = p_account;
  DELETE FROM public.deals WHERE account_id = p_account;

  DELETE FROM public.accounts WHERE id = p_account;

  -- Logs that deliberately have no foreign key to the workspace (and so survived the cascade).
  DELETE FROM public.audit_log WHERE account_id = p_account;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_logs := v_logs + v_n;
  DELETE FROM public.role_capability_log WHERE account_id = p_account;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_logs := v_logs + v_n;

  UPDATE public.workspace_deletions SET step = 'data_deleted' WHERE account_id = p_account;
  RETURN jsonb_build_object('account_id', p_account, 'log_rows_removed', v_logs);
END;
$$;
ALTER FUNCTION public.delete_workspace_data(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_workspace_data(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_workspace_data(UUID) TO service_role;

-- Step 5: close the tombstone. After this it holds the workspace's name, when it was deleted and
-- how many rows each table had; no email, no logins.
CREATE OR REPLACE FUNCTION public.workspace_deletion_finish(p_account UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.workspace_deletions
     SET deleted_at = now(), step = 'done', owner_email = NULL, requested_by_email = NULL,
         member_user_ids = '{}', visitor_user_ids = '{}', error = NULL
   WHERE account_id = p_account;
$$;
ALTER FUNCTION public.workspace_deletion_finish(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workspace_deletion_finish(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_deletion_finish(UUID) TO service_role;

-- Workspaces whose request has fallen due, or whose run stopped half way, for the job to pick up.
CREATE OR REPLACE FUNCTION public.workspace_deletions_due(p_limit INTEGER DEFAULT 5)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(x.account_id), '[]'::jsonb) FROM (
    SELECT ap.account_id
      FROM public.account_platform ap
     WHERE ap.deletion_due_at IS NOT NULL AND ap.deletion_due_at <= now()
       AND EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = ap.account_id)
    UNION
    SELECT d.account_id FROM public.workspace_deletions d WHERE d.deleted_at IS NULL AND d.step <> 'done'
    LIMIT GREATEST(COALESCE(p_limit, 5), 1)
  ) x;
$$;
ALTER FUNCTION public.workspace_deletions_due(INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workspace_deletions_due(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_deletions_due(INTEGER) TO service_role;
