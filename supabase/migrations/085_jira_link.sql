-- ============================================================
-- 085_jira_link.sql — Jira Cloud two-way link for tickets (0.43.0)
--
-- Phase 1 (link and see) and phase 2 (two-way sync) of the design in
-- Vircle-Jira-Integration-Design.docx. Nothing in this migration talks to
-- Jira; it is the data side: connection, cache, queue, echo guards.
--
-- What this migration does
--   1. Capabilities (mirrors src/lib/auth/capabilities.ts, checked by
--      capabilities-sql.test.ts):
--        jira.connect          Owner + Admin   connect / disconnect / settings
--        jira.link             Owner, Admin, Agent   create, link, unlink,
--                                                    transition, sync now
--        jira.share-comments   Owner, Admin, Agent   "Share with Jira"
--      All three are app-enforced (routes use requireCapability). A Viewer
--      can never be given them (min_grant_role admin / agent).
--   2. Tables. Every write goes through the service role or a SECURITY
--      DEFINER function; clients only ever SELECT, and only safe columns:
--        jira_connections         one per workspace, NO secrets
--        jira_connection_secrets  encrypted tokens + webhook token, NO
--                                 client access at all (no policy, no grant)
--        ticket_jira_links        ticket <-> Jira issue + cached state
--        jira_comment_map         note <-> Jira comment (the echo guard)
--        jira_user_map            member <-> Jira account
--        jira_webhook_events      delivery ids for de-duplication
--        jira_sync_jobs           the work queue
--        jira_sync_events         diagnostics (capped by jira_prune)
--   3. A ticket can link at most 5 Jira issues (trigger, race-safe).
--   4. Single-flight token refresh: jira_claim_refresh takes a lease,
--      jira_save_rotated_tokens rotates access + refresh token in ONE atomic
--      compare-and-swap that only the lease holder holding the token it
--      started from can win.
--   5. Queue functions: jira_enqueue_job (coalesces), jira_claim_jobs
--      (FOR UPDATE SKIP LOCKED, so two workers never get the same job),
--      jira_finish_job (retry with backoff, dead-letter after max attempts).
--   6. ticket_comments: source / jira_author / jira_comment_id /
--      deleted_in_jira. Notes that come from Jira have no author. A client
--      cannot forge or change those columns.
--   7. ticket_activity: jira_linked, jira_unlinked, jira_status_synced,
--      jira_status_pushed events (+ a `detail` column for the issue key).
--      The activity and watcher triggers say "Jira" instead of a person when
--      the status change came from Jira (session setting vircle.source).
--   8. Triggers that queue outbound work when an agent changes a ticket
--      status or edits a note that was shared with Jira. A change that came
--      FROM Jira never queues anything (vircle.source = 'jira').
--   9. Notification types jira_reauth_required, jira_issue_done. Audit
--      actions connected / disconnected / reconnected / linked / unlinked
--      and jira_audit(), the only way route code can write the audit log.
--  10. oauth_pending_connections accepts channel 'jira' (site picker).
--
-- The four CHECK constraints below are rebuilt from the LIVE definition,
-- never from a hard-coded list, so this cannot drop a value another
-- migration added. The notification list also carries the two approval
-- types that migration 084 adds, so the order 084 then 085 (or 085 alone on
-- a database without 084) ends in the same set. The reader of the live
-- definition understands both shapes pg_get_constraintdef prints (see
-- section 5), so it also works after 084 has rebuilt the notification list.
--
-- Depends on: 063/064/081 (tickets), 079 (capabilities), 082 (log_audit),
-- 055 (oauth_pending_connections). Does NOT depend on 084 objects.
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Capabilities
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('jira.connect', 'admin', 'app'),
  ('jira.link', 'agent', 'app'),
  ('jira.share-comments', 'agent', 'app')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'jira.connect'),
  ('owner', 'jira.link'),
  ('owner', 'jira.share-comments'),
  ('admin', 'jira.connect'),
  ('admin', 'jira.link'),
  ('admin', 'jira.share-comments'),
  ('agent', 'jira.link'),
  ('agent', 'jira.share-comments')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Tables
-- ------------------------------------------------------------

-- 2a. The connection (no secrets in here: members may read it).
CREATE TABLE IF NOT EXISTS public.jira_connections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- The Atlassian cloud id is always a UUID; every API call is built from it.
  cloud_id              TEXT NOT NULL
                        CHECK (cloud_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- Shown and linked to, never fetched.
  site_url              TEXT NOT NULL CHECK (site_url ~ '^https://'),
  site_name             TEXT,
  connected_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  jira_account_id       TEXT,
  jira_display_name     TEXT,
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'reauth_required', 'revoked')),
  status_reason         TEXT,
  token_expires_at      TIMESTAMPTZ,
  -- Dynamic webhooks: registered ids and the earliest expiry (30 days).
  webhook_ids           JSONB NOT NULL DEFAULT '[]'::jsonb,
  webhook_expires_at    TIMESTAMPTZ,
  webhook_checked_at    TIMESTAMPTZ,
  last_catchup_at       TIMESTAMPTZ,
  last_report_at        TIMESTAMPTZ,
  -- projects, mapping, direction, privacy ... (validated by the app).
  settings              JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Last rate-limit headers seen: { reason, remaining, limit, reset, at }.
  rate_limit            JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id)
);

