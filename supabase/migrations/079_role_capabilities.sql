-- ============================================================
-- 079_role_capabilities.sql — Editable role capabilities (phase 1)
--
-- Keeps the four roles (owner / admin / agent / viewer) and lets an
-- Owner or Admin switch menus and capabilities on or off PER ROLE.
-- Defaults reproduce today's behaviour exactly: nothing changes until
-- someone edits the matrix.
--
-- What this migration does
--   1. capability_catalogue          — every capability key, the lowest
--                                      role it can be granted to
--                                      (min_grant_role) and where it is
--                                      enforced. Mirrors
--                                      src/lib/auth/capabilities.ts (a
--                                      test fails if they disagree).
--   2. role_capability_defaults      — the default set per role.
--   3. role_capabilities             — sparse per-account overrides.
--   4. role_capability_log           — append-only history of changes.
--   5. has_capability(account, cap)  — SECURITY DEFINER, STABLE. Owner =>
--                                      true, else override ?? default.
--                                      Unknown capability => false.
--   6. capabilities_for_current_user — the caller's effective set.
--   7. set_role_capabilities(...)    — the ONLY write path. All the
--                                      guardrails live inside it.
--   8. Database-tier RLS: write policies (and the two admin-only SELECT
--      policies) on the channel configs + message_templates
--      (channels.manage), ai_configs / ai_connections / ai_task_routing
--      / ai_usage_log (ai.configure) and api_keys / webhook_endpoints
--      (api.manage) now call has_capability(). Everything else keeps
--      is_account_member() until phase 5. Storage buckets untouched.
--   9. Member rules: set_member_role / remove_account_member may only
--      act on members strictly below the caller (and set roles strictly
--      below the caller); an invitation may only be issued for a role
--      strictly below the inviter's own (trigger, so it also holds for
--      direct inserts).
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.role_rank(r account_role_enum)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE r
    WHEN 'owner'  THEN 4
    WHEN 'admin'  THEN 3
    WHEN 'agent'  THEN 2
    WHEN 'viewer' THEN 1
  END;
$$;

-- ------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.capability_catalogue (
  capability     TEXT PRIMARY KEY,
  min_grant_role account_role_enum NOT NULL,
  enforced_by    TEXT NOT NULL CHECK (enforced_by IN ('database', 'app'))
);

CREATE TABLE IF NOT EXISTS public.role_capability_defaults (
  role       account_role_enum NOT NULL,
  capability TEXT NOT NULL REFERENCES public.capability_catalogue(capability)
               ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (role, capability)
);

CREATE TABLE IF NOT EXISTS public.role_capabilities (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  role       account_role_enum NOT NULL CHECK (role <> 'owner'),
  capability TEXT NOT NULL REFERENCES public.capability_catalogue(capability)
               ON DELETE CASCADE ON UPDATE CASCADE,
  granted    BOOLEAN NOT NULL,
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, role, capability)
);

