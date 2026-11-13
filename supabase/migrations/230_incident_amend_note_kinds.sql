-- Migration 230: amend an incident's title and description with an audit trail, and kinds of note (investigation, finding, closing).
--
-- 1. Notes: `incident_comments.kind` is null for an ordinary note, or 'investigation', 'finding' or 'closing'. A finding was a yes/no (`is_finding`); that column
--    is kept and still set for findings, so nothing that reads it breaks, and existing findings are copied across.
-- 2. Amending: changing the title or the description is written to the incident's activity trail with the old and the new wording and, once the incident is
--    closed, the reason. `incidents.amend_reason` is a pass-through: the app sets it together with the change, the trigger writes it into the trail and
--    clears it, so it is always empty at rest.
-- Run on the Halo PostgreSQL after 229. Idempotent.

-- 1. Kinds of note.
ALTER TABLE public.incident_comments ADD COLUMN IF NOT EXISTS kind TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incident_comments_kind_check' AND conrelid = 'public.incident_comments'::regclass) THEN
    ALTER TABLE public.incident_comments ADD CONSTRAINT incident_comments_kind_check CHECK (kind IS NULL OR kind IN ('investigation', 'finding', 'closing'));
  END IF;
END $$;
UPDATE public.incident_comments SET kind = 'finding' WHERE is_finding AND kind IS NULL;

-- 2. Amending the title and description.
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS amend_reason TEXT;
ALTER TABLE public.incident_activity ADD COLUMN IF NOT EXISTS reason TEXT;

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.incident_activity'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%event_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.incident_activity DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.incident_activity ADD CONSTRAINT incident_activity_event_type_check
  CHECK (event_type IN ('created', 'status_changed', 'severity_changed', 'type_changed', 'lead_changed', 'escalated', 'closed', 'root_cause_changed', 'file_deleted', 'voided', 'restored', 'title_changed', 'description_changed'));

CREATE OR REPLACE FUNCTION public.log_incident_details_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, from_value, to_value, reason)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'title_changed', left(COALESCE(OLD.title, ''), 1000), left(COALESCE(NEW.title, ''), 1000), NULLIF(btrim(COALESCE(NEW.amend_reason, '')), ''));
  END IF;
  IF NEW.description IS DISTINCT FROM OLD.description THEN
    INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, from_value, to_value, reason)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'description_changed', left(COALESCE(OLD.description, ''), 10000), left(COALESCE(NEW.description, ''), 10000), NULLIF(btrim(COALESCE(NEW.amend_reason, '')), ''));
  END IF;
  NEW.amend_reason := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_incident_details_changed ON public.incidents;
CREATE TRIGGER on_incident_details_changed BEFORE UPDATE ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.log_incident_details_changed();

NOTIFY pgrst, 'reload schema';