-- 2b. Secrets: the ONLY place tokens live. No policy, no client grant.
CREATE TABLE IF NOT EXISTS public.jira_connection_secrets (
  connection_id       UUID PRIMARY KEY REFERENCES public.jira_connections(id) ON DELETE CASCADE,
  account_id          UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  access_token_enc    TEXT NOT NULL,
  refresh_token_enc   TEXT NOT NULL,
  -- The random token in the webhook URL path. Unguessable, per connection.
  webhook_token       TEXT NOT NULL UNIQUE,
  token_version       INTEGER NOT NULL DEFAULT 1,
  rotated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Single-flight refresh lease.
  refresh_lease_owner TEXT,
  refresh_lease_until TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2c. Ticket <-> issue links with the cached issue state.
CREATE TABLE IF NOT EXISTS public.ticket_jira_links (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  ticket_id             UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  connection_id         UUID NOT NULL REFERENCES public.jira_connections(id) ON DELETE CASCADE,
  -- The permanent issue id; the key can change when an issue is moved.
  issue_id              TEXT NOT NULL,
  issue_key             TEXT NOT NULL,
  project_key           TEXT,
  project_name          TEXT,
  issue_type            TEXT,
  summary               TEXT,
  status_id             TEXT,
  status_name           TEXT,
  status_category       TEXT CHECK (status_category IS NULL
                          OR status_category IN ('new', 'indeterminate', 'done', 'undefined')),
  resolution            TEXT,
  priority_name         TEXT,
  assignee_account_id   TEXT,
  assignee_name         TEXT,
  reporter_name         TEXT,
  issue_url             TEXT,
  jira_updated_at       TIMESTAMPTZ,
  last_synced_at        TIMESTAMPTZ,
  sync_state            TEXT NOT NULL DEFAULT 'ok'
                        CHECK (sync_state IN ('ok', 'paused', 'broken')),
  sync_error            TEXT,
  -- Echo memory: what WE last wrote to Jira, { status_category, status_name, at }.
  last_written          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Result of the last outbound status push: { ok, reason, wanted, at }.
  last_push             JSONB,
  remote_link_id        TEXT,
  linked_by             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_resync_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, issue_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_jira_links_ticket ON public.ticket_jira_links (ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_jira_links_issue ON public.ticket_jira_links (connection_id, issue_id);
CREATE INDEX IF NOT EXISTS idx_ticket_jira_links_account ON public.ticket_jira_links (account_id, sync_state);

-- 2d. Note <-> Jira comment.
CREATE TABLE IF NOT EXISTS public.jira_comment_map (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  link_id                  UUID NOT NULL REFERENCES public.ticket_jira_links(id) ON DELETE CASCADE,
  ticket_comment_id        UUID REFERENCES public.ticket_comments(id) ON DELETE SET NULL,
  jira_comment_id          TEXT NOT NULL,
  origin                   TEXT NOT NULL CHECK (origin IN ('vircle', 'jira')),
  jira_author_account_id   TEXT,
  body_hash                TEXT,
  jira_updated_at          TIMESTAMPTZ,
  deleted_in_jira          BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (link_id, jira_comment_id),
  UNIQUE (link_id, ticket_comment_id)
);

CREATE INDEX IF NOT EXISTS idx_jira_comment_map_note ON public.jira_comment_map (ticket_comment_id)
  WHERE ticket_comment_id IS NOT NULL;

-- 2e. Member <-> Jira account.
CREATE TABLE IF NOT EXISTS public.jira_user_map (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  jira_account_id     TEXT NOT NULL,
  jira_display_name   TEXT,
  method              TEXT NOT NULL CHECK (method IN ('email', 'manual')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id),
  UNIQUE (account_id, jira_account_id)
);

-- 2f. Webhook de-duplication (short retention, see jira_prune).
CREATE TABLE IF NOT EXISTS public.jira_webhook_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id  UUID NOT NULL REFERENCES public.jira_connections(id) ON DELETE CASCADE,
  delivery_id    TEXT NOT NULL,
  event          TEXT,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, delivery_id)
);

-- 2g. The work queue.
CREATE TABLE IF NOT EXISTS public.jira_sync_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  connection_id  UUID NOT NULL REFERENCES public.jira_connections(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('sync_issue', 'push_status', 'post_comment', 'edit_comment')),
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- A pending job with the same key is reused instead of queued twice.
  dedupe_key     TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'running', 'done', 'dead')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 6,
  next_try_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until   TIMESTAMPTZ,
  locked_by      TEXT,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jira_sync_jobs_pending_dedupe
  ON public.jira_sync_jobs (connection_id, dedupe_key)
  WHERE status = 'pending' AND dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jira_sync_jobs_due
  ON public.jira_sync_jobs (next_try_at) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_jira_sync_jobs_account
  ON public.jira_sync_jobs (account_id, status, updated_at DESC);

-- 2h. Diagnostics.
CREATE TABLE IF NOT EXISTS public.jira_sync_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  connection_id  UUID REFERENCES public.jira_connections(id) ON DELETE CASCADE,
  link_id        UUID REFERENCES public.ticket_jira_links(id) ON DELETE SET NULL,
  level          TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  kind           TEXT NOT NULL,
  message        TEXT,
  details        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jira_sync_events_account
  ON public.jira_sync_events (account_id, created_at DESC);

