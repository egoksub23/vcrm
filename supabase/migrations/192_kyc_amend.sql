-- ============================================================
-- 192_kyc_amend.sql
--
-- KYC review: a REJECTED ID check can be amended and approved. The decision itself is the back end's (POST /validations/{id}/review again, with
-- "approve"); what this migration adds is room in the access log to say, plainly and forever, that a row is an AMENDMENT of an earlier rejection and not a
-- first decision, so an audit never has to infer it from the order of two rows:
--
--   * kyc_access_log.action gains 'amend'. Like a 'decision', an amendment writes two rows: 'attempt' BEFORE the back end is called (nothing is sent
--     when it cannot be written) and the result after.
--   * an 'amend' row carries the decision like a 'decision' row does, and it can only be 'approve': the only change Halo makes is rejected -> approved.
--
-- Nothing else changes: no note, value or key goes in the log, the log stays append-only and readable by admins and owners only, and no function,
-- policy or grant is touched. Apply BEFORE the code that writes 'amend' is deployed. Idempotent.
-- ============================================================

ALTER TABLE public.kyc_access_log DROP CONSTRAINT IF EXISTS kyc_access_log_action_check;
ALTER TABLE public.kyc_access_log ADD CONSTRAINT kyc_access_log_action_check
  CHECK (action IN ('lookup', 'list', 'view_image', 'reveal', 'config_error', 'decision', 'amend'));

-- A 'decision' or 'amend' row always says which decision; any other action never does.
ALTER TABLE public.kyc_access_log DROP CONSTRAINT IF EXISTS kyc_access_log_decision_present;
ALTER TABLE public.kyc_access_log ADD CONSTRAINT kyc_access_log_decision_present
  CHECK ((action IN ('decision', 'amend')) = (decision IS NOT NULL));

-- An amendment is always an approval of a rejected check.
ALTER TABLE public.kyc_access_log DROP CONSTRAINT IF EXISTS kyc_access_log_amend_approves;
ALTER TABLE public.kyc_access_log ADD CONSTRAINT kyc_access_log_amend_approves
  CHECK (action <> 'amend' OR decision = 'approve');
