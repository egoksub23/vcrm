-- ============================================================
-- 191_addon_roles.sql
--
-- Add-on roles: a person has ONE base role, as now (Owner / Admin / Agent / Viewer, and the custom role they may already hold), and may be given any
-- number of ADD-ON roles on top. An add-on role is a named set of extra permissions (for example "KYC reviewer": menu.kyc, kyc.view, kyc.decide). What a
-- person can do is their base role's permissions PLUS every add-on's. Add-only: no add-on ever takes a permission away.
--
-- Rules, all enforced here in the database:
--   * the base role stays the rank backbone (who can change whom, every existing row-level policy): an add-on never changes a person's rank;
--   * an add-on cannot lift a person above what their base tier allows: a permission is effective only when the base tier is at least that
--     permission's minimum grant role (the same floor a custom role has, `capability_catalogue.min_grant_role`), so a Viewer never writes data;
--   * nobody can hand out more than they hold: a permission may be put in an add-on, and an add-on given to someone, only by a person who holds every
--     permission involved (the rule set_account_role_capabilities already applies);
--   * making and editing add-ons needs `roles.manage`; giving them to a member needs `members.change-role`, an admin rank, and a target strictly
--     below the caller; never to the owner (who holds everything), never to oneself;
--   * every change is in the audit trail.
--
-- ONE function, person_has_capability(account, user, capability), now answers "does this person hold it" (base role, custom role or add-on). has_capability,
-- capabilities_for_current_user, capability_account_ids (the three the row-level policies and the app use), compliance_user_can, and the three functions
-- that decide who is notified (approvals, a raised incident, an incident escalation) all use it, so a permission means the same everywhere.
-- Not changed, and said here so nobody assumes otherwise: the ticket SLA alert (086) goes to owners and admins by design, and the knowledge-draft counts
-- (084, 088) still read a person's base role only.
--
-- An invitation may carry add-on roles (account_invitations.addon_role_ids, like team_ids); they are given when it is accepted (attach_user_to_invited_account).
-- A member who leaves the workspace loses theirs (a trigger on profiles.account_id).
--
-- Idempotent. Apply BEFORE the code that reads these tables is deployed.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The tables. Readable by any member of the workspace; written only by the functions below.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_addon_roles (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 300),
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_addon_roles_account_name_ci
  ON public.account_addon_roles (account_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_account_addon_roles_account ON public.account_addon_roles (account_id);

CREATE TABLE IF NOT EXISTS public.account_addon_role_capabilities (
  addon_role_id UUID NOT NULL REFERENCES public.account_addon_roles(id) ON DELETE CASCADE,
  capability    TEXT NOT NULL REFERENCES public.capability_catalogue(capability) ON DELETE CASCADE ON UPDATE CASCADE,
  granted_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (addon_role_id, capability)
);
CREATE INDEX IF NOT EXISTS idx_addon_role_capabilities_capability ON public.account_addon_role_capabilities (capability);

CREATE TABLE IF NOT EXISTS public.member_addon_roles (
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  addon_role_id UUID NOT NULL REFERENCES public.account_addon_roles(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  assigned_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, addon_role_id)
);
CREATE INDEX IF NOT EXISTS idx_member_addon_roles_account_user ON public.member_addon_roles (account_id, user_id);
CREATE INDEX IF NOT EXISTS idx_member_addon_roles_role ON public.member_addon_roles (addon_role_id);

ALTER TABLE public.account_addon_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_addon_role_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_addon_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_addon_roles_select ON public.account_addon_roles;
CREATE POLICY account_addon_roles_select ON public.account_addon_roles FOR SELECT USING (public.is_account_member(account_id));

DROP POLICY IF EXISTS account_addon_role_capabilities_select ON public.account_addon_role_capabilities;
CREATE POLICY account_addon_role_capabilities_select ON public.account_addon_role_capabilities FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.account_addon_roles r WHERE r.id = addon_role_id AND public.is_account_member(r.account_id))
);

