-- ============================================================
-- 176_sign_private_reveal_copy_prefix.sql
--
-- Doc Sign, four changes the owner approved together:
--
--   1. sign.reveal-sensitive      A capability of its own for the Reveal button on a sensitive answer (an ID number, a bank account). It
--                                 used to need sign.send. Owner and Admin hold it by default; a custom role takes its default from the
--                                 base role it is built on (113), so nothing else needs seeding. Server routes only (the answers are read
--                                 by the service role), so its tier is 'app'. Who may read sensitive answers in the sealed PDF, the zip and
--                                 the uploaded files is a separate decision (F8) and is NOT touched here.
--
--   2. Private documents          sign_documents.is_private and sign_envelopes.is_private (default false). A private document or collection
--                                 is seen, with everything about its progress, only by: the person who uploaded it, the workspace's admins
--                                 and owners, and the Halo users named as signers on it (sign_signers.internal_user_id). Everyone else with
--                                 menu.sign gets nothing: not in lists, not by id, not in counts, exports or the zip.
--
--                                 THE RULE for a collection: the collection decides. Every document of a private collection is private
--                                 (a trigger copies the collection's flag onto each document when it joins and again whenever the
--                                 collection's flag changes), so a policy only ever looks at the row's own flag. The collection is one
--                                 thing (the same people sign all of it in one sitting): a Halo user named on ANY document of a private
--                                 collection sees the collection and EVERY document of it, and everything about their progress.
--
--                                 The flag is set while the document (or collection) is a draft and is fixed once it is sent. Only the
--                                 uploader or an admin may change it (a signed-in session is checked here; the server, which has no
--                                 session, checks it in the service layer). Documents made by automations, by bulk send and by registration
--                                 forms are never private (the default).
--
--                                 Enforced here with row level security on the six places a document can be read from: sign_documents,
--                                 sign_envelopes, and the tables that hang off a document (sign_document_files, sign_signers,
--                                 sign_step_invites, sign_answers, sign_events), plus sign_copy_recipients, sign_bulk_rows and
--                                 sign_registrations (they carry a document or collection id), through SECURITY DEFINER helpers (a policy on
--                                 a table cannot read the table it is on, or the signers table that reads it back, without recursing).
--                                 sign_verify_chain (a SECURITY DEFINER function a signed-in user may call) checks it too. The server's
--                                 own reads use the service role, which no policy applies to: they check the same rule in the service
--                                 layer (src/lib/sign/service/privacy.ts).
--
--   3. Copy recipients on bulk send and registration forms
--                                 A list of people who receive the signed copy, kept on the thing that makes the documents and put on every
--                                 document it makes, through the same table and the same delivery as any other copy recipient (175):
--                                   sign_registration_forms.copy_recipients   new column, a JSON list of { "fullName", "email" }
--                                   sign_bulk_jobs.options -> 'copyTo'        the same list inside the batch's options, which a batch
--                                                                             already keeps unchanged for its whole life (162)
--                                 sign_copy_list_valid() is the one definition of a good list (an array of at most 10 people, each a name of
--                                 1 to 160 characters and an address like a signer's, each address once, case ignored); both columns check it.
--
--   4. The reference of a new document collection starts COL- (it started ENV-). A reference already stored is never rewritten, and it
--      stays valid wherever it is looked up: nothing parses the prefix, the uniqueness is per workspace on the whole reference.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The capability
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('sign.reveal-sensitive', 'agent', 'app')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'sign.reveal-sensitive'),
  ('admin', 'sign.reveal-sensitive')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2a. The columns
-- ------------------------------------------------------------
ALTER TABLE public.sign_documents ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.sign_envelopes ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;

-- Small partial indexes: private rows are the exception, and the lists that filter on them are per workspace.
CREATE INDEX IF NOT EXISTS sign_documents_private_idx ON public.sign_documents (account_id, created_at DESC) WHERE is_private;
CREATE INDEX IF NOT EXISTS sign_envelopes_private_idx ON public.sign_envelopes (account_id, created_at DESC) WHERE is_private;
-- "which documents am I named on": the lookup every private check ends with
CREATE INDEX IF NOT EXISTS sign_signers_internal_user_idx ON public.sign_signers (internal_user_id, document_id) WHERE internal_user_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2b. The helpers the policies call. SECURITY DEFINER so they read the tables without the policies of those tables (which call them back);
--     each answers for the signed-in caller (auth.uid()), so they are safe to hand to every signed-in user. A signed-out caller is always
--     answered "no" (it holds no session): the helpers are executable by anon only because a policy is evaluated for every role that holds a
--     privilege on the table, and a function a policy calls must be executable by the role (the same reason has_capability is).
-- ------------------------------------------------------------

-- The caller is a Halo user named as a signer on this document.
CREATE OR REPLACE FUNCTION public.sign_is_named_signer(p_document UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1 FROM public.sign_signers s
     WHERE s.document_id = p_document AND s.internal_user_id IS NOT NULL AND s.internal_user_id = auth.uid()
  ), FALSE);
