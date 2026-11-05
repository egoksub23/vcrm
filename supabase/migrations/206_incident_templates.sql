-- ============================================================
-- 206_incident_templates.sql
--
-- Incident templates + compliance frameworks.
--
-- Until now one "standard" drove the whole incident module, and an
-- account could use only one at a time. This migration splits the idea:
--
--   * a TEMPLATE (kind = 'template') owns what staff see when they raise
--     an incident: the categories and ONE severity scale. An account has
--     exactly one active template (BNM RMiT for Vircle, "School Incident
--     Management" for a school).
--   * a FRAMEWORK (kind = 'framework') is a pack of obligations (PDPA,
--     ISO/IEC 27035, ISO 45001, school policy ...). Any number can be
--     active at once. Each rule fires when an incident carries its
--     trigger flag (personal_data, injury, ...) and becomes a dated
--     checklist item on that incident.
--
-- Also fixes a latent bug: migration 116 hard-wired the 14 BNM type codes
-- and P1-P4 as CHECK constraints on incidents, so ISO 27035 / PDPA rows
-- seeded by 197 could never be raised. The CHECKs are dropped; a trigger
-- validates against the incident's own template instead.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. incident_standards.kind
-- ------------------------------------------------------------
ALTER TABLE public.incident_standards
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'template'
  CHECK (kind IN ('template', 'framework'));

-- ISO 27035 and PDPA (migration 197) are obligation packs, not templates.
UPDATE public.incident_standards
   SET kind = 'framework'
 WHERE slug IN ('iso_27035', 'pdpa_my');

-- An account that had switched to one of them as its only standard must
-- not be left without a template.
INSERT INTO public.account_incident_standards (account_id, standard_id, is_active)
SELECT a.id, s.id, true
  FROM public.accounts a
  CROSS JOIN public.incident_standards s
 WHERE s.slug = 'bnm_rmit'
   AND NOT EXISTS (
     SELECT 1
       FROM public.account_incident_standards ais
       JOIN public.incident_standards t ON t.id = ais.standard_id AND t.kind = 'template'
      WHERE ais.account_id = a.id AND ais.is_active
   )
ON CONFLICT (account_id, standard_id) DO UPDATE SET is_active = true;

-- ------------------------------------------------------------
-- 2. One active template per account (frameworks are unlimited)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_single_active_incident_template()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_active
     AND EXISTS (SELECT 1 FROM public.incident_standards s WHERE s.id = NEW.standard_id AND s.kind = 'template') THEN
    UPDATE public.account_incident_standards a
       SET is_active = false
     WHERE a.account_id = NEW.account_id
       AND a.standard_id <> NEW.standard_id
       AND a.is_active
       AND EXISTS (SELECT 1 FROM public.incident_standards s WHERE s.id = a.standard_id AND s.kind = 'template');
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_single_active_incident_template() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_account_incident_template_single ON public.account_incident_standards;
CREATE TRIGGER on_account_incident_template_single
  AFTER INSERT OR UPDATE OF is_active, standard_id ON public.account_incident_standards
  FOR EACH ROW EXECUTE FUNCTION public.enforce_single_active_incident_template();

-- ------------------------------------------------------------
-- 3. Drop the BNM-only CHECK constraints (found by column, not by a
-- guessed name — same convention as 123).
-- ------------------------------------------------------------
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname, con.conrelid::regclass AS tbl
      FROM pg_constraint con
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
     WHERE con.contype = 'c'
       AND array_length(con.conkey, 1) = 1
       AND (
         (con.conrelid = 'public.incidents'::regclass AND a.attname IN ('incident_type', 'severity'))
         OR (con.conrelid = 'public.incident_escalation_policies'::regclass AND a.attname = 'severity')
       )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;

-- The catalogue replaces them: an incident's type and severity must exist
-- in ITS template. Legacy rows without a standard_id are not checked.
CREATE OR REPLACE FUNCTION public.validate_incident_catalogue()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.standard_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.incident_type_catalogue
     WHERE standard_id = NEW.standard_id AND code = NEW.incident_type
  ) THEN
    RAISE EXCEPTION 'Incident type "%" is not part of this incident template', NEW.incident_type
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.incident_severity_levels
     WHERE standard_id = NEW.standard_id AND slug = NEW.severity
  ) THEN
    RAISE EXCEPTION 'Severity "%" is not part of this incident template', NEW.severity
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_incident_catalogue ON public.incidents;
CREATE TRIGGER validate_incident_catalogue
  BEFORE INSERT OR UPDATE OF incident_type, severity, standard_id ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.validate_incident_catalogue();

