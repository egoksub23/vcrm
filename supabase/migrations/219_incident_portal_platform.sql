-- Migration 219: the coach portal is one platform integration, run by the Halo operator; every call names the school by its Vircle Group ID.
--
-- Before: each school made its own keys, and the key alone said which school a call was for.
-- Now:    * a key belongs to the platform (account_id NULL). The operator makes it, rotates it and revokes it; schools never see it.
--         * incident_portal_schools maps a Vircle Group ID (the portal's own id for a school, with its name) to a Halo school, and holds that school's
--           allowed frame origins. The operator sets it up once at launch and updates it when it changes.
--         * every call carries the Group ID (X-Vircle-Group-Id). A key may act for any mapped, enabled school; a school with no mapping is refused.
--         * a report link remembers the Group ID it was issued for, so switching a school off ends its open links.
-- Keys made by schools under the old design are revoked here (the portal has not gone live on them). Run on the Halo PostgreSQL after 218. Idempotent.

ALTER TABLE public.incident_intake_keys ALTER COLUMN account_id DROP NOT NULL;

UPDATE public.incident_intake_keys SET revoked_at = now() WHERE account_id IS NOT NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.incident_portal_schools (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The portal's id for the school (Vircle Group ID) and its name there (Vircle Group Name). The id is what a call is matched on.
  group_id        TEXT        NOT NULL UNIQUE CHECK (length(group_id) BETWEEN 1 AND 100),
  group_name      TEXT        NOT NULL CHECK (length(group_name) BETWEEN 1 AND 200),
  account_id      UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Origins (https://host) allowed to put this school's report page in a frame, and to be named as the return address.
  allowed_origins TEXT[]      NOT NULL DEFAULT '{}' CHECK (cardinality(allowed_origins) <= 10),
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_portal_schools_account ON public.incident_portal_schools (account_id);

DROP TRIGGER IF EXISTS set_updated_at ON public.incident_portal_schools;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incident_portal_schools
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A school's admins can read their own link (to see what the portal is set up with); only the service connection (the operator console) writes.
ALTER TABLE public.incident_portal_schools ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_portal_schools_select ON public.incident_portal_schools;
CREATE POLICY incident_portal_schools_select ON public.incident_portal_schools FOR SELECT USING (has_capability(account_id, 'incidents.configure'));

-- The Group ID a report link was issued for (NULL on links made before this migration, which no longer work: their keys are revoked).
ALTER TABLE public.incident_intake_sessions ADD COLUMN IF NOT EXISTS group_id TEXT;

-- One platform key now serves every school, so "the same tap sent again" is matched within a school: two schools may use the same idempotency string.
DROP INDEX IF EXISTS public.uq_incident_intake_sessions_idem;
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_intake_sessions_idem_group
  ON public.incident_intake_sessions (key_id, group_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND group_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
