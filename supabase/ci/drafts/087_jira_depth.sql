-- ============================================================
-- 087_jira_depth.sql — Jira link phase 3 (depth) and hardening (0.45.0)
--
-- Builds on 085 (the Jira link). Nothing in this migration talks to Jira; it
-- is the data side of: attachments both ways, custom-field mapping,
-- per-project overrides (they live in jira_connections.settings, no schema),
-- bulk create / link, and the phase 1-2 hardening (webhook trust counters, the
-- personal-data report result, the catch-up stall alert).
--
-- What this migration does
--   1. jira_connections: webhook_stats (how deliveries arrived: signed or on
--      the secret address alone) and last_report_result (the last
--      personal-data report). jira_bump_webhook_stat() counts a delivery.
--   2. ticket_jira_links.field_state: the custom-field echo memory (hashes).
--   3. ticket_attachments: source ('vircle' | 'jira') and jira_attachment_id.
--      A client can never claim a file came from Jira (guard trigger, like
--      ticket_comments in 085). The chat-media bucket is NOT touched.
--   4. Tables, all writes by the service role only:
--        jira_attachment_map     ticket attachment <-> Jira attachment id,
--                                direction, content hash: prevents duplicates
--                                and echo; skipped files keep a link to Jira
--        jira_field_mappings     ticket custom field <-> Jira field, per
--                                project, direction, "when missing"
--        jira_field_meta_cache   Jira create-metadata, cached (no client access)
--        jira_bulk_batches/items one bulk action and its per-ticket results
--   5. The queue accepts push_fields, push_attachment, pull_attachments and
--      bulk_item jobs (the kind CHECK is rebuilt from its LIVE definition).
--   6. Triggers: a ticket custom-field edit queues push_fields (never when the
--      change came from Jira); a new ticket attachment queues push_attachment
--      when "send all new attachments" is on. jira_queue_status_push now also
--      honours a per-project "status to Jira" override.
--   7. jira_apply_ticket_fields (a value that came FROM Jira is applied with
--      the vircle.source marker, so nothing is queued back), jira_notify_stalled
--      (the owner notification jira_sync_stalled, at most once a day).
--   8. notifications.type gains jira_sync_stalled: the CHECK is rebuilt from
--      its LIVE definition, so every value another migration (084, 085, 086)
--      added is kept.
--   9. jira_prune also retires old bulk batches and cached metadata.
--
-- Depends on: 066 (ticket_field_definitions), 081 (ticket_attachments), 085.
-- Does NOT depend on 086 (ticket SLA) objects. Idempotent: safe to run twice.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Reader for the values of a list CHECK, in either shape pg prints
--    (see 085 section 5). Dropped again at the end.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jira_check_values_087(p_def text)
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

-- ------------------------------------------------------------
-- 1. Hardening columns on the connection
-- ------------------------------------------------------------
ALTER TABLE public.jira_connections
  ADD COLUMN IF NOT EXISTS webhook_stats      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_report_result JSONB;