$$;
ALTER FUNCTION public.sign_is_named_signer(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_is_named_signer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sign_is_named_signer(UUID) TO anon, authenticated, service_role;

-- The caller is a Halo user named as a signer on any document of this collection.
CREATE OR REPLACE FUNCTION public.sign_is_named_on_envelope(p_envelope UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1 FROM public.sign_documents d
      JOIN public.sign_signers s ON s.document_id = d.id
     WHERE d.envelope_id = p_envelope AND s.internal_user_id IS NOT NULL AND s.internal_user_id = auth.uid()
  ), FALSE);
$$;
ALTER FUNCTION public.sign_is_named_on_envelope(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_is_named_on_envelope(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sign_is_named_on_envelope(UUID) TO anon, authenticated, service_role;

-- May the caller see this document (and everything about its progress)? A document that is not private: every reader of Doc Sign. A private
-- one: its uploader, an admin or owner of the workspace, a Halo user named on it, or (a document of a collection) named on any document of that
-- collection. A document that does not exist: no.
CREATE OR REPLACE FUNCTION public.sign_document_visible(p_document UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND COALESCE((
    SELECT NOT d.is_private
        OR COALESCE(d.created_by = auth.uid(), FALSE)
        OR public.is_account_member(d.account_id, 'admin'::account_role_enum)
        OR public.sign_is_named_signer(d.id)
        OR (d.envelope_id IS NOT NULL AND public.sign_is_named_on_envelope(d.envelope_id))
      FROM public.sign_documents d WHERE d.id = p_document
  ), FALSE);
$$;
ALTER FUNCTION public.sign_document_visible(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_document_visible(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sign_document_visible(UUID) TO anon, authenticated, service_role;

-- The same for a collection.
CREATE OR REPLACE FUNCTION public.sign_envelope_visible(p_envelope UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND COALESCE((
    SELECT NOT e.is_private
        OR COALESCE(e.created_by = auth.uid(), FALSE)
        OR public.is_account_member(e.account_id, 'admin'::account_role_enum)
        OR public.sign_is_named_on_envelope(e.id)
      FROM public.sign_envelopes e WHERE e.id = p_envelope
  ), FALSE);
$$;
ALTER FUNCTION public.sign_envelope_visible(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelope_visible(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sign_envelope_visible(UUID) TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 2c. Row level security
-- ------------------------------------------------------------
-- Documents. Reading: menu.sign and the private rule. A draft is changed or deleted by whoever may send (sign.send) and, for a private one, only
-- by its uploader or an admin (a named signer may be on a draft, and reads it, but does not edit it). The new row must satisfy the same test, so a
-- person who is neither cannot mark a document private either.
DROP POLICY IF EXISTS sign_documents_select ON public.sign_documents;
DROP POLICY IF EXISTS sign_documents_update ON public.sign_documents;
DROP POLICY IF EXISTS sign_documents_delete ON public.sign_documents;
CREATE POLICY sign_documents_select ON public.sign_documents
  FOR SELECT USING (
    has_capability(account_id, 'menu.sign')
    AND (NOT is_private OR created_by = auth.uid() OR is_account_member(account_id, 'admin'::account_role_enum) OR public.sign_is_named_signer(id)
         OR (envelope_id IS NOT NULL AND public.sign_is_named_on_envelope(envelope_id)))
  );
CREATE POLICY sign_documents_update ON public.sign_documents
  FOR UPDATE USING (
    has_capability(account_id, 'sign.send') AND status = 'draft'
    AND (NOT is_private OR created_by = auth.uid() OR is_account_member(account_id, 'admin'::account_role_enum))
  )
  WITH CHECK (
    has_capability(account_id, 'sign.send') AND status = 'draft'
    AND (NOT is_private OR created_by = auth.uid() OR is_account_member(account_id, 'admin'::account_role_enum))
  );
CREATE POLICY sign_documents_delete ON public.sign_documents
  FOR DELETE USING (
    has_capability(account_id, 'sign.send') AND status = 'draft'
    AND (NOT is_private OR created_by = auth.uid() OR is_account_member(account_id, 'admin'::account_role_enum))
  );

-- Collections: reading only (the server writes).
DROP POLICY IF EXISTS sign_envelopes_select ON public.sign_envelopes;
CREATE POLICY sign_envelopes_select ON public.sign_envelopes
  FOR SELECT USING (
    has_capability(account_id, 'menu.sign')
    AND (NOT is_private OR created_by = auth.uid() OR is_account_member(account_id, 'admin'::account_role_enum) OR public.sign_is_named_on_envelope(id))
  );

-- Everything that hangs off a document follows the document.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sign_document_files', 'sign_signers', 'sign_step_invites', 'sign_answers', 'sign_events']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (has_capability(account_id, %L) AND public.sign_document_visible(document_id))',
                   t || '_select', t, 'menu.sign');
  END LOOP;
END $$;

-- People who receive a copy belong to a document or to a collection.
DROP POLICY IF EXISTS sign_copy_recipients_select ON public.sign_copy_recipients;
CREATE POLICY sign_copy_recipients_select ON public.sign_copy_recipients
  FOR SELECT USING (
    has_capability(account_id, 'menu.sign')
    AND (document_id IS NULL OR public.sign_document_visible(document_id))
    AND (envelope_id IS NULL OR public.sign_envelope_visible(envelope_id))
  );

-- The rows of a bulk batch and the registrations name the document they made. (Those documents are never private, but a row must not be the way
-- round the rule if one ever were.)
DROP POLICY IF EXISTS sign_bulk_rows_select ON public.sign_bulk_rows;
CREATE POLICY sign_bulk_rows_select ON public.sign_bulk_rows
  FOR SELECT USING (has_capability(account_id, 'menu.sign') AND (document_id IS NULL OR public.sign_document_visible(document_id)));
DROP POLICY IF EXISTS sign_registrations_select ON public.sign_registrations;
CREATE POLICY sign_registrations_select ON public.sign_registrations
  FOR SELECT USING (has_capability(account_id, 'menu.sign') AND (document_id IS NULL OR public.sign_document_visible(document_id)));

-- ------------------------------------------------------------
-- 2d. The chain check: a signed-in caller who cannot see the document is told it does not exist (it never confirms that it does).
--     The service role (the verify page, the app's own checks) has no auth.uid() and is unchanged.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_verify_chain(p_document UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_prev    TEXT := repeat('0', 64);
  v_expect  INTEGER := 1;
  v_n       INTEGER := 0;
  r         RECORD;
BEGIN
  SELECT d.account_id INTO v_account FROM public.sign_documents d WHERE d.id = p_document;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Document not found' USING ERRCODE = '22023';
  END IF;
  -- The service role (the app's own checks) has no auth.uid().
  IF auth.uid() IS NOT NULL AND NOT public.has_capability(v_account, 'menu.sign') THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.sign_document_visible(p_document) THEN
    RAISE EXCEPTION 'Document not found' USING ERRCODE = '22023';
  END IF;

  FOR r IN SELECT * FROM public.sign_events e WHERE e.document_id = p_document ORDER BY e.doc_seq LOOP
    v_n := v_n + 1;
    IF r.doc_seq <> v_expect
       OR r.prev_hash <> v_prev
       OR r.row_hash <> public.sign_event_hash(r.prev_hash, r.document_id, r.doc_seq, r.type, r.actor_type,
                                               r.signer_id, r.actor_user_id, r.detail, r.created_at) THEN
      RETURN jsonb_build_object('ok', false, 'events', v_n, 'broken_at', r.doc_seq);
    END IF;
    v_prev := r.row_hash;
    v_expect := v_expect + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'events', v_n, 'head', v_prev);
END;
$$;
ALTER FUNCTION public.sign_verify_chain(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_verify_chain(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sign_verify_chain(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2e. Integrity of the flag
-- ------------------------------------------------------------
-- A document of a collection is private exactly when its collection is (the collection decides). A private document does not join a collection
-- that is not private (it would silently stop being private). The flag of a document on its own changes only while it is a draft, and only by its
-- uploader or an admin when a signed-in person does it (the server has no session and checks in its own layer).
CREATE OR REPLACE FUNCTION public.sign_documents_private_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_env_private BOOLEAN;
BEGIN
  IF NEW.envelope_id IS NOT NULL THEN
    SELECT e.is_private INTO v_env_private FROM public.sign_envelopes e WHERE e.id = NEW.envelope_id AND e.account_id = NEW.account_id;
    IF FOUND THEN
      IF TG_OP = 'UPDATE' AND OLD.envelope_id IS NULL AND OLD.is_private AND NOT v_env_private THEN
        RAISE EXCEPTION 'sign_private_document_cannot_join_a_public_collection' USING ERRCODE = '23514';
      END IF;
      NEW.is_private := v_env_private;
    END IF;
    -- (a collection that does not exist is refused by sign_documents_envelope_guard with its own error)
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.is_private IS DISTINCT FROM OLD.is_private THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'sign_private_is_fixed' USING ERRCODE = '23514',
        DETAIL = 'Whether a document is private is chosen while it is a draft and cannot change once it is sent.';
    END IF;
    IF auth.uid() IS NOT NULL AND NEW.created_by IS DISTINCT FROM auth.uid()
       AND NOT public.is_account_member(NEW.account_id, 'admin'::account_role_enum) THEN
      RAISE EXCEPTION 'sign_private_needs_the_uploader_or_an_admin' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_documents_private_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_documents_private_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_documents_private_guard ON public.sign_documents;
CREATE TRIGGER sign_documents_private_guard
  BEFORE INSERT OR UPDATE OF is_private, envelope_id ON public.sign_documents
  FOR EACH ROW EXECUTE FUNCTION public.sign_documents_private_guard();

-- A collection's flag: only while it is a draft, only by its uploader or an admin (a signed-in person), and it goes onto every document of it.
CREATE OR REPLACE FUNCTION public.sign_envelopes_private_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_private IS DISTINCT FROM OLD.is_private THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'sign_private_is_fixed' USING ERRCODE = '23514',
        DETAIL = 'Whether a collection is private is chosen while it is a draft and cannot change once it is sent.';
    END IF;
    IF auth.uid() IS NOT NULL AND NEW.created_by IS DISTINCT FROM auth.uid()
       AND NOT public.is_account_member(NEW.account_id, 'admin'::account_role_enum) THEN
      RAISE EXCEPTION 'sign_private_needs_the_uploader_or_an_admin' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_envelopes_private_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelopes_private_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_envelopes_private_guard ON public.sign_envelopes;
CREATE TRIGGER sign_envelopes_private_guard
  BEFORE UPDATE OF is_private ON public.sign_envelopes
  FOR EACH ROW EXECUTE FUNCTION public.sign_envelopes_private_guard();

CREATE OR REPLACE FUNCTION public.sign_envelopes_private_cascade()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- the documents' own guard (sign_documents_private_guard) reads the collection's flag, which is already the new one
  UPDATE public.sign_documents SET is_private = NEW.is_private
   WHERE envelope_id = NEW.id AND account_id = NEW.account_id AND is_private IS DISTINCT FROM NEW.is_private;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_envelopes_private_cascade() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelopes_private_cascade() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_envelopes_private_cascade ON public.sign_envelopes;
CREATE TRIGGER sign_envelopes_private_cascade
  AFTER UPDATE OF is_private ON public.sign_envelopes
  FOR EACH ROW
  WHEN (OLD.is_private IS DISTINCT FROM NEW.is_private)
  EXECUTE FUNCTION public.sign_envelopes_private_cascade();

-- ------------------------------------------------------------
-- 3a. The one definition of a good list of people who receive a copy
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_copy_list_valid(p JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  e       JSONB;
  v_name  TEXT;
  v_email TEXT;
  v_seen  TEXT[] := '{}';
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) > 10 THEN
    RETURN FALSE;
  END IF;
  FOR e IN SELECT jsonb_array_elements(p) LOOP
    IF jsonb_typeof(e) <> 'object'
       OR jsonb_typeof(e -> 'fullName') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e -> 'email') IS DISTINCT FROM 'string' THEN
      RETURN FALSE;
    END IF;
    v_name  := btrim(e ->> 'fullName');
    v_email := btrim(e ->> 'email');
    IF length(v_name) NOT BETWEEN 1 AND 160 THEN RETURN FALSE; END IF;
    IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(v_email) > 254 THEN RETURN FALSE; END IF;
    IF lower(v_email) = ANY (v_seen) THEN RETURN FALSE; END IF;
    v_seen := v_seen || lower(v_email);
  END LOOP;
  RETURN TRUE;
END;
$$;
ALTER FUNCTION public.sign_copy_list_valid(JSONB) OWNER TO postgres;
-- (a pure check of a value: it reads no table, so it keeps the default EXECUTE for everyone, which a CHECK constraint needs from whoever writes the row)

-- ------------------------------------------------------------
-- 3b. A registration form's list, and a bulk batch's
-- ------------------------------------------------------------
ALTER TABLE public.sign_registration_forms
  ADD COLUMN IF NOT EXISTS copy_recipients JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_registration_forms_copy_recipients_valid') THEN
    ALTER TABLE public.sign_registration_forms
      ADD CONSTRAINT sign_registration_forms_copy_recipients_valid CHECK (public.sign_copy_list_valid(copy_recipients));
  END IF;
  -- the batch's options already exist and never change after the batch is made (162); this only says what a list in them must look like
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_bulk_jobs_copy_to_valid') THEN
    ALTER TABLE public.sign_bulk_jobs
      ADD CONSTRAINT sign_bulk_jobs_copy_to_valid CHECK (NOT (options ? 'copyTo') OR public.sign_copy_list_valid(options -> 'copyTo'));
  END IF;
END $$;

-- The audit log records a form's list of copy recipients by name only (its addresses are not written to it), like the people for the other roles.
DROP TRIGGER IF EXISTS audit_row_change ON public.sign_registration_forms;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_registration_forms
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'sign_settings', 'name', 'name,active,send_document,template_id,applicant_role_key,contact_tag_id,daily_cap,default_locale,mode',
    'slug,signers_other,fields,consent_text,success_message,copy_recipients', '', 'created_by');

-- ------------------------------------------------------------
-- 4. The reference of a new collection: COL-YYYY-nnnnnn (171's function, with the prefix changed and nothing else)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_envelopes_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'sign_envelope_must_start_as_draft' USING ERRCODE = '23514';
    END IF;
    IF NEW.reference IS NULL OR NEW.reference = '' THEN
      UPDATE public.accounts SET sign_envelope_seq = sign_envelope_seq + 1 WHERE id = NEW.account_id
        RETURNING sign_envelope_seq INTO v_seq;
      IF v_seq IS NULL THEN
        RAISE EXCEPTION 'Account % not found', NEW.account_id USING ERRCODE = '22023';
      END IF;
      NEW.reference := 'COL-' || to_char(now() AT TIME ZONE 'utc', 'YYYY') || '-' || lpad(v_seq::text, 6, '0');
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.reference IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION 'sign_envelope_reference_is_fixed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.title         IS DISTINCT FROM OLD.title
    OR NEW.message       IS DISTINCT FROM OLD.message
    OR NEW.locale        IS DISTINCT FROM OLD.locale
    OR NEW.sign_in_order IS DISTINCT FROM OLD.sign_in_order
    OR NEW.code_required IS DISTINCT FROM OLD.code_required
  ) THEN
    RAISE EXCEPTION 'sign_envelope_is_frozen' USING ERRCODE = '23514',
      DETAIL = 'A document collection that was sent cannot be edited. Void it and send a new one.';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_envelopes_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelopes_guard() FROM PUBLIC, anon, authenticated;
