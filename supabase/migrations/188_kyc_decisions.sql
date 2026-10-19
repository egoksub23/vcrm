-- ============================================================
-- 188_kyc_decisions.sql
--
-- KYC review, phase 2: a reviewer can APPROVE or REJECT an ID check from Halo. The decision itself is made by the ID verification back end
-- ("doc-processor", POST /validations/{id}/review), called from the server with the key that never leaves it. What this migration adds is the
-- permission and the room in the access log to say who decided what:
--
--   1. Capability   kyc.decide  Approve or reject an ID check. App tier (min grant: agent), Owner and Admin by default, never a viewer.
--                   Separate from kyc.view and kyc.reveal on purpose: a person can read and look without being able to decide.
--   2. Access log   kyc_access_log gets the action 'decision', the outcome 'attempt' and a column `decision` ('approve' or 'reject').
--                   A decision writes TWO rows: 'attempt' BEFORE the back end is called (when that row cannot be written nothing is sent) and the
--                   result after it ('ok', 'error' or 'not_found'). The log still holds no note, no value, no key and nothing the back end said:
--                   the reviewer's note lives in the back end's own record. The log stays append-only and readable by admins and owners only.
--
-- No new function is callable by a signed-in or signed-out user. Apply this migration BEFORE the code that goes with it is deployed. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The capability
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('kyc.decide', 'agent', 'app')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'kyc.decide'),
  ('admin', 'kyc.decide')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2. The access log: one more action, one more outcome, one more column
-- ------------------------------------------------------------
ALTER TABLE public.kyc_access_log DROP CONSTRAINT IF EXISTS kyc_access_log_action_check;
ALTER TABLE public.kyc_access_log ADD CONSTRAINT kyc_access_log_action_check
  CHECK (action IN ('lookup', 'list', 'view_image', 'reveal', 'config_error', 'decision'));

ALTER TABLE public.kyc_access_log DROP CONSTRAINT IF EXISTS kyc_access_log_outcome_check;
ALTER TABLE public.kyc_access_log ADD CONSTRAINT kyc_access_log_outcome_check
  CHECK (outcome IN ('ok', 'not_found', 'forbidden', 'error', 'attempt'));

ALTER TABLE public.kyc_access_log ADD COLUMN IF NOT EXISTS decision TEXT;

ALTER TABLE public.kyc_access_log DROP CONSTRAINT IF EXISTS kyc_access_log_decision_check;
ALTER TABLE public.kyc_access_log ADD CONSTRAINT kyc_access_log_decision_check
  CHECK (decision IS NULL OR decision IN ('approve', 'reject'));

-- A 'decision' row always says which decision; any other action never does.
ALTER TABLE public.kyc_access_log DROP CONSTRAINT IF EXISTS kyc_access_log_decision_present;
ALTER TABLE public.kyc_access_log ADD CONSTRAINT kyc_access_log_decision_present
  CHECK ((action = 'decision') = (decision IS NOT NULL));