-- ------------------------------------------------------------
-- 4. Flags: what an incident involves. Categories carry default flags;
-- frameworks key their rules off them.
--   injury, child_involved, personal_data, infosec, property_damage,
--   security_breach, safeguarding, outside_agency
-- ------------------------------------------------------------
ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS incident_flags TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.incident_type_catalogue
  ADD COLUMN IF NOT EXISTS default_flags TEXT[] NOT NULL DEFAULT '{}';

-- BNM categories that are information-security matters (only used when an
-- account also switches on a framework such as PDPA or ISO 27035).
UPDATE public.incident_type_catalogue c
   SET default_flags = v.flags::text[]
  FROM public.incident_standards s,
       (VALUES
         ('SB', '{infosec}'),
         ('DB', '{personal_data,infosec}'),
         ('AT', '{infosec}'),
         ('MW', '{infosec}'),
         ('AV', '{infosec}'),
         ('TP', '{infosec}'),
         ('SA', '{infosec}')
       ) AS v(code, flags)
 WHERE s.slug = 'bnm_rmit' AND c.standard_id = s.id AND c.code = v.code;

-- ------------------------------------------------------------
-- 5. Obligation rules (global reference, like the type catalogue)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_obligation_rules (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  standard_id  UUID    NOT NULL REFERENCES public.incident_standards(id) ON DELETE CASCADE,
  code         TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  description  TEXT,
  trigger_flag TEXT    NOT NULL,
  -- hours after the incident was detected; NULL = no deadline
  due_hours    INT     CHECK (due_hours IS NULL OR due_hours > 0),
  -- a recipient_party value when the obligation is "tell somebody"
  party        TEXT,
  position     INT     NOT NULL DEFAULT 0,
  UNIQUE (standard_id, code)
);

CREATE INDEX IF NOT EXISTS iobr_standard_id ON public.incident_obligation_rules (standard_id);

ALTER TABLE public.incident_obligation_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "incident_obligation_rules_select" ON public.incident_obligation_rules;
CREATE POLICY "incident_obligation_rules_select" ON public.incident_obligation_rules
  FOR SELECT USING (true);

-- ------------------------------------------------------------
-- 6. Per-incident obligations (the checklist)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_obligations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  UUID        NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  account_id   UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  rule_id      UUID        REFERENCES public.incident_obligation_rules(id) ON DELETE SET NULL,
  standard_id  UUID        REFERENCES public.incident_standards(id) ON DELETE SET NULL,
  -- snapshot of the rule so history survives a rule edit
  title        TEXT        NOT NULL,
  description  TEXT,
  party        TEXT,
  due_at       TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'not_applicable')),
  note         TEXT,
  completed_at TIMESTAMPTZ,
  completed_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (incident_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_incident_obligations_incident ON public.incident_obligations (incident_id, due_at);
CREATE INDEX IF NOT EXISTS idx_incident_obligations_open_due
  ON public.incident_obligations (account_id, due_at) WHERE status = 'open';

ALTER TABLE public.incident_obligations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_obligations_select ON public.incident_obligations;
DROP POLICY IF EXISTS incident_obligations_update ON public.incident_obligations;

-- Same visibility as the incident itself.
CREATE POLICY incident_obligations_select ON public.incident_obligations FOR SELECT USING (
  has_capability(account_id, 'incidents.manage')
  OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_id AND i.reporter_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.incident_watchers w WHERE w.incident_id = incident_obligations.incident_id AND w.user_id = auth.uid())
);
-- Only the Compliance Officer / Admin / Owner tick items off. Rows are
-- created by incident_sync_obligations() (SECURITY DEFINER), never by a client.
CREATE POLICY incident_obligations_update ON public.incident_obligations FOR UPDATE
  USING (has_capability(account_id, 'incidents.manage'))
  WITH CHECK (has_capability(account_id, 'incidents.manage'));

CREATE OR REPLACE FUNCTION public.stamp_incident_obligation_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
    NEW.completed_at := now();
    NEW.completed_by := auth.uid();
  ELSIF NEW.status <> 'done' AND OLD.status = 'done' THEN
    NEW.completed_at := NULL;
    NEW.completed_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_incident_obligation_completion ON public.incident_obligations;
CREATE TRIGGER on_incident_obligation_completion
  BEFORE UPDATE OF status ON public.incident_obligations
  FOR EACH ROW EXECUTE FUNCTION public.stamp_incident_obligation_completion();

