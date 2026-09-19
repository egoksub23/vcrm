-- ============================================================
-- 072_session_notes_edit_delete
--
-- Customer notes become "session notes" that can be edited and deleted.
--
--   edited_at / edited_by   stamped by a trigger whenever the note text
--                           changes, so "edited" is always truthful and
--                           can't be set (or hidden) from the client.
--   author + date           user_id / created_at already exist; a trigger
--                           now freezes both, so an edit can't rewrite who
--                           wrote a note or when.
--
-- RLS: until now any agent could change or delete any teammate's note.
-- Update and delete are narrowed to the note's author, or an admin+.
-- Reading and adding are unchanged.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE contact_notes
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS edited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION contact_notes_guard_update()
RETURNS TRIGGER AS $$
BEGIN
  -- Authorship and time of writing are facts, not editable fields.
  NEW.user_id := OLD.user_id;
  NEW.created_at := OLD.created_at;
  IF NEW.note_text IS DISTINCT FROM OLD.note_text THEN
    NEW.edited_at := NOW();
    NEW.edited_by := auth.uid();
  ELSE
    NEW.edited_at := OLD.edited_at;
    NEW.edited_by := OLD.edited_by;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contact_notes_guard_update ON contact_notes;
CREATE TRIGGER contact_notes_guard_update
  BEFORE UPDATE ON contact_notes
  FOR EACH ROW EXECUTE FUNCTION contact_notes_guard_update();

DROP POLICY IF EXISTS contact_notes_update ON contact_notes;
CREATE POLICY contact_notes_update ON contact_notes FOR UPDATE
  USING (
    is_account_member(account_id, 'admin')
    OR (user_id = auth.uid() AND is_account_member(account_id, 'agent'))
  )
  WITH CHECK (
    is_account_member(account_id, 'admin')
    OR (user_id = auth.uid() AND is_account_member(account_id, 'agent'))
  );

DROP POLICY IF EXISTS contact_notes_delete ON contact_notes;
CREATE POLICY contact_notes_delete ON contact_notes FOR DELETE
  USING (
    is_account_member(account_id, 'admin')
    OR (user_id = auth.uid() AND is_account_member(account_id, 'agent'))
  );