-- updated_at
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['jira_connections', 'jira_connection_secrets', 'ticket_jira_links',
                           'jira_comment_map', 'jira_sync_jobs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()',
      t);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- RLS + privileges. Clients: SELECT of the safe tables only.
-- ------------------------------------------------------------
ALTER TABLE public.jira_connections        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jira_connection_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_jira_links       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jira_comment_map        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jira_user_map           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jira_webhook_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jira_sync_jobs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jira_sync_events        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS jira_connections_select ON public.jira_connections;
CREATE POLICY jira_connections_select ON public.jira_connections
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS ticket_jira_links_select ON public.ticket_jira_links;
CREATE POLICY ticket_jira_links_select ON public.ticket_jira_links
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS jira_comment_map_select ON public.jira_comment_map;
CREATE POLICY jira_comment_map_select ON public.jira_comment_map
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS jira_user_map_select ON public.jira_user_map;
CREATE POLICY jira_user_map_select ON public.jira_user_map
  FOR SELECT USING (is_account_member(account_id));

-- Diagnostics are for whoever manages the connection.
DROP POLICY IF EXISTS jira_sync_jobs_select ON public.jira_sync_jobs;
CREATE POLICY jira_sync_jobs_select ON public.jira_sync_jobs
  FOR SELECT USING (has_capability(account_id, 'jira.connect'));

DROP POLICY IF EXISTS jira_sync_events_select ON public.jira_sync_events;
CREATE POLICY jira_sync_events_select ON public.jira_sync_events
  FOR SELECT USING (has_capability(account_id, 'jira.connect'));

-- jira_connection_secrets and jira_webhook_events: no policy at all.
REVOKE ALL ON public.jira_connection_secrets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.jira_webhook_events     FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.jira_connections, public.ticket_jira_links, public.jira_comment_map,
  public.jira_user_map, public.jira_sync_jobs, public.jira_sync_events
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON
  public.jira_connections, public.jira_connection_secrets, public.ticket_jira_links,
  public.jira_comment_map, public.jira_user_map, public.jira_webhook_events,
  public.jira_sync_jobs, public.jira_sync_events
  TO service_role;

-- Live card updates (the ticket view subscribes to its own links, and to the
-- comment map so "Shared with Jira" appears for every agent).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_jira_links', 'jira_comment_map'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3. At most 5 links per ticket; the link belongs to the ticket's account
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jira_link_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_acct UUID;
  v_conn_acct UUID;
BEGIN
  -- Serialise concurrent inserts for one ticket so the count cannot race.
  PERFORM pg_advisory_xact_lock(hashtext('jira_link:' || NEW.ticket_id::text));

  SELECT account_id INTO v_acct FROM tickets WHERE id = NEW.ticket_id;
  SELECT account_id INTO v_conn_acct FROM jira_connections WHERE id = NEW.connection_id;
  IF v_acct IS NULL OR v_conn_acct IS NULL OR v_acct <> NEW.account_id OR v_conn_acct <> NEW.account_id THEN
    RAISE EXCEPTION 'The ticket, the connection and the link must belong to one account'
      USING ERRCODE = '23514';
  END IF;

  IF (SELECT count(*) FROM ticket_jira_links WHERE ticket_id = NEW.ticket_id) >= 5 THEN
    RAISE EXCEPTION 'A ticket can link at most 5 Jira issues' USING ERRCODE = '23514', HINT = 'jira_link_limit';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jira_link_guard ON public.ticket_jira_links;
CREATE TRIGGER jira_link_guard BEFORE INSERT ON public.ticket_jira_links
  FOR EACH ROW EXECUTE FUNCTION public.jira_link_guard();

-- ------------------------------------------------------------
-- 4. ticket_comments: notes that come from Jira
-- ------------------------------------------------------------
ALTER TABLE public.ticket_comments
  ADD COLUMN IF NOT EXISTS source           TEXT NOT NULL DEFAULT 'vircle',
  ADD COLUMN IF NOT EXISTS jira_author      TEXT,
  ADD COLUMN IF NOT EXISTS jira_comment_id  TEXT,
  ADD COLUMN IF NOT EXISTS deleted_in_jira  BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.ticket_comments DROP CONSTRAINT IF EXISTS ticket_comments_source_check;
ALTER TABLE public.ticket_comments ADD CONSTRAINT ticket_comments_source_check
  CHECK (source IN ('vircle', 'jira'));

-- author_id stays nullable (063): a Jira-sourced note has no Vircle author,
-- so the author-only update / delete policies (081) never match it.

-- A client can never claim a note came from Jira, or change where it came
-- from. Only code with no user session (the service role) can.
CREATE OR REPLACE FUNCTION public.ticket_comment_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      NEW.source := 'vircle';
      NEW.jira_author := NULL;
      NEW.jira_comment_id := NULL;
      NEW.deleted_in_jira := false;
    ELSE
      NEW.source := OLD.source;
      NEW.jira_author := OLD.jira_author;
      NEW.jira_comment_id := OLD.jira_comment_id;
      NEW.deleted_in_jira := OLD.deleted_in_jira;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ticket_comment_source_guard ON public.ticket_comments;
CREATE TRIGGER ticket_comment_source_guard BEFORE INSERT OR UPDATE ON public.ticket_comments
  FOR EACH ROW EXECUTE FUNCTION public.ticket_comment_source_guard();

CREATE INDEX IF NOT EXISTS idx_ticket_comments_jira
  ON public.ticket_comments (ticket_id, jira_comment_id) WHERE jira_comment_id IS NOT NULL;

