-- ============================================================
-- Migration 201: drop the old share_issue_token overload
--
-- Migration 200 added p_allowed_emails but CREATE OR REPLACE
-- with a different parameter list creates a new overload instead
-- of replacing the old function. PostgREST cannot resolve the
-- ambiguity when both overloads exist. Drop the old 10-param
-- version so only the new 11-param version remains.
-- ============================================================

DROP FUNCTION IF EXISTS public.share_issue_token(
  uuid, uuid, text, text, text, bigint,
  uuid, text, boolean, timestamptz
);
