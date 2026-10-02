-- ============================================================
-- 144: language and timezone per workspace, language/timezone per person
-- (plan item B3).
--
-- Language was a build-time setting (NEXT_PUBLIC_APP_LOCALE), so a deployment
-- had one language, and a few places defaulted to Kuala Lumpur. Now:
--   accounts.locale / accounts.timezone   the workspace's defaults
--   profiles.locale / profiles.timezone   a person's own choice (optional)
-- Resolution at request time: person, then workspace, then the deployment's
-- default (the app does that; NULL means "no choice made at this level").
--
-- The locale list lives in the app (src/lib/i18n/locales.ts) so adding a
-- language does not need a migration; the database only checks the shape
-- (en, ko, ms, zh-CN ...). Timezones are checked against pg_timezone_names
-- (the same list the SLA schedules use).
--
-- Existing workspaces keep today's behaviour: their timezone is set to
-- Asia/Kuala_Lumpur; new ones start at UTC and choose their own.
-- ============================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS locale   TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS locale   TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT;

-- Every workspace that exists today ran with Kuala Lumpur defaults.
UPDATE public.accounts SET timezone = 'Asia/Kuala_Lumpur' WHERE timezone = 'UTC';

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_locale_check;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_locale_check
  CHECK (locale IS NULL OR locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$');

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_locale_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_locale_check
  CHECK (locale IS NULL OR locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$');

CREATE OR REPLACE FUNCTION public.validate_timezone_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.timezone IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'invalid_timezone: %', NEW.timezone USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_timezone ON public.accounts;
CREATE TRIGGER validate_timezone
  BEFORE INSERT OR UPDATE OF timezone ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.validate_timezone_column();

DROP TRIGGER IF EXISTS validate_timezone ON public.profiles;
CREATE TRIGGER validate_timezone
  BEFORE INSERT OR UPDATE OF timezone ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.validate_timezone_column();

-- A trigger function is not callable on its own, but the catalogue guard
-- (verify-guard-catalog.sql) is about what a signed-in user may reach: keep it
-- off the default grants anyway.
REVOKE ALL ON FUNCTION public.validate_timezone_column() FROM PUBLIC, anon, authenticated;
