-- ============================================================
-- 083_team_members_merge.sql — Team and Members as one area
-- (Access Control phase 3)
--
-- What this migration does
--   1. account_invitations.team_ids uuid[]: the teams an invitee joins
--      when the link is redeemed. A BEFORE trigger keeps only teams of
--      the invitation's own account (so a direct insert with foreign ids
--      is silently cleaned), the same trigger makes members.invite a
--      database-enforced requirement for inserting an invitation, and
--      redeem_invitation() re-validates at redeem time (a team deleted
--      since is ignored).
--   2. redeem_invitation(): same behaviour as 019 plus the team joins.
--      The new team_members rows are stamped added_by = the inviter.
--   3. list_team_members(): ONE read that returns every member of the
--      caller's account with all their teams, last active and the open
--      work assigned to them. No per-person fetch.
--   4. team_open_conversation_counts(): open conversations per team for
--      the Teams view.
--   5. remove_account_member(p_user_id, p_reassign_to): replaces the
--      one-argument function (079 rules unchanged: members.remove, target
--      strictly below the caller, never the Owner or yourself). In one
--      transaction it also deletes the member's team rows and either
--      unassigns or reassigns their open conversations and open /
--      in-progress / pending tickets. Returns jsonb with the counts.
--   6. set_member_teams() and change_team_members(): atomic team
--      membership writes (teams.manage, every team and person validated
--      against the caller's account, foreign ids ignored).
--   7. Partial indexes for the open-work counts.
--
-- team_members.added_at / added_by already exist (043 / 082); the audit
-- triggers from 082 log every team_members insert/delete, so the new
-- writes below are covered without extra code.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. account_invitations.team_ids
-- ------------------------------------------------------------
ALTER TABLE public.account_invitations
  ADD COLUMN IF NOT EXISTS team_ids UUID[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.account_invitations'::regclass
       AND conname = 'account_invitations_team_ids_max'
  ) THEN
    ALTER TABLE public.account_invitations
      ADD CONSTRAINT account_invitations_team_ids_max
      CHECK (cardinality(team_ids) <= 50);
  END IF;
END $$;

-- Before an invitation is stored:
--   * a signed-in member of the account must hold members.invite (the
--     role rule "only below your own" is the 079 trigger); service-role
--     writes (no auth.uid()) are not restricted,
--   * team_ids is reduced to distinct teams of the invitation's account.
CREATE OR REPLACE FUNCTION public.invitation_guard_and_sanitize()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     AND auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM profiles p
                  WHERE p.user_id = auth.uid() AND p.account_id = NEW.account_id)
     AND NOT has_capability(NEW.account_id, 'members.invite') THEN
    RAISE EXCEPTION 'This action requires the ''members.invite'' permission'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.team_ids IS NULL OR cardinality(NEW.team_ids) = 0 THEN
    NEW.team_ids := '{}';
    RETURN NEW;
  END IF;
  NEW.team_ids := COALESCE((
    SELECT array_agg(DISTINCT t.id)
      FROM teams t
     WHERE t.account_id = NEW.account_id
       AND t.id = ANY(NEW.team_ids)
  ), '{}');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.invitation_guard_and_sanitize() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sanitize_invitation_team_ids ON public.account_invitations;
DROP FUNCTION IF EXISTS public.sanitize_invitation_team_ids();
DROP TRIGGER IF EXISTS invitation_guard_and_sanitize ON public.account_invitations;
CREATE TRIGGER invitation_guard_and_sanitize
  BEFORE INSERT OR UPDATE OF team_ids ON public.account_invitations
  FOR EACH ROW EXECUTE FUNCTION public.invitation_guard_and_sanitize();

-- ------------------------------------------------------------
-- 7. Indexes for the open-work counts (partial: only live work)
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_conversations_open_assignee
  ON public.conversations (account_id, assigned_agent_id)
  WHERE assigned_agent_id IS NOT NULL AND status IN ('open', 'pending');

