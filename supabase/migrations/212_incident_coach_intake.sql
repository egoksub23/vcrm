-- Migration 212: incident platform, part 3 — coach reporting (intake keys and one-time report links), people named on an incident,
-- Return to Play clearances, and the per-school retention setting.
--
-- The coach portal (which Halo does not control) asks Halo, server to server and with a key, for a one-time report link. The roster it sends is stored as
-- a snapshot on that link and copied onto the incident for the people named on it. Coaches have no Halo login: they are external reporters.
-- Run on the Halo PostgreSQL after 211. Idempotent.

-- ------------------------------------------------------------
-- 1. incidents: where a report came from and who made it
-- ------------------------------------------------------------
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS source         TEXT NOT NULL DEFAULT 'halo';
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS external_ref    TEXT;
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS reporter_name   TEXT;
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS reporter_email  TEXT;
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS reporter_phone  TEXT;
-- A report made with a test key: it notifies only the school's admins and is marked TEST everywhere.
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS is_test         BOOLEAN NOT NULL DEFAULT FALSE;
-- The activity the incident happened in (name, venue, date and the portal's own id), as the portal sent it.
ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS activity        JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'incidents_source_check' AND conrelid = 'public.incidents'::regclass) THEN
    ALTER TABLE public.incidents ADD CONSTRAINT incidents_source_check CHECK (source IN ('halo', 'coach_portal', 'api'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_incidents_external_ref ON public.incidents (account_id, external_ref) WHERE external_ref IS NOT NULL;

-- ------------------------------------------------------------
-- 2. incident_intake_keys — a key the coach portal uses
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_intake_keys (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  label           TEXT        NOT NULL DEFAULT 'Coach portal',
  mode            TEXT        NOT NULL CHECK (mode IN ('live', 'test')),
  -- The first characters of the key, to recognise it on screen. The key itself is shown once and only its SHA-256 hash is kept.
  prefix          TEXT        NOT NULL,
  key_hash        TEXT        NOT NULL UNIQUE,
  scopes          TEXT[]      NOT NULL DEFAULT '{launch,clearances.read}',
  -- Origins (https://host) allowed to put the report page in a frame, and to be named as the return address.
  allowed_origins TEXT[]      NOT NULL DEFAULT '{}',
  created_by      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incident_intake_keys_account ON public.incident_intake_keys (account_id, created_at DESC);

-- ------------------------------------------------------------
-- 3. incident_intake_sessions — a one-time report link
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_intake_sessions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key_id          UUID        NOT NULL REFERENCES public.incident_intake_keys(id) ON DELETE CASCADE,
  mode            TEXT        NOT NULL CHECK (mode IN ('live', 'test')),
  form            TEXT        NOT NULL DEFAULT 'cca',
  coach           JSONB       NOT NULL,
  activity        JSONB       NOT NULL,
  -- The roster as the portal sent it (names, classes, optional guardians). Children's data: kept only for the life of the link and copied to the
  -- incident for the people actually named on it.
  roster          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  return_url      TEXT,
  idempotency_key TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  submitted_at    TIMESTAMPTZ,
  incident_id     UUID        REFERENCES public.incidents(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_intake_sessions_idem
  ON public.incident_intake_sessions (key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_incident_intake_sessions_expiry ON public.incident_intake_sessions (expires_at);

-- ------------------------------------------------------------
-- 4. incident_intake_calls — the call log shown under the key
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_intake_calls (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key_id     UUID        REFERENCES public.incident_intake_keys(id) ON DELETE SET NULL,
  route      TEXT        NOT NULL,
  status     INTEGER     NOT NULL,
  summary    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_intake_calls_account ON public.incident_intake_calls (account_id, created_at DESC);

-- ------------------------------------------------------------
-- 5. incident_involved — the people named on an incident
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_involved (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id         UUID        NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  account_id          UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- The portal's own id for the student (null for a visitor or someone typed in by hand).
  external_student_id TEXT,
  name                TEXT        NOT NULL,
  class_name          TEXT,
  guardians           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  involvement         TEXT        NOT NULL DEFAULT 'involved' CHECK (involvement IN ('injured', 'involved', 'witness')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_involved_incident ON public.incident_involved (incident_id);
CREATE INDEX IF NOT EXISTS idx_incident_involved_student ON public.incident_involved (account_id, external_student_id) WHERE external_student_id IS NOT NULL;

-- ------------------------------------------------------------
-- 6. person_clearances — Return to Play (warn only, never blocks)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.person_clearances (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  external_student_id TEXT        NOT NULL,
  student_name        TEXT        NOT NULL,
  type                TEXT        NOT NULL DEFAULT 'injury' CHECK (type IN ('injury', 'concussion', 'illness', 'other')),
  not_before          DATE        NOT NULL,
  note                TEXT,
  incident_id         UUID        REFERENCES public.incidents(id) ON DELETE SET NULL,
  set_by              UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  cleared_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_person_clearances_student ON public.person_clearances (account_id, external_student_id, not_before DESC);
CREATE INDEX IF NOT EXISTS idx_person_clearances_open ON public.person_clearances (account_id, not_before) WHERE cleared_at IS NULL;

-- ------------------------------------------------------------
-- 7. incident_settings — one row per school
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_settings (
  account_id      UUID        PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Keep reports and photos for as long as the school wants. NULL means until the school deletes them (the default).
  retention_years INTEGER     CHECK (retention_years IS NULL OR retention_years BETWEEN 1 AND 50),
  updated_by      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 8. Triggers and row-level security
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS set_updated_at ON public.person_clearances;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.person_clearances
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.incident_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incident_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.incident_intake_keys     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_intake_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_intake_calls    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_involved        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.person_clearances        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_settings        ENABLE ROW LEVEL SECURITY;

-- Keys: configurers see and manage them. The hash never leaves the server in any route, but the table is closed to everyone else anyway.
DROP POLICY IF EXISTS incident_intake_keys_select ON public.incident_intake_keys;
DROP POLICY IF EXISTS incident_intake_keys_write  ON public.incident_intake_keys;
CREATE POLICY incident_intake_keys_select ON public.incident_intake_keys FOR SELECT USING (has_capability(account_id, 'incidents.configure'));
CREATE POLICY incident_intake_keys_write ON public.incident_intake_keys FOR ALL
  USING (has_capability(account_id, 'incidents.configure'))
  WITH CHECK (has_capability(account_id, 'incidents.configure'));

-- Sessions hold a roster of children: no policy at all, so only the server (service connection) can read or write them.

DROP POLICY IF EXISTS incident_intake_calls_select ON public.incident_intake_calls;
CREATE POLICY incident_intake_calls_select ON public.incident_intake_calls FOR SELECT USING (has_capability(account_id, 'incidents.configure'));

-- The people named on an incident are visible to whoever can see the incident.
DROP POLICY IF EXISTS incident_involved_select ON public.incident_involved;
CREATE POLICY incident_involved_select ON public.incident_involved FOR SELECT USING (
  has_capability(account_id, 'incidents.manage')
  OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_involved.incident_id AND i.reporter_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.incident_watchers w WHERE w.incident_id = incident_involved.incident_id AND w.user_id = auth.uid())
);

-- Clearances are medical: read with incidents.medical. They are written by the server after it has checked that capability.
DROP POLICY IF EXISTS person_clearances_select ON public.person_clearances;
CREATE POLICY person_clearances_select ON public.person_clearances FOR SELECT USING (has_capability(account_id, 'incidents.medical'));

DROP POLICY IF EXISTS incident_settings_select ON public.incident_settings;
DROP POLICY IF EXISTS incident_settings_write  ON public.incident_settings;
CREATE POLICY incident_settings_select ON public.incident_settings FOR SELECT USING (
  has_capability(account_id, 'incidents.manage') OR has_capability(account_id, 'incidents.configure')
);
CREATE POLICY incident_settings_write ON public.incident_settings FOR ALL
  USING (has_capability(account_id, 'incidents.configure'))
  WITH CHECK (has_capability(account_id, 'incidents.configure'));

-- Tidy up expired, unused links after a week (called by the cron; service role only).
CREATE OR REPLACE FUNCTION public.purge_expired_incident_sessions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM public.incident_intake_sessions WHERE expires_at < now() - interval '7 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.purge_expired_incident_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_incident_sessions() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'halo_notify_account_change') THEN
    DROP TRIGGER IF EXISTS halo_rt_person_clearances ON public.person_clearances;
    CREATE TRIGGER halo_rt_person_clearances
      AFTER INSERT OR UPDATE OR DELETE ON public.person_clearances
      FOR EACH ROW EXECUTE FUNCTION public.halo_notify_account_change();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
