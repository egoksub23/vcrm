-- ============================================================
-- 237_kyc_amend_bidirectional.sql
--
-- Migration 192 added kyc_access_log_amend_approves which enforced that an 'amend' action
-- could only carry decision = 'approve' (the original flow was rejected → approved only).
--
-- Platform admins can now also reverse an approved check to rejected (approved → rejected),
-- which writes an 'amend' row with decision = 'reject'. Drop the direction restriction;
-- the existing kyc_access_log_decision_check already enforces decision IN ('approve','reject').
--
-- Idempotent.
-- ============================================================

ALTER TABLE public.kyc_access_log DROP CONSTRAINT IF EXISTS kyc_access_log_amend_approves;
