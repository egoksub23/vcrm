-- Migration 229: a note on an incident (a finding, for example) can be edited, and what it said before is kept.
--
-- `incident_comments.edited_at` already exists and is stamped whenever the text changes. This adds who edited it and an append-only list of the earlier wordings
-- ({ body, at, by }: the earlier text, when that version was written, and who wrote it), so correcting a finding never rewrites the record: the Audit log shows each earlier version.
-- Run on the Halo PostgreSQL after 228. Idempotent.

ALTER TABLE public.incident_comments ADD COLUMN IF NOT EXISTS edited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.incident_comments ADD COLUMN IF NOT EXISTS previous_versions JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.set_incident_comment_edited_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.edited_at := NOW();
    NEW.previous_versions := COALESCE(OLD.previous_versions, '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('body', OLD.body, 'at', COALESCE(OLD.edited_at, OLD.created_at), 'by', COALESCE(OLD.edited_by, OLD.author_id)));
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