-- No FK on account_id: the log is append-only and must survive (and
-- never block) an account deletion.
CREATE TABLE IF NOT EXISTS public.role_capability_log (
  id          BIGSERIAL PRIMARY KEY,
  account_id  UUID NOT NULL,
  role        account_role_enum NOT NULL,
  capability  TEXT NOT NULL,
  old_granted BOOLEAN NOT NULL,
  new_granted BOOLEAN NOT NULL,
  actor       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_role_capability_log_account_at
  ON public.role_capability_log (account_id, at DESC);

-- Append-only: nobody (service role included) updates or deletes a row.
CREATE OR REPLACE FUNCTION public.role_capability_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'role_capability_log is append-only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS role_capability_log_no_change ON public.role_capability_log;
CREATE TRIGGER role_capability_log_no_change
  BEFORE UPDATE OR DELETE ON public.role_capability_log
  FOR EACH ROW EXECUTE FUNCTION public.role_capability_log_append_only();

DROP TRIGGER IF EXISTS role_capability_log_no_truncate ON public.role_capability_log;
CREATE TRIGGER role_capability_log_no_truncate
  BEFORE TRUNCATE ON public.role_capability_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.role_capability_log_append_only();

-- ------------------------------------------------------------
-- Seed: catalogue + defaults (regenerated from the TS catalogue)
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('menu.dashboard', 'viewer', 'app'),
  ('menu.inbox', 'viewer', 'app'),
  ('menu.notifications', 'viewer', 'app'),
  ('menu.contacts', 'viewer', 'app'),
  ('menu.pipelines', 'viewer', 'app'),
  ('menu.broadcasts', 'viewer', 'app'),
  ('menu.tickets', 'viewer', 'app'),
  ('menu.automations', 'viewer', 'app'),
  ('menu.flows', 'viewer', 'app'),
  ('menu.knowledge', 'viewer', 'app'),
  ('menu.agents', 'viewer', 'app'),
  ('menu.reports', 'viewer', 'app'),
  ('menu.settings', 'viewer', 'app'),
  ('messages.send', 'agent', 'app'),
  ('conversations.manage', 'agent', 'app'),
  ('comments.moderate', 'agent', 'app'),
  ('comments.delete', 'agent', 'app'),
  ('inbox.shared-views', 'admin', 'app'),
  ('contacts.edit', 'agent', 'app'),
  ('contacts.merge', 'agent', 'app'),
  ('deals.manage', 'agent', 'app'),
  ('pipelines.configure', 'admin', 'app'),
  ('broadcasts.send', 'agent', 'app'),
  ('automations.manage', 'agent', 'app'),
  ('flows.manage', 'agent', 'app'),
  ('tickets.work', 'agent', 'app'),
  ('tickets.delete', 'admin', 'app'),
  ('tickets.configure-form', 'admin', 'app'),
  ('tags.manage', 'admin', 'app'),
  ('snippets.manage', 'agent', 'app'),
  ('knowledge.draft', 'agent', 'app'),
  ('knowledge.publish', 'admin', 'app'),
  ('knowledge.manage', 'admin', 'app'),
  ('ai.use', 'agent', 'app'),
  ('ai.configure', 'agent', 'database'),
  ('channels.manage', 'agent', 'database'),
  ('api.manage', 'agent', 'database'),
  ('settings.workspace', 'admin', 'app'),
  ('reports.view', 'viewer', 'app'),
  ('members.invite', 'admin', 'app'),
  ('members.change-role', 'admin', 'database'),
  ('members.remove', 'admin', 'database'),
  ('teams.manage', 'admin', 'app'),
  ('roles.manage', 'admin', 'database')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

-- Defaults are code-owned: replace the whole table so the SQL mirror
-- always equals the TS catalogue.
DELETE FROM public.role_capability_defaults;
INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'menu.dashboard'),
  ('owner', 'menu.inbox'),
  ('owner', 'menu.notifications'),
  ('owner', 'menu.contacts'),
  ('owner', 'menu.pipelines'),
  ('owner', 'menu.broadcasts'),
  ('owner', 'menu.tickets'),
  ('owner', 'menu.automations'),
  ('owner', 'menu.flows'),
  ('owner', 'menu.knowledge'),
  ('owner', 'menu.agents'),
  ('owner', 'menu.reports'),
  ('owner', 'menu.settings'),
  ('owner', 'messages.send'),
  ('owner', 'conversations.manage'),
  ('owner', 'comments.moderate'),
  ('owner', 'comments.delete'),
  ('owner', 'inbox.shared-views'),
  ('owner', 'contacts.edit'),
  ('owner', 'contacts.merge'),
  ('owner', 'deals.manage'),
  ('owner', 'pipelines.configure'),
  ('owner', 'broadcasts.send'),
  ('owner', 'automations.manage'),
  ('owner', 'flows.manage'),
  ('owner', 'tickets.work'),
  ('owner', 'tickets.delete'),
  ('owner', 'tickets.configure-form'),
  ('owner', 'tags.manage'),
  ('owner', 'snippets.manage'),
  ('owner', 'knowledge.draft'),
  ('owner', 'knowledge.publish'),
  ('owner', 'knowledge.manage'),
  ('owner', 'ai.use'),
  ('owner', 'ai.configure'),
  ('owner', 'channels.manage'),
  ('owner', 'api.manage'),
  ('owner', 'settings.workspace'),
  ('owner', 'reports.view'),
  ('owner', 'members.invite'),
  ('owner', 'members.change-role'),
  ('owner', 'members.remove'),
  ('owner', 'teams.manage'),
  ('owner', 'roles.manage'),
  ('admin', 'menu.dashboard'),
  ('admin', 'menu.inbox'),
  ('admin', 'menu.notifications'),
  ('admin', 'menu.contacts'),
  ('admin', 'menu.pipelines'),
  ('admin', 'menu.broadcasts'),
  ('admin', 'menu.tickets'),
  ('admin', 'menu.automations'),
  ('admin', 'menu.flows'),
  ('admin', 'menu.knowledge'),
  ('admin', 'menu.agents'),
  ('admin', 'menu.reports'),
  ('admin', 'menu.settings'),
  ('admin', 'messages.send'),
  ('admin', 'conversations.manage'),
  ('admin', 'comments.moderate'),
  ('admin', 'comments.delete'),
  ('admin', 'inbox.shared-views'),
  ('admin', 'contacts.edit'),
  ('admin', 'contacts.merge'),
  ('admin', 'deals.manage'),
  ('admin', 'pipelines.configure'),
  ('admin', 'broadcasts.send'),
  ('admin', 'automations.manage'),
  ('admin', 'flows.manage'),
  ('admin', 'tickets.work'),
  ('admin', 'tickets.delete'),
  ('admin', 'tickets.configure-form'),
  ('admin', 'tags.manage'),
  ('admin', 'snippets.manage'),
  ('admin', 'knowledge.draft'),
  ('admin', 'knowledge.publish'),
  ('admin', 'knowledge.manage'),
  ('admin', 'ai.use'),
  ('admin', 'ai.configure'),
  ('admin', 'channels.manage'),
  ('admin', 'api.manage'),
  ('admin', 'settings.workspace'),
  ('admin', 'reports.view'),
  ('admin', 'members.invite'),
  ('admin', 'members.change-role'),
  ('admin', 'members.remove'),
  ('admin', 'teams.manage'),
  ('admin', 'roles.manage'),
  ('agent', 'menu.dashboard'),
  ('agent', 'menu.inbox'),
  ('agent', 'menu.notifications'),
  ('agent', 'menu.contacts'),
  ('agent', 'menu.pipelines'),
  ('agent', 'menu.broadcasts'),
  ('agent', 'menu.tickets'),
  ('agent', 'menu.automations'),
  ('agent', 'menu.flows'),
  ('agent', 'menu.knowledge'),
  ('agent', 'menu.agents'),
  ('agent', 'menu.reports'),
  ('agent', 'menu.settings'),
  ('agent', 'messages.send'),
  ('agent', 'conversations.manage'),
  ('agent', 'comments.moderate'),
  ('agent', 'contacts.edit'),
  ('agent', 'contacts.merge'),
  ('agent', 'deals.manage'),
  ('agent', 'broadcasts.send'),
  ('agent', 'automations.manage'),
  ('agent', 'flows.manage'),
  ('agent', 'tickets.work'),
  ('agent', 'snippets.manage'),
  ('agent', 'knowledge.draft'),
  ('agent', 'ai.use'),
  ('agent', 'reports.view'),
  ('viewer', 'menu.dashboard'),
  ('viewer', 'menu.inbox'),
  ('viewer', 'menu.notifications'),
  ('viewer', 'menu.contacts'),
  ('viewer', 'menu.pipelines'),
  ('viewer', 'menu.broadcasts'),
  ('viewer', 'menu.tickets'),
  ('viewer', 'menu.automations'),
  ('viewer', 'menu.flows'),
  ('viewer', 'menu.knowledge'),
  ('viewer', 'menu.agents'),
  ('viewer', 'menu.reports'),
  ('viewer', 'menu.settings'),
  ('viewer', 'reports.view');

