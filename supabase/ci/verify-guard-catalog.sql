-- Catalogue guards. Not tied to one migration: it asserts properties of the schema as a
-- whole, so a future migration cannot quietly undo them. Self-contained and read-only
-- (it reads the catalogs only), so it runs the same on an empty CI database and on
-- production. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every rule held.
--
-- When a rule fails the message says what to do. The allowlists below are the review
-- record: adding a name means someone checked that the function validates its caller
-- (or that the table/bucket is meant to be readable by everyone).
DO $verify$
DECLARE
  -- SECURITY DEFINER functions (not triggers) a signed-in user may call. Each checks the
  -- caller itself (auth.uid(), is_account_member, has_capability, platform_require_admin).
  authenticated_ok text[] := ARRAY[
    'approvals_list', 'approvals_pending_count', 'audit_removed_items',
    'capabilities_for_current_user', 'capability_account_ids', 'change_team_members',
    'close_conversation_with_note', 'create_account_role', 'decide_proposal', 'delete_account_role',
    'has_capability', 'incident_escalate_manual', 'is_account_member', 'is_platform_admin',
    'is_sembang_channel_member', 'is_sembang_channel_moderator', 'is_sembang_manager',
    'list_deleted_contacts', 'list_sembang_channels_for_current_user', 'list_team_members',
    'mark_sembang_channel_read', 'next_incident_number', 'next_ticket_number', 'peek_invitation',
    'platform_cron_status', 'platform_list_accounts', 'platform_reseed_account',
    'platform_set_account_status', 'platform_set_open_signup', 'platform_update_account',
    'propose_snippet', 'propose_snippet_edit', 'propose_tag', 'propose_tag_edit',
    'redeem_invitation', 'remove_account_member', 'reopen_conversation', 'restore_contact',
    'restore_removed_item', 'set_account_role_capabilities', 'set_member_custom_role',
    'set_member_role', 'set_member_teams', 'set_role_capabilities', 'set_sembang_channel_hidden',
    'set_sembang_channel_muted', 'signup_is_open', 'sla_apply_to_open_tickets',
    'sla_reorder_policies', 'team_open_conversation_counts', 'touch_presence',
    'transfer_account_ownership', 'withdraw_proposal'
  ];
  -- ...and the subset a SIGNED-OUT caller may call: the two used before login, and the
  -- helpers that RLS policies (which apply to every role) evaluate.
  anon_ok text[] := ARRAY[
    'capability_account_ids', 'has_capability', 'is_account_member', 'is_sembang_channel_member',
    'is_sembang_channel_moderator', 'peek_invitation', 'signup_is_open'
  ];
  -- Reference tables every signed-in user may read in full (no tenant data in them).
  open_read_tables text[] := ARRAY['capability_catalogue', 'role_capability_defaults'];
  -- Storage buckets served publicly by URL. Anything new must be a deliberate choice.
  public_buckets text[] := ARRAY['avatars', 'chat-media', 'flow-media'];
  r record;
  v_list text;
BEGIN
  -- 1. Row level security is on for every table in public.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_list
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity;
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL RLS is off for: %. Enable it (ALTER TABLE ... ENABLE ROW LEVEL SECURITY) and add account-scoped policies.', v_list;
  END IF;

  -- 2. No policy lets everyone read or write a whole table.
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO v_list
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND (btrim(coalesce(p.qual, ''), '() ') = 'true'
         OR (p.cmd = 'INSERT' AND btrim(coalesce(p.with_check, ''), '() ') = 'true'))
    AND NOT (p.tablename = ANY (open_read_tables) AND p.cmd = 'SELECT');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL a policy allows every row (USING true): %. Scope it to the account, or add the table to open_read_tables if it is reference data.', v_list;
  END IF;

  -- 3. Every SECURITY DEFINER function pins its search_path (otherwise a schema the caller
  --    controls can shadow what it calls).
  SELECT string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname) INTO v_list
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef AND p.prokind = 'f'
    AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL SECURITY DEFINER function without SET search_path: %', v_list;
  END IF;

  -- 4. Signed-in callers: only reviewed SECURITY DEFINER functions. New functions get
  --    EXECUTE by default, and they run with the owner's rights.
  SELECT string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname) INTO v_list
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef AND p.prokind = 'f'
    AND p.prorettype <> 'trigger'::regtype
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND NOT (p.proname = ANY (authenticated_ok));
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL new SECURITY DEFINER function(s) callable by any signed-in user: %. If it checks the caller (auth.uid() / has_capability / is_account_member), add it to authenticated_ok in this file; otherwise REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated and GRANT EXECUTE TO service_role.', v_list;
  END IF;

  -- 5. Signed-out callers: a much shorter list.
  SELECT string_agg(DISTINCT p.proname, ', ' ORDER BY p.proname) INTO v_list
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef AND p.prokind = 'f'
    AND p.prorettype <> 'trigger'::regtype
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
    AND NOT (p.proname = ANY (anon_ok));
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL SECURITY DEFINER function(s) callable without logging in: %. REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon; GRANT EXECUTE ... TO authenticated, service_role.', v_list;
  END IF;

  -- 6. Public storage buckets are an explicit list; the tenant-private ones are not public.
  SELECT string_agg(b.id, ', ' ORDER BY b.id) INTO v_list
  FROM storage.buckets b WHERE b.public AND NOT (b.id = ANY (public_buckets));
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL storage bucket(s) served publicly by URL: %. Make them private (signed URLs) or add them to public_buckets after review.', v_list;
  END IF;

  -- 7. No table in public is writable or readable by signed-out callers through a policy
  --    that does not tie the row to an account (policies granted TO anon explicitly).
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO v_list
  FROM pg_policies p
  WHERE p.schemaname = 'public' AND p.roles @> ARRAY['anon']::name[];
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL policy granted explicitly to anon: %. Signed-out callers should have no direct table access.', v_list;
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: RLS on for every public table; no allow-all policy outside reference tables; every SECURITY DEFINER function pins search_path; signed-in and signed-out callable function lists match the reviewed allowlists; public buckets match the allowlist; no policy granted straight to anon';
END
$verify$;