DROP POLICY IF EXISTS member_addon_roles_select ON public.member_addon_roles;
CREATE POLICY member_addon_roles_select ON public.member_addon_roles FOR SELECT USING (public.is_account_member(account_id));

REVOKE ALL ON public.account_addon_roles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.account_addon_role_capabilities FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.member_addon_roles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_addon_roles TO authenticated;
GRANT SELECT ON public.account_addon_role_capabilities TO authenticated;
GRANT SELECT ON public.member_addon_roles TO authenticated;
GRANT ALL ON public.account_addon_roles TO service_role;
GRANT ALL ON public.account_addon_role_capabilities TO service_role;
GRANT ALL ON public.member_addon_roles TO service_role;

ALTER TABLE public.account_invitations
  ADD COLUMN IF NOT EXISTS addon_role_ids UUID[] NOT NULL DEFAULT '{}';

-- ------------------------------------------------------------
-- 2. The one question: does this person hold this permission?
-- ------------------------------------------------------------
-- An add-on grants it when the person's base tier is high enough for it (never lifts a Viewer to a write permission). INTERNAL: not callable by clients.
CREATE OR REPLACE FUNCTION public.addon_grants_capability(p_account UUID, p_user UUID, p_cap TEXT)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM profiles p
      JOIN member_addon_roles m ON m.user_id = p.user_id AND m.account_id = p.account_id
      JOIN account_addon_role_capabilities ac ON ac.addon_role_id = m.addon_role_id AND ac.capability = p_cap
      JOIN capability_catalogue cc ON cc.capability = ac.capability
     WHERE p.user_id = p_user
       AND p.account_id = p_account
       AND role_rank(p.account_role) >= role_rank(cc.min_grant_role)
  );
$$;
ALTER FUNCTION public.addon_grants_capability(UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.addon_grants_capability(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.addon_grants_capability(UUID, UUID, TEXT) TO service_role;

-- The base role (or custom role) as before, OR an add-on. INTERNAL: not callable by clients (has_capability is the client-facing one, for the caller).
CREATE OR REPLACE FUNCTION public.person_has_capability(p_account UUID, p_user UUID, p_cap TEXT)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
           (SELECT CASE
                     WHEN p.custom_role_id IS NOT NULL THEN effective_custom_role_capability(p.custom_role_id, p_cap)
                     ELSE effective_capability(p.account_id, p.account_role, p_cap)
                   END
              FROM profiles p
             WHERE p.user_id = p_user AND p.account_id = p_account),
           false)
         OR public.addon_grants_capability(p_account, p_user, p_cap);
$$;
ALTER FUNCTION public.person_has_capability(UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.person_has_capability(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.person_has_capability(UUID, UUID, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 3. The three functions the policies and the app call, and Compliance's. Same signatures, same grants (CREATE OR REPLACE keeps them).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_capability(target_account_id UUID, cap TEXT)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.person_has_capability(target_account_id, auth.uid(), cap);
$$;

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
          COALESCE(
            CASE
              WHEN p.custom_role_id IS NOT NULL
                THEN effective_custom_role_capability(p.custom_role_id, c.capability)
              ELSE effective_capability(p.account_id, p.account_role, c.capability)
            END,
            false)
          OR public.addon_grants_capability(p.account_id, p.user_id, c.capability)
        )
    ),
    ARRAY[]::text[]
  );
$$;

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
       OR COALESCE(CASE
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
          END, false)
       -- an add-on role of this person's grants it (191), as long as their base tier is high enough for the capability
       OR EXISTS (
            SELECT 1
              FROM member_addon_roles m
              JOIN account_addon_role_capabilities ac ON ac.addon_role_id = m.addon_role_id AND ac.capability = cap
             WHERE m.user_id = p.user_id
               AND m.account_id = p.account_id
               AND role_rank(p.account_role) >= role_rank(cc.min_grant_role)
          )
     );
  RETURN COALESCE(v_ids, ARRAY[]::uuid[]);
END;
$$;

