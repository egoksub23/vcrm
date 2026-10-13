-- ============================================================
-- 186_compliance_bank_own_account.sql
--
-- Compliance requests: "does this bank account belong to you?". Spec: docs/compliance-requests.md (section 31).
--
-- The public closure and withdrawal forms and the personal closure form used to decide that an authorization letter was needed by comparing the bank
-- account holder name with the Vircle account holder name, which wrongly demanded a letter for the same person written another way ("Gokula Krishnan a/l
-- Subramaniam" / "Gokula Krishnan Subramaniam"). The form now ASKS: "Does this bank account belong to you, the Vircle account holder?" (Yes / No). Only
-- a No needs the letter. The name comparison stays as an information flag for staff (data.name_differs, written by the server, never typed).
--
--   1. The question    a new yes/no field bank_account_is_own on the closure and withdrawal types: required, not sensitive, placed right before the bank
--                      details. A workspace that exists now gets it; one made later gets it through the seed trigger.
--   2. The letter      the authorization_letter field becomes conditional (showIf bank_account_is_own = false) and required. A file is checked by the
--                      forms and by the server where it is uploaded, not by the field check, so the definition says when the letter is expected and the
--                      staff screen lists it only then.
--
-- Never overwrites an administrator's edit (the same rule as 184's intake fields and 185's account change fields): the question is added only when its
-- key is absent; the letter is made conditional only while it still has NO condition; its words change only while they are exactly the ones 183 seeded.
-- A case made before this migration lacks the answer: the staff screen says "Not asked (older form)" and nothing is rewritten.
--
-- Nothing here is callable by a signed-in or signed-out user (REVOKEd; EXECUTE to service_role only; SECURITY DEFINER with a pinned search_path), so
-- verify-guard-catalog.sql needs no change. Apply this migration BEFORE the code that goes with it is deployed: the public forms are "not available" for a
-- workspace whose closure or withdrawal type lacks the question. It needs 183, 184 and 185. Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.compliance_bank_own_fields(p_account UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_own     JSONB;
  v_show    JSONB := jsonb_build_object('field', 'bank_account_is_own', 'in', jsonb_build_array('false'));
  v_old     JSONB := public.compliance_label(
                       'Authorization letter (needed when the bank account holder name differs)',
                       'Surat kebenaran (diperlukan jika nama pemegang akaun bank berbeza)',
                       '授权书（银行账户持有人姓名不同时需要）',
                       '위임장(은행 계좌 예금주 이름이 다를 때 필요)');
  v_new     JSONB := public.compliance_label(
                       'Authorization letter (signed by the bank account holder; needed when the bank account is not yours)',
                       'Surat kebenaran (ditandatangani oleh pemegang akaun bank; diperlukan jika akaun bank bukan milik anda)',
                       '授权书（由银行账户持有人签署；银行账户不属于您本人时需要）',
                       '위임장(은행 계좌 예금주가 서명, 본인 명의 계좌가 아닐 때 필요)');
  r         RECORD;
  v_at      INT;
BEGIN
  v_own := jsonb_build_object('key', 'bank_account_is_own', 'type', 'yesno', 'required', true, 'sensitive', false,
    'label', public.compliance_label(
      'Does this bank account belong to you, the Vircle account holder?',
      'Adakah akaun bank ini milik anda, pemegang akaun Vircle?',
      '这个银行账户是否属于您本人（Vircle 账户持有人）？',
      '이 은행 계좌는 Vircle 계정 명의자 본인의 계좌입니까?'));

  FOR r IN SELECT t.id, t.fields FROM public.compliance_request_types t WHERE t.account_id = p_account AND t.key IN ('closure', 'withdrawal') LOOP
    -- the question, right before the bank details (at the end when the type has no bank name field)
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.fields) f WHERE f ->> 'key' = 'bank_account_is_own') THEN
      SELECT e.ord - 1 INTO v_at FROM jsonb_array_elements(r.fields) WITH ORDINALITY AS e(f, ord) WHERE e.f ->> 'key' = 'bank_name' ORDER BY e.ord LIMIT 1;
      UPDATE public.compliance_request_types t
         SET fields = CASE WHEN v_at IS NULL THEN t.fields || jsonb_build_array(v_own) ELSE jsonb_insert(t.fields, ARRAY[v_at::text], v_own) END
       WHERE t.id = r.id;
    END IF;
  END LOOP;

  -- the letter: asked (and required) while the bank account is not the customer's own. Only a letter that has no condition yet; its words only while they
  -- are exactly the ones 183 seeded
  UPDATE public.compliance_request_types t
     SET fields = (SELECT jsonb_agg(CASE WHEN e.f ->> 'key' = 'authorization_letter' AND NOT (e.f ? 'showIf')
                                         THEN (CASE WHEN e.f -> 'label' = v_old THEN jsonb_set(e.f, '{label}', v_new) ELSE e.f END)
                                              || jsonb_build_object('required', true, 'showIf', v_show)
                                         ELSE e.f END ORDER BY e.ord)
                     FROM jsonb_array_elements(t.fields) WITH ORDINALITY AS e(f, ord))
   WHERE t.account_id = p_account AND t.key IN ('closure', 'withdrawal')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'authorization_letter' AND NOT (f ? 'showIf'));
END;
$$;
ALTER FUNCTION public.compliance_bank_own_fields(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_bank_own_fields(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_bank_own_fields(UUID) TO service_role;

-- A workspace made from now on gets the three types, 184's intake fields, 185's account change fields and the question. Never blocks signup.
CREATE OR REPLACE FUNCTION public.compliance_accounts_seed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.compliance_seed_types(NEW.id);
  PERFORM public.compliance_intake_fields(NEW.id);
  PERFORM public.compliance_account_change_fields(NEW.id);
  PERFORM public.compliance_bank_own_fields(NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'compliance_accounts_seed failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.compliance_accounts_seed() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_accounts_seed() FROM PUBLIC, anon, authenticated;

-- the workspaces that exist now
DO $$
BEGIN
  PERFORM public.compliance_bank_own_fields(a.id) FROM public.accounts a;
END $$;