-- Count one webhook delivery: signed (a bearer that verified), unsigned (the
-- secret address alone) or rejected_unsigned ("Require signed deliveries" on).
CREATE OR REPLACE FUNCTION public.jira_bump_webhook_stat(p_connection_id uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_kind NOT IN ('signed', 'unsigned', 'rejected_unsigned') THEN
    RAISE EXCEPTION 'jira_bump_webhook_stat: unexpected kind %', p_kind USING ERRCODE = '22023';
  END IF;
  UPDATE jira_connections
     SET webhook_stats =
           jsonb_set(
             jsonb_set(COALESCE(webhook_stats, '{}'::jsonb), ARRAY[p_kind],
                       to_jsonb(COALESCE((webhook_stats ->> p_kind)::integer, 0) + 1)),
             '{since}', COALESCE(webhook_stats -> 'since', to_jsonb(now())))
           || CASE WHEN p_kind = 'unsigned'
                   THEN jsonb_build_object('last_unsigned_at', now())
                   ELSE '{}'::jsonb END
   WHERE id = p_connection_id;
END;
$$;

-- ------------------------------------------------------------
-- 2. Custom-field echo memory on the link
-- ------------------------------------------------------------
ALTER TABLE public.ticket_jira_links
  ADD COLUMN IF NOT EXISTS field_state JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ------------------------------------------------------------
-- 3. ticket_attachments: where a file came from
-- ------------------------------------------------------------
ALTER TABLE public.ticket_attachments
  ADD COLUMN IF NOT EXISTS source             TEXT NOT NULL DEFAULT 'vircle',
  ADD COLUMN IF NOT EXISTS jira_attachment_id TEXT;

ALTER TABLE public.ticket_attachments DROP CONSTRAINT IF EXISTS ticket_attachments_source_check;
ALTER TABLE public.ticket_attachments ADD CONSTRAINT ticket_attachments_source_check
  CHECK (source IN ('vircle', 'jira'));

-- A client can never claim a file came from Jira, or change where it came from.
-- Only code with no user session (the service role) can.
CREATE OR REPLACE FUNCTION public.ticket_attachment_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      NEW.source := 'vircle';
      NEW.jira_attachment_id := NULL;
    ELSE
      NEW.source := OLD.source;
      NEW.jira_attachment_id := OLD.jira_attachment_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ticket_attachment_source_guard ON public.ticket_attachments;
CREATE TRIGGER ticket_attachment_source_guard BEFORE INSERT OR UPDATE ON public.ticket_attachments
  FOR EACH ROW EXECUTE FUNCTION public.ticket_attachment_source_guard();

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_jira
  ON public.ticket_attachments (ticket_id, jira_attachment_id) WHERE jira_attachment_id IS NOT NULL;

-- ------------------------------------------------------------
-- 4. Tables
-- ------------------------------------------------------------

-- 4a. Attachment map: the echo guard and the duplicate guard.
CREATE TABLE IF NOT EXISTS public.jira_attachment_map (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  link_id               UUID NOT NULL REFERENCES public.ticket_jira_links(id) ON DELETE CASCADE,
  -- Cleared (not deleted) when the ticket attachment is removed in Vircle: the
  -- file is still in Jira, so the hash keeps blocking a duplicate.
  ticket_attachment_id  UUID REFERENCES public.ticket_attachments(id) ON DELETE SET NULL,
  jira_attachment_id    TEXT NOT NULL,
  direction             TEXT NOT NULL CHECK (direction IN ('to_jira', 'from_jira')),
  status                TEXT NOT NULL DEFAULT 'synced'
                        CHECK (status IN ('synced', 'skipped_type', 'skipped_size', 'skipped_cap', 'failed', 'duplicate')),
  content_hash          TEXT,
  filename              TEXT,
  mime_type             TEXT,
  size_bytes            BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  -- A skipped file stays a link in Jira; shown, never fetched.
  jira_url              TEXT,
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (link_id, jira_attachment_id)
);

-- One ticket attachment goes to an issue once; the same bytes are on an issue once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jira_attachment_map_note
  ON public.jira_attachment_map (link_id, ticket_attachment_id)
  WHERE ticket_attachment_id IS NOT NULL AND status = 'synced';
CREATE UNIQUE INDEX IF NOT EXISTS idx_jira_attachment_map_hash
  ON public.jira_attachment_map (link_id, content_hash)
  WHERE content_hash IS NOT NULL AND status = 'synced';
CREATE INDEX IF NOT EXISTS idx_jira_attachment_map_ticket_att
  ON public.jira_attachment_map (ticket_attachment_id) WHERE ticket_attachment_id IS NOT NULL;

-- 4b. Field mappings: a ticket custom field <-> a Jira field, per project.
CREATE TABLE IF NOT EXISTS public.jira_field_mappings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  connection_id    UUID NOT NULL REFERENCES public.jira_connections(id) ON DELETE CASCADE,
  -- An upper-case project key, or '*' for every project.
  project_key      TEXT NOT NULL CHECK (project_key = '*' OR project_key ~ '^[A-Z][A-Z0-9_]{0,9}$'),
  ticket_field_id  UUID NOT NULL REFERENCES public.ticket_field_definitions(id) ON DELETE CASCADE,
  jira_field_id    TEXT NOT NULL CHECK (jira_field_id ~ '^[A-Za-z0-9_]{1,64}$'),
  jira_field_name  TEXT NOT NULL,
  jira_kind        TEXT NOT NULL
                   CHECK (jira_kind IN ('text', 'textarea', 'number', 'date', 'select', 'multicheckbox', 'labels')),
  direction        TEXT NOT NULL DEFAULT 'both' CHECK (direction IN ('to_jira', 'from_jira', 'both')),
  when_missing     TEXT NOT NULL DEFAULT 'skip' CHECK (when_missing IN ('skip', 'clear', 'default')),
  default_value    TEXT,
  -- { label } for checkbox <-> labels.
  config           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, project_key, ticket_field_id)
);

CREATE INDEX IF NOT EXISTS idx_jira_field_mappings_conn ON public.jira_field_mappings (connection_id);
CREATE INDEX IF NOT EXISTS idx_jira_field_mappings_field ON public.jira_field_mappings (ticket_field_id);