-- ------------------------------------------------------------
-- RLS on the new tables: members read, NOBODY writes directly.
-- (No INSERT/UPDATE/DELETE policies exist, and the privileges are
-- revoked too — set_role_capabilities is the only write path.)
-- ------------------------------------------------------------
ALTER TABLE public.capability_catalogue     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_capability_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_capabilities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_capability_log      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS capability_catalogue_select ON public.capability_catalogue;
CREATE POLICY capability_catalogue_select ON public.capability_catalogue
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS role_capability_defaults_select ON public.role_capability_defaults;
CREATE POLICY role_capability_defaults_select ON public.role_capability_defaults
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS role_capabilities_select ON public.role_capabilities;
CREATE POLICY role_capabilities_select ON public.role_capabilities
  FOR SELECT USING (is_account_member(account_id));

REVOKE ALL ON public.capability_catalogue,
              public.role_capability_defaults,
              public.role_capabilities,
              public.role_capability_log
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.capability_catalogue,
                public.role_capability_defaults,
                public.role_capabilities,
                public.role_capability_log
  TO authenticated;
REVOKE ALL ON SEQUENCE public.role_capability_log_id_seq FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Effective capability for an explicit (account, role). INTERNAL:
-- not callable by clients (it takes the account and role as
-- arguments), only by the SECURITY DEFINER functions below.
--
-- A grant override only counts when the role is at or above the
-- capability's min_grant_role (defence in depth: a stale row can
-- never lift a role over what the database rules can support).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.effective_capability(
  p_account_id UUID,
  p_role       account_role_enum,
  p_cap        TEXT
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
    WHEN p_role = 'owner' THEN true
    ELSE COALESCE(
      (
        SELECT CASE
                 WHEN rc.granted
                      AND role_rank(p_role) < role_rank(cc.min_grant_role) THEN NULL
                 ELSE rc.granted
               END
        FROM role_capabilities rc
        JOIN capability_catalogue cc ON cc.capability = rc.capability
        WHERE rc.account_id = p_account_id
          AND rc.role       = p_role
          AND rc.capability = p_cap
      ),
      EXISTS (
        SELECT 1 FROM role_capability_defaults d
        WHERE d.role = p_role AND d.capability = p_cap
      )
    )
  END;
$$;

REVOKE ALL ON FUNCTION public.effective_capability(UUID, account_role_enum, TEXT)
  FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- has_capability(target_account_id, cap)
--
-- The caller is auth.uid(). Owner => true (for a known capability),
-- otherwise override ?? default. No profile in that account, no
-- session, or an unknown capability => false (deny by default).
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
      SELECT effective_capability(p.account_id, p.account_role, cap)
      FROM profiles p
      WHERE p.user_id    = auth.uid()
        AND p.account_id = target_account_id
    ),
    false
  );
