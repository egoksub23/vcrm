-- ============================================================
-- 165_sign_retention.sql
--
-- Doc Sign, work packages 22 and 23: certificates from an authority, and retention.
--
-- WP22 (certificate readiness)
--   sign_certificates.source               'generated' (made by Halo, self-signed) or 'uploaded'
--   sign_certificates.expiry_notified_days the last warning sent about this certificate ending (30, 14, 7, or 0 =
--                                          already ended), so each one goes out once
--   sign_install_certificate()             one transaction: the new certificate becomes the default and the
--                                          workspace's chosen one; the old one stays on file, not default
--   sign_hold_sealing()                    a document that cannot be sealed because of the certificate waits for a
--                                          person to fix it instead of using up its attempts and failing for good
--   notifications.type                     widened with sign_certificate_expiring (rebuilt from the live constraint,
--                                          the same pattern as 159)
--
-- WP23 (retention): a completed document cannot be deleted before its retention date, by anyone
--   sign_documents_no_hard_delete()        replaced: draft = deletable; completed = deletable only once retain_until
--                                          has passed; everything else = never (as before); the workspace purge is
--                                          the one exception (see retention_purge_active)
--   sign_document_files_retention()        the sealed file and the certificate pages of a retained document are not
--                                          deletable on their own either
--   sign_documents_retention_lock()        retain_until can be extended but never shortened or cleared
--   *_no_truncate                          TRUNCATE is refused on both tables
--   retention_purge_active(account)        the only exception: true only while delete_workspace_data (153) runs for
--                                          that workspace. See the note on it for why a client cannot make it true.
--
-- A retention rule that the application alone enforces is a rule a bug, a console session or a cascade can break.
-- These are database triggers, so they hold for the service role and the owner as well. What they do not and cannot
-- guard: the stored files in the `sign-documents` bucket (a separate system the database cannot veto), and a person
-- who owns the database. The application deletes the database row first and removes files only after it succeeded.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Certificates
-- ------------------------------------------------------------
ALTER TABLE public.sign_certificates
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'generated'
    CHECK (source IN ('generated', 'uploaded')),
  ADD COLUMN IF NOT EXISTS expiry_notified_days INTEGER
    CHECK (expiry_notified_days IS NULL OR expiry_notified_days IN (0, 7, 14, 30));

-- Rows that exist now: the ones Halo made are named "Halo self-signed ..."; anything else was put there by a person.
UPDATE public.sign_certificates SET source = 'uploaded'
 WHERE source = 'generated' AND name NOT LIKE 'Halo self-signed%';

CREATE INDEX IF NOT EXISTS sign_certificates_expiry_idx ON public.sign_certificates (valid_until)
  WHERE source = 'uploaded' AND valid_until IS NOT NULL;

-- A new certificate: default for the workspace, and the one its settings point at. The previous default stays on
-- file (documents already sealed with it are unchanged) but is no longer the default.
CREATE OR REPLACE FUNCTION public.sign_install_certificate(
  p_account        UUID,
  p_name           TEXT,
  p_subject        TEXT,
  p_valid_until    TIMESTAMPTZ,
  p_p12_enc        TEXT,
  p_passphrase_enc TEXT,
  p_user           UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p_account) THEN
    RAISE EXCEPTION 'account_not_found' USING ERRCODE = '22023';
  END IF;
  PERFORM public.sign_ensure_defaults(p_account);
  UPDATE public.sign_certificates SET is_default = FALSE WHERE account_id = p_account AND is_default;
  INSERT INTO public.sign_certificates (account_id, name, subject, valid_until, p12_enc, passphrase_enc, is_default, created_by, source)
  VALUES (p_account, p_name, p_subject, p_valid_until, p_p12_enc, p_passphrase_enc, TRUE, p_user, 'uploaded')
  RETURNING id INTO v_id;
  UPDATE public.sign_settings SET certificate_id = v_id WHERE account_id = p_account;
  RETURN v_id;
