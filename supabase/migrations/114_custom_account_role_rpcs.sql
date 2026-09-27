-- ============================================================
-- Custom account roles — phase 3: write RPCs.
--
-- Same guardrail shape as 079's set_role_capabilities/set_member_role
-- (roles.manage required; caller can't grant what they don't hold;
-- min_grant_role floor; caller can only act strictly below their own
-- rank; every effective change logged), just keyed by account_role_id
-- instead of a literal (account_id, role) pair.
--
-- Depends on: 112 (account_roles, account_role_capabilities,
-- profiles.custom_role_id, account_invitations.custom_role_id), 113
-- (effective_custom_role_capability).
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. create_account_role(account, name, base_role, source)
--
-- `source` is {"kind":"base","role":"agent"} (snapshot that built-in
-- role's CURRENT effective set in this account — defaults plus
-- whatever overrides an admin already applied) or {"kind":"custom",
-- "id":"<uuid>"} (another custom role in the same account). Stores
-- only the diff against the NEW role's own base_role default, exactly
-- like set_role_capabilities does for an edit. A capability the
-- source had that either exceeds the new base tier's floor or that
-- the caller does not themselves hold is silently dropped rather than
-- erroring — duplicating a role into a lower tier demotes it exactly
-- as set_role_capabilities would refuse to let you grant it by hand.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_account_role(
  p_account_id UUID,
  p_name       TEXT,
  p_base_role  account_role_enum,
  p_source     JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            UUID := auth.uid();
  v_caller_account UUID;
  v_caller_role    account_role_enum;
  v_name           TEXT := btrim(COALESCE(p_name, ''));
  v_new_id         UUID;
  v_src_kind       TEXT;
  v_src_role       account_role_enum;
  v_src_custom_id  UUID;
  v_src_account    UUID;
  cap              RECORD;
  v_source_val     BOOLEAN;
  v_default_val    BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_caller_account, v_caller_role
    FROM profiles WHERE user_id = v_uid;

  IF v_caller_account IS NULL OR v_caller_account <> p_account_id THEN
    RAISE EXCEPTION 'You are not a member of this account' USING ERRCODE = '42501';
  END IF;

  IF NOT has_capability(p_account_id, 'roles.manage') THEN
    RAISE EXCEPTION 'This action requires the ''roles.manage'' permission'
      USING ERRCODE = '42501';
  END IF;

  IF v_name = '' THEN
    RAISE EXCEPTION 'Give the role a name' USING ERRCODE = '22023';
  END IF;

  IF p_base_role NOT IN ('admin', 'agent', 'viewer') THEN
    RAISE EXCEPTION 'A custom role must be based on admin, agent or viewer'
      USING ERRCODE = '22023';
  END IF;

  IF role_rank(p_base_role) >= role_rank(v_caller_role) THEN
    RAISE EXCEPTION 'You can only create roles below your own' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM account_roles
     WHERE account_id = p_account_id AND lower(btrim(name)) = lower(v_name)
  ) THEN
    RAISE EXCEPTION 'A role named "%" already exists', v_name USING ERRCODE = '23505';
  END IF;

  v_src_kind := p_source ->> 'kind';
  IF v_src_kind = 'base' THEN
    v_src_role := NULLIF(p_source ->> 'role', '')::account_role_enum;
    IF v_src_role IS NULL OR v_src_role NOT IN ('admin', 'agent', 'viewer') THEN
      RAISE EXCEPTION 'Unknown source role' USING ERRCODE = '22023';
    END IF;
  ELSIF v_src_kind = 'custom' THEN
    v_src_custom_id := NULLIF(p_source ->> 'id', '')::UUID;
    SELECT account_id INTO v_src_account FROM account_roles WHERE id = v_src_custom_id;
    IF v_src_account IS NULL OR v_src_account <> p_account_id THEN
      RAISE EXCEPTION 'Source role not found' USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'source.kind must be "base" or "custom"' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('account_roles:' || p_account_id::text, 0));

  INSERT INTO account_roles (account_id, name, base_role, created_by)
  VALUES (p_account_id, v_name, p_base_role, v_uid)
  RETURNING id INTO v_new_id;

  FOR cap IN SELECT capability, min_grant_role FROM capability_catalogue LOOP
    v_source_val := CASE
      WHEN v_src_kind = 'base' THEN effective_capability(p_account_id, v_src_role, cap.capability)
      ELSE effective_custom_role_capability(v_src_custom_id, cap.capability)
    END;
    v_default_val := EXISTS (
      SELECT 1 FROM role_capability_defaults d
       WHERE d.role = p_base_role AND d.capability = cap.capability
    );

    IF v_source_val = v_default_val THEN
      CONTINUE;
    END IF;

    IF v_source_val AND (
      role_rank(p_base_role) < role_rank(cap.min_grant_role)
      OR NOT has_capability(p_account_id, cap.capability)
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO account_role_capabilities (account_role_id, capability, granted, changed_by)
    VALUES (v_new_id, cap.capability, v_source_val, v_uid);

    INSERT INTO role_capability_log
      (account_id, role, capability, old_granted, new_granted, actor, account_role_id, note)
    VALUES
      (p_account_id, p_base_role, cap.capability, v_default_val, v_source_val, v_uid, v_new_id,
       'role created (' || v_src_kind || ')');
  END LOOP;

  RETURN v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_account_role(UUID, TEXT, account_role_enum, JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_account_role(UUID, TEXT, account_role_enum, JSONB)
  TO authenticated;

-- ------------------------------------------------------------
-- 2. set_account_role_capabilities(account_role_id, changes) — same
-- shape/guardrails as set_role_capabilities (079), keyed by id.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_account_role_capabilities(
  target_account_role_id UUID,
  changes                JSONB
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            UUID := auth.uid();
  v_caller_account UUID;
  v_caller_role    account_role_enum;
  v_target_account UUID;
  v_base_role      account_role_enum;
  v_key            TEXT;
  v_val            JSONB;
  v_min            account_role_enum;
  v_default        BOOLEAN;
  v_old            BOOLEAN;
  v_new            BOOLEAN;
  v_changed        INTEGER := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_caller_account, v_caller_role
    FROM profiles WHERE user_id = v_uid;

  SELECT account_id, base_role INTO v_target_account, v_base_role
    FROM account_roles WHERE id = target_account_role_id;

  IF v_target_account IS NULL THEN
    RAISE EXCEPTION 'Role not found' USING ERRCODE = '22023';
  END IF;

  IF v_caller_account IS NULL OR v_caller_account <> v_target_account THEN
    RAISE EXCEPTION 'You are not a member of this account' USING ERRCODE = '42501';
  END IF;

  IF NOT has_capability(v_target_account, 'roles.manage') THEN
    RAISE EXCEPTION 'This action requires the ''roles.manage'' permission'
      USING ERRCODE = '42501';
  END IF;

  IF role_rank(v_base_role) >= role_rank(v_caller_role) THEN
    RAISE EXCEPTION 'You can only edit roles below your own' USING ERRCODE = '42501';
  END IF;

  IF changes IS NULL OR jsonb_typeof(changes) <> 'object' THEN
    RAISE EXCEPTION '''changes'' must be a JSON object of capability to true, false or null'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('account_role_capabilities:' || target_account_role_id::text, 0));

  FOR v_key, v_val IN SELECT key, value FROM jsonb_each(changes) LOOP
    SELECT min_grant_role INTO v_min FROM capability_catalogue WHERE capability = v_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown capability: %', v_key USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_val) NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION 'Capability % must be set to true, false or null', v_key
        USING ERRCODE = '22023';
    END IF;

    v_default := EXISTS (
      SELECT 1 FROM role_capability_defaults d WHERE d.role = v_base_role AND d.capability = v_key
    );
    v_old := effective_custom_role_capability(target_account_role_id, v_key);
    v_new := CASE WHEN jsonb_typeof(v_val) = 'null' THEN v_default
                  ELSE (v_val #>> '{}')::boolean END;

    IF v_new AND NOT v_old THEN
      IF role_rank(v_base_role) < role_rank(v_min) THEN
        RAISE EXCEPTION 'The % role cannot be given ''%'' (it needs the % role or higher)',
          v_base_role, v_key, v_min
          USING ERRCODE = '22023';
      END IF;
      IF NOT has_capability(v_target_account, v_key) THEN
        RAISE EXCEPTION 'You cannot grant ''%'' because you do not hold it yourself', v_key
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF v_new = v_default THEN
      DELETE FROM account_role_capabilities
       WHERE account_role_id = target_account_role_id AND capability = v_key;
    ELSE
      INSERT INTO account_role_capabilities (account_role_id, capability, granted, changed_by, changed_at)
      VALUES (target_account_role_id, v_key, v_new, v_uid, NOW())
      ON CONFLICT (account_role_id, capability)
      DO UPDATE SET granted    = EXCLUDED.granted,
                    changed_by = EXCLUDED.changed_by,
                    changed_at = EXCLUDED.changed_at;
    END IF;

    IF v_new IS DISTINCT FROM v_old THEN
      INSERT INTO role_capability_log
        (account_id, role, capability, old_granted, new_granted, actor, account_role_id)
      VALUES
        (v_target_account, v_base_role, v_key, v_old, v_new, v_uid, target_account_role_id);
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  UPDATE account_roles SET updated_at = NOW() WHERE id = target_account_role_id;

  RETURN jsonb_build_object('changed', v_changed);
END;
$$;

REVOKE ALL ON FUNCTION public.set_account_role_capabilities(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_account_role_capabilities(UUID, JSONB) TO authenticated;

-- ------------------------------------------------------------
-- 3. delete_account_role(account_role_id) — demotes affected members
-- to their bare base_role (profiles.custom_role_id / account_
-- invitations.custom_role_id are ON DELETE SET NULL; their
-- account_role column was always already the base_role, so nothing
-- else changes for them). Blocked while a pending invitation still
-- references it — simpler than cascading into invitations.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_account_role(target_account_role_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            UUID := auth.uid();
  v_caller_account UUID;
  v_caller_role    account_role_enum;
  v_target_account UUID;
  v_base_role      account_role_enum;
  v_member_count   INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_caller_account, v_caller_role
    FROM profiles WHERE user_id = v_uid;

  SELECT account_id, base_role INTO v_target_account, v_base_role
    FROM account_roles WHERE id = target_account_role_id;

  IF v_target_account IS NULL THEN
    RAISE EXCEPTION 'Role not found' USING ERRCODE = '22023';
  END IF;
  IF v_caller_account IS NULL OR v_caller_account <> v_target_account THEN
    RAISE EXCEPTION 'You are not a member of this account' USING ERRCODE = '42501';
  END IF;
  IF NOT has_capability(v_target_account, 'roles.manage') THEN
    RAISE EXCEPTION 'This action requires the ''roles.manage'' permission'
      USING ERRCODE = '42501';
  END IF;
  IF role_rank(v_base_role) >= role_rank(v_caller_role) THEN
    RAISE EXCEPTION 'You can only delete roles below your own' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM account_invitations
     WHERE custom_role_id = target_account_role_id AND accepted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'There is a pending invitation for this role; cancel it first'
      USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_member_count FROM profiles WHERE custom_role_id = target_account_role_id;

  DELETE FROM account_roles WHERE id = target_account_role_id;

  RETURN jsonb_build_object('demoted_members', v_member_count);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_account_role(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_account_role(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 4. set_member_custom_role(user_id, custom_role_id) — new, narrow
-- RPC rather than overloading set_member_role: sets account_role to
-- the custom role's base_role and custom_role_id together in one
-- statement, reusing set_member_role's exact hierarchy checks
-- (caller <> target, target's CURRENT role strictly below caller, the
-- NEW base_role strictly below caller).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_custom_role(
  p_user_id UUID,
  p_custom_role_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_role_account_id UUID;
  v_base_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role INTO v_caller_account_id, v_caller_role
    FROM profiles WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin')
     OR NOT has_capability(v_caller_account_id, 'members.change-role') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role INTO v_target_account_id, v_target_role
    FROM profiles WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;
  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot assign a custom role to the account owner'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, base_role INTO v_role_account_id, v_base_role
    FROM account_roles WHERE id = p_custom_role_id;

  IF v_role_account_id IS NULL OR v_role_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Role not found' USING ERRCODE = '22023';
  END IF;

  IF role_rank(v_target_role) >= role_rank(v_caller_role) THEN
    RAISE EXCEPTION 'You can only change members whose role is below your own'
      USING ERRCODE = '42501';
  END IF;
  IF role_rank(v_base_role) >= role_rank(v_caller_role) THEN
    RAISE EXCEPTION 'You can only assign roles below your own'
      USING ERRCODE = '42501';
  END IF;

  UPDATE profiles
     SET account_role = v_base_role,
         custom_role_id = p_custom_role_id
   WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_member_custom_role(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_custom_role(UUID, UUID) TO authenticated;

-- ------------------------------------------------------------
-- 5. set_member_role (079) — CREATE OR REPLACE, body unchanged except
-- clearing custom_role_id: assigning a plain built-in role always
-- means "no custom role" (the two RPCs are mutually exclusive ways to
-- set a member's role; without this, switching someone from a custom
-- role back to a plain built-in role via set_member_role would leave
-- a stale custom_role_id whose base_role no longer matches their new
-- literal account_role).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_role(p_user_id UUID, p_new_role account_role_enum)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
    INTO v_caller_account_id, v_caller_role
    FROM profiles
   WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin')
     OR NOT has_capability(v_caller_account_id, 'members.change-role') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
    INTO v_target_account_id, v_target_role
    FROM profiles
   WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  IF role_rank(v_target_role) >= role_rank(v_caller_role) THEN
    RAISE EXCEPTION 'You can only change members whose role is below your own'
      USING ERRCODE = '42501';
  END IF;
  IF role_rank(p_new_role) >= role_rank(v_caller_role) THEN
    RAISE EXCEPTION 'You can only assign roles below your own'
      USING ERRCODE = '42501';
  END IF;

  UPDATE profiles
     SET account_role = p_new_role,
         custom_role_id = NULL
   WHERE user_id = p_user_id;
END;
$$;

-- ------------------------------------------------------------
-- 6. enforce_invitation_role_below_inviter (079) — CREATE OR REPLACE,
-- extended to validate custom_role_id as defense in depth (belongs to
-- the same account, its base_role matches NEW.role): a client sending
-- a mismatched role/custom_role_id pair is rejected at the trigger,
-- not just by the route that builds the insert.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_invitation_role_below_inviter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
  v_role_account_id UUID;
  v_role_base_role account_role_enum;
BEGIN
  IF NEW.custom_role_id IS NOT NULL THEN
    SELECT account_id, base_role INTO v_role_account_id, v_role_base_role
      FROM account_roles WHERE id = NEW.custom_role_id;
    IF v_role_account_id IS NULL OR v_role_account_id <> NEW.account_id THEN
      RAISE EXCEPTION 'Role not found' USING ERRCODE = '22023';
    END IF;
    IF v_role_base_role <> NEW.role THEN
      RAISE EXCEPTION 'The invitation role must match the custom role''s base role'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT account_role INTO v_role
    FROM profiles
   WHERE user_id = auth.uid() AND account_id = NEW.account_id;

  IF v_role IS NULL THEN
    RETURN NEW;
  END IF;

  IF role_rank(NEW.role) >= role_rank(v_role) THEN
    RAISE EXCEPTION 'You can only invite roles below your own'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 7. attach_user_to_invited_account (108) — CREATE OR REPLACE, body
-- unchanged except carrying custom_role_id over onto the accepting
-- member's profile alongside the literal role, so accepting an invite
-- that named a custom role actually assigns it.
-- ------------------------------------------------------------
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

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN NULL;
END;
$$;
ALTER FUNCTION public.attach_user_to_invited_account(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.attach_user_to_invited_account(UUID, UUID) FROM PUBLIC, anon, authenticated;