-- The field, the connection and the mapping belong to one workspace.
CREATE OR REPLACE FUNCTION public.jira_field_mapping_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_field_acct UUID;
  v_conn_acct  UUID;
BEGIN
  SELECT account_id INTO v_field_acct FROM ticket_field_definitions WHERE id = NEW.ticket_field_id;
  SELECT account_id INTO v_conn_acct  FROM jira_connections        WHERE id = NEW.connection_id;
  IF v_field_acct IS NULL OR v_conn_acct IS NULL OR v_field_acct <> NEW.account_id OR v_conn_acct <> NEW.account_id THEN
    RAISE EXCEPTION 'The field, the connection and the mapping must belong to one account'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jira_field_mapping_guard ON public.jira_field_mappings;
CREATE TRIGGER jira_field_mapping_guard BEFORE INSERT OR UPDATE ON public.jira_field_mappings
  FOR EACH ROW EXECUTE FUNCTION public.jira_field_mapping_guard();

-- 4c. Cached Jira create-metadata (refreshable). No client access at all.
CREATE TABLE IF NOT EXISTS public.jira_field_meta_cache (
  connection_id  UUID NOT NULL REFERENCES public.jira_connections(id) ON DELETE CASCADE,
  account_id     UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  project_key    TEXT NOT NULL,
  issue_type_id  TEXT NOT NULL,
  fields         JSONB NOT NULL DEFAULT '[]'::jsonb,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, project_key, issue_type_id)
);

-- 4d. Bulk actions.
CREATE TABLE IF NOT EXISTS public.jira_bulk_batches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  connection_id     UUID NOT NULL REFERENCES public.jira_connections(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('create', 'link')),
  created_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  total             INTEGER NOT NULL CHECK (total BETWEEN 1 AND 25),
  -- 'link': the ONE issue every ticket is linked to.
  target_issue_id   TEXT,
  target_issue_key  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.jira_bulk_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         UUID NOT NULL REFERENCES public.jira_bulk_batches(id) ON DELETE CASCADE,
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  ticket_id        UUID NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  project_key      TEXT,
  issue_type_id    TEXT,
  issue_type_name  TEXT,
  summary          TEXT,
  issue_key        TEXT,
  code             TEXT,
  message          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_jira_bulk_batches_account ON public.jira_bulk_batches (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jira_bulk_items_batch ON public.jira_bulk_items (batch_id);

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['jira_field_mappings', 'jira_bulk_items'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()',
      t);
  END LOOP;
END $$;

-- RLS + privileges: clients only ever SELECT, and only what their role needs.
ALTER TABLE public.jira_attachment_map   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jira_field_mappings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jira_field_meta_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jira_bulk_batches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jira_bulk_items       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS jira_attachment_map_select ON public.jira_attachment_map;
CREATE POLICY jira_attachment_map_select ON public.jira_attachment_map
  FOR SELECT USING (is_account_member(account_id));

-- Mappings and the metadata behind them are for whoever manages the connection.
DROP POLICY IF EXISTS jira_field_mappings_select ON public.jira_field_mappings;
CREATE POLICY jira_field_mappings_select ON public.jira_field_mappings
  FOR SELECT USING (has_capability(account_id, 'jira.connect'));

DROP POLICY IF EXISTS jira_bulk_batches_select ON public.jira_bulk_batches;
CREATE POLICY jira_bulk_batches_select ON public.jira_bulk_batches
  FOR SELECT USING (has_capability(account_id, 'jira.link'));

DROP POLICY IF EXISTS jira_bulk_items_select ON public.jira_bulk_items;
CREATE POLICY jira_bulk_items_select ON public.jira_bulk_items
  FOR SELECT USING (has_capability(account_id, 'jira.link'));

-- jira_field_meta_cache: no policy at all.
REVOKE ALL ON public.jira_field_meta_cache FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.jira_attachment_map, public.jira_field_mappings,
  public.jira_bulk_batches, public.jira_bulk_items
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON
  public.jira_attachment_map, public.jira_field_mappings, public.jira_field_meta_cache,
  public.jira_bulk_batches, public.jira_bulk_items
  TO service_role;

-- Live "sent to Jira" state on the attachments grid.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'jira_attachment_map'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.jira_attachment_map;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 5. Widen two CHECK constraints from their LIVE definitions
-- ------------------------------------------------------------

-- jira_sync_jobs.kind
DO $$
DECLARE
  c       RECORD;
  v_kinds TEXT[] := ARRAY[]::text[];
BEGIN
  FOR c IN
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'public.jira_sync_jobs'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    v_kinds := v_kinds || public.jira_check_values_087(c.def);
    EXECUTE format('ALTER TABLE public.jira_sync_jobs DROP CONSTRAINT %I', c.conname);
  END LOOP;

  v_kinds := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_kinds || ARRAY['sync_issue', 'push_status', 'post_comment', 'edit_comment',
                                             'push_fields', 'push_attachment', 'pull_attachments',
                                             'bulk_item']) AS x);

  EXECUTE format(
    'ALTER TABLE public.jira_sync_jobs ADD CONSTRAINT jira_sync_jobs_kind_check CHECK (kind = ANY (%L::text[]))',
    v_kinds);
