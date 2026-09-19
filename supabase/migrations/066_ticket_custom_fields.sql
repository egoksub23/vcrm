-- ============================================================
-- 066_ticket_custom_fields
--
-- The "customizable ticket form" follow-up flagged when Ticketing shipped
-- (migration 063 deliberately left this out). klink.cloud lets an admin
-- define extra ticket fields per account; this does the same, with one
-- addition that covers its "per ticket type" wording: a field can be
-- scoped to specific ticket categories (empty = applies to every ticket).
--
-- Storage: definitions in `ticket_field_definitions`; values in one
-- `tickets.custom_fields` JSONB keyed by definition id (no per-field
-- column, so adding a field never needs a migration — same reasoning as
-- inbox_views.filter_config, migration 051).
--
-- Fields are archived (is_active = false), never hard-deleted, so tickets
-- that already hold a value keep a label to render it with.
-- ============================================================

CREATE TABLE IF NOT EXISTS ticket_field_definitions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  field_type TEXT NOT NULL
    CHECK (field_type IN ('text', 'textarea', 'number', 'date', 'dropdown', 'checkbox')),
  -- Dropdown choices, as a JSON array of strings. Ignored for other types.
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_required BOOLEAN NOT NULL DEFAULT false,
  -- Ticket categories this field appears on. Empty = every category.
  applies_to_categories TEXT[] NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Two ACTIVE fields can't share a label (case-insensitive); an archived
-- one doesn't block reusing its name.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_field_defs_account_label
  ON ticket_field_definitions (account_id, lower(label)) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_ticket_field_defs_account_position
  ON ticket_field_definitions (account_id, position);

DROP TRIGGER IF EXISTS set_updated_at ON ticket_field_definitions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ticket_field_definitions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE ticket_field_definitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_field_defs_select ON ticket_field_definitions;
DROP POLICY IF EXISTS ticket_field_defs_insert ON ticket_field_definitions;
DROP POLICY IF EXISTS ticket_field_defs_update ON ticket_field_definitions;
DROP POLICY IF EXISTS ticket_field_defs_delete ON ticket_field_definitions;
CREATE POLICY ticket_field_defs_select ON ticket_field_definitions
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY ticket_field_defs_insert ON ticket_field_definitions
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY ticket_field_defs_update ON ticket_field_definitions
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY ticket_field_defs_delete ON ticket_field_definitions
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ---- Values ---------------------------------------------------------
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ---- Activity log: record custom-field edits too ------------------------
ALTER TABLE ticket_activity
  ADD COLUMN IF NOT EXISTS field_id UUID;

-- Widen the event_type CHECK. Drop by lookup rather than by guessed name —
-- an IF EXISTS on a wrong name would silently leave the narrow CHECK in
-- place and every new insert would fail.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'ticket_activity'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%event_type%'
  LOOP
    EXECUTE format('ALTER TABLE ticket_activity DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE ticket_activity ADD CONSTRAINT ticket_activity_event_type_check
  CHECK (event_type IN (
    'created', 'status_changed', 'priority_changed', 'category_changed',
    'assigned_agent_changed', 'assigned_team_changed', 'custom_field_changed'
  ));

CREATE OR REPLACE FUNCTION log_ticket_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO ticket_activity (ticket_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'status_changed', OLD.status, NEW.status);
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

ALTER FUNCTION log_ticket_activity() OWNER TO postgres;
-- Trigger on_ticket_activity (migration 064) already points at this
-- function by name, so CREATE OR REPLACE is enough.
