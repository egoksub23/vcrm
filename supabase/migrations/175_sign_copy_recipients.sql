-- ============================================================
-- 175_sign_copy_recipients.sql
--
-- Doc Sign: people who RECEIVE A COPY. A person on a document or a document collection who does not sign: when the document (or every
-- document of the collection) is completed and sealed, they get ONE email with the signed PDF attached, the sealed copy that already holds
-- the certificate pages. They are not signers: no row in sign_signers, no link, no turn, no step, never counted in progress, reminders,
-- webhooks, the API's signers or the exports.
--
--   sign_copy_recipients                one row per person per target. The target is a document (a document on its own) or a document
--                                       collection (sign_envelopes), exactly one of the two. full_name, email (the same email check as
--                                       a signer), created_by, created_at, and notified_at: when the signed copy was sent to them (the
--                                       one place that says it was, so a second run of the completion step cannot send it again)
--   sign_copy_recipients_uq_*           one row per target and address, case ignored
--   sign_copy_recipients_guard          (trigger) a person is added only while the target is a draft or open (draft, sent, in_progress),
--                                       a document of a collection takes none of its own (they belong to the collection), at most 10 for
--                                       one target (counted under a lock, so two adds at once cannot both take the tenth place), and a
--                                       row's identity never changes afterwards: only notified_at moves
--
-- Reading follows menu.sign (members of the workspace); every write is the server's (service role), which checks sign.send. The audit
-- trigger records the person by NAME only (the address is not written to the audit log). Workspace export and deletion (153) find the
-- table by itself: it has account_id with a cascade. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sign_copy_recipients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- exactly one target: a document on its own, or a document collection
  document_id UUID,
  envelope_id UUID,
  full_name   TEXT NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 160),
  email       TEXT NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  -- Set once when the signed copy was sent to this person; null until then (and again if the message could not be delivered, so it can be tried again).
  notified_at TIMESTAMPTZ,
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_copy_recipients_one_target CHECK ((document_id IS NULL) <> (envelope_id IS NULL)),
  -- a target of another workspace is refused by the composite key (a null part switches the check off, and the other target is then the one that holds)
  CONSTRAINT sign_copy_recipients_document_fk FOREIGN KEY (document_id, account_id)
    REFERENCES public.sign_documents (id, account_id) ON DELETE CASCADE,
  CONSTRAINT sign_copy_recipients_envelope_fk FOREIGN KEY (envelope_id, account_id)
    REFERENCES public.sign_envelopes (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sign_copy_recipients_account_idx ON public.sign_copy_recipients (account_id);
-- one row per target and address, case ignored
CREATE UNIQUE INDEX IF NOT EXISTS sign_copy_recipients_uq_document ON public.sign_copy_recipients (document_id, lower(email)) WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sign_copy_recipients_uq_envelope ON public.sign_copy_recipients (envelope_id, lower(email)) WHERE envelope_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Row level security: members with menu.sign read; the server writes
-- ------------------------------------------------------------
ALTER TABLE public.sign_copy_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sign_copy_recipients_select ON public.sign_copy_recipients;
CREATE POLICY sign_copy_recipients_select ON public.sign_copy_recipients
  FOR SELECT USING (has_capability(account_id, 'menu.sign'));

REVOKE ALL ON public.sign_copy_recipients FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sign_copy_recipients TO authenticated;
GRANT ALL ON public.sign_copy_recipients TO service_role;

-- ------------------------------------------------------------
-- 3. Audit: by name only (a change to the address is recorded as "email changed", never the address itself)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS audit_row_change ON public.sign_copy_recipients;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_copy_recipients
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'sign_copy_recipient', 'full_name', 'full_name', 'email', '', 'created_by');

-- ------------------------------------------------------------
-- 4. Integrity
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_copy_recipients_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status   TEXT;
  v_envelope UUID;
  v_n        INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- who and where never change; the only thing that moves is the record of the message
    IF NEW.account_id  IS DISTINCT FROM OLD.account_id
       OR NEW.document_id IS DISTINCT FROM OLD.document_id
       OR NEW.envelope_id IS DISTINCT FROM OLD.envelope_id
       OR NEW.full_name   IS DISTINCT FROM OLD.full_name
       OR NEW.email       IS DISTINCT FROM OLD.email
       OR NEW.created_by  IS DISTINCT FROM OLD.created_by
       OR NEW.created_at  IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'sign_copy_recipient_is_fixed' USING ERRCODE = '23514',
        DETAIL = 'A person who receives a copy is removed and added again, never changed.';
    END IF;
    RETURN NEW;
  END IF;

  -- a new person: only while the target can still be completed
  IF NEW.document_id IS NOT NULL THEN
    SELECT d.status, d.envelope_id INTO v_status, v_envelope
      FROM public.sign_documents d WHERE d.id = NEW.document_id AND d.account_id = NEW.account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'document_not_found' USING ERRCODE = '22023';
    END IF;
    IF v_envelope IS NOT NULL THEN
      RAISE EXCEPTION 'sign_copy_belongs_to_collection' USING ERRCODE = '23514',
        DETAIL = 'A document of a collection takes no copy recipients of its own: they belong to the collection.';
    END IF;
  ELSE
    SELECT e.status INTO v_status
      FROM public.sign_envelopes e WHERE e.id = NEW.envelope_id AND e.account_id = NEW.account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'envelope_not_found' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_status NOT IN ('draft', 'sent', 'in_progress') THEN
    RAISE EXCEPTION 'sign_copy_not_open' USING ERRCODE = '23514',
      DETAIL = 'People can be added to receive a copy until the document is completed.';
  END IF;

  -- at most 10 for one target; the lock makes two adds at the same moment take turns, so neither can slip past the count
  PERFORM pg_advisory_xact_lock(hashtextextended('sign_copy_recipients:' || COALESCE(NEW.document_id, NEW.envelope_id)::text, 0));
  SELECT count(*) INTO v_n FROM public.sign_copy_recipients c
   WHERE c.account_id = NEW.account_id AND c.document_id IS NOT DISTINCT FROM NEW.document_id AND c.envelope_id IS NOT DISTINCT FROM NEW.envelope_id;
  IF v_n >= 10 THEN
    RAISE EXCEPTION 'sign_copy_limit' USING ERRCODE = '23514',
      DETAIL = 'Up to 10 people can receive a copy of one document or collection.';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_copy_recipients_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_copy_recipients_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_copy_recipients_guard ON public.sign_copy_recipients;
CREATE TRIGGER sign_copy_recipients_guard
  BEFORE INSERT OR UPDATE ON public.sign_copy_recipients
  FOR EACH ROW EXECUTE FUNCTION public.sign_copy_recipients_guard();
