-- ============================================================
-- 053_assignment_routing_strategies
--
-- The last two Assignment Strategies P1 gap-analysis items: respond.io
-- offers a "Least Open Contacts" routing strategy (load-aware, not just
-- rotation-based) and an online-only filter that skips agents who
-- aren't currently at their desk. Neither existed — round-robin
-- (migration 043) was the only routing strategy, and presence data
-- (migration 024's `member_presence`) was never consulted during
-- assignment despite already being tracked for the UI's presence dots.
--
-- What this adds
--   1. `pick_least_loaded_agent` / `pick_least_loaded_team_member` —
--      new SQL functions mirroring the shape of migration 043's
--      round-robin pickers, but ordering candidates by their current
--      count of OPEN conversations instead of a rotation cursor. Unlike
--      round-robin, this never mutates `last_assigned_at` — "load" is
--      read straight from `conversations`, not tracked via a cursor —
--      so it stays fully independent of the round-robin rotation state.
--      No FOR UPDATE SKIP LOCKED here either: a race between two
--      concurrent picks can at worst return the same "currently least
--      loaded" agent for both (a minor, temporary skew corrected by the
--      next few assignments), not a correctness bug the way a shared
--      rotation cursor would be.
--   2. `p_online_only` param on all four pickers (round-robin x2 +
--      least-loaded x2) — CREATE OR REPLACE appending a new trailing
--      parameter with a default preserves the existing function OID
--      and grants (Postgres allows this specific case; see CREATE
--      FUNCTION docs), so every existing call site keeps working
--      unchanged and only opts into online-only filtering explicitly.
--      "Online" here means `member_presence.status = 'online'` AND a
--      heartbeat within the last 75 seconds — the same OFFLINE_AFTER_MS
--      threshold src/lib/presence.ts already uses for the presence
--      dots, so "online" here means the same thing it means everywhere
--      else in the app. 'away' counts as NOT online — the point of this
--      filter is "will see this conversation soon", and an idle/hidden-
--      tab agent won't.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION pick_round_robin_agent(
  p_account_id UUID,
  p_min_role account_role_enum DEFAULT 'agent',
  p_online_only BOOLEAN DEFAULT false
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  UPDATE profiles
  SET last_assigned_at = NOW()
  WHERE user_id = (
    SELECT p.user_id
    FROM profiles p
    WHERE p.account_id = p_account_id
      AND (CASE p.account_role
             WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1
           END) >= (CASE p_min_role
             WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1
           END)
      AND (
        NOT p_online_only
        OR EXISTS (
          SELECT 1 FROM member_presence mp
          WHERE mp.user_id = p.user_id
            AND mp.status = 'online'
            AND mp.last_seen_at > NOW() - INTERVAL '75 seconds'
        )
      )
    ORDER BY p.last_assigned_at ASC NULLS FIRST, p.user_id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING user_id INTO v_user_id;

  RETURN v_user_id;
END;
$$;

ALTER FUNCTION pick_round_robin_agent(UUID, account_role_enum, BOOLEAN) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION pick_round_robin_agent(UUID, account_role_enum, BOOLEAN) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION pick_team_round_robin_member(
  p_team_id UUID,
  p_online_only BOOLEAN DEFAULT false
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  UPDATE team_members
  SET last_assigned_at = NOW()
  WHERE id = (
    SELECT tm.id
    FROM team_members tm
    WHERE tm.team_id = p_team_id
      AND (
        NOT p_online_only
        OR EXISTS (
          SELECT 1 FROM member_presence mp
          WHERE mp.user_id = tm.user_id
            AND mp.status = 'online'
            AND mp.last_seen_at > NOW() - INTERVAL '75 seconds'
        )
      )
    ORDER BY tm.last_assigned_at ASC NULLS FIRST, tm.user_id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING user_id INTO v_user_id;

  RETURN v_user_id;
END;
$$;

ALTER FUNCTION pick_team_round_robin_member(UUID, BOOLEAN) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION pick_team_round_robin_member(UUID, BOOLEAN) TO authenticated, service_role;

-- ============================================================
-- pick_least_loaded_agent — account-wide, load-aware
-- ============================================================
CREATE OR REPLACE FUNCTION pick_least_loaded_agent(
  p_account_id UUID,
  p_min_role account_role_enum DEFAULT 'agent',
  p_online_only BOOLEAN DEFAULT false
) RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.user_id
  FROM profiles p
  WHERE p.account_id = p_account_id
    AND (CASE p.account_role
           WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1
         END) >= (CASE p_min_role
           WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1
         END)
    AND (
      NOT p_online_only
      OR EXISTS (
        SELECT 1 FROM member_presence mp
        WHERE mp.user_id = p.user_id
          AND mp.status = 'online'
          AND mp.last_seen_at > NOW() - INTERVAL '75 seconds'
      )
    )
  ORDER BY (
    SELECT COUNT(*) FROM conversations c
    WHERE c.assigned_agent_id = p.user_id AND c.status = 'open'
  ) ASC, p.user_id ASC
  LIMIT 1;
$$;

ALTER FUNCTION pick_least_loaded_agent(UUID, account_role_enum, BOOLEAN) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION pick_least_loaded_agent(UUID, account_role_enum, BOOLEAN) TO authenticated, service_role;

-- ============================================================
-- pick_least_loaded_team_member — per-team, load-aware
-- ============================================================
CREATE OR REPLACE FUNCTION pick_least_loaded_team_member(
  p_team_id UUID,
  p_online_only BOOLEAN DEFAULT false
) RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tm.user_id
  FROM team_members tm
  WHERE tm.team_id = p_team_id
    AND (
      NOT p_online_only
      OR EXISTS (
        SELECT 1 FROM member_presence mp
        WHERE mp.user_id = tm.user_id
          AND mp.status = 'online'
          AND mp.last_seen_at > NOW() - INTERVAL '75 seconds'
      )
    )
  ORDER BY (
    SELECT COUNT(*) FROM conversations c
    WHERE c.assigned_agent_id = tm.user_id AND c.status = 'open'
  ) ASC, tm.user_id ASC
  LIMIT 1;
$$;

ALTER FUNCTION pick_least_loaded_team_member(UUID, BOOLEAN) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION pick_least_loaded_team_member(UUID, BOOLEAN) TO authenticated, service_role;