END $$;

-- notifications.type (jira_sync_stalled; every other value is kept from the live definition)
DO $$
DECLARE
  v_def   TEXT;
  v_types TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';

  v_types := public.jira_check_values_087(v_def);

  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY['jira_sync_stalled']) AS x);

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

-- ------------------------------------------------------------
-- 6. A value that came FROM Jira is applied without queueing it back
-- ------------------------------------------------------------

-- p_values maps a field definition id to its new value; a JSON null clears it.
CREATE OR REPLACE FUNCTION public.jira_apply_ticket_fields(p_ticket_id uuid, p_values jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old     JSONB;
  v_new     JSONB;
  v_cleared TEXT[];
  v_changed INTEGER;
BEGIN
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN
    RETURN false;
  END IF;

  SELECT COALESCE(custom_fields, '{}'::jsonb) INTO v_old FROM tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT COALESCE(array_agg(k), ARRAY[]::text[]) INTO v_cleared
    FROM jsonb_each(p_values) AS e(k, v) WHERE jsonb_typeof(v) = 'null';

  v_new := (v_old || COALESCE(
             (SELECT jsonb_object_agg(k, v) FROM jsonb_each(p_values) AS e(k, v) WHERE jsonb_typeof(v) <> 'null'),
             '{}'::jsonb)) - v_cleared;

  PERFORM set_config('vircle.source', 'jira', true);
  UPDATE tickets SET custom_fields = v_new WHERE id = p_ticket_id AND custom_fields IS DISTINCT FROM v_new;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  PERFORM set_config('vircle.source', '', true);
  RETURN v_changed > 0;
END;
$$;

-- ------------------------------------------------------------
-- 7. Triggers that queue OUTBOUND work
-- ------------------------------------------------------------

-- An agent edited a custom field and a mapping sends that field to Jira.
-- One pending job per ticket, a few seconds late, so a burst of edits is one
-- PUT (batch friendly).
CREATE OR REPLACE FUNCTION public.jira_queue_field_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conn UUID;
BEGIN
  IF COALESCE(current_setting('vircle.source', true), '') = 'jira' THEN
    RETURN NEW;
  END IF;

  SELECT c.id INTO v_conn
    FROM jira_connections c
   WHERE c.account_id = NEW.account_id
     AND c.status = 'active'
     AND EXISTS (SELECT 1 FROM jira_field_mappings m
                  WHERE m.connection_id = c.id AND m.direction IN ('to_jira', 'both'))
     AND EXISTS (SELECT 1 FROM ticket_jira_links l
                  WHERE l.ticket_id = NEW.id AND l.connection_id = c.id AND l.sync_state = 'ok')
   LIMIT 1;

  IF v_conn IS NOT NULL THEN
    PERFORM jira_enqueue_job(NEW.account_id, v_conn, 'push_fields',
      jsonb_build_object('ticket_id', NEW.id, 'actor', auth.uid()),
      'fields:' || NEW.id::text, 5);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'jira_queue_field_push failed for ticket %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jira_field_push ON public.tickets;
CREATE TRIGGER jira_field_push AFTER UPDATE OF custom_fields ON public.tickets
  FOR EACH ROW WHEN (OLD.custom_fields IS DISTINCT FROM NEW.custom_fields)
  EXECUTE FUNCTION public.jira_queue_field_push();

-- "Send all new attachments" is on (for the workspace, or for one project):
-- a new file on a ticket with a live link is queued. A file that came from
-- Jira never is.
CREATE OR REPLACE FUNCTION public.jira_queue_attachment_push()
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

  SELECT c.id INTO v_conn
    FROM jira_connections c
   WHERE c.account_id = NEW.account_id
     AND c.status = 'active'
     AND (
           (COALESCE((c.settings -> 'direction' ->> 'attachments')::boolean, false)
            AND COALESCE((c.settings -> 'direction' ->> 'attachments_auto')::boolean, false))
        OR EXISTS (SELECT 1 FROM jsonb_each(COALESCE(c.settings -> 'project_overrides', '{}'::jsonb)) AS o(k, v)
                    WHERE COALESCE((o.v -> 'direction' ->> 'attachments_auto')::boolean, false))
         )
     AND EXISTS (SELECT 1 FROM ticket_jira_links l
                  WHERE l.ticket_id = NEW.ticket_id AND l.connection_id = c.id AND l.sync_state = 'ok')
   LIMIT 1;

  IF v_conn IS NOT NULL THEN
    PERFORM jira_enqueue_job(NEW.account_id, v_conn, 'push_attachment',
      jsonb_build_object('attachment_id', NEW.id, 'auto', true),
      'pushatt:' || NEW.id::text, 2);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'jira_queue_attachment_push failed for attachment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jira_attachment_push ON public.ticket_attachments;
CREATE TRIGGER jira_attachment_push AFTER INSERT ON public.ticket_attachments
  FOR EACH ROW EXECUTE FUNCTION public.jira_queue_attachment_push();

-- 085's status push, now also when only ONE project turns "status to Jira" on
-- (the worker decides per link with the most specific setting).
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
     AND (
           COALESCE((c.settings -> 'direction' ->> 'status_to_jira')::boolean, false)
        OR EXISTS (SELECT 1 FROM jsonb_each(COALESCE(c.settings -> 'project_overrides', '{}'::jsonb)) AS o(k, v)
                    WHERE COALESCE((o.v -> 'direction' ->> 'status_to_jira')::boolean, false))
         )
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

-- ------------------------------------------------------------
-- 8. The catch-up stall alert
-- ------------------------------------------------------------

-- Tell the people who run the Jira link (the connecting user and the workspace
-- owners and admins) that the catch-up has stopped. At most once a day each.
CREATE OR REPLACE FUNCTION public.jira_notify_stalled(p_connection_id uuid, p_minutes integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c          jira_connections%ROWTYPE;
  v_user     UUID;
  v_notified INTEGER := 0;
BEGIN
  SELECT * INTO c FROM jira_connections WHERE id = p_connection_id;
  IF NOT FOUND OR c.status <> 'active' THEN RETURN 0; END IF;

  FOR v_user IN
    SELECT DISTINCT u FROM (
      SELECT c.connected_by AS u
      UNION
      SELECT p.user_id FROM profiles p
       WHERE p.account_id = c.account_id AND p.account_role IN ('owner', 'admin')
    ) s
    WHERE u IS NOT NULL
      AND EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u AND p.account_id = c.account_id)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM notifications n
       WHERE n.user_id = v_user AND n.type = 'jira_sync_stalled'
         AND n.account_id = c.account_id
         AND n.created_at > now() - interval '24 hours'
    ) THEN
      INSERT INTO notifications (account_id, user_id, type, title, body)
      VALUES (c.account_id, v_user, 'jira_sync_stalled',
              'Jira sync has stalled',
              'Linked tickets have not been checked against ' || COALESCE(c.site_name, 'Jira') ||
              ' for about ' || GREATEST(COALESCE(p_minutes, 30), 1) ||
              ' minutes. The scheduled job may have stopped: see Settings > Integrations > Jira > Diagnostics.');
      v_notified := v_notified + 1;
    END IF;
  END LOOP;
  RETURN v_notified;
END;
$$;

-- ------------------------------------------------------------
-- 9. Housekeeping (085's jira_prune plus the new tables)
-- ------------------------------------------------------------
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
  -- 0.45.0: bulk results are shown for a month; cached field metadata is refetched after a week.
  DELETE FROM jira_bulk_batches WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  DELETE FROM jira_field_meta_cache WHERE fetched_at < now() - interval '7 days';
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  RETURN n;
END;
$$;

-- ------------------------------------------------------------
-- 10. Privileges: everything above is for the service role only
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.jira_bump_webhook_stat(uuid, text)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_apply_ticket_fields(uuid, jsonb)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_notify_stalled(uuid, integer)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_queue_field_push()                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_queue_attachment_push()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_queue_status_push()               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ticket_attachment_source_guard()       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_field_mapping_guard()             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.jira_prune()                           FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.jira_bump_webhook_stat(uuid, text)    TO service_role;
GRANT EXECUTE ON FUNCTION public.jira_apply_ticket_fields(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.jira_notify_stalled(uuid, integer)    TO service_role;
GRANT EXECUTE ON FUNCTION public.jira_prune()                          TO service_role;

DROP FUNCTION IF EXISTS public.jira_check_values_087(text);