$$;

-- The caller's effective capability set in their account.
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
        AND effective_capability(p.account_id, p.account_role, c.capability)
    ),
    ARRAY[]::text[]
  );
$$;

-- ------------------------------------------------------------
-- set_role_capabilities(target_account_id, target_role, changes)
--
-- `changes` is a JSON object { "<capability>": true | false | null }.
-- true = grant, false = revoke, null = reset to the default. The whole
-- call is all-or-nothing (one function = one transaction).
--
-- Guardrails (all enforced HERE, not in the app):
--   * the caller must hold roles.manage in the target account;
--   * the caller may only edit roles STRICTLY below their own, and the
--     owner role is never editable;
--   * the caller can never grant a capability they do not hold;
--   * a role can only be granted a capability at or above that
--     capability's min_grant_role (this is also what keeps write
--     capabilities away from the viewer role);
--   * unknown capability keys are rejected;
--   * the account must keep an owner (who always holds roles.manage);
--   * only differences from the default are stored (an override equal
--     to the default is removed);
--   * every effective change is written to role_capability_log.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_role_capabilities(
  target_account_id UUID,
  target_role       account_role_enum,
  changes           JSONB
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

  SELECT account_id, account_role
    INTO v_caller_account, v_caller_role
    FROM profiles
   WHERE user_id = v_uid;

  IF v_caller_account IS NULL OR v_caller_account <> target_account_id THEN
    RAISE EXCEPTION 'You are not a member of this account' USING ERRCODE = '42501';
  END IF;

  IF NOT has_capability(target_account_id, 'roles.manage') THEN
    RAISE EXCEPTION 'This action requires the ''roles.manage'' permission'
      USING ERRCODE = '42501';
  END IF;

  IF target_role = 'owner' THEN
    RAISE EXCEPTION 'The Owner role always has full access and cannot be edited'
      USING ERRCODE = '42501';
  END IF;

  IF role_rank(target_role) >= role_rank(v_caller_role) THEN
    RAISE EXCEPTION 'You can only edit roles below your own'
      USING ERRCODE = '42501';
  END IF;

  IF changes IS NULL OR jsonb_typeof(changes) <> 'object' THEN
    RAISE EXCEPTION '''changes'' must be a JSON object of capability to true, false or null'
      USING ERRCODE = '22023';
  END IF;

  -- Serialise concurrent edits of the same account.
  PERFORM pg_advisory_xact_lock(hashtextextended('role_capabilities:' || target_account_id::text, 0));

  FOR v_key, v_val IN SELECT key, value FROM jsonb_each(changes) LOOP
    SELECT min_grant_role INTO v_min
      FROM capability_catalogue WHERE capability = v_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown capability: %', v_key USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_val) NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION 'Capability % must be set to true, false or null', v_key
        USING ERRCODE = '22023';
    END IF;

    v_default := EXISTS (
      SELECT 1 FROM role_capability_defaults d
       WHERE d.role = target_role AND d.capability = v_key
    );
    v_old := effective_capability(target_account_id, target_role, v_key);
    v_new := CASE WHEN jsonb_typeof(v_val) = 'null' THEN v_default
                  ELSE (v_val #>> '{}')::boolean END;

    -- Only a real GRANT is restricted; revoking is always allowed for an
    -- editable role.
    IF v_new AND NOT v_old THEN
      IF role_rank(target_role) < role_rank(v_min) THEN
        RAISE EXCEPTION 'The % role cannot be given ''%'' (it needs the % role or higher)',
          target_role, v_key, v_min
          USING ERRCODE = '22023';
      END IF;
      IF NOT has_capability(target_account_id, v_key) THEN
        RAISE EXCEPTION 'You cannot grant ''%'' because you do not hold it yourself', v_key
          USING ERRCODE = '42501';
      END IF;
    END IF;

    -- Store only differences from the default.
    IF v_new = v_default THEN
      DELETE FROM role_capabilities
       WHERE account_id = target_account_id
         AND role       = target_role
         AND capability = v_key;
    ELSE
      INSERT INTO role_capabilities (account_id, role, capability, granted, changed_by, changed_at)
      VALUES (target_account_id, target_role, v_key, v_new, v_uid, NOW())
      ON CONFLICT (account_id, role, capability)
      DO UPDATE SET granted    = EXCLUDED.granted,
                    changed_by = EXCLUDED.changed_by,
                    changed_at = EXCLUDED.changed_at;
    END IF;

    IF v_new IS DISTINCT FROM v_old THEN
      INSERT INTO role_capability_log
        (account_id, role, capability, old_granted, new_granted, actor)
      VALUES
        (target_account_id, target_role, v_key, v_old, v_new, v_uid);
      v_changed := v_changed + 1;
    END IF;
  END LOOP;

  -- The account must always keep someone who can manage roles. The
  -- owner always does and cannot be edited, so this only fails if the
  -- account has no owner at all.
  IF NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE account_id = target_account_id AND account_role = 'owner'
  ) THEN
    RAISE EXCEPTION 'The account must keep an owner who can manage roles'
      USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('changed', v_changed);
END;
$$;

-- ------------------------------------------------------------
-- Database-tier RLS: move the write policies (and the two admin-only
-- SELECT policies) onto has_capability(). Default behaviour is
-- identical: the defaults give Owner + Admin exactly what
-- is_account_member(..., 'admin') gave them. SELECT for viewers stays
-- as it is today (is_account_member(account_id)).
-- ------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  t TEXT;
  cap TEXT;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('whatsapp_config',   'channels.manage'),
      ('messenger_config',  'channels.manage'),
      ('instagram_config',  'channels.manage'),
      ('email_config',      'channels.manage'),
      ('gmail_config',      'channels.manage'),
      ('tiktok_config',     'channels.manage'),
      ('web_widget_config', 'channels.manage'),
      ('message_templates', 'channels.manage'),
      ('ai_configs',        'ai.configure'),
      ('ai_connections',    'ai.configure'),
      ('ai_task_routing',   'ai.configure'),
      ('api_keys',          'api.manage'),
      ('webhook_endpoints', 'api.manage')
    ) AS v(tbl, capability)
  LOOP
    t := r.tbl;
    cap := r.capability;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (has_capability(account_id, %L))',
      t || '_insert', t, cap);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (has_capability(account_id, %L))',
      t || '_update', t, cap);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE USING (has_capability(account_id, %L))',
      t || '_delete', t, cap);
  END LOOP;
END $$;

-- The two admin-only SELECT policies.
DROP POLICY IF EXISTS ai_connections_select ON public.ai_connections;
CREATE POLICY ai_connections_select ON public.ai_connections
  FOR SELECT USING (has_capability(account_id, 'ai.configure'));

DROP POLICY IF EXISTS ai_usage_log_select ON public.ai_usage_log;
CREATE POLICY ai_usage_log_select ON public.ai_usage_log
  FOR SELECT USING (has_capability(account_id, 'ai.configure'));

-- The change log is readable by people who can manage roles.
DROP POLICY IF EXISTS role_capability_log_select ON public.role_capability_log;
CREATE POLICY role_capability_log_select ON public.role_capability_log
  FOR SELECT USING (has_capability(account_id, 'roles.manage'));

-- ------------------------------------------------------------
-- Member rules
--   * set_member_role: caller may only change members whose CURRENT
--     role is strictly below the caller's, and may only assign roles
--     strictly below the caller's own. (An Admin can no longer change
--     another Admin, or mint one; only the Owner does.)
--   * remove_account_member: caller may only remove members strictly
--     below the caller's own role.
--   * both also require the members.change-role / members.remove
--     capability (Owner always; Admin by default).
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

  -- Admin+ AND the capability (Owner always holds it).
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

  -- Hierarchy: strictly below the caller, before and after.
  IF role_rank(v_target_role) >= role_rank(v_caller_role) THEN
    RAISE EXCEPTION 'You can only change members whose role is below your own'
      USING ERRCODE = '42501';
  END IF;
  IF role_rank(p_new_role) >= role_rank(v_caller_role) THEN
    RAISE EXCEPTION 'You can only assign roles below your own'
      USING ERRCODE = '42501';
  END IF;

  UPDATE profiles
     SET account_role = p_new_role
   WHERE user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_account_member(p_user_id UUID)
RETURNS uuid
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

  -- Spin up a fresh personal account for the removed user. Mirror
  -- of handle_new_user's logic — keep them whole, just relocated.
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

  RETURN v_new_account_id;
END;
$$;

-- ------------------------------------------------------------
-- Invitations: only into roles strictly below the inviter's own.
-- A trigger (not just the route) so a direct insert with a user JWT
-- cannot bypass it. Service-role / internal writes (auth.uid() IS NULL)
-- are not restricted; a non-member is left to RLS to reject.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_invitation_role_below_inviter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
BEGIN
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

DROP TRIGGER IF EXISTS enforce_invitation_role_below_inviter ON public.account_invitations;
CREATE TRIGGER enforce_invitation_role_below_inviter
  BEFORE INSERT OR UPDATE OF role ON public.account_invitations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_invitation_role_below_inviter();

NOTIFY pgrst, 'reload schema';
