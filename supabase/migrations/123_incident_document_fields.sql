-- ============================================================
-- Incident document generation (Form A/B/C/D) — supporting schema.
--
-- Adds the incident-record fields that are genuine, reusable facts
-- about an incident (root-cause detail, contributing factors, what
-- worked/didn't, funds recovered, etc. — read directly from the four
-- actual policy form templates), fixes incident_evidence_log.file_hash
-- never being populated, widens incident_notifications_sent's recipient
-- list, adds a per-account 24/7 incident contact, and adds
-- incident_documents_generated so Form C's "timeliness against
-- targets" table can show when Form A/B were actually produced.
--
-- Deliberately NOT persisted anywhere (stays compose-time-only, typed
-- fresh into the generation dialog every time — see the plan): Form B's
-- executive summary, Form D's "changes since last update"/"requests to
-- the recipient", and each form's per-send "Prepared by"/"Approved by".
-- ============================================================

-- ------------------------------------------------------------
-- 1. incidents — new persistent document-generation fields.
-- ------------------------------------------------------------
ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS incident_start_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recipient_directly_affected TEXT,
  ADD COLUMN IF NOT EXISTS containment_summary TEXT,
  ADD COLUMN IF NOT EXISTS eradication_summary TEXT,
  ADD COLUMN IF NOT EXISTS recovery_summary TEXT,
  ADD COLUMN IF NOT EXISTS vendor_involvement TEXT,
  ADD COLUMN IF NOT EXISTS attack_vector TEXT,
  ADD COLUMN IF NOT EXISTS threat_actor_info TEXT,
  ADD COLUMN IF NOT EXISTS children_data_involved TEXT,
  ADD COLUMN IF NOT EXISTS contributing_factors TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS contributing_factors_detail TEXT,
  ADD COLUMN IF NOT EXISTS pir_method TEXT,
  ADD COLUMN IF NOT EXISTS what_worked_well TEXT,
  ADD COLUMN IF NOT EXISTS what_did_not_work_well TEXT,
  ADD COLUMN IF NOT EXISTS funds_recovered_myr NUMERIC,
  ADD COLUMN IF NOT EXISTS funds_recovered_at DATE,
  ADD COLUMN IF NOT EXISTS end_of_hypercare_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pir_review_meeting_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pir_review_attendees TEXT;

ALTER TABLE public.incidents DROP CONSTRAINT IF EXISTS incidents_recipient_directly_affected_check;
ALTER TABLE public.incidents ADD CONSTRAINT incidents_recipient_directly_affected_check
  CHECK (recipient_directly_affected IS NULL OR recipient_directly_affected IN ('yes', 'no', 'unknown'));

ALTER TABLE public.incidents DROP CONSTRAINT IF EXISTS incidents_children_data_involved_check;
ALTER TABLE public.incidents ADD CONSTRAINT incidents_children_data_involved_check
  CHECK (children_data_involved IS NULL OR children_data_involved IN ('yes', 'no', 'unknown'));

ALTER TABLE public.incidents DROP CONSTRAINT IF EXISTS incidents_pir_method_check;
ALTER TABLE public.incidents ADD CONSTRAINT incidents_pir_method_check
  CHECK (pir_method IS NULL OR pir_method IN ('5_whys', 'fishbone', 'other'));

ALTER TABLE public.incidents DROP CONSTRAINT IF EXISTS incidents_contributing_factors_check;
ALTER TABLE public.incidents ADD CONSTRAINT incidents_contributing_factors_check
  CHECK (contributing_factors <@ ARRAY['people', 'process', 'technology', 'third_party']::text[]);

-- ------------------------------------------------------------
-- 2. incident_evidence_log.file_hash fix — the column has existed since
-- 116 but nothing has ever populated it (upload is client-direct-to-
-- storage; the trigger below never copied it through). Now it does.
-- ------------------------------------------------------------
ALTER TABLE public.incident_attachments
  ADD COLUMN IF NOT EXISTS file_hash TEXT;