-- ------------------------------------------------------------
-- 5. Widen four CHECK constraints from their LIVE definitions
--
-- pg_get_constraintdef prints a list CHECK in one of two shapes:
--   ARRAY['a'::text, 'b'::text]      (written by hand)
--   '{a,b,c}'::text[]                (written through format('%L::text[]'),
--                                     which is how these rebuilds write it)
-- The helper reads both, so this migration (and any later one that rebuilds
-- a constraint the same way) can run on a database that already went
-- through a rebuild, and can be re-run, without turning the list into one
-- element. It is dropped again at the end of the migration.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jira_check_values(p_def text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(DISTINCT v), ARRAY[]::text[])
    FROM (
      SELECT unnest(
               CASE WHEN m[1] ~ '^\{.*\}$'
                    THEN string_to_array(replace(btrim(m[1], '{}'), '"', ''), ',')
                    ELSE ARRAY[m[1]] END) AS v
        FROM regexp_matches(COALESCE(p_def, ''), '''([^'']+)''::text', 'g') AS m
    ) s;
$$;

-- notifications.type
DO $$
DECLARE
  v_def   TEXT;
  v_types TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';

  v_types := public.jira_check_values(v_def);

  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY['approval_requested', 'approval_decided',
                                             'jira_reauth_required', 'jira_issue_done']) AS x);

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

-- audit_log.action
DO $$
DECLARE
  v_def  TEXT;
  v_list TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.audit_log'::regclass AND conname = 'audit_log_action_check';

  v_list := public.jira_check_values(v_def);

  v_list := (SELECT array_agg(DISTINCT x ORDER BY x)
               FROM unnest(v_list || ARRAY['connected', 'disconnected', 'reconnected',
                                           'linked', 'unlinked']) AS x);

  ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
  EXECUTE format(
    'ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_action_check CHECK (action = ANY (%L::text[]))',
    v_list);
END $$;

-- ticket_activity.event_type (+ a free-text detail column for the issue key)
ALTER TABLE public.ticket_activity ADD COLUMN IF NOT EXISTS detail TEXT;

DO $$
DECLARE
  c       RECORD;
  v_types TEXT[] := ARRAY[]::text[];
BEGIN
  FOR c IN
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'public.ticket_activity'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%event_type%'
  LOOP
    v_types := v_types || public.jira_check_values(c.def);
    EXECUTE format('ALTER TABLE public.ticket_activity DROP CONSTRAINT %I', c.conname);
  END LOOP;

  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY['created', 'status_changed', 'priority_changed',
                       'category_changed', 'assigned_agent_changed', 'assigned_team_changed',
                       'custom_field_changed', 'due_date_changed', 'labels_changed',
                       'summary_changed', 'description_changed', 'link_added', 'link_removed',
                       'attachment_added',
                       'jira_linked', 'jira_unlinked', 'jira_status_synced', 'jira_status_pushed']) AS x);

  EXECUTE format(
    'ALTER TABLE public.ticket_activity ADD CONSTRAINT ticket_activity_event_type_check CHECK (event_type = ANY (%L::text[]))',
    v_types);
END $$;

-- oauth_pending_connections.channel (the Jira site picker uses it)
DO $$
DECLARE
  v_def  TEXT;
  v_list TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.oauth_pending_connections'::regclass
     AND conname = 'oauth_pending_connections_channel_check';

  v_list := public.jira_check_values(v_def);

  v_list := (SELECT array_agg(DISTINCT x ORDER BY x)
               FROM unnest(v_list || ARRAY['messenger', 'instagram', 'email', 'gmail', 'jira']) AS x);

  ALTER TABLE public.oauth_pending_connections DROP CONSTRAINT IF EXISTS oauth_pending_connections_channel_check;
  EXECUTE format(
    'ALTER TABLE public.oauth_pending_connections ADD CONSTRAINT oauth_pending_connections_channel_check CHECK (channel = ANY (%L::text[]))',
    v_list);
END $$;

-- ------------------------------------------------------------
-- 6. Activity and watcher triggers: "by Jira" when the change came from Jira.
--    log_ticket_activity is migration 081's function with ONE change: a
--    status change made while vircle.source = 'jira' is logged as
--    jira_status_synced (no actor, detail = the issue key). notify_ticket_
--    watchers is 081's with the actor name set to 'Jira' in that case.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_ticket_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF COALESCE(current_setting('vircle.source', true), '') = 'jira' THEN
      INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value, detail)
      VALUES (NEW.id, NEW.account_id, NULL, 'jira_status_synced', OLD.status, NEW.status,
              NULLIF(current_setting('vircle.jira_key', true), ''));
    ELSE
      INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
      VALUES (NEW.id, NEW.account_id, auth.uid(), 'status_changed', OLD.status, NEW.status);
    END IF;
  END IF;

  IF NEW.priority IS DISTINCT FROM OLD.priority THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'priority_changed', OLD.priority, NEW.priority);
  END IF;

  IF NEW.category IS DISTINCT FROM OLD.category THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'category_changed', OLD.category, NEW.category);
  END IF;

  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (
      NEW.id, NEW.account_id, auth.uid(), 'assigned_agent_changed',
      OLD.assigned_agent_id::text, NEW.assigned_agent_id::text
    );
  END IF;

  IF NEW.assigned_team_id IS DISTINCT FROM OLD.assigned_team_id THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (
      NEW.id, NEW.account_id, auth.uid(), 'assigned_team_changed',
      OLD.assigned_team_id::text, NEW.assigned_team_id::text
    );
  END IF;

  IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (
      NEW.id, NEW.account_id, auth.uid(), 'due_date_changed',
      OLD.due_date::text, NEW.due_date::text
    );
  END IF;

  IF NEW.labels IS DISTINCT FROM OLD.labels THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (
      NEW.id, NEW.account_id, auth.uid(), 'labels_changed',
      NULLIF(array_to_string(OLD.labels, ','), ''), NULLIF(array_to_string(NEW.labels, ','), '')
    );
  END IF;

  IF NEW.subject IS DISTINCT FROM OLD.subject THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'summary_changed', OLD.subject, NEW.subject);
  END IF;

  IF NEW.description IS DISTINCT FROM OLD.description THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'description_changed');
  END IF;

  -- One row per changed custom field (keys are definition ids).
  IF NEW.custom_fields IS DISTINCT FROM OLD.custom_fields THEN
    FOR v_key IN
      SELECT k FROM (
        SELECT jsonb_object_keys(COALESCE(OLD.custom_fields, '{}'::jsonb)) AS k
        UNION
        SELECT jsonb_object_keys(COALESCE(NEW.custom_fields, '{}'::jsonb))
      ) keys
    LOOP
      IF (OLD.custom_fields -> v_key) IS DISTINCT FROM (NEW.custom_fields -> v_key) THEN
        INSERT INTO ticket_activity (
          ticket_id, account_id, actor_id, event_type, field_id, from_value, to_value
        ) VALUES (
          NEW.id, NEW.account_id, auth.uid(), 'custom_field_changed',
          CASE WHEN v_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN v_key::uuid END,
          OLD.custom_fields ->> v_key, NEW.custom_fields ->> v_key
        );
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log ticket activity for ticket %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.log_ticket_activity() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.notify_ticket_watchers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
  v_actor_name TEXT;
  v_actor TEXT;
  v_watcher UUID;
BEGIN
  SELECT a.ticket_key_prefix || '-' || NEW.ticket_number INTO v_key
  FROM accounts a WHERE a.id = NEW.account_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM profiles WHERE user_id = auth.uid();
  END IF;
  v_actor := COALESCE(v_actor_name, 'Someone');
  IF COALESCE(current_setting('vircle.source', true), '') = 'jira' THEN
    v_actor := 'Jira';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    FOR v_watcher IN
      SELECT user_id FROM ticket_watchers
      WHERE ticket_id = NEW.id AND user_id IS DISTINCT FROM auth.uid()
    LOOP
      INSERT INTO notifications (
        account_id, user_id, type, ticket_id, contact_id, actor_user_id, title, body
      ) VALUES (
        NEW.account_id, v_watcher, 'ticket_updated', NEW.id, NEW.contact_id, auth.uid(),
        'Ticket status changed',
        v_actor || ' moved ' || v_key || ' to ' || initcap(replace(NEW.status, '_', ' '))
          || ' — ' || NEW.subject
      );
    END LOOP;
  END IF;

  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    FOR v_watcher IN
      SELECT user_id FROM ticket_watchers
      WHERE ticket_id = NEW.id
        AND user_id IS DISTINCT FROM auth.uid()
        AND user_id IS DISTINCT FROM NEW.assigned_agent_id
    LOOP
      INSERT INTO notifications (
        account_id, user_id, type, ticket_id, contact_id, actor_user_id, title, body
      ) VALUES (
        NEW.account_id, v_watcher, 'ticket_updated', NEW.id, NEW.contact_id, auth.uid(),
        'Ticket reassigned',
        v_actor || CASE WHEN NEW.assigned_agent_id IS NULL
                        THEN ' unassigned ' ELSE ' reassigned ' END
          || v_key || ' — ' || NEW.subject
      );
    END LOOP;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to notify watchers of ticket %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.notify_ticket_watchers() OWNER TO postgres;

-- A note that came from Jira notifies watchers as "Jira · <name>", not as
-- "Someone". (081's function with the actor line changed.)
CREATE OR REPLACE FUNCTION public.notify_ticket_comment_watchers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket tickets%ROWTYPE;
  v_key TEXT;
  v_actor_name TEXT;
  v_watcher UUID;
BEGIN
  SELECT * INTO v_ticket FROM tickets WHERE id = NEW.ticket_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT a.ticket_key_prefix || '-' || v_ticket.ticket_number INTO v_key
  FROM accounts a WHERE a.id = v_ticket.account_id;

  IF NEW.source = 'jira' THEN
    v_actor_name := 'Jira · ' || COALESCE(NULLIF(NEW.jira_author, ''), 'Jira user');
  ELSE
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = COALESCE(NEW.author_id, auth.uid());
  END IF;

  FOR v_watcher IN
    SELECT user_id FROM ticket_watchers
    WHERE ticket_id = NEW.ticket_id
      AND user_id IS DISTINCT FROM NEW.author_id
      AND user_id IS DISTINCT FROM auth.uid()
      AND NOT (COALESCE(NEW.mentions, '[]'::jsonb) @> to_jsonb(user_id::text))
  LOOP
    INSERT INTO notifications (
      account_id, user_id, type, ticket_id, contact_id, actor_user_id, title, body
    ) VALUES (
      v_ticket.account_id, v_watcher, 'ticket_comment', NEW.ticket_id, v_ticket.contact_id,
      COALESCE(NEW.author_id, auth.uid()),
      'New comment on a ticket',
      COALESCE(v_actor_name, 'Someone') || ' commented on ' || v_key || ' — ' || v_ticket.subject
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to notify watchers of comment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.notify_ticket_comment_watchers() OWNER TO postgres;

-- ------------------------------------------------------------
-- 7. Queue helpers (service role / SECURITY DEFINER only)
-- ------------------------------------------------------------

-- Queue a job; a PENDING job with the same dedupe key is reused (its payload
-- is replaced and it becomes due now), so a burst of webhooks for one issue
-- is one job.
CREATE OR REPLACE FUNCTION public.jira_enqueue_job(
  p_account_id    uuid,
  p_connection_id uuid,
  p_kind          text,
  p_payload       jsonb,
  p_dedupe_key    text DEFAULT NULL,
  p_delay_seconds integer DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO jira_sync_jobs (account_id, connection_id, kind, payload, dedupe_key, next_try_at)
  VALUES (p_account_id, p_connection_id, p_kind, COALESCE(p_payload, '{}'::jsonb), p_dedupe_key,
          now() + make_interval(secs => GREATEST(COALESCE(p_delay_seconds, 0), 0)))
  ON CONFLICT (connection_id, dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL
  DO UPDATE SET
    -- The newest payload wins, except that "read the comments too" is sticky:
    -- if either job wanted them (comments is not explicitly false) the merged
    -- job reads them, so a status event after a comment event loses nothing.
    payload = CASE
                WHEN (jira_sync_jobs.payload ->> 'comments') IS DISTINCT FROM 'false'
                  OR (EXCLUDED.payload ->> 'comments') IS DISTINCT FROM 'false'
                THEN EXCLUDED.payload - 'comments'
                ELSE EXCLUDED.payload
              END,
    next_try_at = LEAST(jira_sync_jobs.next_try_at, EXCLUDED.next_try_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Claim due jobs. FOR UPDATE SKIP LOCKED: two workers never get the same job.
-- A job whose lease ran out (the worker died) is claimed again; one that has
-- used all its attempts is dead-lettered instead.
CREATE OR REPLACE FUNCTION public.jira_claim_jobs(
  p_limit         integer,
  p_worker        text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS SETOF public.jira_sync_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE jira_sync_jobs
     SET status = 'dead', finished_at = now(),
         last_error = COALESCE(last_error, 'lease expired after the last attempt')
   WHERE status = 'running' AND locked_until < now() AND attempts >= max_attempts;

  RETURN QUERY
  WITH picked AS (
    SELECT id FROM jira_sync_jobs
     WHERE (status = 'pending' AND next_try_at <= now())
        OR (status = 'running' AND locked_until < now())
     ORDER BY next_try_at, created_at
       FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 10), 50))
  )
  UPDATE jira_sync_jobs j
     SET status = 'running',
         attempts = j.attempts + 1,
         locked_by = p_worker,
         locked_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 120), 10)),
         updated_at = now()
    FROM picked
   WHERE j.id = picked.id
  RETURNING j.*;
END;
$$;

-- Finish a claimed job. Only the worker that holds it can. p_outcome:
--   ok     -> done
--   retry  -> pending again after p_retry_seconds, or dead after max_attempts
--   dead   -> dead now (a permanent error: 403, a deleted issue ...)
CREATE OR REPLACE FUNCTION public.jira_finish_job(
  p_id            uuid,
  p_worker        text,
  p_outcome       text,
  p_error         text DEFAULT NULL,
  p_retry_seconds integer DEFAULT 60
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  j jira_sync_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM jira_sync_jobs WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR j.status <> 'running' OR j.locked_by IS DISTINCT FROM p_worker THEN
    RETURN 'lost';
  END IF;

  IF p_outcome = 'ok' THEN
    UPDATE jira_sync_jobs
       SET status = 'done', finished_at = now(), locked_until = NULL, locked_by = NULL, last_error = NULL
     WHERE id = p_id;
    RETURN 'done';
  ELSIF p_outcome = 'retry' AND j.attempts < j.max_attempts THEN
    UPDATE jira_sync_jobs
       SET status = 'pending', locked_until = NULL, locked_by = NULL,
           last_error = left(p_error, 500),
           next_try_at = now() + make_interval(secs => GREATEST(COALESCE(p_retry_seconds, 60), 1))
     WHERE id = p_id;
    RETURN 'retry';
  ELSE
    UPDATE jira_sync_jobs
       SET status = 'dead', finished_at = now(), locked_until = NULL, locked_by = NULL,
           last_error = left(p_error, 500)
     WHERE id = p_id;
    RETURN 'dead';
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- 8. Single-flight token refresh
-- ------------------------------------------------------------

-- Take the refresh lease. One UPDATE: concurrent callers queue on the row
-- lock and the loser re-checks the lease, finds it held and gets false.
CREATE OR REPLACE FUNCTION public.jira_claim_refresh(
  p_connection_id uuid,
  p_owner         text,
  p_lease_seconds integer DEFAULT 30
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE jira_connection_secrets
     SET refresh_lease_owner = p_owner,
         refresh_lease_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 30), 5))
   WHERE connection_id = p_connection_id
     AND (refresh_lease_until IS NULL
          OR refresh_lease_until < now()
          OR refresh_lease_owner = p_owner);
  RETURN FOUND;
END;
$$;

-- Save the rotated tokens. ONE atomic compare-and-swap: it only succeeds for
-- the lease holder, and only if the stored refresh token is still the one the
-- refresh started from. Atlassian invalidates the old refresh token on use,
-- so the new pair must land in the same statement.
CREATE OR REPLACE FUNCTION public.jira_save_rotated_tokens(
  p_connection_id       uuid,
  p_owner               text,
  p_expected_refresh    text,
  p_access_enc          text,
  p_refresh_enc         text,
  p_expires_at          timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE jira_connection_secrets
     SET access_token_enc = p_access_enc,
         refresh_token_enc = p_refresh_enc,
         token_version = token_version + 1,
         rotated_at = now(),
         refresh_lease_owner = NULL,
         refresh_lease_until = NULL
   WHERE connection_id = p_connection_id
     AND refresh_lease_owner = p_owner
     AND refresh_lease_until >= now()
     AND refresh_token_enc = p_expected_refresh;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE jira_connections SET token_expires_at = p_expires_at WHERE id = p_connection_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.jira_release_refresh(p_connection_id uuid, p_owner text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE jira_connection_secrets
     SET refresh_lease_owner = NULL, refresh_lease_until = NULL
   WHERE connection_id = p_connection_id AND refresh_lease_owner = p_owner;
$$;

-- ------------------------------------------------------------
-- 9. Connection health
-- ------------------------------------------------------------

-- The connection needs the user to sign in again: links pause (they are
-- kept, not deleted) and the people who work on linked tickets are told
-- once a day.
CREATE OR REPLACE FUNCTION public.jira_mark_reauth(p_connection_id uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c        jira_connections%ROWTYPE;
  v_user   UUID;
  v_notified INTEGER := 0;
BEGIN
  SELECT * INTO c FROM jira_connections WHERE id = p_connection_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;

  UPDATE jira_connections
     SET status = 'reauth_required', status_reason = left(p_reason, 300)
   WHERE id = p_connection_id AND status <> 'revoked';
  IF NOT FOUND THEN RETURN 0; END IF;

  UPDATE ticket_jira_links SET sync_state = 'paused'
   WHERE connection_id = p_connection_id AND sync_state = 'ok';

  FOR v_user IN
    SELECT DISTINCT u FROM (
      SELECT c.connected_by AS u
      UNION
      SELECT t.assigned_agent_id
        FROM tickets t JOIN ticket_jira_links l ON l.ticket_id = t.id
       WHERE l.connection_id = p_connection_id
      UNION
      SELECT p.user_id FROM profiles p
       WHERE p.account_id = c.account_id AND p.account_role IN ('owner', 'admin')
    ) s
    WHERE u IS NOT NULL
      AND EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u AND p.account_id = c.account_id)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM notifications n
       WHERE n.user_id = v_user AND n.type = 'jira_reauth_required'
         AND n.created_at > now() - interval '24 hours'
    ) THEN
      INSERT INTO notifications (account_id, user_id, type, title, body)
      VALUES (c.account_id, v_user, 'jira_reauth_required',
              'Jira needs to be reconnected',
              'The connection to ' || COALESCE(c.site_name, 'Jira') ||
              ' stopped working, so linked tickets are paused. An admin can reconnect it in Settings.');
      v_notified := v_notified + 1;
    END IF;
  END LOOP;
  RETURN v_notified;
END;
$$;

-- Apply a ticket status that came FROM Jira. Sets the session markers the
-- activity / watcher triggers read (transaction-local) and the resolved_at /
-- closed_at stamps a normal status change carries.
CREATE OR REPLACE FUNCTION public.jira_apply_ticket_status(
  p_ticket_id uuid,
  p_status    text,
  p_issue_key text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed INTEGER;
BEGIN
  PERFORM set_config('vircle.source', 'jira', true);
  PERFORM set_config('vircle.jira_key', COALESCE(p_issue_key, ''), true);

  UPDATE tickets
     SET status = p_status,
         resolved_at = CASE WHEN p_status = 'resolved' THEN now()
                            WHEN p_status = 'closed' THEN resolved_at
                            ELSE NULL END,
         closed_at   = CASE WHEN p_status = 'closed' THEN now()
                            WHEN p_status = 'resolved' THEN closed_at
                            ELSE NULL END
   WHERE id = p_ticket_id AND status <> p_status;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  PERFORM set_config('vircle.source', '', true);
  PERFORM set_config('vircle.jira_key', '', true);
  RETURN v_changed > 0;
END;
$$;

-- ------------------------------------------------------------
-- 10. Triggers that queue OUTBOUND work
-- ------------------------------------------------------------

-- An agent changed a ticket status and the workspace pushes status to Jira.
-- One pending job per connection and ticket: quick changes coalesce.
CREATE OR REPLACE FUNCTION public.jira_queue_status_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conn UUID;
BEGIN
  -- A change that came from Jira never goes back to Jira.
  IF COALESCE(current_setting('vircle.source', true), '') = 'jira' THEN
    RETURN NEW;
  END IF;

  SELECT c.id INTO v_conn
    FROM jira_connections c
   WHERE c.account_id = NEW.account_id
     AND c.status = 'active'
     AND COALESCE((c.settings -> 'direction' ->> 'status_to_jira')::boolean, false)
     AND EXISTS (SELECT 1 FROM ticket_jira_links l
                  WHERE l.ticket_id = NEW.id AND l.connection_id = c.id AND l.sync_state = 'ok')
   LIMIT 1;

  IF v_conn IS NOT NULL THEN
    PERFORM jira_enqueue_job(NEW.account_id, v_conn, 'push_status',
      jsonb_build_object('ticket_id', NEW.id, 'status', NEW.status, 'actor', auth.uid()),
      'push:' || NEW.id::text);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'jira_queue_status_push failed for ticket %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jira_status_push ON public.tickets;
CREATE TRIGGER jira_status_push AFTER UPDATE OF status ON public.tickets
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.jira_queue_status_push();

-- A note that was shared with Jira was edited in Vircle: update the Jira
-- comment (a delete in Vircle never deletes in Jira).
CREATE OR REPLACE FUNCTION public.jira_queue_comment_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conn UUID;
BEGIN
  IF NEW.source = 'jira' THEN
    RETURN NEW;
  END IF;
  FOR v_conn IN
    SELECT DISTINCT l.connection_id
      FROM jira_comment_map m JOIN ticket_jira_links l ON l.id = m.link_id
     WHERE m.ticket_comment_id = NEW.id AND m.origin = 'vircle' AND l.sync_state = 'ok'
  LOOP
    PERFORM jira_enqueue_job(NEW.account_id, v_conn, 'edit_comment',
      jsonb_build_object('ticket_comment_id', NEW.id),
      'edit:' || NEW.id::text);
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'jira_queue_comment_edit failed for comment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jira_comment_edit ON public.ticket_comments;
CREATE TRIGGER jira_comment_edit AFTER UPDATE OF body ON public.ticket_comments
  FOR EACH ROW WHEN (OLD.body IS DISTINCT FROM NEW.body)
  EXECUTE FUNCTION public.jira_queue_comment_edit();

-- ------------------------------------------------------------
-- 11. Audit + housekeeping
-- ------------------------------------------------------------

-- The only way route code writes the audit log (log_audit itself is not
-- callable by anyone but SECURITY DEFINER code). Summaries carry keys and
-- names only, never tokens: the app builds them, this only clips them.
CREATE OR REPLACE FUNCTION public.jira_audit(
  p_account_id  uuid,
  p_actor       uuid,
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_label       text,
  p_summary     jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_entity_type NOT IN ('jira_connection', 'ticket_jira_link') THEN
    RAISE EXCEPTION 'jira_audit: unexpected entity type %', p_entity_type USING ERRCODE = '22023';
  END IF;
  PERFORM log_audit(p_account_id, p_action, p_entity_type, p_entity_id, p_label, p_summary, p_actor, 0);
END;
$$;

-- Retention: webhook delivery ids 7 days, finished jobs 7 days, dead jobs 30
-- days, diagnostics 30 days and at most 2000 rows per workspace.
CREATE OR REPLACE FUNCTION public.jira_prune()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER := 0;
  k INTEGER;
BEGIN
  DELETE FROM jira_webhook_events WHERE received_at < now() - interval '7 days';
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  DELETE FROM jira_sync_jobs WHERE status = 'done' AND finished_at < now() - interval '7 days';
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  DELETE FROM jira_sync_jobs WHERE status = 'dead' AND finished_at < now() - interval '30 days';
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  DELETE FROM jira_sync_events WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  DELETE FROM jira_sync_events e
   USING (SELECT id, row_number() OVER (PARTITION BY account_id ORDER BY created_at DESC, id DESC) AS rn
            FROM jira_sync_events) r
   WHERE e.id = r.id AND r.rn > 2000;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  RETURN n;
END;
$$;

-- ------------------------------------------------------------
-- 12. Privileges: everything above is for the service role only
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.jira_link_guard()                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ticket_comment_source_guard()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_queue_status_push()                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_queue_comment_edit()               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_enqueue_job(uuid, uuid, text, jsonb, text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_claim_jobs(integer, text, integer)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_finish_job(uuid, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_claim_refresh(uuid, text, integer)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_save_rotated_tokens(uuid, text, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_release_refresh(uuid, text)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_mark_reauth(uuid, text)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_apply_ticket_status(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_audit(uuid, uuid, text, text, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_prune()                             FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.jira_enqueue_job(uuid, uuid, text, jsonb, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.jira_claim_jobs(integer, text, integer)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.jira_finish_job(uuid, text, text, text, integer)        TO service_role;
GRANT EXECUTE ON FUNCTION public.jira_claim_refresh(uuid, text, integer)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.jira_save_rotated_tokens(uuid, text, text, text, text, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.jira_release_refresh(uuid, text)                        TO service_role;
GRANT EXECUTE ON FUNCTION public.jira_mark_reauth(uuid, text)                            TO service_role;
GRANT EXECUTE ON FUNCTION public.jira_apply_ticket_status(uuid, text, text)              TO service_role;
GRANT EXECUTE ON FUNCTION public.jira_audit(uuid, uuid, text, text, uuid, text, jsonb)   TO service_role;
GRANT EXECUTE ON FUNCTION public.jira_prune()                                            TO service_role;

DROP FUNCTION IF EXISTS public.jira_check_values(text);