CREATE INDEX IF NOT EXISTS idx_tickets_open_assignee
  ON public.tickets (account_id, assigned_agent_id)
  WHERE assigned_agent_id IS NOT NULL AND status IN ('open', 'in_progress', 'pending');

-- ------------------------------------------------------------
-- 2. redeem_invitation — 019 plus the team joins
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
  v_team_ids UUID[];
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

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

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Teams to join: only teams that still exist AND belong to the
  -- invitation's account. Stale or foreign ids are ignored silently.
  IF cardinality(v_inv.team_ids) > 0 THEN
    SELECT COALESCE(array_agg(t.id), '{}') INTO v_team_ids
      FROM teams t
     WHERE t.account_id = v_inv.account_id
       AND t.id = ANY(v_inv.team_ids);

    IF cardinality(v_team_ids) > 0 THEN
      INSERT INTO team_members (team_id, user_id)
      SELECT unnest(v_team_ids), v_caller_id
      ON CONFLICT (team_id, user_id) DO NOTHING;

      -- The BEFORE trigger stamped the redeemer; the person who added
      -- them to these teams is the inviter.
      IF v_inv.created_by_user_id IS NOT NULL THEN
        UPDATE team_members
           SET added_by = v_inv.created_by_user_id
         WHERE user_id = v_caller_id
           AND team_id = ANY(v_team_ids);
      END IF;
    END IF;
  END IF;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 3. list_team_members()
--
-- The caller's account only (resolved from auth.uid(); no session or no
-- profile returns no rows). Email is returned only to Owner/Admin, the
-- same rule the members route applied before. Open work is counted in
-- one grouped pass per table.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_team_members()
RETURNS TABLE (
  user_id            UUID,
  full_name          TEXT,
  email              TEXT,
  avatar_url         TEXT,
  role               account_role_enum,
  joined_at          TIMESTAMPTZ,
  last_active        TIMESTAMPTZ,
  teams              JSONB,
  open_conversations INTEGER,
  open_tickets       INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT p.account_id, p.account_role
      FROM profiles p
     WHERE p.user_id = auth.uid()
  ),
  team_agg AS (
    SELECT tm.user_id AS uid,
           jsonb_agg(
             jsonb_build_object('id', t.id, 'name', t.name, 'color', t.color)
             ORDER BY lower(t.name), t.id
           ) AS teams
      FROM team_members tm
      JOIN teams t ON t.id = tm.team_id
      JOIN me ON me.account_id = t.account_id
     GROUP BY tm.user_id
  ),
  conv AS (
    SELECT c.assigned_agent_id AS uid, count(*)::int AS n
      FROM conversations c
      JOIN me ON me.account_id = c.account_id
     WHERE c.assigned_agent_id IS NOT NULL
       AND c.status IN ('open', 'pending')
     GROUP BY c.assigned_agent_id
  ),
  tick AS (
    SELECT k.assigned_agent_id AS uid, count(*)::int AS n
      FROM tickets k
      JOIN me ON me.account_id = k.account_id
     WHERE k.assigned_agent_id IS NOT NULL
       AND k.status IN ('open', 'in_progress', 'pending')
     GROUP BY k.assigned_agent_id
  )
  SELECT p.user_id,
         COALESCE(p.full_name, ''),
         CASE WHEN me.account_role IN ('owner', 'admin') THEN p.email ELSE NULL END,
         p.avatar_url,
         p.account_role,
         p.created_at,
         mp.last_seen_at,
         COALESCE(ta.teams, '[]'::jsonb),
         COALESCE(conv.n, 0),
         COALESCE(tick.n, 0)
    FROM profiles p
    JOIN me ON me.account_id = p.account_id
    LEFT JOIN team_agg ta ON ta.uid = p.user_id
    LEFT JOIN conv ON conv.uid = p.user_id
    LEFT JOIN tick ON tick.uid = p.user_id
    LEFT JOIN member_presence mp ON mp.user_id = p.user_id
   ORDER BY p.created_at, p.user_id;
