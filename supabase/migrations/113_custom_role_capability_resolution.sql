-- ============================================================
-- Custom account roles — phase 2: capability resolution.
--
-- The only SQL behavior that needs to change for a custom-role member
-- is CAPABILITY RESOLUTION, and it has exactly two chokepoints:
-- has_capability(account, cap) (079) and capability_account_ids(cap)
-- (088 — used by ~30 write policies for query-plan reasons; it
-- independently inlines the same resolution logic, so it needs the
-- identical branch, kept in lockstep with has_capability). Both
-- currently resolve via profiles.account_role against
-- role_capabilities; both now check profiles.custom_role_id first
-- and, when set, resolve against account_role_capabilities for that
-- id instead — same default-anchor (role_capability_defaults for the
-- custom role's base_role) and the same min_grant_role floor check
-- either way.
--
-- No RLS policy that CALLS either function needs to change — every
-- one of those call sites only ever passes (account_id, cap), never
-- the literal role, so this is a two-function edit, not a sweep.
--
-- Depends on: 079 (has_capability, effective_capability), 088
-- (capability_account_ids), 112 (account_roles, custom_role_id).
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. effective_custom_role_capability(account_role_id, cap) — the
-- custom-role mirror of effective_capability(account_id, role, cap).
-- INTERNAL: not callable by clients.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.effective_custom_role_capability(
  p_account_role_id UUID,
  p_cap             TEXT
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM capability_catalogue c WHERE c.capability = p_cap)
      THEN false
    ELSE COALESCE(
      (
        SELECT CASE
                 WHEN arc.granted
                      AND role_rank(ar.base_role) < role_rank(cc.min_grant_role) THEN NULL
                 ELSE arc.granted
               END
        FROM account_role_capabilities arc
        JOIN account_roles ar ON ar.id = arc.account_role_id
        JOIN capability_catalogue cc ON cc.capability = arc.capability
        WHERE arc.account_role_id = p_account_role_id
          AND arc.capability = p_cap
      ),
      EXISTS (
        SELECT 1 FROM role_capability_defaults d
        JOIN account_roles ar ON ar.base_role = d.role
        WHERE ar.id = p_account_role_id AND d.capability = p_cap
      )
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.effective_custom_role_capability(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. has_capability(account, cap) — same signature, branches on
-- custom_role_id before falling back to the literal-role path.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_capability(target_account_id UUID, cap TEXT)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT CASE
               WHEN p.custom_role_id IS NOT NULL
                 THEN effective_custom_role_capability(p.custom_role_id, cap)
               ELSE effective_capability(p.account_id, p.account_role, cap)
             END
      FROM profiles p
      WHERE p.user_id    = auth.uid()
        AND p.account_id = target_account_id
    ),
    false
  );
$$;

-- ------------------------------------------------------------
-- 3. capabilities_for_current_user(account) — same branch.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capabilities_for_current_user(target_account_id UUID)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT array_agg(c.capability ORDER BY c.capability)
      FROM profiles p
      CROSS JOIN capability_catalogue c
      WHERE p.user_id    = auth.uid()
        AND p.account_id = target_account_id
        AND (
          CASE
            WHEN p.custom_role_id IS NOT NULL
              THEN effective_custom_role_capability(p.custom_role_id, c.capability)
            ELSE effective_capability(p.account_id, p.account_role, c.capability)
          END
        )
    ),
    ARRAY[]::text[]
  );
$$;

-- ------------------------------------------------------------
-- 4. capability_account_ids(cap) — 088's independent inline of the
-- same resolution logic (kept as plpgsql/array_agg for its original
-- query-plan reason). The literal-role branch is copied verbatim from
-- 088; only the custom-role branch is new.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capability_account_ids(cap text)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT array_agg(p.account_id) INTO v_ids
    FROM profiles p
    JOIN capability_catalogue cc ON cc.capability = cap
   WHERE p.user_id = auth.uid()
     AND (
       p.account_role = 'owner'
       OR CASE
            WHEN p.custom_role_id IS NOT NULL THEN
              COALESCE(
                (SELECT CASE WHEN arc.granted AND role_rank(ar.base_role) < role_rank(cc.min_grant_role) THEN NULL
                              ELSE arc.granted END
                   FROM account_role_capabilities arc
                   JOIN account_roles ar ON ar.id = arc.account_role_id
                  WHERE arc.account_role_id = p.custom_role_id
                    AND arc.capability = cap),
                EXISTS (
                  SELECT 1 FROM role_capability_defaults d
                  JOIN account_roles ar2 ON ar2.base_role = d.role
                  WHERE ar2.id = p.custom_role_id AND d.capability = cap
                )
              )
            ELSE
              COALESCE(
                (SELECT CASE WHEN rc.granted AND p.account_role > cc.min_grant_role THEN NULL
                             ELSE rc.granted END
                   FROM role_capabilities rc
                  WHERE rc.account_id = p.account_id
                    AND rc.role       = p.account_role
                    AND rc.capability = cap),
                EXISTS (SELECT 1 FROM role_capability_defaults d
                         WHERE d.role = p.account_role AND d.capability = cap)
              )
          END
     );
  RETURN COALESCE(v_ids, ARRAY[]::uuid[]);
END;
$$;
