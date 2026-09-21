-- ============================================================
-- 096_ticket_resolutions.sql — a required resolution when a ticket is
-- resolved or closed (0.52.0)
--
-- Owner request: "Klink asks for a disposition at wrap-up." When a person moves
-- a ticket to Resolved or Closed they must say HOW it was resolved (Fixed,
-- Duplicate, Cannot reproduce, ...), the way the Conversation close dialog
-- already asks for a closure note (migration 065). Enforced in the DATABASE, so
-- every write path is covered without the app having to remember.
--
-- What this migration does
--   1. ticket_resolutions: the account's catalogue of resolutions (name,
--      position, is_active = archived when false, is_system). Seeded per
--      account with eight defaults, two of them system ones the database
--      itself uses ("Resolved in Jira", "Closed automatically"). Members read;
--      writes need `tickets.configure-form` (the capability that already owns
--      the ticket settings), enforced by RLS. System resolutions can be renamed
--      and reordered but not archived. Person edits are audited.
--   2. accounts.require_ticket_resolution (default ON). Its column guard is the
--      one from migration 088 with one more owned column: changing this needs
--      `tickets.configure-form`, like the ticket key prefix. Audited.
--   3. tickets.resolution_id and tickets.resolution_note (max 2000, only with a
--      resolution).
--   4. The rule, tickets_resolution_guard (BEFORE INSERT/UPDATE): a PERSON (the
--      `authenticated` database role) moving a ticket to Resolved or Closed
--      without a resolution is rejected with the message `resolution_required`
--      (SQLSTATE 22023) while the setting is ON. A resolution that is not an
--      active one of the ticket's account is rejected as `resolution_invalid`.
--      SYSTEM writers (service role, SECURITY DEFINER functions such as the Jira
--      sync, the owner in the SQL editor) are never blocked: they get the
--      "Closed automatically" resolution, or "Resolved in Jira" when the change
--      came from Jira (vircle.source = 'jira').
--      Re-opening clears nothing: the resolution and note stay on the ticket
--      and in the history. Changing the resolution later is allowed.
--   5. ticket_activity: two new event types, `resolved_as` (a ticket became
--      resolved/closed with a resolution: to_value = its name, detail = the
--      note) and `resolution_changed` (from_value / to_value = names, detail =
--      the note). Written by a small trigger of its own; log_ticket_activity
--      (migration 085) is not touched. The event_type CHECK is rebuilt from the
--      LIVE definition, so every value another migration added is kept.
--   6. jira_apply_ticket_status gets an optional 4th argument: the catalogue
--      resolution chosen for what Jira reported (mapped by name in the app).
--      Without one, a ticket Jira moves to Done gets "Resolved in Jira".
--
-- Not changed: SLA logic, mention resolution (migration 095: an AFTER trigger
-- on the status, which still runs after this guard lets the change through),
-- Jira status mapping.
--
-- Depends on: 063 / 064 / 081 (tickets, activity), 082 (audit), 085 (Jira),
-- 088 (capability_account_ids / has_capability / accounts guard), 095 (the
-- event_type list). Idempotent: safe to run twice.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The catalogue
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ticket_resolutions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  position   INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  -- A resolution the database itself uses. system_key says which.
  is_system  BOOLEAN NOT NULL DEFAULT false,
  system_key TEXT CHECK (system_key IN ('resolved_in_jira', 'closed_automatically')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ticket_resolutions_system_shape CHECK (is_system = (system_key IS NOT NULL))
);

-- Two ACTIVE resolutions cannot share a name (case-insensitive); an archived
-- one does not block reusing its name.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_resolutions_account_name
  ON public.ticket_resolutions (account_id, lower(btrim(name))) WHERE is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_resolutions_system_key
  ON public.ticket_resolutions (account_id, system_key) WHERE system_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ticket_resolutions_account_position
  ON public.ticket_resolutions (account_id, position);

DROP TRIGGER IF EXISTS set_updated_at ON public.ticket_resolutions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.ticket_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ticket_resolutions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_resolutions_select ON public.ticket_resolutions;
DROP POLICY IF EXISTS ticket_resolutions_insert ON public.ticket_resolutions;
DROP POLICY IF EXISTS ticket_resolutions_update ON public.ticket_resolutions;
CREATE POLICY ticket_resolutions_select ON public.ticket_resolutions
  FOR SELECT
  USING (public.is_account_member(account_id));
CREATE POLICY ticket_resolutions_insert ON public.ticket_resolutions
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.configure-form'))::uuid[])
  );
CREATE POLICY ticket_resolutions_update ON public.ticket_resolutions
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.configure-form'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.configure-form'))::uuid[])
  );