$$;

ALTER FUNCTION public.list_team_members() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_team_members() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_team_members() TO authenticated;

-- ------------------------------------------------------------
-- 4. team_open_conversation_counts()
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.team_open_conversation_counts()
RETURNS TABLE (team_id UUID, open_conversations INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT p.account_id FROM profiles p WHERE p.user_id = auth.uid()
  ),
  conv AS (
    SELECT c.assigned_team_id AS tid, count(*)::int AS n
      FROM conversations c
      JOIN me ON me.account_id = c.account_id
     WHERE c.assigned_team_id IS NOT NULL
       AND c.status IN ('open', 'pending')
     GROUP BY c.assigned_team_id
  )
  SELECT t.id, COALESCE(conv.n, 0)
    FROM teams t
    JOIN me ON me.account_id = t.account_id
    LEFT JOIN conv ON conv.tid = t.id;
$$;

ALTER FUNCTION public.team_open_conversation_counts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.team_open_conversation_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_open_conversation_counts() TO authenticated;

-- ------------------------------------------------------------
-- 5. remove_account_member(p_user_id, p_reassign_to)
--
-- Same authorisation as 079. The old one-argument function returned the
-- removed person's new personal account id (uuid); the new one returns
-- jsonb, so the old signature is dropped first (an overload would make a
-- one-argument call ambiguous).
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.remove_account_member(UUID);

CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id     UUID,
  p_reassign_to UUID DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_new_account_id UUID;
  v_heir_account_id UUID;
  v_heir_role account_role_enum;
  v_convs INTEGER;
  v_tickets INTEGER;
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
     OR NOT has_capability(v_caller_account_id, 'members.remove') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, full_name, email
    INTO v_target_account_id, v_target_role, v_target_name, v_target_email
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
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  IF role_rank(v_target_role) >= role_rank(v_caller_role) THEN
    RAISE EXCEPTION 'You can only remove members whose role is below your own'
      USING ERRCODE = '42501';
  END IF;

  -- Optional heir for their open work: a different member of this
  -- account who can actually work on it (not a viewer).
  IF p_reassign_to IS NOT NULL THEN
    IF p_reassign_to = p_user_id THEN
      RAISE EXCEPTION 'Cannot reassign work to the member being removed'
        USING ERRCODE = '22023';
    END IF;
    SELECT account_id, account_role
      INTO v_heir_account_id, v_heir_role
      FROM profiles
     WHERE user_id = p_reassign_to;
    IF v_heir_account_id IS NULL OR v_heir_account_id <> v_caller_account_id THEN
      RAISE EXCEPTION 'The person to reassign to is not a member of your account'
        USING ERRCODE = '22023';
    END IF;
    IF role_rank(v_heir_role) < role_rank('agent') THEN
      RAISE EXCEPTION 'Work can only be reassigned to an agent or above'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Team memberships go first (each delete is logged by the 082 trigger).
  DELETE FROM team_members tm
   USING teams t
   WHERE tm.team_id = t.id
     AND t.account_id = v_caller_account_id
     AND tm.user_id = p_user_id;

  -- Open work: reassign to the heir, or unassign (NULL) when none given.
  UPDATE conversations
     SET assigned_agent_id = p_reassign_to
   WHERE account_id = v_caller_account_id
     AND assigned_agent_id = p_user_id
     AND status IN ('open', 'pending');
  GET DIAGNOSTICS v_convs = ROW_COUNT;

  UPDATE tickets
     SET assigned_agent_id = p_reassign_to
   WHERE account_id = v_caller_account_id
     AND assigned_agent_id = p_user_id
     AND status IN ('open', 'in_progress', 'pending');
  GET DIAGNOSTICS v_tickets = ROW_COUNT;

  -- Spin up a fresh personal account for the removed user (as 018/079).
  INSERT INTO accounts (name, owner_user_id)
  VALUES (
    COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
    p_user_id
  )
  RETURNING id INTO v_new_account_id;

  UPDATE profiles
     SET account_id = v_new_account_id,
         account_role = 'owner'
   WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'removed', true,
    'unassigned_conversations', CASE WHEN p_reassign_to IS NULL THEN v_convs ELSE 0 END,
    'unassigned_tickets',       CASE WHEN p_reassign_to IS NULL THEN v_tickets ELSE 0 END,
    'reassigned_conversations', CASE WHEN p_reassign_to IS NULL THEN 0 ELSE v_convs END,
    'reassigned_tickets',       CASE WHEN p_reassign_to IS NULL THEN 0 ELSE v_tickets END,
    'reassigned_to',            p_reassign_to,
    'new_account_id',           v_new_account_id
  );
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID, UUID) TO authenticated;

