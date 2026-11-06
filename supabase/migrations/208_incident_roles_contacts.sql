-- Migration 208: incident platform, part 1 — capabilities, contacts, roles, role members.
--
-- Notifications go to a ROLE (Head of Sport, School nurse ...), never to a
-- fixed address. A role has members in order; each member is a contact with
-- one or more emails and phones. Per-incident roles (reporter, incident lead,
-- parent or guardian) have no members: they are worked out per incident.
--
-- Everything is keyed by account_id with row-level security. Run on the Halo
-- PostgreSQL after 207. Idempotent.

-- ------------------------------------------------------------
-- 1. Capabilities (mirrors src/lib/auth/capabilities.ts)
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('incidents.configure', 'agent', 'database'),
  ('incidents.medical',   'agent', 'app'),
  ('incidents.export',    'agent', 'app')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'incidents.configure'),
  ('admin', 'incidents.configure'),
  ('owner', 'incidents.medical'),
  ('admin', 'incidents.medical'),
  ('owner', 'incidents.export'),
  ('admin', 'incidents.export')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2. incident_contacts — a person who can be told about an incident
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_contacts (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Set when the person is a Halo user; null for outside contacts.
  user_id            UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  name               TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  kind               TEXT        NOT NULL DEFAULT 'staff' CHECK (kind IN ('staff', 'outside')),
  emails             TEXT[]      NOT NULL DEFAULT '{}',
  phones             TEXT[]      NOT NULL DEFAULT '{}',
  -- Channels in order of preference. Only 'email' has an adapter today.
  preferred_channels TEXT[]      NOT NULL DEFAULT '{email}',
  is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_contacts_account ON public.incident_contacts (account_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_contacts_user
  ON public.incident_contacts (account_id, user_id) WHERE user_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3. incident_roles — a job that rules tell
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_roles (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key            TEXT        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- Language map, e.g. {"en": "Head of Sport"}. English first; others added later.
  name           JSONB       NOT NULL CHECK (jsonb_typeof(name) = 'object' AND name ? 'en'),
  description    TEXT,
  -- fixed: has members. per_incident: worked out for each incident.
  kind           TEXT        NOT NULL DEFAULT 'fixed' CHECK (kind IN ('fixed', 'per_incident')),
  dynamic_source TEXT        CHECK (dynamic_source IN ('reporter', 'incident_lead', 'guardian')),
  -- all: tell every active member. first_available: tell the first member who is not away.
  notify_mode    TEXT        NOT NULL DEFAULT 'all' CHECK (notify_mode IN ('all', 'first_available')),
  sort_order     INTEGER     NOT NULL DEFAULT 0,
  is_system      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, key),
  CHECK ((kind = 'per_incident') = (dynamic_source IS NOT NULL))
);

-- ------------------------------------------------------------
-- 4. incident_role_members — who holds a role, in order
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_role_members (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  role_id    UUID        NOT NULL REFERENCES public.incident_roles(id) ON DELETE CASCADE,
  contact_id UUID        NOT NULL REFERENCES public.incident_contacts(id) ON DELETE CASCADE,
  position   INTEGER     NOT NULL DEFAULT 0,
  -- Inclusive dates the person is away; while away, a backup is told instead.
  away_from  DATE,
  away_to    DATE,
  -- A backup is only told when every non-backup member is away.
  is_backup  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (role_id, contact_id),
  CHECK (away_to IS NULL OR away_from IS NULL OR away_to >= away_from)
);
CREATE INDEX IF NOT EXISTS idx_incident_role_members_role ON public.incident_role_members (role_id, position);
CREATE INDEX IF NOT EXISTS idx_incident_role_members_contact ON public.incident_role_members (contact_id);

-- A member must belong to the same school as the role and the contact.
CREATE OR REPLACE FUNCTION public.enforce_incident_role_member_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.incident_roles r WHERE r.id = NEW.role_id AND r.account_id = NEW.account_id)
     OR NOT EXISTS (SELECT 1 FROM public.incident_contacts c WHERE c.id = NEW.contact_id AND c.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'role and contact must belong to the same account as the member row';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_incident_role_member_account ON public.incident_role_members;
CREATE TRIGGER enforce_incident_role_member_account
  BEFORE INSERT OR UPDATE ON public.incident_role_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_incident_role_member_account();

DROP TRIGGER IF EXISTS set_updated_at ON public.incident_contacts;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incident_contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.incident_roles;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incident_roles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ------------------------------------------------------------
-- 5. Row-level security: managers read, configurers write
-- ------------------------------------------------------------
ALTER TABLE public.incident_contacts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_roles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_role_members ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['incident_contacts', 'incident_roles', 'incident_role_members'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (has_capability(account_id, %L) OR has_capability(account_id, %L))',
      t || '_select', t, 'incidents.manage', 'incidents.configure');
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL USING (has_capability(account_id, %L)) WITH CHECK (has_capability(account_id, %L))',
      t || '_write', t, 'incidents.configure', 'incidents.configure');
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 6. seed_incident_roles — the starter roles for a school
-- ------------------------------------------------------------
-- Called by the server the first time Setup is opened. Service role only.
CREATE OR REPLACE FUNCTION public.seed_incident_roles(p_account_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_added INTEGER := 0;
  v_rows  INTEGER;
BEGIN
  INSERT INTO public.incident_roles (account_id, key, name, description, kind, dynamic_source, notify_mode, sort_order, is_system)
  VALUES
    (p_account_id, 'principal',          '{"en":"Principal"}',              'The head of the school.',                             'fixed', NULL, 'all',             10, TRUE),
    (p_account_id, 'head_of_sport',      '{"en":"Head of Sport"}',          'Runs CCA and sports activities.',                     'fixed', NULL, 'all',             20, TRUE),
    (p_account_id, 'school_nurse',       '{"en":"School nurse"}',           'Treats injuries and sets return-to-play dates.',      'fixed', NULL, 'all',             30, TRUE),
    (p_account_id, 'dpo',                '{"en":"Data protection officer"}','Decides on personal-data incidents and notifications.', 'fixed', NULL, 'all',        40, TRUE),
    (p_account_id, 'safeguarding_lead',  '{"en":"Safeguarding lead"}',      'Handles child-protection concerns.',                  'fixed', NULL, 'all',             50, TRUE),
    (p_account_id, 'facilities_manager', '{"en":"Facilities manager"}',     'Handles property damage and building safety.',        'fixed', NULL, 'all',             60, TRUE),
    (p_account_id, 'reporter',           '{"en":"Reporter"}',               'Whoever reported the incident (for example the coach).', 'per_incident', 'reporter',      'all', 100, TRUE),
    (p_account_id, 'incident_lead',      '{"en":"Incident lead"}',          'The person assigned to the incident.',                'per_incident', 'incident_lead',  'all', 110, TRUE),
    (p_account_id, 'parent_guardian',    '{"en":"Parent or guardian"}',     'Parents or guardians of the students involved.',      'per_incident', 'guardian',       'all', 120, TRUE)
  ON CONFLICT (account_id, key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_added := v_added + v_rows;
  RETURN v_added;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_incident_roles(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_incident_roles(UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