-- No DELETE policy on purpose: a resolution is archived, never deleted, so
-- tickets that carry it keep a name to show.
REVOKE ALL ON public.ticket_resolutions FROM PUBLIC, anon;
REVOKE DELETE, TRUNCATE ON public.ticket_resolutions FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ticket_resolutions TO authenticated;
GRANT ALL ON public.ticket_resolutions TO service_role;

-- What a person may not do to a row: change which account it is in, turn an
-- ordinary resolution into a system one (or back), or archive a system one.
CREATE OR REPLACE FUNCTION public.ticket_resolutions_guard()
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
    NEW.system_key := NULL;
    RETURN NEW;
  END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.is_system IS DISTINCT FROM OLD.is_system
     OR NEW.system_key IS DISTINCT FROM OLD.system_key THEN
    RAISE EXCEPTION 'system_resolution_locked' USING ERRCODE = '22023';
  END IF;
  IF OLD.is_system AND NOT NEW.is_active THEN
    RAISE EXCEPTION 'system_resolution_locked' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ticket_resolutions_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS ticket_resolutions_guard ON public.ticket_resolutions;
CREATE TRIGGER ticket_resolutions_guard
  BEFORE INSERT OR UPDATE ON public.ticket_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.ticket_resolutions_guard();

-- The audit trail (082): a person's changes only, so seeding a new workspace
-- writes nothing. position is not tracked, so a reorder is not logged.
DROP TRIGGER IF EXISTS audit_row_change ON public.ticket_resolutions;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.ticket_resolutions
  FOR EACH ROW WHEN (auth.uid() IS NOT NULL)
  EXECUTE FUNCTION public.audit_row_change('ticket_resolution', 'name', 'name,is_active', '', '', '');

