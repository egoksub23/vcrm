-- ============================================================
-- 168_sign_sensitive_answers.sql
--
-- Doc Sign phase 2, work package 20a (F-47): sensitive form fields. A data field marked `sensitive` in the
-- form (an ID number, a bank account) is stored encrypted, never in plain text.
--
--   sign_answers.value_enc            the answer, encrypted by the server (lib/whatsapp/encryption.ts, the key ring), as
--                                     text. Added to ENCRYPTED_COLUMNS (lib/crypto/reencrypt.ts) so key rotation
--                                     re-encrypts it with the rest.
--   sign_answers_sensitive_check      the row says which it is, and cannot be both: a sensitive row holds its answer in
--                                     value_enc and NOTHING in value; an ordinary row never has value_enc. So a sensitive
--                                     answer cannot be left readable by a mistake in application code.
--   sign_answers_guard()              what an answer IS (value, sensitive, key) cannot change, and no answer can be added,
--                                     once its signer has signed. The ciphertext may be replaced by another ciphertext (key
--                                     rotation); that is the one change allowed. Deleting is not blocked (retention, forwarding
--                                     a part, the purge of a workspace all delete answers).
--
-- Documents already sent keep what they hold: only answers written from now on, to fields the sent form marks sensitive,
-- are encrypted. The sensitive column of 157 is now used (it was never written before).
--
-- Idempotent.
-- ============================================================

ALTER TABLE public.sign_answers ADD COLUMN IF NOT EXISTS value_enc TEXT;

ALTER TABLE public.sign_answers DROP CONSTRAINT IF EXISTS sign_answers_sensitive_check;
ALTER TABLE public.sign_answers
  ADD CONSTRAINT sign_answers_sensitive_check CHECK (
    (sensitive AND value IS NULL AND value_enc IS NOT NULL AND length(value_enc) BETWEEN 1 AND 100000)
    OR (NOT sensitive AND value_enc IS NULL)
  );

CREATE OR REPLACE FUNCTION public.sign_answers_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- moving a row to another person (forwarding a part), the source and the time are not a change of the answer;
    -- neither is a new ciphertext for the same answer (re-encryption under a newer key)
    IF NEW.value IS NOT DISTINCT FROM OLD.value
       AND NEW.sensitive = OLD.sensitive
       AND NEW.field_key = OLD.field_key
       AND (NEW.value_enc IS NULL) = (OLD.value_enc IS NULL) THEN
      RETURN NEW;
    END IF;
    SELECT status INTO v_status FROM public.sign_signers WHERE id = OLD.signer_id AND account_id = OLD.account_id;
  ELSE
    SELECT status INTO v_status FROM public.sign_signers WHERE id = NEW.signer_id AND account_id = NEW.account_id;
  END IF;

  IF v_status = 'signed' THEN
    RAISE EXCEPTION 'sign_answer_is_frozen' USING ERRCODE = '23514',
      DETAIL = 'The answers of a person who has signed cannot change.';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_answers_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_answers_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_answers_guard ON public.sign_answers;
CREATE TRIGGER sign_answers_guard
  BEFORE INSERT OR UPDATE ON public.sign_answers
  FOR EACH ROW EXECUTE FUNCTION public.sign_answers_guard();
