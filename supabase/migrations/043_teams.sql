-- ============================================================
-- 043_teams
--
-- P0 gap-analysis item: respond.io lets an account group agents into
-- teams (Tech, Compliance, Payments, ...) and route conversations to
-- a team rather than one named agent, with round-robin spreading load
-- across whoever's in it. Nothing in this codebase modelled a team —
-- `assign_conversation`'s round_robin mode was a stub that always
-- picked the same profile (`.limit(1)`, no ordering). This migration
-- adds the team primitives and fixes the stub for real.
--
-- What this adds
--   1. `teams` — one row per group (name, description, color), scoped
--      to an account like every other settings-class table from
--      migration 017.
--   2. `team_members` — join table, one row per (team, user). Carries
--      `last_assigned_at` so round-robin can rotate within a team
--      independently of the account-wide rotation below.
--   3. `profiles.last_assigned_at` — same idea for the *account-wide*
--      round-robin that `assign_conversation` already exposed (mode
--      'round_robin', no team). Reusing one column for both single-
--      agent and per-team rotation would couple two independent
--      rotations together — an agent assigned via a team round-robin
--      would jump the queue (or get skipped) for the next plain
--      round-robin, and vice versa.
--   4. `conversations.assigned_team_id` — which team (if any) owns a
--      conversation, orthogonal to `assigned_agent_id` (which agent is
--      currently working it). A team assignment always resolves to a
--      specific agent at assignment time; the team pointer is kept so
--      the inbox can filter/bucket by team.
--   5. `pick_round_robin_agent` / `pick_team_round_robin_member` —
--      SECURITY DEFINER functions that atomically claim-and-rotate the
--      next agent via `UPDATE ... WHERE pk = (SELECT ... FOR UPDATE
--      SKIP LOCKED LIMIT 1)`. This is the standard Postgres "claim a
--      queue row" pattern: the row lock makes two concurrent callers
--      pick different agents instead of racing to read the same
--      `last_assigned_at` and both picking whoever's oldest.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- TEAMS
-- ============================================================
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  -- Swatch shown on team chips/badges across the inbox and settings.
  -- Free-form hex so the UI palette can grow without a migration.
  color TEXT NOT NULL DEFAULT '#6366f1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_teams_account ON teams(account_id);

-- One team name per account (case-insensitive) — "Tech" and "tech"
-- created five minutes apart is a support ticket, not a feature.
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_account_name
  ON teams(account_id, lower(name));

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON teams;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TEAM_MEMBERS
-- ============================================================
CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Rotation cursor for this team's round-robin. NULL = never assigned
  -- yet, sorts first (ORDER BY ... NULLS FIRST) so a newly-added member
  -- gets the very next conversation rather than waiting a full lap.
  last_assigned_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_unique ON team_members(team_id, user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
-- The round-robin claim query orders by (team_id, last_assigned_at) —
-- give it an index to walk instead of a sort.
CREATE INDEX IF NOT EXISTS idx_team_members_rotation ON team_members(team_id, last_assigned_at);

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- profiles.last_assigned_at — account-wide round-robin cursor
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_assigned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_profiles_rotation ON profiles(account_id, last_assigned_at);

-- ============================================================
-- conversations.assigned_team_id
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS assigned_team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_assigned_team ON conversations(assigned_team_id);

-- ============================================================
-- RLS — teams / team_members
--
-- Settings-class tiering, same split as tags/pipelines/whatsapp_config
-- in migration 017: every member can read (the inbox needs team names
-- + colors to render chips for viewers/agents too), only admin+ can
-- write.
-- ============================================================
DROP POLICY IF EXISTS teams_select ON teams;
DROP POLICY IF EXISTS teams_insert ON teams;
DROP POLICY IF EXISTS teams_update ON teams;
DROP POLICY IF EXISTS teams_delete ON teams;
CREATE POLICY teams_select ON teams FOR SELECT USING (is_account_member(account_id));
CREATE POLICY teams_insert ON teams FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY teams_update ON teams FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY teams_delete ON teams FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS team_members_select ON team_members;
DROP POLICY IF EXISTS team_members_modify ON team_members;
CREATE POLICY team_members_select ON team_members FOR SELECT USING (
  EXISTS (SELECT 1 FROM teams tm WHERE tm.id = team_members.team_id AND is_account_member(tm.account_id))
);
CREATE POLICY team_members_modify ON team_members FOR ALL USING (
  EXISTS (SELECT 1 FROM teams tm WHERE tm.id = team_members.team_id AND is_account_member(tm.account_id, 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM teams tm WHERE tm.id = team_members.team_id AND is_account_member(tm.account_id, 'admin'))
);

-- ============================================================
-- pick_round_robin_agent — account-wide rotation
--
-- Claims the agent+ profile in `p_account_id` with the oldest (or
-- NULL) `last_assigned_at`, stamps it to NOW(), and returns its
-- user_id. `FOR UPDATE SKIP LOCKED` makes concurrent callers fan out
-- to different rows instead of both reading the same "oldest" and
-- assigning the same agent twice.
-- ============================================================
CREATE OR REPLACE FUNCTION pick_round_robin_agent(
  p_account_id UUID,
  p_min_role account_role_enum DEFAULT 'agent'
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
    ORDER BY p.last_assigned_at ASC NULLS FIRST, p.user_id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING user_id INTO v_user_id;

  RETURN v_user_id;
END;
$$;

ALTER FUNCTION pick_round_robin_agent(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION pick_round_robin_agent(UUID, account_role_enum) TO authenticated, service_role;

-- ============================================================
-- pick_team_round_robin_member — per-team rotation
-- ============================================================
CREATE OR REPLACE FUNCTION pick_team_round_robin_member(
  p_team_id UUID
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
    ORDER BY tm.last_assigned_at ASC NULLS FIRST, tm.user_id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING user_id INTO v_user_id;

  RETURN v_user_id;
END;
$$;

ALTER FUNCTION pick_team_round_robin_member(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION pick_team_round_robin_member(UUID) TO authenticated, service_role;