-- ------------------------------------------------------------
-- 2. Seeding: eight defaults per account, now and for every new account
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ticket_resolutions_seed(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO ticket_resolutions (account_id, name, position, is_system, system_key)
  SELECT p_account_id, d.name, d.pos, d.key IS NOT NULL, d.key
    FROM (VALUES
      ('Fixed',                          10, NULL::text),
      ('Answered / information given',   20, NULL),
      ('Duplicate',                      30, NULL),
      ('Cannot reproduce',               40, NULL),
      ('Won''t fix',                     50, NULL),
      ('Customer did not respond',       60, NULL),
      ('Resolved in Jira',               70, 'resolved_in_jira'),
      ('Closed automatically',           80, 'closed_automatically')
    ) AS d(name, pos, key)
   WHERE NOT EXISTS (
     SELECT 1 FROM ticket_resolutions r
      WHERE r.account_id = p_account_id
        AND (lower(btrim(r.name)) = lower(d.name)
             OR (d.key IS NOT NULL AND r.system_key = d.key))
   );
END;
$$;

ALTER FUNCTION public.ticket_resolutions_seed(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ticket_resolutions_seed(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ticket_resolutions_seed(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.ticket_resolutions_seed_new_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM ticket_resolutions_seed(NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to seed ticket resolutions for account %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.ticket_resolutions_seed_new_account() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ticket_resolutions_seed_new_account() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_account_seed_ticket_resolutions ON public.accounts;
CREATE TRIGGER on_account_seed_ticket_resolutions
  AFTER INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.ticket_resolutions_seed_new_account();

-- The system resolution the database assigns for a system writer; recreated
-- if it is missing for any reason, so a system writer is never blocked.
CREATE OR REPLACE FUNCTION public.ticket_system_resolution(p_account_id uuid, p_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  SELECT id INTO v_id FROM ticket_resolutions
   WHERE account_id = p_account_id AND system_key = p_key;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  PERFORM ticket_resolutions_seed(p_account_id);
  SELECT id INTO v_id FROM ticket_resolutions
   WHERE account_id = p_account_id AND system_key = p_key;
  IF v_id IS NULL THEN
    -- The name is taken by an ordinary resolution: use a distinct one.
    INSERT INTO ticket_resolutions (account_id, name, position, is_system, system_key)
    VALUES (p_account_id,
            CASE p_key WHEN 'resolved_in_jira' THEN 'Resolved in Jira (system)'
                       ELSE 'Closed automatically (system)' END,
            CASE p_key WHEN 'resolved_in_jira' THEN 70 ELSE 80 END,
            true, p_key)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

ALTER FUNCTION public.ticket_system_resolution(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ticket_system_resolution(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ticket_system_resolution(uuid, text) TO service_role;

-- Every existing account gets the defaults.
DO $$
DECLARE
  a RECORD;
BEGIN
  FOR a IN SELECT id FROM public.accounts LOOP
    PERFORM public.ticket_resolutions_seed(a.id);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3. The setting (accounts) and its guard (088's, with one more owned column)
-- ------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS require_ticket_resolution BOOLEAN NOT NULL DEFAULT true;

--   ticket_key_prefix, require_ticket_resolution -> tickets.configure-form
--   auto_label_ai_enabled                         -> tags.manage
--   everything else the app writes                -> settings.workspace
CREATE OR REPLACE FUNCTION public.accounts_capability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_prefix BOOLEAN;
  v_auto   BOOLEAN;
  v_other  BOOLEAN;
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  v_prefix := NEW.ticket_key_prefix IS DISTINCT FROM OLD.ticket_key_prefix
           OR NEW.require_ticket_resolution IS DISTINCT FROM OLD.require_ticket_resolution;
  v_auto   := NEW.auto_label_ai_enabled IS DISTINCT FROM OLD.auto_label_ai_enabled;
  v_other  := (to_jsonb(NEW) - 'ticket_key_prefix' - 'require_ticket_resolution' - 'auto_label_ai_enabled' - 'updated_at')
              IS DISTINCT FROM
              (to_jsonb(OLD) - 'ticket_key_prefix' - 'require_ticket_resolution' - 'auto_label_ai_enabled' - 'updated_at');

  IF v_other AND NOT has_capability(OLD.id, 'settings.workspace') THEN
    RAISE EXCEPTION 'This action requires the ''settings.workspace'' permission'
      USING ERRCODE = '42501';
  END IF;
  IF v_prefix AND NOT has_capability(OLD.id, 'tickets.configure-form') THEN
    RAISE EXCEPTION 'This action requires the ''tickets.configure-form'' permission'
      USING ERRCODE = '42501';
  END IF;
  IF v_auto AND NOT has_capability(OLD.id, 'tags.manage') THEN
    RAISE EXCEPTION 'This action requires the ''tags.manage'' permission'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.accounts_capability_guard() FROM PUBLIC, anon, authenticated;

-- Turning the requirement on or off is audited.
CREATE OR REPLACE FUNCTION public.audit_ticket_resolution_setting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM log_audit(
    NEW.id, 'updated', 'ticket_settings', NEW.id, 'Ticket resolutions',
    jsonb_build_object('changes', jsonb_build_object('require_ticket_resolution',
      jsonb_build_object('from', to_jsonb(OLD.require_ticket_resolution),
                         'to',   to_jsonb(NEW.require_ticket_resolution)))));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'audit_ticket_resolution_setting failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

ALTER FUNCTION public.audit_ticket_resolution_setting() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.audit_ticket_resolution_setting() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_ticket_resolution_setting ON public.accounts;
CREATE TRIGGER audit_ticket_resolution_setting
  AFTER UPDATE OF require_ticket_resolution ON public.accounts
  FOR EACH ROW WHEN (OLD.require_ticket_resolution IS DISTINCT FROM NEW.require_ticket_resolution)
  EXECUTE FUNCTION public.audit_ticket_resolution_setting();

-- ------------------------------------------------------------
-- 4. tickets.resolution_id / resolution_note
-- ------------------------------------------------------------
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS resolution_id UUID REFERENCES public.ticket_resolutions(id),
  ADD COLUMN IF NOT EXISTS resolution_note TEXT;

ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_resolution_note_len;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_resolution_note_len
  CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 2000);
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_resolution_note_needs_resolution;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_resolution_note_needs_resolution
  CHECK (resolution_note IS NULL OR resolution_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_tickets_account_resolution
  ON public.tickets (account_id, resolution_id) WHERE resolution_id IS NOT NULL;

-- ------------------------------------------------------------
-- 5. The rule
--    SECURITY INVOKER on purpose (like 088's guards): current_user is the
--    caller's database role, so the service role and SECURITY DEFINER
--    functions are never blocked, only a person using their own login.
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

DROP TRIGGER IF EXISTS tickets_resolution_guard ON public.tickets;
CREATE TRIGGER tickets_resolution_guard
  BEFORE INSERT OR UPDATE ON public.tickets
  FOR EACH ROW EXECUTE FUNCTION public.tickets_resolution_guard();

-- ------------------------------------------------------------
-- 6. History: resolved_as / resolution_changed
--    The event_type CHECK is rebuilt from the LIVE definition (as in 095).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ticket_resolutions_check_values_096(p_def text)
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
    v_types := v_types || public.ticket_resolutions_check_values_096(c.def);
    EXECUTE format('ALTER TABLE public.ticket_activity DROP CONSTRAINT %I', c.conname);
  END LOOP;

  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY['resolved_as', 'resolution_changed']) AS x);

  EXECUTE format(
    'ALTER TABLE public.ticket_activity ADD CONSTRAINT ticket_activity_event_type_check CHECK (event_type = ANY (%L::text[]))',
    v_types);
END $$;

DROP FUNCTION IF EXISTS public.ticket_resolutions_check_values_096(text);

--   resolved_as         the ticket became resolved / closed with a resolution:
--                       to_value = its name, detail = the note (first 500 chars)
--   resolution_changed  the resolution or its note changed: from_value / to_value
--                       = names (from is empty when there was none), detail = the note
-- The actor is whoever made the change; empty for the system and for Jira.
CREATE OR REPLACE FUNCTION public.log_ticket_resolution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new  TEXT;
  v_old  TEXT;
  v_note TEXT := NULLIF(left(COALESCE(NEW.resolution_note, ''), 500), '');
BEGIN
  IF NEW.resolution_id IS NOT NULL THEN
    SELECT name INTO v_new FROM ticket_resolutions WHERE id = NEW.resolution_id;
  END IF;
  IF OLD.resolution_id IS NOT NULL THEN
    SELECT name INTO v_old FROM ticket_resolutions WHERE id = OLD.resolution_id;
  END IF;

  IF NEW.status IN ('resolved', 'closed') AND OLD.status NOT IN ('resolved', 'closed')
     AND NEW.resolution_id IS NOT NULL THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, to_value, detail, created_at)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'resolved_as', v_new, v_note, clock_timestamp());
  ELSIF NEW.resolution_id IS DISTINCT FROM OLD.resolution_id
        OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value, detail, created_at)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'resolution_changed', v_old, v_new, v_note, clock_timestamp());
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log ticket resolution for ticket %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$$;

ALTER FUNCTION public.log_ticket_resolution() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.log_ticket_resolution() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_ticket_resolution_activity ON public.tickets;
CREATE TRIGGER on_ticket_resolution_activity
  AFTER UPDATE ON public.tickets
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        OR OLD.resolution_id IS DISTINCT FROM NEW.resolution_id
        OR OLD.resolution_note IS DISTINCT FROM NEW.resolution_note)
  EXECUTE FUNCTION public.log_ticket_resolution();

-- ------------------------------------------------------------
-- 7. Jira: what Jira reported becomes the ticket's resolution
--    085's function with one optional argument. A ticket Jira moves to Done
--    (from an active status) gets the catalogue resolution the app mapped by
--    name, or "Resolved in Jira" when there is none; a stale resolution left
--    from an earlier close is replaced. resolved -> closed keeps what is there.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.jira_apply_ticket_status(uuid, text, text);

CREATE OR REPLACE FUNCTION public.jira_apply_ticket_status(
  p_ticket_id     uuid,
  p_status        text,
  p_issue_key     text,
  p_resolution_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_changed INTEGER;
  v_account UUID;
  v_res     UUID;
BEGIN
  SELECT account_id INTO v_account FROM tickets WHERE id = p_ticket_id;
  IF v_account IS NULL THEN
    RETURN false;
  END IF;

  PERFORM set_config('vircle.source', 'jira', true);
  PERFORM set_config('vircle.jira_key', COALESCE(p_issue_key, ''), true);

  IF p_status IN ('resolved', 'closed') THEN
    SELECT r.id INTO v_res FROM ticket_resolutions r
     WHERE r.id = p_resolution_id AND r.account_id = v_account AND r.is_active;
    IF v_res IS NULL THEN
      v_res := ticket_system_resolution(v_account, 'resolved_in_jira');
    END IF;
  END IF;

  UPDATE tickets
     SET status = p_status,
         resolved_at = CASE WHEN p_status = 'resolved' THEN now()
                            WHEN p_status = 'closed' THEN resolved_at
                            ELSE NULL END,
         closed_at   = CASE WHEN p_status = 'closed' THEN now()
                            WHEN p_status = 'resolved' THEN closed_at
                            ELSE NULL END,
         resolution_id = CASE WHEN p_status IN ('resolved', 'closed')
                                   AND status NOT IN ('resolved', 'closed')
                              THEN v_res ELSE resolution_id END,
         resolution_note = CASE WHEN p_status IN ('resolved', 'closed')
                                     AND status NOT IN ('resolved', 'closed')
                                THEN NULL ELSE resolution_note END
   WHERE id = p_ticket_id AND status <> p_status;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  PERFORM set_config('vircle.source', '', true);
  PERFORM set_config('vircle.jira_key', '', true);
  RETURN v_changed > 0;
END;
$$;

ALTER FUNCTION public.jira_apply_ticket_status(uuid, text, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.jira_apply_ticket_status(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jira_apply_ticket_status(uuid, text, text, uuid) TO service_role;