-- Builds / refreshes an incident's checklist from the account's ACTIVE
-- frameworks: adds an item per matching rule, re-opens one that was set
-- not-applicable when its flag comes back, and marks open items
-- not-applicable when their flag is removed. Done items are never touched.
CREATE OR REPLACE FUNCTION public.incident_sync_obligations(p_incident_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v incidents%ROWTYPE;
BEGIN
  SELECT * INTO v FROM incidents WHERE id = p_incident_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO incident_obligations (incident_id, account_id, rule_id, standard_id, title, description, party, due_at)
  SELECT v.id, v.account_id, r.id, r.standard_id, r.title, r.description, r.party,
         CASE WHEN r.due_hours IS NULL THEN NULL ELSE v.detected_at + make_interval(hours => r.due_hours) END
    FROM account_incident_standards ais
    JOIN incident_standards s ON s.id = ais.standard_id AND s.kind = 'framework'
    JOIN incident_obligation_rules r ON r.standard_id = s.id AND r.trigger_flag = ANY (v.incident_flags)
   WHERE ais.account_id = v.account_id AND ais.is_active
  ON CONFLICT (incident_id, rule_id) DO UPDATE
    SET status = 'open'
    WHERE incident_obligations.status = 'not_applicable';

  UPDATE incident_obligations o
     SET status = 'not_applicable'
   WHERE o.incident_id = v.id
     AND o.status = 'open'
     AND o.rule_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM incident_obligation_rules r
        WHERE r.id = o.rule_id AND r.trigger_flag = ANY (v.incident_flags)
     );
END;
$$;