END;
$$;
ALTER FUNCTION public.sign_install_certificate(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_install_certificate(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_install_certificate(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, UUID) TO service_role;

-- A document that cannot be sealed because of the certificate (expired, unreadable) is not a document that failed:
-- it waits, is tried again every lease, and seals as soon as a good certificate is installed. The attempt is given
-- back so the five-attempt limit (sign_claim_sealing) is kept for real faults, and the history records the reason
-- once, not at every try.
CREATE OR REPLACE FUNCTION public.sign_hold_sealing(p_document UUID, p_error TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev TEXT;
  v_now  TEXT := left(p_error, 500);
BEGIN
  SELECT d.seal_error INTO v_prev FROM public.sign_documents d WHERE d.id = p_document AND d.status = 'sealing' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE public.sign_documents
     SET seal_error = v_now, sealing_started_at = now(), sealing_attempts = GREATEST(sealing_attempts - 1, 0)
   WHERE id = p_document;
  IF v_prev IS DISTINCT FROM v_now THEN
    PERFORM public.sign_log(p_document, 'seal_attempt_failed', 'system', NULL, NULL,
                            jsonb_build_object('error', left(p_error, 200), 'waiting_for', 'certificate'));
  END IF;
END;
$$;
ALTER FUNCTION public.sign_hold_sealing(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_hold_sealing(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_hold_sealing(UUID, TEXT) TO service_role;

-- The warning about a certificate ending goes to the workspace's administrators as a notification.
DO $$
DECLARE
  v_def   TEXT;
  v_types TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';

  -- The live definition is either ANY ('{a,b}'::text[]) or ANY (ARRAY['a'::text, 'b'::text]); read both.
  IF v_def ~ '\{[^}]*\}' THEN
    v_types := string_to_array(substring(v_def FROM '\{([^}]*)\}'), ',');
  ELSE
    SELECT COALESCE(array_agg(DISTINCT m[1]), ARRAY[]::text[])
      INTO v_types
      FROM regexp_matches(COALESCE(v_def, ''), '''([^'']+)''::text', 'g') AS m;
  END IF;
  v_types := (SELECT array_agg(DISTINCT replace(x, '"', '') ORDER BY replace(x, '"', ''))
                FROM unnest(v_types || ARRAY['sign_certificate_expiring']) AS x);

  IF EXISTS (SELECT 1 FROM public.notifications n WHERE n.type IS NOT NULL AND NOT (n.type = ANY (v_types))) THEN
    RAISE EXCEPTION 'notifications_type_check rebuild would drop a type in use: %', v_def;
  END IF;

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

-- ------------------------------------------------------------
-- 2. Retention
-- ------------------------------------------------------------

-- The one exception to "a retained document cannot be deleted": the workspace purge of 153.
--
-- delete_workspace_data(p_account) sets the setting `vircle.purge_account` to the workspace's id for its own
-- transaction, then deletes. Any session can set a setting of that name (it is a free-form namespace, and
-- SET LOCAL or set_config() work for anyone), so the setting alone proves nothing. A foreign-key cascade also
-- runs as the table's owner whoever started it, so "the role is the owner" proves nothing alone either. This
-- function therefore needs all four of:
--   1. the role running the statement is the OWNER of delete_workspace_data (a request made with a signed-in
--      or service JWT runs as `authenticated` or `service_role`, which no setting can change);
--   2. the setting names this very workspace;
--   3. a deletion of this workspace has begun and is not finished (a row in workspace_deletions with no
--      deleted_at, written by workspace_deletion_begin);
--   4. delete_workspace_data(uuid) is on the call stack of this statement (read from PG_CONTEXT), so the exception
--      holds only while that function is running, not for a cascade someone else started with the setting set.
-- It is not SECURITY DEFINER on purpose: current_user must be the caller's role.
-- Reasoned limit: someone who can run SQL AS the owner role can write the tombstone, set the setting and define a
-- function of the same name to stand on the stack. That is a database owner (who can also drop these triggers),
-- not a client of the API; the Supabase REST interface offers no way to run SQL or to call set_config at all.
CREATE OR REPLACE FUNCTION public.retention_purge_active(p_account UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_owner TEXT;
  v_stack TEXT;
BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO v_owner
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.delete_workspace_data(uuid)');
  IF v_owner IS NULL OR current_user::text <> v_owner THEN
    RETURN FALSE;
  END IF;
  IF current_setting('vircle.purge_account', true) IS DISTINCT FROM p_account::text THEN
    RETURN FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_deletions d WHERE d.account_id = p_account AND d.deleted_at IS NULL) THEN
    RETURN FALSE;
  END IF;
  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  RETURN v_stack LIKE '%PL/pgSQL function delete_workspace_data(uuid)%';
END;
$$;

-- Documents. A draft is deletable. A completed document is deletable once its retention date has passed.
-- Nothing else is (a document that was sent is voided, never deleted; declined, expired and voided documents were
-- never sealed and are not covered by retention, but they stay undeletable as before). The workspace purge excepted.
CREATE OR REPLACE FUNCTION public.sign_documents_no_hard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN OLD;
  END IF;
  IF public.retention_purge_active(OLD.account_id) THEN
    RETURN OLD;
  END IF;
  IF OLD.status = 'completed' THEN
    IF OLD.retain_until IS NOT NULL AND OLD.retain_until <= now() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'sign_document_retained' USING ERRCODE = '42501',
      DETAIL = CASE WHEN OLD.retain_until IS NULL
                    THEN 'A signed document is kept; it has no retention date set.'
                    ELSE 'A signed document is kept until ' || to_char(OLD.retain_until AT TIME ZONE 'UTC', 'YYYY-MM-DD') || '.' END;
  END IF;
  RAISE EXCEPTION 'sign_document_cannot_be_deleted' USING ERRCODE = '42501',
    DETAIL = 'Only a draft can be deleted. Void a document that was sent.';
END;
$$;

DROP TRIGGER IF EXISTS sign_documents_no_hard_delete ON public.sign_documents;
CREATE TRIGGER sign_documents_no_hard_delete
  BEFORE DELETE ON public.sign_documents
  FOR EACH ROW EXECUTE FUNCTION public.sign_documents_no_hard_delete();

-- The sealed file and the certificate pages of a retained document. Deleting the document itself removes its file
-- rows by the foreign key cascade: by then the document row is gone, and that is the case allowed here.
CREATE OR REPLACE FUNCTION public.sign_document_files_retention()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  d RECORD;
BEGIN
  IF OLD.kind NOT IN ('signed', 'certificate') THEN
    RETURN OLD;
  END IF;
  SELECT x.status, x.retain_until INTO d
    FROM public.sign_documents x WHERE x.id = OLD.document_id AND x.account_id = OLD.account_id;
  IF NOT FOUND THEN
    RETURN OLD;
  END IF;
  IF d.status <> 'completed' THEN
    RETURN OLD;
  END IF;
  IF d.retain_until IS NOT NULL AND d.retain_until <= now() THEN
    RETURN OLD;
  END IF;
  IF public.retention_purge_active(OLD.account_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'sign_document_retained' USING ERRCODE = '42501',
    DETAIL = 'The signed file of a retained document cannot be deleted.';
END;
$$;

DROP TRIGGER IF EXISTS sign_document_files_retention ON public.sign_document_files;
CREATE TRIGGER sign_document_files_retention
  BEFORE DELETE ON public.sign_document_files
  FOR EACH ROW EXECUTE FUNCTION public.sign_document_files_retention();

-- The retention date is fixed when the document is sealed. It can be moved later (a hold) but never earlier,
-- and never cleared: otherwise "set it to now, then delete" would walk round the rule.
CREATE OR REPLACE FUNCTION public.sign_documents_retention_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.retention_purge_active(OLD.account_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sign_retention_cannot_shorten' USING ERRCODE = '23514',
    DETAIL = 'The retention date of a document can be extended, never shortened or cleared.';
END;
$$;

DROP TRIGGER IF EXISTS sign_documents_retention_lock ON public.sign_documents;
CREATE TRIGGER sign_documents_retention_lock
  BEFORE UPDATE OF retain_until ON public.sign_documents
  FOR EACH ROW
  WHEN (OLD.retain_until IS NOT NULL AND (NEW.retain_until IS NULL OR NEW.retain_until < OLD.retain_until))
  EXECUTE FUNCTION public.sign_documents_retention_lock();

-- TRUNCATE does not fire the row triggers above, so it is refused outright (no workspace purge uses it).
CREATE OR REPLACE FUNCTION public.sign_retention_no_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'sign_document_cannot_be_deleted' USING ERRCODE = '42501',
    DETAIL = 'Documents and their files cannot be truncated.';
END;
$$;

DROP TRIGGER IF EXISTS sign_documents_no_truncate ON public.sign_documents;
CREATE TRIGGER sign_documents_no_truncate
  BEFORE TRUNCATE ON public.sign_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public.sign_retention_no_truncate();

DROP TRIGGER IF EXISTS sign_document_files_no_truncate ON public.sign_document_files;
CREATE TRIGGER sign_document_files_no_truncate
  BEFORE TRUNCATE ON public.sign_document_files
  FOR EACH STATEMENT EXECUTE FUNCTION public.sign_retention_no_truncate();

NOTIFY pgrst, 'reload schema';