CREATE OR REPLACE FUNCTION public.log_incident_attachment_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO incident_evidence_log (
    incident_id, account_id, attachment_id, description, source, collected_by, file_hash
  ) VALUES (
    NEW.incident_id, NEW.account_id, NEW.id,
    'File uploaded: ' || NEW.filename,
    'attachment_upload',
    NEW.uploaded_by,
    NEW.file_hash
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log evidence for attachment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.log_incident_attachment_evidence() OWNER TO postgres;

-- ------------------------------------------------------------
-- 3. incident_notifications_sent.recipient_party widen — Form A's
-- recipient checkboxes (safeguarding bank, settlement bank/acquirer,
-- payment network) and "other parties notified" list (PDRM/NSRC,
-- MyCERT) don't all fit the original 7-value set. Dropped by lookup,
-- not by a guessed name (same convention as 081/066/121).
-- ------------------------------------------------------------
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.incident_notifications_sent'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%recipient_party%'
  LOOP
    EXECUTE format('ALTER TABLE public.incident_notifications_sent DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.incident_notifications_sent ADD CONSTRAINT incident_notifications_sent_recipient_party_check
  CHECK (recipient_party IN (
    'bnm', 'sponsor_emi', 'partner', 'pdp_commissioner', 'data_subjects', 'police', 'other',
    'safeguarding_bank', 'settlement_bank_acquirer', 'payment_network', 'nsrc', 'mycert'
  ));

-- ------------------------------------------------------------
-- 4. accounts — per-account 24/7 incident contact (Form A/D's
-- "Vircle incident contact" field). Plain columns, same convention as
-- ticket_key_prefix — gated by incidents.manage via a new branch on
-- accounts_capability_guard() (088).
-- ------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS incident_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS incident_contact_role TEXT,
  ADD COLUMN IF NOT EXISTS incident_contact_mobile TEXT,
  ADD COLUMN IF NOT EXISTS incident_contact_email TEXT;

CREATE OR REPLACE FUNCTION public.accounts_capability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_prefix           BOOLEAN;
  v_auto             BOOLEAN;
  v_incident_contact BOOLEAN;
  v_other            BOOLEAN;
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  v_prefix := NEW.ticket_key_prefix IS DISTINCT FROM OLD.ticket_key_prefix;
  v_auto   := NEW.auto_label_ai_enabled IS DISTINCT FROM OLD.auto_label_ai_enabled;
  v_incident_contact := (NEW.incident_contact_name, NEW.incident_contact_role, NEW.incident_contact_mobile, NEW.incident_contact_email)
                         IS DISTINCT FROM
                         (OLD.incident_contact_name, OLD.incident_contact_role, OLD.incident_contact_mobile, OLD.incident_contact_email);
  v_other  := (to_jsonb(NEW) - 'ticket_key_prefix' - 'auto_label_ai_enabled' - 'updated_at'
                - 'incident_contact_name' - 'incident_contact_role' - 'incident_contact_mobile' - 'incident_contact_email')
              IS DISTINCT FROM
              (to_jsonb(OLD) - 'ticket_key_prefix' - 'auto_label_ai_enabled' - 'updated_at'
                - 'incident_contact_name' - 'incident_contact_role' - 'incident_contact_mobile' - 'incident_contact_email');

  IF v_other AND NOT has_capability(OLD.id, 'settings.workspace') THEN
    RAISE EXCEPTION 'This action requires the ''settings.workspace'' permission'
      USING ERRCODE = '42501';
  END IF;
  IF v_prefix AND NOT has_capability(OLD.id, 'tickets.configure-form') THEN
    RAISE EXCEPTION 'This action requires the ''tickets.configure-form'' permission'
      USING ERRCODE = '42501';
  END IF;
  IF v_auto AND NOT has_capability(OLD.id, 'tags.manage') THEN
    RAISE EXCEPTION 'This action requires the ''tags.manage'' permission'
      USING ERRCODE = '42501';
  END IF;
  IF v_incident_contact AND NOT has_capability(OLD.id, 'incidents.manage') THEN
    RAISE EXCEPTION 'This action requires the ''incidents.manage'' permission'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.accounts_capability_guard() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 5. incident_documents_generated — one row per generated Form A/B/C/D.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_documents_generated (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id UUID NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  form TEXT NOT NULL CHECK (form IN ('a', 'b', 'c', 'd')),
  generated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attachment_id UUID REFERENCES public.incident_attachments(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_incident_documents_generated_incident
  ON public.incident_documents_generated(incident_id, form, generated_at);

ALTER TABLE public.incident_documents_generated ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_documents_generated_select ON public.incident_documents_generated;
CREATE POLICY incident_documents_generated_select ON public.incident_documents_generated FOR SELECT USING (
  has_capability(account_id, 'incidents.manage')
  OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_id AND i.reporter_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.incident_watchers w WHERE w.incident_id = incident_documents_generated.incident_id AND w.user_id = auth.uid())
);
DROP POLICY IF EXISTS incident_documents_generated_insert ON public.incident_documents_generated;
CREATE POLICY incident_documents_generated_insert ON public.incident_documents_generated FOR INSERT WITH CHECK (
  has_capability(account_id, 'incidents.manage') AND generated_by = auth.uid()
);