ALTER FUNCTION public.incident_sync_obligations(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.incident_sync_obligations(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.incident_sync_obligations(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.on_incident_sync_obligations()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.incident_sync_obligations(NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to sync obligations for incident %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.on_incident_sync_obligations() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_incident_obligations_sync ON public.incidents;
CREATE TRIGGER on_incident_obligations_sync
  AFTER INSERT OR UPDATE OF incident_flags, detected_at ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.on_incident_sync_obligations();

-- ------------------------------------------------------------
-- 7. Parties an obligation can name — widen recipient_party (lookup, not
-- a guessed constraint name; mirrors 123).
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
    'safeguarding_bank', 'settlement_bank_acquirer', 'payment_network', 'nsrc', 'mycert',
    'parent_guardian', 'school_leadership', 'ministry_education', 'insurer'
  ));

-- ------------------------------------------------------------
-- 8. Escalation defaults for the non-P1..P4 scales. critical/high/medium/
-- low take P1..P4's timers; P1..P4 values are unchanged (migration 118).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.incident_escalation_default_minutes(p_severity TEXT, p_level INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_severity IN ('P1', 'critical') THEN CASE WHEN p_level = 1 THEN 15 ELSE 60 END
    WHEN p_severity IN ('P2', 'high')     THEN CASE WHEN p_level = 1 THEN 60 ELSE 240 END
    WHEN p_severity IN ('P3', 'medium')   THEN CASE WHEN p_level = 1 THEN 1440 ELSE 43200 END
    WHEN p_severity IN ('P4', 'low')      THEN CASE WHEN p_level = 1 THEN 10080 ELSE 43200 END
    ELSE 1440
  END;
$$;

-- ============================================================
-- SEED: School Incident Management (template)
-- ============================================================
INSERT INTO public.incident_standards (slug, name, regulatory_body, sector, description, kind)
VALUES (
  'school_incident',
  'School Incident Management',
  'School / Ministry of Education (set by your school)',
  'Education',
  'One form for everything a school needs to log: CCA and sports injuries, mishaps and near misses, property damage, security and data breaches, and safeguarding concerns. Switch on PDPA, ISO/IEC 27035, ISO 45001 and school policy as frameworks and each incident picks up the obligations that apply to it.',
  'template'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.incident_severity_levels
  (standard_id, slug, label, color, escalate_hrs, regulatory_hrs, resolve_days, position)
SELECT s.id, v.slug, v.label, v.color, v.escalate_hrs::INT, NULL, v.resolve_days::INT, v.position::INT
FROM public.incident_standards s,
(VALUES
  ('critical', 'Critical',          '#dc2626', 1,   1,  1),
  ('high',     'Serious',           '#d97706', 4,   7,  2),
  ('medium',   'Moderate',          '#ca8a04', 24,  30, 3),
  ('low',      'Minor / near miss', '#64748b', 168, 90, 4)
) AS v(slug, label, color, escalate_hrs, resolve_days, position)
WHERE s.slug = 'school_incident'
ON CONFLICT (standard_id, slug) DO NOTHING;

INSERT INTO public.incident_type_catalogue
  (standard_id, code, name, description, default_severity, min_severity, notifiable, default_flags, position)
SELECT s.id, v.code, v.name, v.description, v.default_severity, v.min_severity, v.notifiable,
       v.flags::text[], v.position
FROM public.incident_standards s,
(VALUES
  ('CCA', 'CCA / sports injury',
   'A student or coach is hurt during a co-curricular activity, sports day or training',
   'high', NULL, true, '{injury,child_involved}', 1),
  ('INJ', 'Injury or medical emergency',
   'Injury, illness or medical emergency outside CCA — classroom, canteen, playground, staff',
   'medium', NULL, true, '{injury}', 2),
  ('NMS', 'Mishap / near miss',
   'Something went wrong or nearly did, and nobody was hurt',
   'low', NULL, false, '{}', 3),
  ('PRD', 'Property damage / vandalism',
   'School property, equipment or buildings damaged, deliberately or by accident',
   'medium', NULL, false, '{property_damage}', 4),
  ('THF', 'Theft or loss of property',
   'School, staff or student property stolen or lost',
   'medium', NULL, false, '{property_damage}', 5),
  ('SEC', 'Security breach (intruder, trespass)',
   'Unauthorised person on site, forced entry, lock-down or gate/fence failure',
   'high', NULL, true, '{security_breach}', 6),
  ('CYB', 'Cyber incident',
   'Hacked account, malware, phishing, ransomware or a compromised school system',
   'high', NULL, true, '{infosec}', 7),
  ('DBR', 'Data breach (personal data)',
   'Student, parent or staff personal data lost, leaked, sent to the wrong person or accessed without permission',
   'high', 'high', true, '{personal_data,infosec}', 8),
  ('SGD', 'Safeguarding / bullying / child protection',
   'Suspected abuse, serious bullying or any concern about a child''s welfare',
   'high', 'high', true, '{child_involved,safeguarding}', 9),
  ('FIR', 'Fire, evacuation or facility hazard',
   'Fire, evacuation, structural or electrical hazard, flooding, unsafe premises',
   'high', NULL, true, '{outside_agency}', 10),
  ('VEN', 'Vendor / contractor incident',
   'Incident caused by or involving a contractor, canteen operator, bus or other third party',
   'medium', NULL, false, '{}', 11),
  ('OTH', 'Other',
   'Anything that does not fit another category',
   'medium', NULL, false, '{}', 12)
) AS v(code, name, description, default_severity, min_severity, notifiable, flags, position)
WHERE s.slug = 'school_incident'
ON CONFLICT (standard_id, code) DO NOTHING;

-- ============================================================
-- SEED: frameworks + their obligation rules
-- Starter values only. Deadlines and wording are defaults for the
-- Compliance Officer / DPO to confirm against the current regulation and
-- the school's own policy — they are not legal advice.
-- ============================================================
INSERT INTO public.incident_standards (slug, name, regulatory_body, sector, description, kind)
VALUES
  ('iso_45001',
   'ISO 45001 Occupational Health & Safety',
   'ISO',
   'All sectors',
   'Injury and ill-health handling: first aid, next-of-kin notification, root-cause investigation, corrective actions and a check that they worked. Applies to any incident flagged as an injury.',
   'framework'),
  ('school_policy',
   'School policy & ministry reporting (starter rules)',
   'School leadership / Ministry of Education',
   'Education',
   'Starter checklist for informing school leadership, the education office, insurer and police. Replace the wording and deadlines with your school''s own procedures.',
   'framework')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.incident_obligation_rules
  (standard_id, code, title, description, trigger_flag, due_hours, party, position)
SELECT s.id, v.code, v.title, v.description, v.trigger_flag, v.due_hours::INT, v.party, v.position::INT
FROM public.incident_standards s
JOIN (VALUES
  -- PDPA Malaysia ------------------------------------------------
  ('pdpa_my', 'PDPA_ASSESS',
   'Assess whether this is a notifiable personal data breach',
   'Decide whether the breach causes, or is likely to cause, significant harm or is of significant scale. Write the reasoning on the incident.',
   'personal_data', 24, NULL, 1),
  ('pdpa_my', 'PDPA_COMMISSIONER',
   'Notify the PDP Commissioner (if notifiable)',
   'Notify as soon as practicable and within 72 hours. Confirm the current threshold and process with your data protection officer.',
   'personal_data', 72, 'pdp_commissioner', 2),
  ('pdpa_my', 'PDPA_SUBJECTS',
   'Notify affected data subjects (if required)',
   'Tell the people affected when the breach is likely to cause them significant harm. Confirm the timing with your data protection officer.',
   'personal_data', 240, 'data_subjects', 3),
  -- ISO/IEC 27035 ------------------------------------------------
  ('iso_27035', 'ISO27035_ASSESS',
   'Assess and decide: is this a security incident?',
   'Confirm what happened, what is affected and how serious it is.',
   'infosec', 4, NULL, 1),
  ('iso_27035', 'ISO27035_EVIDENCE',
   'Preserve evidence',
   'Keep logs, screenshots and affected devices as they are. Attach what you collect to the incident.',
   'infosec', 4, NULL, 2),
  ('iso_27035', 'ISO27035_RESPOND',
   'Contain, eradicate and recover',
   'Stop the spread, remove the cause and restore normal service. Note each step on the incident.',
   'infosec', 72, NULL, 3),
  ('iso_27035', 'ISO27035_LESSONS',
   'Lessons-learned review',
   'Review what happened, what worked and what to change, and record the actions.',
   'infosec', 336, NULL, 4),
  -- ISO 45001 ----------------------------------------------------
  ('iso_45001', 'ISO45001_AID',
   'Give first aid / medical attention and record it',
   'Record who attended, what was done and whether the person was sent to a clinic or hospital.',
   'injury', 1, NULL, 1),
  ('iso_45001', 'ISO45001_NEXTKIN',
   'Notify parent, guardian or next of kin',
   'Contact them and record the time and who spoke to them.',
   'injury', 2, 'parent_guardian', 2),
  ('iso_45001', 'ISO45001_INVESTIGATE',
   'Investigate and find the root cause',
   'Interview those involved, check the area and equipment, and record the root cause on the incident.',
   'injury', 168, NULL, 3),
  ('iso_45001', 'ISO45001_CORRECTIVE',
   'Agree corrective and preventive actions',
   'Add each action to the incident with an owner and a due date.',
   'injury', 336, NULL, 4),
  ('iso_45001', 'ISO45001_VERIFY',
   'Check the corrective actions worked',
   'Confirm the actions were done and the risk is controlled.',
   'injury', 720, NULL, 5),
  -- School policy (starter) -------------------------------------
  ('school_policy', 'SCHOOL_LEADERSHIP_INJURY',
   'Inform the principal / school leadership',
   'Starter rule: replace with your school''s own escalation procedure.',
   'injury', 2, 'school_leadership', 1),
  ('school_policy', 'SCHOOL_LEADERSHIP_SECURITY',
   'Inform the principal / school leadership',
   'Starter rule: replace with your school''s own escalation procedure.',
   'security_breach', 2, 'school_leadership', 2),
  ('school_policy', 'SCHOOL_LEADERSHIP_SAFEGUARD',
   'Inform the principal / school leadership',
   'Starter rule: replace with your school''s own escalation procedure.',
   'safeguarding', 2, 'school_leadership', 3),
  ('school_policy', 'SCHOOL_SAFEGUARD_PROCEDURE',
   'Follow the child-protection reporting procedure',
   'Starter rule: check your child-protection policy and the reporting duties that apply to your school with school leadership or legal advice.',
   'safeguarding', 24, 'other', 4),
  ('school_policy', 'SCHOOL_MINISTRY_INJURY',
   'Report to the education office / ministry if required',
   'Starter rule: confirm which incidents your school must report and by when.',
   'injury', 24, 'ministry_education', 5),
  ('school_policy', 'SCHOOL_MINISTRY_SECURITY',
   'Report to the education office / ministry if required',
   'Starter rule: confirm which incidents your school must report and by when.',
   'security_breach', 24, 'ministry_education', 6),
  ('school_policy', 'SCHOOL_AGENCY_REF',
   'Log the police / fire / ambulance report reference',
   'Record the report number and the officer or station, and attach any copy.',
   'outside_agency', 24, 'police', 7),
  ('school_policy', 'SCHOOL_INSURER',
   'Tell the insurer if the damage is claimable',
   'Starter rule: check the policy for notification deadlines and what is covered.',
   'property_damage', 168, 'insurer', 8)
) AS v(slug, code, title, description, trigger_flag, due_hours, party, position)
  ON v.slug = s.slug
ON CONFLICT (standard_id, code) DO NOTHING;

-- ------------------------------------------------------------
-- Realtime: the checklist updates live on the detail screen.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'incident_obligations'
  ) AND EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.incident_obligations;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