CREATE OR REPLACE FUNCTION public.compliance_user_can(p_account UUID, p_user UUID, p_cap TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.person_has_capability(p_account, p_user, p_cap);
$$;

-- ------------------------------------------------------------
-- 4. Who is notified: the same resolution, so an add-on that grants approvals.review or incidents.manage is told too.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approvals_notify_reviewers(
  p_account uuid, p_actor uuid, p_title text, p_body text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO notifications (account_id, user_id, type, actor_user_id, title, body)
  SELECT p.account_id, p.user_id, 'approval_requested', p_actor,
         left(p_title, 200), left(p_body, 500)
    FROM profiles p
   WHERE p.account_id = p_account
     AND p.user_id IS DISTINCT FROM p_actor
     AND public.person_has_capability(p.account_id, p.user_id, 'approvals.review');
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'approvals_notify_reviewers failed: %', SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_incident_raised()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
  v_reporter_name TEXT;
  v_recipient UUID;
  v_any BOOLEAN := false;
BEGIN
  v_key := 'INC-' || to_char(NEW.created_at, 'YYYY') || '-' || NEW.incident_number;

  SELECT full_name INTO v_reporter_name FROM profiles WHERE user_id = NEW.reporter_id;

  IF NEW.incident_lead_id IS NOT NULL THEN
    INSERT INTO notifications (account_id, user_id, type, incident_id, actor_user_id, title, body)
    VALUES (
      NEW.account_id, NEW.incident_lead_id, 'incident_raised', NEW.id, NEW.reporter_id,
      'New incident: ' || v_key,
      COALESCE(v_reporter_name, 'Someone') || ' raised ' || v_key || ' (' || NEW.severity || ') — ' || NEW.title
    );
    v_any := true;
  ELSE
    FOR v_recipient IN
      SELECT p.user_id FROM profiles p
       WHERE p.account_id = NEW.account_id
         AND p.account_role = 'agent'
         AND public.person_has_capability(p.account_id, p.user_id, 'incidents.manage')
    LOOP
      INSERT INTO notifications (account_id, user_id, type, incident_id, actor_user_id, title, body)
      VALUES (
        NEW.account_id, v_recipient, 'incident_raised', NEW.id, NEW.reporter_id,
        'New incident: ' || v_key,
        COALESCE(v_reporter_name, 'Someone') || ' raised ' || v_key || ' (' || NEW.severity || ') — ' || NEW.title
      );
      v_any := true;
    END LOOP;
  END IF;

  -- No Compliance Officer configured yet: fall back to every Admin/Owner
  -- so a P1 report is never silently unseen.
  IF NOT v_any THEN
    FOR v_recipient IN
      SELECT p.user_id FROM profiles p
       WHERE p.account_id = NEW.account_id AND p.account_role IN ('admin', 'owner')
    LOOP
      INSERT INTO notifications (account_id, user_id, type, incident_id, actor_user_id, title, body)
      VALUES (
        NEW.account_id, v_recipient, 'incident_raised', NEW.id, NEW.reporter_id,
        'New incident: ' || v_key,
        COALESCE(v_reporter_name, 'Someone') || ' raised ' || v_key || ' (' || NEW.severity || ') — ' || NEW.title
      );
    END LOOP;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to notify on incident raised for incident %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.notify_incident_raised() OWNER TO postgres;ALTER FUNCTION public.notify_incident_raised() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.incident_escalation_recipient_ids(p_account_id UUID, p_level INTEGER)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT user_id FROM public.incident_escalation_recipients
   WHERE account_id = p_account_id AND level = p_level
  UNION
  SELECT p.user_id FROM public.profiles p
   WHERE p.account_id = p_account_id
     AND NOT EXISTS (
       SELECT 1 FROM public.incident_escalation_recipients r
        WHERE r.account_id = p_account_id AND r.level = p_level
     )
     AND (
       p.account_role IN ('admin', 'owner')
       OR public.person_has_capability(p.account_id, p.user_id, 'incidents.manage')
     );
$$;
ALTER FUNCTION public.incident_escalation_recipient_ids(UUID, INTEGER) OWNER TO postgres;

-- ------------------------------------------------------------
-- 5. A member who leaves the workspace loses their add-ons there. (Removing someone moves their profile to a new personal workspace.)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.member_addon_roles_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.member_addon_roles WHERE user_id = NEW.user_id AND account_id <> NEW.account_id;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.member_addon_roles_cleanup() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.member_addon_roles_cleanup() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS member_addon_roles_cleanup ON public.profiles;
CREATE TRIGGER member_addon_roles_cleanup
  AFTER UPDATE OF account_id ON public.profiles
  FOR EACH ROW WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id)
  EXECUTE FUNCTION public.member_addon_roles_cleanup();

-- ------------------------------------------------------------
-- 6. Making, editing and deleting add-on roles (roles.manage).
-- ------------------------------------------------------------
-- A permission goes into an add-on only if the caller holds it themselves (nobody hands out more than they have).
CREATE OR REPLACE FUNCTION public.create_addon_role(
  p_account_id   UUID,
  p_name         TEXT,
  p_description  TEXT,
  p_capabilities TEXT[]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_account UUID;
  v_name    TEXT := btrim(COALESCE(p_name, ''));
  v_desc    TEXT := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_id      UUID;
  v_cap     TEXT;
  v_caps    TEXT[] := ARRAY(SELECT DISTINCT c FROM unnest(COALESCE(p_capabilities, ARRAY[]::TEXT[])) AS c);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT account_id INTO v_account FROM profiles WHERE user_id = v_uid;
  IF v_account IS NULL OR v_account <> p_account_id THEN
    RAISE EXCEPTION 'You are not a member of this account' USING ERRCODE = '42501';
  END IF;
  IF NOT has_capability(p_account_id, 'roles.manage') THEN
    RAISE EXCEPTION 'This action requires the ''roles.manage'' permission' USING ERRCODE = '42501';
  END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'Give the role a name' USING ERRCODE = '22023'; END IF;
  IF char_length(v_name) > 80 THEN RAISE EXCEPTION 'The name is too long (80 characters at most)' USING ERRCODE = '22023'; END IF;
  IF v_desc IS NOT NULL AND char_length(v_desc) > 300 THEN RAISE EXCEPTION 'The description is too long (300 characters at most)' USING ERRCODE = '22023'; END IF;

  FOREACH v_cap IN ARRAY v_caps LOOP
    IF NOT EXISTS (SELECT 1 FROM capability_catalogue WHERE capability = v_cap) THEN
      RAISE EXCEPTION 'Unknown capability: %', v_cap USING ERRCODE = '22023';
    END IF;
    IF NOT has_capability(p_account_id, v_cap) THEN
      RAISE EXCEPTION 'You cannot grant ''%'' because you do not hold it yourself', v_cap USING ERRCODE = '42501';
    END IF;
  END LOOP;

  INSERT INTO account_addon_roles (account_id, name, description, created_by)
  VALUES (p_account_id, v_name, v_desc, v_uid)
  RETURNING id INTO v_id;

  INSERT INTO account_addon_role_capabilities (addon_role_id, capability, granted_by)
  SELECT v_id, c, v_uid FROM unnest(v_caps) AS c;

  PERFORM public.log_audit(p_account_id, 'created', 'role', v_id, v_name,
    jsonb_build_object('kind', 'add-on', 'capabilities', to_jsonb(v_caps)), v_uid);
  RETURN v_id;
END;
$$;
ALTER FUNCTION public.create_addon_role(UUID, TEXT, TEXT, TEXT[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_addon_role(UUID, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_addon_role(UUID, TEXT, TEXT, TEXT[]) TO authenticated;

-- NULL leaves a field as it is; capabilities, when given, is the WHOLE new set (what is added needs holding, what is removed does not).
CREATE OR REPLACE FUNCTION public.update_addon_role(
  p_addon_role_id UUID,
  p_name          TEXT,
  p_description   TEXT,
  p_capabilities  TEXT[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_caller  UUID;
  v_role    account_addon_roles%ROWTYPE;
  v_name    TEXT;
  v_desc    TEXT;
  v_new     TEXT[];
  v_old     TEXT[];
  v_added   TEXT[];
  v_removed TEXT[];
  v_cap     TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_role FROM account_addon_roles WHERE id = p_addon_role_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role not found' USING ERRCODE = '22023'; END IF;
  SELECT account_id INTO v_caller FROM profiles WHERE user_id = v_uid;
  IF v_caller IS NULL OR v_caller <> v_role.account_id THEN
    RAISE EXCEPTION 'You are not a member of this account' USING ERRCODE = '42501';
  END IF;
  IF NOT has_capability(v_role.account_id, 'roles.manage') THEN
    RAISE EXCEPTION 'This action requires the ''roles.manage'' permission' USING ERRCODE = '42501';
  END IF;

  v_name := CASE WHEN p_name IS NULL THEN v_role.name ELSE btrim(p_name) END;
  IF v_name = '' THEN RAISE EXCEPTION 'Give the role a name' USING ERRCODE = '22023'; END IF;
  IF char_length(v_name) > 80 THEN RAISE EXCEPTION 'The name is too long (80 characters at most)' USING ERRCODE = '22023'; END IF;
  v_desc := CASE WHEN p_description IS NULL THEN v_role.description ELSE NULLIF(btrim(p_description), '') END;
  IF v_desc IS NOT NULL AND char_length(v_desc) > 300 THEN RAISE EXCEPTION 'The description is too long (300 characters at most)' USING ERRCODE = '22023'; END IF;

  v_added := ARRAY[]::TEXT[];
  v_removed := ARRAY[]::TEXT[];
  IF p_capabilities IS NOT NULL THEN
    v_new := ARRAY(SELECT DISTINCT c FROM unnest(p_capabilities) AS c);
    v_old := ARRAY(SELECT capability FROM account_addon_role_capabilities WHERE addon_role_id = p_addon_role_id);
    v_added := ARRAY(SELECT c FROM unnest(v_new) AS c WHERE NOT (c = ANY (v_old)));
    v_removed := ARRAY(SELECT c FROM unnest(v_old) AS c WHERE NOT (c = ANY (v_new)));
    FOREACH v_cap IN ARRAY v_added LOOP
      IF NOT EXISTS (SELECT 1 FROM capability_catalogue WHERE capability = v_cap) THEN
        RAISE EXCEPTION 'Unknown capability: %', v_cap USING ERRCODE = '22023';
      END IF;
      IF NOT has_capability(v_role.account_id, v_cap) THEN
        RAISE EXCEPTION 'You cannot grant ''%'' because you do not hold it yourself', v_cap USING ERRCODE = '42501';
      END IF;
    END LOOP;
    DELETE FROM account_addon_role_capabilities WHERE addon_role_id = p_addon_role_id AND capability = ANY (v_removed);
    INSERT INTO account_addon_role_capabilities (addon_role_id, capability, granted_by)
    SELECT p_addon_role_id, c, v_uid FROM unnest(v_added) AS c;
  END IF;

  IF v_name IS DISTINCT FROM v_role.name OR v_desc IS DISTINCT FROM v_role.description THEN
    UPDATE account_addon_roles SET name = v_name, description = v_desc, updated_at = NOW() WHERE id = p_addon_role_id;
    PERFORM public.log_audit(v_role.account_id, 'updated', 'role', p_addon_role_id, v_name,
      jsonb_build_object('kind', 'add-on', 'was', v_role.name), v_uid);
  ELSIF cardinality(v_added) + cardinality(v_removed) > 0 THEN
    UPDATE account_addon_roles SET updated_at = NOW() WHERE id = p_addon_role_id;
  END IF;
  IF cardinality(v_added) + cardinality(v_removed) > 0 THEN
    PERFORM public.log_audit(v_role.account_id, 'capability_changed', 'role', p_addon_role_id, v_name,
      jsonb_build_object('kind', 'add-on', 'added', to_jsonb(v_added), 'removed', to_jsonb(v_removed)), v_uid);
  END IF;
  RETURN jsonb_build_object('added', cardinality(v_added), 'removed', cardinality(v_removed));
END;
$$;
ALTER FUNCTION public.update_addon_role(UUID, TEXT, TEXT, TEXT[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_addon_role(UUID, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_addon_role(UUID, TEXT, TEXT, TEXT[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_addon_role(p_addon_role_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_caller UUID;
  v_role   account_addon_roles%ROWTYPE;
  v_n      INTEGER;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_role FROM account_addon_roles WHERE id = p_addon_role_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role not found' USING ERRCODE = '22023'; END IF;
  SELECT account_id INTO v_caller FROM profiles WHERE user_id = v_uid;
  IF v_caller IS NULL OR v_caller <> v_role.account_id THEN
    RAISE EXCEPTION 'You are not a member of this account' USING ERRCODE = '42501';
  END IF;
  IF NOT has_capability(v_role.account_id, 'roles.manage') THEN
    RAISE EXCEPTION 'This action requires the ''roles.manage'' permission' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_n FROM member_addon_roles WHERE addon_role_id = p_addon_role_id;
  DELETE FROM account_addon_roles WHERE id = p_addon_role_id;
  -- an invitation still carrying it simply loses it when accepted (attach_user_to_invited_account only gives roles that still exist)
  PERFORM public.log_audit(v_role.account_id, 'deleted', 'role', p_addon_role_id, v_role.name,
    jsonb_build_object('kind', 'add-on', 'members', v_n), v_uid);
  RETURN jsonb_build_object('members', v_n);
END;
$$;
ALTER FUNCTION public.delete_addon_role(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_addon_role(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_addon_role(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 7. Giving a member their add-on roles (members.change-role). The WHOLE set for that person: what is added needs the caller to hold every permission
-- in it; what is taken away does not.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_addon_roles(p_user_id UUID, p_addon_role_ids UUID[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_acct        UUID;
  v_caller_role account_role_enum;
  v_t_acct      UUID;
  v_t_role      account_role_enum;
  v_t_name      TEXT;
  v_ids         UUID[] := ARRAY(SELECT DISTINCT i FROM unnest(COALESCE(p_addon_role_ids, ARRAY[]::UUID[])) AS i);
  v_have        UUID[];
  v_added       UUID[];
  v_removed     UUID[];
  v_id          UUID;
  v_cap         TEXT;
  v_role_name   TEXT;
  v_added_names TEXT[];
  v_removed_names TEXT[];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT account_id, account_role INTO v_acct, v_caller_role FROM profiles WHERE user_id = v_uid;
  IF v_acct IS NULL THEN RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501'; END IF;
  IF v_caller_role NOT IN ('owner', 'admin') OR NOT has_capability(v_acct, 'members.change-role') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = v_uid THEN RAISE EXCEPTION 'Cannot change your own roles' USING ERRCODE = '22023'; END IF;
  IF cardinality(v_ids) > 50 THEN RAISE EXCEPTION 'Too many add-on roles for one person (50 at most)' USING ERRCODE = '22023'; END IF;

  SELECT account_id, account_role, COALESCE(NULLIF(btrim(full_name), ''), email, '') INTO v_t_acct, v_t_role, v_t_name
    FROM profiles WHERE user_id = p_user_id;
  IF v_t_acct IS NULL THEN RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023'; END IF;
  IF v_t_acct <> v_acct THEN RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501'; END IF;
  IF v_t_role = 'owner' THEN RAISE EXCEPTION 'The account owner already holds every permission' USING ERRCODE = '22023'; END IF;
  IF role_rank(v_t_role) >= role_rank(v_caller_role) THEN
    RAISE EXCEPTION 'You can only change members whose role is below your own' USING ERRCODE = '42501';
  END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM account_addon_roles WHERE id = v_id AND account_id = v_acct) THEN
      RAISE EXCEPTION 'Role not found' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('member_addon_roles:' || p_user_id::text, 0));
  v_have := ARRAY(SELECT addon_role_id FROM member_addon_roles WHERE user_id = p_user_id AND account_id = v_acct);
  v_added := ARRAY(SELECT i FROM unnest(v_ids) AS i WHERE NOT (i = ANY (v_have)));
  v_removed := ARRAY(SELECT i FROM unnest(v_have) AS i WHERE NOT (i = ANY (v_ids)));

  FOREACH v_id IN ARRAY v_added LOOP
    FOR v_cap IN SELECT capability FROM account_addon_role_capabilities WHERE addon_role_id = v_id LOOP
      IF NOT has_capability(v_acct, v_cap) THEN
        SELECT name INTO v_role_name FROM account_addon_roles WHERE id = v_id;
        RAISE EXCEPTION 'You cannot give ''%'' because it includes ''%'', which you do not hold yourself', v_role_name, v_cap
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END LOOP;

  DELETE FROM member_addon_roles WHERE user_id = p_user_id AND account_id = v_acct AND addon_role_id = ANY (v_removed);
  INSERT INTO member_addon_roles (user_id, addon_role_id, account_id, assigned_by)
  SELECT p_user_id, i, v_acct, v_uid FROM unnest(v_added) AS i;

  IF cardinality(v_added) + cardinality(v_removed) > 0 THEN
    v_added_names := ARRAY(SELECT name FROM account_addon_roles WHERE id = ANY (v_added) ORDER BY name);
    v_removed_names := ARRAY(SELECT name FROM account_addon_roles WHERE id = ANY (v_removed) ORDER BY name);
    PERFORM public.log_audit(v_acct, 'role_changed', 'member', p_user_id, v_t_name,
      jsonb_build_object('kind', 'add-on', 'added', to_jsonb(v_added_names), 'removed', to_jsonb(v_removed_names)), v_uid);
  END IF;
  RETURN jsonb_build_object('added', cardinality(v_added), 'removed', cardinality(v_removed));
END;
$$;
ALTER FUNCTION public.set_member_addon_roles(UUID, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_addon_roles(UUID, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_addon_roles(UUID, UUID[]) TO authenticated;

-- ------------------------------------------------------------
-- 8. An invitation may carry add-on roles: they must be this workspace's, and the inviter must hold every permission in them.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_invitation_addons()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id  UUID;
  v_cap TEXT;
BEGIN
  IF cardinality(NEW.addon_role_ids) = 0 THEN RETURN NEW; END IF;
  IF cardinality(NEW.addon_role_ids) > 50 THEN
    RAISE EXCEPTION 'Too many add-on roles for one invitation (50 at most)' USING ERRCODE = '22023';
  END IF;
  FOREACH v_id IN ARRAY NEW.addon_role_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM account_addon_roles WHERE id = v_id AND account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'Role not found' USING ERRCODE = '22023';
    END IF;
    IF auth.uid() IS NOT NULL THEN
      FOR v_cap IN SELECT capability FROM account_addon_role_capabilities WHERE addon_role_id = v_id LOOP
        IF NOT public.person_has_capability(NEW.account_id, auth.uid(), v_cap) THEN
          RAISE EXCEPTION 'You cannot invite with an add-on role that includes ''%'', which you do not hold yourself', v_cap USING ERRCODE = '42501';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enforce_invitation_addons() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_invitation_addons() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS enforce_invitation_addons ON public.account_invitations;
CREATE TRIGGER enforce_invitation_addons
  BEFORE INSERT OR UPDATE OF addon_role_ids, account_id ON public.account_invitations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_invitation_addons();

-- ------------------------------------------------------------
-- 9. Accepting an invitation gives its add-on roles (190's function, with that one addition).
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

  -- The add-on roles the invitation carried (191): only ones that still exist in the inviter's workspace, recorded as given by whoever invited.
  IF cardinality(v_inv.addon_role_ids) > 0 THEN
    INSERT INTO member_addon_roles (user_id, addon_role_id, account_id, assigned_by)
    SELECT p_user_id, r.id, v_inv.account_id, v_inv.created_by_user_id
      FROM account_addon_roles r
     WHERE r.account_id = v_inv.account_id
       AND r.id = ANY (v_inv.addon_role_ids)
    ON CONFLICT (user_id, addon_role_id) DO NOTHING;
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
