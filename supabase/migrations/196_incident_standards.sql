-- ============================================================
-- 196_incident_standards.sql
--
-- Phase 1: incident standards registry — makes the incident module
-- config-driven instead of hardcoded to BNM RMiT.
--
-- A "standard" is a row that drives the incident module for an
-- account: it defines available incident types, severity taxonomy,
-- and SLA windows. Multiple standards can be active per account
-- (e.g. ISO 27035 + ISO 45001 for a school).
--
-- This migration:
--   1. Creates the registry tables
--   2. Seeds BNM RMiT as the first system standard
--   3. Adds standard_id FK to incidents + backfills
--   4. Seeds all existing accounts with BNM RMiT as active standard
--   5. Adds a trigger so new accounts auto-get BNM RMiT
-- ============================================================

-- 1. Standards catalogue -----------------------------------

CREATE TABLE public.incident_standards (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT        NOT NULL UNIQUE,
  name            TEXT        NOT NULL,
  regulatory_body TEXT,
  sector          TEXT,
  description     TEXT,
  is_system       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Per-standard incident type catalogue ------------------

CREATE TABLE public.incident_type_catalogue (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  standard_id      UUID    NOT NULL REFERENCES public.incident_standards(id) ON DELETE CASCADE,
  code             TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  description      TEXT,
  default_severity TEXT,
  -- if set, UI warns when selected severity is weaker than this slug
  min_severity     TEXT,
  notifiable       BOOLEAN NOT NULL DEFAULT false,
  position         INT     NOT NULL DEFAULT 0,
  UNIQUE (standard_id, code)
);

CREATE INDEX itc_standard_id ON public.incident_type_catalogue (standard_id);

-- 3. Per-standard severity levels --------------------------

CREATE TABLE public.incident_severity_levels (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  standard_id    UUID    NOT NULL REFERENCES public.incident_standards(id) ON DELETE CASCADE,
  slug           TEXT    NOT NULL,
  label          TEXT    NOT NULL,
  color          TEXT,
  escalate_hrs   INT,
  regulatory_hrs INT,
  resolve_days   INT,
  position       INT     NOT NULL DEFAULT 0,
  UNIQUE (standard_id, slug)
);

CREATE INDEX isl_standard_id ON public.incident_severity_levels (standard_id);

-- 4. Per-account active standards --------------------------

CREATE TABLE public.account_incident_standards (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  standard_id  UUID        NOT NULL REFERENCES public.incident_standards(id) ON DELETE CASCADE,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, standard_id)
);

CREATE INDEX ais_account_id ON public.account_incident_standards (account_id);

-- 5. Add standard_id to incidents (nullable; backfilled below) --

ALTER TABLE public.incidents
  ADD COLUMN standard_id UUID REFERENCES public.incident_standards(id);

CREATE INDEX incidents_standard_id ON public.incidents (standard_id);

-- RLS --------------------------------------------------------

ALTER TABLE public.incident_standards          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_type_catalogue     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_severity_levels    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_incident_standards  ENABLE ROW LEVEL SECURITY;

-- Standards and their catalogues are a global read-only reference
CREATE POLICY "incident_standards_select" ON public.incident_standards
  FOR SELECT USING (true);

CREATE POLICY "incident_type_catalogue_select" ON public.incident_type_catalogue
  FOR SELECT USING (true);

CREATE POLICY "incident_severity_levels_select" ON public.incident_severity_levels
  FOR SELECT USING (true);

