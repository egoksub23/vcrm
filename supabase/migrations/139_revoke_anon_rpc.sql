-- ============================================================
-- 139: signed-out callers lose EXECUTE on RPCs that need a login.
--
-- Supabase grants EXECUTE on every new function to anon and authenticated by
-- default, and these SECURITY DEFINER functions all checked auth.uid() /
-- has_capability() inside, so a signed-out call failed. Failing inside is a
-- second line of defence, though, not the first: a signed-out visitor had no
-- reason to reach them at all (and a missed check in a future edit would have
-- exposed the function to the whole internet). Revoking closes that.
--
-- Kept for signed-out callers on purpose:
--   * peek_invitation, signup_is_open: used before anyone has logged in.
--   * has_capability, is_account_member, capability_account_ids,
--     is_sembang_channel_member, is_sembang_channel_moderator: referenced by
--     RLS policies that apply to every role, so evaluating a policy for a
--     signed-out query needs EXECUTE on them.
-- Trigger functions are untouched (they cannot be called directly).
--
-- The verification script supabase/ci/verify-guard-catalog.sql pins the lists, so a
-- new function that signed-out callers can reach fails CI until it is reviewed.
-- ============================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'capabilities_for_current_user', 'close_conversation_with_note',
        'list_sembang_channels_for_current_user', 'mark_sembang_channel_read',
        'next_incident_number', 'next_ticket_number', 'redeem_invitation',
        'reopen_conversation', 'set_member_role', 'set_role_capabilities',
        'set_sembang_channel_hidden', 'set_sembang_channel_muted', 'touch_presence',
        'transfer_account_ownership'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.fn);
  END LOOP;
END $$;
