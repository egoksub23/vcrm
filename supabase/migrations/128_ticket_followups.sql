-- ============================================================
-- 128_ticket_followups
--
-- Four of the remaining roadmap items for the Tickets module:
--
--   1. Reopening a ticket now clears its resolution (tickets_resolution_guard,
--      migration 096) instead of silently keeping a stale one — the DB, not
--      just the close dialog, now forces a fresh pick on the next close.
--   2. ticket_types: the fixed `category` CHECK list becomes an admin-editable
--      catalogue, the same pattern migration 096 already used for
--      resolutions. `tickets.category` stays TEXT and keeps storing the same
--      7 slugs for every existing ticket — only the hardcoded CHECK is
--      replaced by a trigger that validates against the account's active
--      types, so renaming a type's display name never has to cascade
--      anything.
--   3. ticket_reports_drilldown(): oldest-open tickets + a label breakdown
--      for Reports > Tickets, mirroring ticket_sla_report's (086) jsonb
--      report-RPC shape.
--   4. tickets_search(): server-side search/filter/sort, so a match outside
--      whatever page is already loaded is no longer invisible. Mirrors
--      ticketMatchesFilters' exact semantics (src/lib/tickets/filters.ts) for
--      every dimension except the "mentioned me" quick filter, which stays
--      client-side (it is already an id-list lookup, not a column predicate).
--
-- Depends on: 063 (tickets), 079 (capabilities), 086 (SLA columns), 096
-- (ticket_resolutions, tickets_resolution_guard). Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Reopening clears the resolution
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tickets_resolution_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_person  BOOLEAN := current_user = 'authenticated';
  v_require BOOLEAN;
  v_key     TEXT;
BEGIN
  -- Leaving Resolved/Closed for any other status: the resolution no longer
  -- describes anything live. Clearing it here (not just in the close dialog)
  -- means the very next "entering a done status needs a resolution" check
  -- below cannot be satisfied by a leftover value from before the reopen.
  IF TG_OP = 'UPDATE' AND OLD.status IN ('resolved', 'closed') AND NEW.status NOT IN ('resolved', 'closed') THEN
    NEW.resolution_id := NULL;
    NEW.resolution_note := NULL;
  END IF;

  -- A resolution must be an active one of this ticket's account.
  IF NEW.resolution_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.resolution_id IS DISTINCT FROM OLD.resolution_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM ticket_resolutions r
       WHERE r.id = NEW.resolution_id AND r.account_id = NEW.account_id AND r.is_active
    ) THEN
      RAISE EXCEPTION 'resolution_invalid' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Moving to Resolved or Closed (or clearing the resolution of one that is)
  -- needs a resolution.
  IF NEW.status IN ('resolved', 'closed')
     AND NEW.resolution_id IS NULL
     AND (TG_OP = 'INSERT'
          OR NEW.status IS DISTINCT FROM OLD.status
          OR OLD.resolution_id IS NOT NULL) THEN
    IF v_person THEN
      SELECT COALESCE(a.require_ticket_resolution, true) INTO v_require
        FROM accounts a WHERE a.id = NEW.account_id;
      IF COALESCE(v_require, true) THEN
        RAISE EXCEPTION 'resolution_required' USING ERRCODE = '22023';
      END IF;
    ELSE
      v_key := CASE WHEN COALESCE(current_setting('vircle.source', true), '') = 'jira'
                    THEN 'resolved_in_jira' ELSE 'closed_automatically' END;
      NEW.resolution_id := public.ticket_system_resolution(NEW.account_id, v_key);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tickets_resolution_guard() FROM PUBLIC, anon, authenticated;

-- (Trigger already exists from migration 096 — CREATE OR REPLACE above is enough.)

-- ------------------------------------------------------------
-- 2. ticket_types: the account's catalogue of ticket "types"
--    (the UI label; the column is still `category`), same shape as
--    ticket_resolutions (096).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ticket_types (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Stable identifier stored on tickets.category. Never shown directly once a
  -- display name exists; renaming a type changes `name`, never `slug`.
  slug       TEXT NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_]{0,39}$'),
  name       TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  position   INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  -- One of the 7 original built-in types. Can be renamed and reordered, but
  -- not archived (existing tickets would lose their only type otherwise) —
  -- same rule ticket_resolutions already applies to its system rows.
  is_system  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_types_account_slug
  ON public.ticket_types (account_id, slug) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_types_account_name
  ON public.ticket_types (account_id, lower(btrim(name))) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_ticket_types_account_position
  ON public.ticket_types (account_id, position);