-- Account standards: members read, admins write
CREATE POLICY "account_incident_standards_select" ON public.account_incident_standards
  FOR SELECT USING (
    account_id IN (
      SELECT account_id FROM public.account_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "account_incident_standards_write" ON public.account_incident_standards
  FOR ALL USING (
    account_id IN (
      SELECT account_id FROM public.account_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin', 'owner'])
    )
  );

-- Seed -------------------------------------------------------

-- BNM RMiT standard
INSERT INTO public.incident_standards (slug, name, regulatory_body, sector, description)
VALUES (
  'bnm_rmit',
  'BNM Risk Management in Technology (RMiT)',
  'Bank Negara Malaysia',
  'Financial services',
  'Bank Negara Malaysia technology risk management framework. Mandatory for banks, insurers, and payment system operators licensed under BNM.'
);

-- BNM incident types (14 types from VCL-ISP-IRP-001 §8)
INSERT INTO public.incident_type_catalogue
  (standard_id, code, name, description, default_severity, min_severity, notifiable, position)
SELECT
  s.id,
  v.code, v.name, v.description,
  v.default_severity, v.min_severity,
  v.notifiable, v.position
FROM public.incident_standards s,
(VALUES
  ('SB', 'Security breach / unauthorised access',
   'Unauthorised access to systems, accounts or data',
   'P2', NULL, true, 1),
  ('DB', 'Data breach / data leakage',
   'Loss, disclosure or misuse of personal or confidential data',
   'P1', 'P2', true, 2),
  ('FL', 'Float / safeguarding incident',
   'E-money liabilities not fully matched by safeguarded funds, or safeguarded funds at risk',
   'P1', 'P2', true, 3),
  ('LI', 'Ledger integrity / processing error',
   'Incorrect, lost, duplicated or corrupted balances or transactions',
   'P2', NULL, false, 4),
  ('TF', 'Top-up, transfer and payment fraud',
   'Fraudulent funding, transfers, payments or refunds',
   'P2', NULL, true, 5),
  ('QF', 'QR payment fraud and tampering',
   'Manipulation of QR codes or payment flows',
   'P2', NULL, true, 6),
  ('AT', 'Account takeover / credential compromise',
   'Takeover of customer, merchant, staff or API credentials',
   'P2', 'P2', true, 7),
  ('IF', 'Internal fraud / employee misconduct',
   'Dishonest or unauthorised acts by staff or contractors',
   'P2', NULL, true, 8),
  ('UA', 'Unacceptable use / policy violation',
   'Staff activity against policy without confirmed fraud',
   'P3', NULL, false, 9),
  ('MW', 'Malware and ransomware',
   'Malicious code on Vircle systems or staff devices',
   'P2', NULL, true, 10),
  ('AV', 'Availability / denial of service',
   'Loss or degradation of e-money services with a security or integrity dimension',
   'P2', NULL, true, 11),
  ('TP', 'Third-party / supply-chain incident',
   'Incident at a provider or partner that affects Vircle',
   'P2', 'P2', true, 12),
  ('SA', 'Suspicious activity / other',
   'Anomalous behaviour needing investigation that does not fit another type',
   'P3', NULL, false, 13),
  ('DF', 'DuitNow linked fraud and layering',
   'Suspicious movement between principal and unverified supplementary user coupled with outflow within 24 hours or shorter',
   'P2', NULL, true, 14)
) AS v(code, name, description, default_severity, min_severity, notifiable, position)
WHERE s.slug = 'bnm_rmit';

-- BNM severity levels (P1–P4 SLA windows from VCL-ISP-IRP-001 §9)
INSERT INTO public.incident_severity_levels
  (standard_id, slug, label, color, escalate_hrs, regulatory_hrs, resolve_days, position)
SELECT
  s.id,
  v.slug, v.label, v.color,
  v.escalate_hrs::INT, v.regulatory_hrs::INT, v.resolve_days::INT,
  v.position::INT
FROM public.incident_standards s,
(VALUES
  ('P1', 'Critical', '#dc2626',  1, 4,   1,   1),
  ('P2', 'High',     '#d97706',  4, 72,  7,   2),
  ('P3', 'Medium',   '#ca8a04', 24, 168, 30,  3),
  ('P4', 'Low',      '#64748b',168, NULL,90,  4)
) AS v(slug, label, color, escalate_hrs, regulatory_hrs, resolve_days, position)
WHERE s.slug = 'bnm_rmit';

-- Backfill all existing incidents to BNM RMiT
UPDATE public.incidents i
SET    standard_id = s.id
FROM   public.incident_standards s
WHERE  s.slug          = 'bnm_rmit'
  AND  i.standard_id  IS NULL;

-- Seed all existing accounts with BNM RMiT as their active standard
INSERT INTO public.account_incident_standards (account_id, standard_id, is_active)
SELECT a.id, s.id, true
FROM   public.accounts a
CROSS  JOIN public.incident_standards s
WHERE  s.slug = 'bnm_rmit'
ON CONFLICT (account_id, standard_id) DO NOTHING;

-- Trigger: every new account automatically gets BNM RMiT --------
-- (Phase 3/4 will let admins switch to ISO 27035 / ISO 45001 in Settings)

CREATE OR REPLACE FUNCTION public.seed_account_incident_standard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.account_incident_standards (account_id, standard_id, is_active)
  SELECT NEW.id, s.id, true
  FROM   public.incident_standards s
  WHERE  s.slug = 'bnm_rmit'
  ON CONFLICT (account_id, standard_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_account_seed_incident_standard
  AFTER INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.seed_account_incident_standard();