-- ------------------------------------------------------------
-- 6. Team membership writes
--
-- Both need the teams.manage capability. Teams and people are matched
-- against the CALLER's account; anything else is ignored silently.
-- ------------------------------------------------------------

-- Make p_user_id a member of exactly p_team_ids (diff applied).
CREATE OR REPLACE FUNCTION public.set_member_teams(
  p_user_id  UUID,
  p_team_ids UUID[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_target_account_id UUID;
  v_wanted UUID[];
  v_added INTEGER;
  v_removed INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL OR NOT has_capability(v_account_id, 'teams.manage') THEN
    RAISE EXCEPTION 'This action requires the ''teams.manage'' permission'
      USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_target_account_id FROM profiles WHERE user_id = p_user_id;
  IF v_target_account_id IS NULL OR v_target_account_id <> v_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg(t.id), '{}') INTO v_wanted
    FROM teams t
   WHERE t.account_id = v_account_id
     AND t.id = ANY(COALESCE(p_team_ids, '{}'));

  DELETE FROM team_members tm
   USING teams t
   WHERE tm.team_id = t.id
     AND t.account_id = v_account_id
     AND tm.user_id = p_user_id
     AND NOT (tm.team_id = ANY(v_wanted));
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  INSERT INTO team_members (team_id, user_id)
  SELECT w, p_user_id FROM unnest(v_wanted) AS w
  ON CONFLICT (team_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN jsonb_build_object('added', v_added, 'removed', v_removed);
END;
$$;

ALTER FUNCTION public.set_member_teams(UUID, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_teams(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_teams(UUID, UUID[]) TO authenticated;

-- Add several people to several teams, or remove them from those teams.
CREATE OR REPLACE FUNCTION public.change_team_members(
  p_user_ids UUID[],
  p_team_ids UUID[],
  p_action   TEXT
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_users UUID[];
  v_teams UUID[];
  v_changed INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_action NOT IN ('add', 'remove') THEN
    RAISE EXCEPTION 'p_action must be add or remove' USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL OR NOT has_capability(v_account_id, 'teams.manage') THEN
    RAISE EXCEPTION 'This action requires the ''teams.manage'' permission'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg(p.user_id), '{}') INTO v_users
    FROM profiles p
   WHERE p.account_id = v_account_id
     AND p.user_id = ANY(COALESCE(p_user_ids, '{}'));

  SELECT COALESCE(array_agg(t.id), '{}') INTO v_teams
    FROM teams t
   WHERE t.account_id = v_account_id
     AND t.id = ANY(COALESCE(p_team_ids, '{}'));

  IF p_action = 'add' THEN
    INSERT INTO team_members (team_id, user_id)
    SELECT t, u FROM unnest(v_teams) AS t CROSS JOIN unnest(v_users) AS u
    ON CONFLICT (team_id, user_id) DO NOTHING;
  ELSE
    DELETE FROM team_members tm
     WHERE tm.team_id = ANY(v_teams)
       AND tm.user_id = ANY(v_users);
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  RETURN jsonb_build_object('changed', v_changed);
END;
$$;

ALTER FUNCTION public.change_team_members(UUID[], UUID[], TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.change_team_members(UUID[], UUID[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_team_members(UUID[], UUID[], TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
