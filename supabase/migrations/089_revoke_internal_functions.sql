-- ============================================================
-- 089_revoke_internal_functions
--
-- Four SECURITY DEFINER helpers were executable by everyone (PostgreSQL grants
-- EXECUTE to PUBLIC on new functions unless it is revoked), including signed-out
-- callers and every logged-in member, with no ownership check inside:
--
--   _bcast_bump(uuid, text, integer)       used only by a definer trigger
--   recompute_broadcast_counts(uuid)       used only by a definer trigger
--   claim_ai_reply_slot(uuid, integer)     called by the server (service role)
--   record_webhook_failure(uuid, integer)  called by the server (service role)
--
-- Found during the access-control phase 5 audit (docs/access-control-enforcement.md).
-- Nothing in the browser calls them. The definer trigger
-- broadcast_recipient_aggregate_trigger() keeps working: it runs with its
-- owner's rights, not the caller's.
-- ============================================================

REVOKE ALL ON FUNCTION public._bcast_bump(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public._bcast_bump(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, integer) TO service_role;
