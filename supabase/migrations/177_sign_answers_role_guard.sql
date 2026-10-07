-- ============================================================
-- 177_sign_answers_role_guard.sql
--
-- Doc Sign: the database refuses an answer to a place that belongs to someone else.
--
-- A place on a document (a signature, an initials box, a text box, a tick box) is assigned to a ROLE, and a person's row on the document names
-- their role (sign_signers.role_key). The server only ever saves a person's answers for the places of their own role (service/signing.ts,
-- `saveAnswers`: anything else is refused as not_your_field), and it only ever reads a link's own rows. That is the rule, and this migration
-- makes the database hold it as well, so that a mistake in the application (or in something written later) cannot put one person's
-- signature on another person's place:
--
--   sign_answers_role_guard()   BEFORE INSERT, or UPDATE of the key, the person or the document, on sign_answers. When the answer's key is a place
--                               on the document's page whose role is NOT the role of the person the answer belongs to, the write is refused
--                               ('sign_answer_is_not_the_signers', check_violation). It does not apply to
--                                 - an answer to a data field of a form (its key is a field of the form: the form's own rules decide who may
--                                   answer it, and a part handed to someone else is answered by a person of the same role);
--                                 - a place that names no role, or that prints a form's answer (`data`): nobody answers those on the page.
--                               It also refuses an answer kept against a person's row on ANOTHER document (a person of a collection has one row on
--                               each of their documents, and answers on that document with that row only).
--                               It reads the document's frozen snapshot, so it holds the same for a document on its own and for each document of
--                               a collection, where a person has a row (and their own role) on every document they are on.
--
--   sign_signers_new_person_clear()   AFTER UPDATE of the address on sign_signers. When a row is handed to a DIFFERENT address (a change of recipient, which
--                               keeps the row, its role and its answers so far) and its person has not signed, the signature and initials the earlier
--                               person had drawn or typed on it are deleted: a signature is a personal act (as when a turn is forwarded, 166), so the
--                               new person starts their signature from nothing and can never finish a document with the earlier person's. The rest of
--                               what was typed stays as a starting point. A change of the name alone, or of the address's case, changes nothing.
--
-- Nothing is changed for rows that exist: the guards look at writes from now on. Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.sign_answers_role_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role  TEXT;
  v_doc   UUID;
  v_field JSONB;
BEGIN
  SELECT s.role_key, s.document_id INTO v_role, v_doc
    FROM public.sign_signers s
   WHERE s.id = NEW.signer_id AND s.account_id = NEW.account_id;
  IF NOT FOUND THEN
    RETURN NEW; -- (the foreign key refuses an answer with no person; nothing to compare here)
  END IF;
  -- a person answers on the document they are a row of: in a collection a person has a row on each of their documents, and the answer to a place of
  -- the first document is never kept against their row on the second
  IF v_doc <> NEW.document_id THEN
    RAISE EXCEPTION 'sign_answer_signer_is_not_on_the_document' USING ERRCODE = '23514',
      DETAIL = 'An answer belongs to the person''s own row on the document it is an answer to.';
  END IF;

  SELECT f.elem INTO v_field
    FROM public.sign_documents d, jsonb_array_elements(COALESCE(d.fields_snapshot, '[]'::jsonb)) AS f(elem)
   WHERE d.id = NEW.document_id AND d.account_id = NEW.account_id AND f.elem ->> 'key' = NEW.field_key
   LIMIT 1;
  IF v_field IS NULL THEN
    RETURN NEW; -- not a place on the page: a data field of a form, or a key the document does not have
  END IF;
  -- a data field of the form with this key: the form's rules apply, not the place's
  IF EXISTS (SELECT 1
               FROM public.sign_documents d, jsonb_array_elements(COALESCE(d.form_snapshot -> 'fields', '[]'::jsonb)) AS ff(elem)
              WHERE d.id = NEW.document_id AND d.account_id = NEW.account_id AND ff.elem ->> 'key' = NEW.field_key) THEN
    RETURN NEW;
  END IF;
  -- a place with no role, or one that prints a form's answer, is not answered on the page by anybody
  IF (v_field ->> 'role') IS NULL OR (v_field ->> 'data') IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF v_field ->> 'role' <> v_role THEN
    RAISE EXCEPTION 'sign_answer_is_not_the_signers' USING ERRCODE = '23514',
      DETAIL = 'A place on the document belongs to one role, and only the person of that role can answer it.';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_answers_role_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_answers_role_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_answers_role_guard ON public.sign_answers;
CREATE TRIGGER sign_answers_role_guard
  BEFORE INSERT OR UPDATE OF field_key, signer_id, document_id ON public.sign_answers
  FOR EACH ROW EXECUTE FUNCTION public.sign_answers_role_guard();

CREATE OR REPLACE FUNCTION public.sign_signers_new_person_clear()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.sign_answers a
   USING public.sign_documents d
   WHERE a.signer_id = NEW.id AND a.account_id = NEW.account_id
     AND d.id = a.document_id AND d.account_id = a.account_id
     AND a.field_key IN (SELECT f.elem ->> 'key'
                           FROM jsonb_array_elements(COALESCE(d.fields_snapshot, '[]'::jsonb)) AS f(elem)
                          WHERE f.elem ->> 'type' IN ('signature', 'initials'));
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_signers_new_person_clear() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_signers_new_person_clear() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_signers_new_person_clear ON public.sign_signers;
CREATE TRIGGER sign_signers_new_person_clear
  AFTER UPDATE OF email ON public.sign_signers
  FOR EACH ROW
  WHEN (lower(btrim(OLD.email)) IS DISTINCT FROM lower(btrim(NEW.email)) AND NEW.status <> 'signed')
  EXECUTE FUNCTION public.sign_signers_new_person_clear();

NOTIFY pgrst, 'reload schema';
