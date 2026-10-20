-- ============================================================
-- 190_invite_accept_purge_flag.sql
--
-- Accepting an invitation failed with "Failed to redeem invitation" for every new person who signed up and then accepted. It has failed since
-- migration 183 (Compliance); it was found when a new colleague accepted a Compliance Officer invitation.
--
-- Accepting moves the invitee into the inviter's workspace and then deletes the empty personal workspace they were given at signup
-- (attach_user_to_invited_account). Deleting a workspace cascades to its Compliance request types, which every workspace is seeded with as SYSTEM
-- types, and 183's guard (compliance_types_guard) refuses to delete a system type unless the workspace is being purged on purpose
-- (`vircle.purge_account` set to its id by a database owner role). Nothing set it here, so the delete raised
--   23514 compliance_system_type_is_fixed
-- which the redeem route does not map (it maps 42501, 22023 and 23505), so it answered a generic 500 and the person saw "Failed to redeem". The
-- whole accept rolled back, so nobody was left half moved.
--
-- Fix: the function names the personal workspace it is about to delete in `vircle.purge_account`, for that one delete, and clears it. Because that
-- flag also lets retained records go, the "does the personal workspace hold data" check (which already refused 11 kinds of data) now also refuses
-- a workspace holding a Compliance case (kept seven years), a Secure Sign document, or a KYC access log row: such a person is told to sign up with a
-- different email, as for any other data, and nothing is deleted.
--
-- The body is 114's, apart from those two changes. Idempotent (CREATE OR REPLACE). No table, column, policy, trigger or grant is changed.
-- ============================================================

CREATE OR REPLACE FUNCTION public.attach_user_to_invited_account(
  p_user_id UUID,
  p_invitation_id UUID
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
  v_team_ids UUID[];
BEGIN
  IF p_invitation_id IS NULL THEN
    RETURN 'not_found';
  END IF;

  SELECT * INTO v_inv FROM account_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_inv.accepted_at IS NOT NULL THEN RETURN 'already_redeemed'; END IF;
  IF v_inv.expires_at <= NOW() THEN RETURN 'expired'; END IF;

  SELECT p.account_id, a.owner_user_id INTO v_old_account_id, v_old_account_owner
  FROM profiles p JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = p_user_id;

  IF v_old_account_id IS NULL THEN RETURN 'no_profile'; END IF;
  IF v_old_account_id = v_inv.account_id THEN RETURN 'already_member'; END IF;
  IF v_old_account_owner <> p_user_id THEN RETURN 'not_sole_owner'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    -- records that are kept on purpose (190): a Compliance case is retained for seven years, a Secure Sign document is only voided never deleted,
    -- and the KYC access log is append-only. The purge flag set below lets the workspace's delete pass those guards, so they must be refused HERE,
    -- never destroyed: an empty personal workspace has none of them.
    UNION ALL SELECT 1 FROM compliance_requests WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM sign_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM kyc_access_log WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;
  IF v_has_data THEN RETURN 'has_data'; END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id, account_role = v_inv.role, custom_role_id = v_inv.custom_role_id
  WHERE user_id = p_user_id;

  UPDATE account_invitations
  SET accepted_at = NOW(), accepted_by_user_id = p_user_id
  WHERE id = v_inv.id;

  IF cardinality(v_inv.team_ids) > 0 THEN
    SELECT COALESCE(array_agg(t.id), '{}') INTO v_team_ids
      FROM teams t
     WHERE t.account_id = v_inv.account_id
       AND t.id = ANY(v_inv.team_ids);

    IF cardinality(v_team_ids) > 0 THEN
      INSERT INTO team_members (team_id, user_id)
      SELECT unnest(v_team_ids), p_user_id
      ON CONFLICT (team_id, user_id) DO NOTHING;

      IF v_inv.created_by_user_id IS NOT NULL THEN
        UPDATE team_members
           SET added_by = v_inv.created_by_user_id
         WHERE user_id = p_user_id
           AND team_id = ANY(v_team_ids);
      END IF;
    END IF;
  END IF;

  -- The empty personal workspace the invitee got at signup is deleted now. Its seeded Compliance request types are system types, which a guard
  -- (183) lets go only while that workspace is being purged (`vircle.purge_account` = its id, and only a database owner role). This function is
  -- SECURITY DEFINER and owned by postgres, and has just checked the workspace holds no data, so it names THIS workspace and nothing else, for this
  -- one delete, and clears the setting straight after.
  PERFORM set_config('vircle.purge_account', v_old_account_id::text, true);
  DELETE FROM accounts WHERE id = v_old_account_id;
  PERFORM set_config('vircle.purge_account', '', true);

  RETURN NULL;
END;
$$;
ALTER FUNCTION public.attach_user_to_invited_account(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.attach_user_to_invited_account(UUID, UUID) FROM PUBLIC, anon, authenticated;
