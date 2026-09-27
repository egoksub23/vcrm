-- ============================================================
-- Custom account roles — phase 1: schema.
--
-- Today the permission model is exactly 4 fixed roles (owner/admin/
-- agent/viewer, account_role_enum), each with capability toggles that
-- apply account-wide to everyone holding that literal role
-- (role_capabilities, migration 079). An account with a bigger team
-- than that assumes needs named, purpose-built roles — e.g. "an
-- internal-org role that can only access Tickets and Sembang" —
-- assignable to specific people, not "everyone who is an Agent."
--
-- Design: keep account_role_enum exactly as the hierarchy/rank
-- backbone (untouched: is_account_member, role_rank, every existing
-- RLS policy). A custom role is a NAMED CAPABILITY-SET PROFILE PINNED
-- TO ONE OF THE THREE NON-OWNER BASE TIERS, layered on top:
--   * account_roles: one row per custom role, account-scoped, with a
--     base_role (never 'owner' — the singular-owner invariant is
--     unchanged).
--   * account_role_capabilities: identical sparse-diff-from-default
--     shape to role_capabilities, keyed by account_role_id instead of
--     (account_id, role).
--   * profiles.custom_role_id (nullable): when set, the member's
--     account_role STAYS the custom role's base_role (so every
--     existing rank/hierarchy check keeps working with zero changes
--     — a custom-role member is, at the rank level, indistinguishable
--     from a plain member of that base tier) and their CAPABILITIES
--     resolve against the custom role instead of the literal role
--     (that resolution rewrite is migration 113, not here).
--   * account_invitations.custom_role_id (nullable): an invite can
--     carry a custom role the same way.
--
-- Scope decision (confirmed with the user): this ships with the same
-- UI-level restriction every role has today (menus hidden, writes
-- blocked by capability). Most modules' SELECT policies only check
-- plain account membership, not capabilities (Sembang is the one
-- deliberate exception, migrations 098/111) — real read-level data
-- isolation for Tickets or anything else is explicitly out of scope
-- here, to be revisited separately if it turns out to matter.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. account_roles
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_roles (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  base_role  account_role_enum NOT NULL CHECK (base_role IN ('admin', 'agent', 'viewer')),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_roles_account_name_ci
  ON public.account_roles (account_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_account_roles_account ON public.account_roles (account_id);

-- ------------------------------------------------------------
-- 2. account_role_capabilities — same sparse-diff-from-default shape
-- as role_capabilities (079), keyed by account_role_id.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_role_capabilities (
  account_role_id UUID NOT NULL REFERENCES public.account_roles(id) ON DELETE CASCADE,
  capability       TEXT NOT NULL REFERENCES public.capability_catalogue(capability)
                     ON DELETE CASCADE ON UPDATE CASCADE,
  granted          BOOLEAN NOT NULL,
  changed_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_role_id, capability)
);

-- ------------------------------------------------------------
-- 3. role_capability_log grows an optional account_role_id, so the
-- one audit trail covers both literal-role and custom-role edits
-- instead of a parallel log table. `role` stays NOT NULL for a
-- literal-role entry and is set to the custom role's base_role for a
-- custom-role entry (so every existing reader of this table, which
-- only ever looked at `role`, keeps working; account_role_id is
-- purely additive).
-- ------------------------------------------------------------
ALTER TABLE public.role_capability_log
  ADD COLUMN IF NOT EXISTS account_role_id UUID REFERENCES public.account_roles(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_role_capability_log_account_role
  ON public.role_capability_log (account_role_id, at DESC) WHERE account_role_id IS NOT NULL;

-- ------------------------------------------------------------
-- 4. profiles.custom_role_id / account_invitations.custom_role_id
-- ------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS custom_role_id UUID REFERENCES public.account_roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_custom_role ON public.profiles (custom_role_id)
  WHERE custom_role_id IS NOT NULL;

ALTER TABLE public.account_invitations
  ADD COLUMN IF NOT EXISTS custom_role_id UUID REFERENCES public.account_roles(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- 5. RLS — readable by any account member; no direct client write
-- policy (same "revoke ALL, writes only through RPCs" posture
-- role_capabilities already has; migration 114 adds the RPCs).
-- ------------------------------------------------------------
ALTER TABLE public.account_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_role_capabilities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_roles_select ON public.account_roles;
CREATE POLICY account_roles_select ON public.account_roles FOR SELECT USING (
  public.is_account_member(account_id)
);

DROP POLICY IF EXISTS account_role_capabilities_select ON public.account_role_capabilities;
CREATE POLICY account_role_capabilities_select ON public.account_role_capabilities FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.account_roles r
    WHERE r.id = account_role_id AND public.is_account_member(r.account_id)
  )
);

REVOKE ALL ON public.account_roles FROM PUBLIC, anon;
GRANT SELECT ON public.account_roles TO authenticated;
GRANT ALL ON public.account_roles TO service_role;

REVOKE ALL ON public.account_role_capabilities FROM PUBLIC, anon;
GRANT SELECT ON public.account_role_capabilities TO authenticated;
GRANT ALL ON public.account_role_capabilities TO service_role;

-- ------------------------------------------------------------
-- 6. list_team_members(): return-shape change needs DROP FUNCTION
-- first. Adds custom_role_id / custom_role_name (left join); every
-- other column and the query itself is otherwise identical to 083's
-- definition.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_team_members();
CREATE FUNCTION public.list_team_members()
RETURNS TABLE (
  user_id            UUID,
  full_name          TEXT,
  email              TEXT,
  avatar_url         TEXT,
  role               account_role_enum,
  custom_role_id     UUID,
  custom_role_name   TEXT,
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
         p.custom_role_id,
         ar.name,
         p.created_at,
         mp.last_seen_at,
         COALESCE(ta.teams, '[]'::jsonb),
         COALESCE(conv.n, 0),
         COALESCE(tick.n, 0)
    FROM profiles p
    JOIN me ON me.account_id = p.account_id
    LEFT JOIN account_roles ar ON ar.id = p.custom_role_id
    LEFT JOIN team_agg ta ON ta.uid = p.user_id
    LEFT JOIN conv ON conv.uid = p.user_id
    LEFT JOIN tick ON tick.uid = p.user_id
    LEFT JOIN member_presence mp ON mp.user_id = p.user_id
   ORDER BY p.created_at, p.user_id;
$$;

ALTER FUNCTION public.list_team_members() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_team_members() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_team_members() TO authenticated;