DROP TRIGGER IF EXISTS set_updated_at ON public.ticket_types;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.ticket_types
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ticket_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_types_select ON public.ticket_types;
DROP POLICY IF EXISTS ticket_types_insert ON public.ticket_types;
DROP POLICY IF EXISTS ticket_types_update ON public.ticket_types;
CREATE POLICY ticket_types_select ON public.ticket_types
  FOR SELECT USING (public.is_account_member(account_id));
CREATE POLICY ticket_types_insert ON public.ticket_types
  FOR INSERT
  WITH CHECK (account_id = ANY ((SELECT public.capability_account_ids('tickets.configure-form'))::uuid[]));
CREATE POLICY ticket_types_update ON public.ticket_types
  FOR UPDATE
  USING (account_id = ANY ((SELECT public.capability_account_ids('tickets.configure-form'))::uuid[]))
  WITH CHECK (account_id = ANY ((SELECT public.capability_account_ids('tickets.configure-form'))::uuid[]));
-- No DELETE policy, same reasoning as ticket_resolutions: archive, never delete.
REVOKE ALL ON public.ticket_types FROM PUBLIC, anon;
REVOKE DELETE, TRUNCATE ON public.ticket_types FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ticket_types TO authenticated;
GRANT ALL ON public.ticket_types TO service_role;

CREATE OR REPLACE FUNCTION public.ticket_types_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.is_system := false;
    NEW.slug := lower(regexp_replace(btrim(NEW.slug), '[^a-z0-9_]+', '_', 'g'));
    RETURN NEW;
  END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    RAISE EXCEPTION 'system_type_locked' USING ERRCODE = '22023';
  END IF;
  IF OLD.is_system AND NOT NEW.is_active THEN
    RAISE EXCEPTION 'system_type_locked' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ticket_types_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ticket_types_guard ON public.ticket_types;
CREATE TRIGGER ticket_types_guard
  BEFORE INSERT OR UPDATE ON public.ticket_types
  FOR EACH ROW EXECUTE FUNCTION public.ticket_types_guard();

DROP TRIGGER IF EXISTS audit_row_change ON public.ticket_types;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.ticket_types
  FOR EACH ROW WHEN (auth.uid() IS NOT NULL)
  EXECUTE FUNCTION public.audit_row_change('ticket_type', 'name', 'name,slug,is_active', '', '', '');

