-- Migration 228: more ways to tell people (WhatsApp, SMS, push) and a way in by email.
--
-- One row per school holds both settings:
--   Notices   a school switches WhatsApp, SMS and push on or off for incident notices. WhatsApp also needs the name of an approved Meta message template
--             (a business may only start a WhatsApp conversation with one). SMS and push also need the server to be set up for them (environment variables).
--             Email always works. A person who prefers one of these is told on it AND by email, so a notice is never lost.
--   Email in  an address that turns an email into an incident. A mail service posts each email to /api/incidents/email-in/<token>; only the senders the
--             school listed are accepted, and the incident is filed under the category the school chose.
-- Run on the Halo PostgreSQL after 227. Idempotent.

CREATE TABLE IF NOT EXISTS public.incident_channel_settings (
  account_id                UUID        PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  whatsapp_enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
  whatsapp_template_name    TEXT        CHECK (whatsapp_template_name IS NULL OR whatsapp_template_name ~ '^[a-z0-9_]{1,512}$'),
  whatsapp_template_language TEXT       NOT NULL DEFAULT 'en' CHECK (whatsapp_template_language ~ '^[a-z]{2,3}(_[A-Za-z]{2})?$'),
  sms_enabled               BOOLEAN     NOT NULL DEFAULT FALSE,
  push_enabled              BOOLEAN     NOT NULL DEFAULT FALSE,
  email_in_enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
  email_in_token            TEXT,
  -- Addresses (alice@school.edu) or whole domains (@school.edu) allowed to file by email. Empty means nobody.
  email_in_senders          TEXT[]      NOT NULL DEFAULT '{}',
  email_in_category         TEXT,
  updated_by                UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_channel_settings_token ON public.incident_channel_settings (email_in_token) WHERE email_in_token IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON public.incident_channel_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incident_channel_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.incident_channel_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_channel_settings_select ON public.incident_channel_settings;
DROP POLICY IF EXISTS incident_channel_settings_write  ON public.incident_channel_settings;
-- It holds the secret address, so only people who configure incidents see it; the server writes after checking the same capability.
CREATE POLICY incident_channel_settings_select ON public.incident_channel_settings FOR SELECT USING (has_capability(account_id, 'incidents.configure'));
CREATE POLICY incident_channel_settings_write ON public.incident_channel_settings FOR ALL
  USING (has_capability(account_id, 'incidents.configure'))
  WITH CHECK (has_capability(account_id, 'incidents.configure'));

-- An incident can now come from an email.
ALTER TABLE public.incidents DROP CONSTRAINT IF EXISTS incidents_source_check;
ALTER TABLE public.incidents ADD CONSTRAINT incidents_source_check CHECK (source IN ('halo', 'coach_portal', 'api', 'email'));

NOTIFY pgrst, 'reload schema';