-- Seeding: the 7 original types, per account, now and for every new account.
CREATE OR REPLACE FUNCTION public.ticket_types_seed(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO ticket_types (account_id, slug, name, position, is_system)
  SELECT p_account_id, d.slug, d.name, d.pos, true
    FROM (VALUES
      ('bug',             'Bug',              10),
      ('feature_request', 'Feature request',  20),
      ('technical',       'Technical',        30),
      ('billing',         'Billing',          40),
      ('account',         'Account',          50),
      ('general',         'General',          60),
      ('other',           'Other',            70)
    ) AS d(slug, name, pos)
   WHERE NOT EXISTS (
     SELECT 1 FROM ticket_types ty WHERE ty.account_id = p_account_id AND ty.slug = d.slug
   );
END;
$$;

ALTER FUNCTION public.ticket_types_seed(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ticket_types_seed(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ticket_types_seed(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.ticket_types_seed_new_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM ticket_types_seed(NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to seed ticket types for account %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.ticket_types_seed_new_account() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ticket_types_seed_new_account() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_account_seed_ticket_types ON public.accounts;
CREATE TRIGGER on_account_seed_ticket_types
  AFTER INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.ticket_types_seed_new_account();

-- Every existing account gets the 7 defaults.
DO $$
DECLARE a RECORD;
BEGIN
  FOR a IN SELECT id FROM public.accounts LOOP
    PERFORM public.ticket_types_seed(a.id);
  END LOOP;
END $$;

-- Replace the old hardcoded CHECK with a trigger against the live catalogue —
-- a person can only set an active type of their own account; the service
-- role (Jira sync, automations' AI create-ticket step, etc.) is never
-- blocked, same posture as tickets_resolution_guard.
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_category_check;

CREATE OR REPLACE FUNCTION public.tickets_category_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR NEW.category IS DISTINCT FROM OLD.category THEN
    IF NOT EXISTS (
      SELECT 1 FROM ticket_types ty
       WHERE ty.account_id = NEW.account_id AND ty.slug = NEW.category AND ty.is_active
    ) THEN
      RAISE EXCEPTION 'ticket_type_invalid' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tickets_category_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS tickets_category_guard ON public.tickets;
CREATE TRIGGER tickets_category_guard
  BEFORE INSERT OR UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.tickets_category_guard();

-- ------------------------------------------------------------
-- 3. Reports drill-down
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ticket_reports_drilldown(
  p_account uuid,
  p_from    timestamptz,
  p_to      timestamptz,
  p_limit   integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH oldest AS (
    SELECT id, ticket_number, subject, created_at, assigned_agent_id
      FROM tickets
     WHERE account_id = p_account
       AND status IN ('open', 'in_progress', 'pending')
       AND created_at >= p_from AND created_at < p_to
     ORDER BY created_at ASC
     LIMIT GREATEST(p_limit, 1)
  ),
  oldest_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', o.id, 'ticketNumber', o.ticket_number, 'subject', o.subject,
             'createdAt', o.created_at, 'assigneeName', p.full_name)
           ORDER BY o.created_at ASC), '[]'::jsonb) AS j
      FROM oldest o
      LEFT JOIN profiles p ON p.user_id = o.assigned_agent_id
  ),
  labels AS (
    SELECT label, count(*) AS n
      FROM tickets t, unnest(t.labels) AS label
     WHERE t.account_id = p_account
       AND t.created_at >= p_from AND t.created_at < p_to
     GROUP BY label
     ORDER BY n DESC, label ASC
     LIMIT 20
  ),
  labels_json AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('label', l.label, 'count', l.n)), '[]'::jsonb) AS j
      FROM labels l
  )
  SELECT jsonb_build_object('oldestOpen', oldest_json.j, 'byLabel', labels_json.j)
    INTO v_result
    FROM oldest_json, labels_json;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.ticket_reports_drilldown(uuid, timestamptz, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ticket_reports_drilldown(uuid, timestamptz, timestamptz, integer) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Server-side search/filter/sort
--
--    Mirrors ticketMatchesFilters (src/lib/tickets/filters.ts) dimension by
--    dimension. The "mentioned me" quick filter is NOT included here — it
--    already works correctly as a client-side id-list lookup
--    (useTicketStore.ensureLoaded), not a column predicate, so it stays
--    exactly as-is and the caller applies it after hydrating these ids.
-- ------------------------------------------------------------

-- The display state of one SLA target (src/lib/sla/display.ts's targetView,
-- minus the remaining-time calculation nobody needs for a quick-filter match).
CREATE OR REPLACE FUNCTION public.ticket_sla_target_display(p_state text, p_due timestamptz, p_risk timestamptz)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN p_state IS NULL OR p_state = 'none' OR p_due IS NULL THEN
      CASE WHEN p_state = 'met' THEN 'met' WHEN p_state = 'paused' THEN 'paused' ELSE 'none' END
    WHEN p_state = 'met' THEN 'met'
    WHEN p_state = 'paused' THEN 'paused'
    WHEN p_state = 'breached' OR now() > p_due THEN 'breached'
    WHEN p_risk IS NOT NULL AND now() >= p_risk THEN 'at_risk'
    ELSE 'on_track'
  END;
$$;

-- The due time to sort "SLA" by (slaDueSortKey): null unless the target is
-- actually live (on_track/at_risk/breached) and has a due time.
CREATE OR REPLACE FUNCTION public.ticket_sla_due_sort(p_state text, p_due timestamptz, p_risk timestamptz)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN public.ticket_sla_target_display(p_state, p_due, p_risk) IN ('on_track', 'at_risk', 'breached') AND p_due IS NOT NULL
    THEN p_due ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.ticket_sla_target_display(text, timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ticket_sla_due_sort(text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ticket_sla_target_display(text, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ticket_sla_due_sort(text, timestamptz, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tickets_search(
  p_account       uuid,
  p_search_text   text DEFAULT '',
  p_search_number integer DEFAULT NULL,
  p_search_prefix text DEFAULT NULL,
  p_quick         text[] DEFAULT '{}',
  p_user_id       uuid DEFAULT NULL,
  p_today         date DEFAULT NULL,
  p_today_start   timestamptz DEFAULT NULL,
  p_today_end     timestamptz DEFAULT NULL,
  p_statuses      text[] DEFAULT NULL,
  p_assignees     text[] DEFAULT NULL,
  p_types         text[] DEFAULT NULL,
  p_priorities    text[] DEFAULT NULL,
  p_labels        text[] DEFAULT NULL,
  p_teams         text[] DEFAULT NULL,
  p_resolutions   text[] DEFAULT NULL,
  p_sort_key      text DEFAULT 'updated',
  p_sort_dir      text DEFAULT 'desc',
  p_limit         integer DEFAULT 200,
  p_offset        integer DEFAULT 0
)
RETURNS TABLE (id uuid, total_count bigint)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $func$
DECLARE
  v_prefix   text;
  v_sort_col text;
  v_dir      text;
BEGIN
  SELECT COALESCE(a.ticket_key_prefix, 'VIR') INTO v_prefix FROM accounts a WHERE a.id = p_account;

  v_sort_col := CASE p_sort_key
    WHEN 'key'      THEN 't.ticket_number'
    WHEN 'summary'  THEN 't.subject'
    WHEN 'status'   THEN $$array_position(ARRAY['open','in_progress','pending','resolved','closed'], t.status)$$
    WHEN 'priority' THEN $$array_position(ARRAY['urgent','high','normal','low'], t.priority)$$
    WHEN 'due'      THEN 't.due_date'
    WHEN 'created'  THEN 't.created_at'
    WHEN 'assignee' THEN 'p.full_name'
    WHEN 'sla'      THEN 'LEAST(public.ticket_sla_due_sort(t.sla_first_response_state, t.sla_first_response_due_at, t.sla_first_response_risk_at), public.ticket_sla_due_sort(t.sla_resolution_state, t.sla_resolution_due_at, t.sla_resolution_risk_at))'
    ELSE                 't.updated_at'
  END;
  v_dir := CASE WHEN lower(p_sort_dir) = 'asc' THEN 'ASC' ELSE 'DESC' END;

  RETURN QUERY EXECUTE format(
    $f$
    SELECT t.id, count(*) OVER()::bigint AS total_count
      FROM tickets t
      LEFT JOIN profiles p ON p.user_id = t.assigned_agent_id
     WHERE t.account_id = $1
       AND ($2 = '' OR
            ($3 IS NOT NULL AND t.ticket_number = $3 AND ($4 IS NULL OR $4 = $5))
            OR ($4 IS NULL AND (t.subject ILIKE '%%' || $2 || '%%' OR COALESCE(t.description, '') ILIKE '%%' || $2 || '%%')))
       AND (COALESCE(cardinality($6), 0) = 0 OR t.status = ANY($6))
       AND (COALESCE(cardinality($7), 0) = 0 OR
            (t.assigned_agent_id IS NOT NULL AND t.assigned_agent_id::text = ANY($7))
            OR (t.assigned_agent_id IS NULL AND '__unassigned__' = ANY($7)))
       AND (COALESCE(cardinality($8), 0) = 0 OR t.category = ANY($8))
       AND (COALESCE(cardinality($9), 0) = 0 OR t.priority = ANY($9))
       AND (COALESCE(cardinality($10), 0) = 0 OR t.labels && $10)
       AND (COALESCE(cardinality($11), 0) = 0 OR
            (t.assigned_team_id IS NOT NULL AND t.assigned_team_id::text = ANY($11)))
       AND (COALESCE(cardinality($12), 0) = 0 OR
            (CASE WHEN t.status IN ('resolved', 'closed') THEN COALESCE(t.resolution_id::text, '__none__') ELSE '__none__' END) = ANY($12))
       AND (NOT ('mine' = ANY($13)) OR ($14 IS NOT NULL AND t.assigned_agent_id = $14))
       AND (NOT ('unassigned' = ANY($13)) OR t.assigned_agent_id IS NULL)
       AND (NOT ('overdue' = ANY($13)) OR (t.due_date IS NOT NULL AND t.due_date < COALESCE($15, current_date) AND t.status NOT IN ('resolved', 'closed')))
       AND (NOT ('today' = ANY($13)) OR ($16 IS NOT NULL AND $17 IS NOT NULL AND t.updated_at >= $16 AND t.updated_at < $17))
       AND (NOT ('sla_at_risk' = ANY($13)) OR
            public.ticket_sla_target_display(t.sla_first_response_state, t.sla_first_response_due_at, t.sla_first_response_risk_at) = 'at_risk' OR
            public.ticket_sla_target_display(t.sla_resolution_state, t.sla_resolution_due_at, t.sla_resolution_risk_at) = 'at_risk')
       AND (NOT ('sla_breached' = ANY($13)) OR
            public.ticket_sla_target_display(t.sla_first_response_state, t.sla_first_response_due_at, t.sla_first_response_risk_at) = 'breached' OR
            public.ticket_sla_target_display(t.sla_resolution_state, t.sla_resolution_due_at, t.sla_resolution_risk_at) = 'breached')
     ORDER BY %s %s NULLS LAST, t.id DESC
     LIMIT $18 OFFSET $19
    $f$,
    v_sort_col, v_dir
  )
  USING p_account, p_search_text, p_search_number, p_search_prefix, v_prefix,
        p_statuses, p_assignees, p_types, p_priorities, p_labels, p_teams, p_resolutions,
        p_quick, p_user_id, p_today, p_today_start, p_today_end, p_limit, p_offset;
END;
$func$;

REVOKE ALL ON FUNCTION public.tickets_search(
  uuid, text, integer, text, text[], uuid, date, timestamptz, timestamptz,
  text[], text[], text[], text[], text[], text[], text[], text, text, integer, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tickets_search(
  uuid, text, integer, text, text[], uuid, date, timestamptz, timestamptz,
  text[], text[], text[], text[], text[], text[], text[], text, text, integer, integer
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
