-- ============================================================
-- 197_incident_standards_phase3.sql
--
-- Phase 3: ISO/IEC 27035 and PDPA Malaysia seed data.
-- No schema changes — only rows in the catalogue tables that
-- migration 196 created. Accounts activate these via Settings >
-- Incidents > Standards; BNM RMiT remains the default for every
-- existing account.
-- ============================================================

-- ============================================================
-- ISO/IEC 27035 — Information Security Incident Management
-- ============================================================

INSERT INTO public.incident_standards (slug, name, regulatory_body, sector, description)
VALUES (
  'iso_27035',
  'ISO/IEC 27035 Information Security Incident Management',
  'ISO/IEC',
  'All sectors',
  'International standard for information security incident management (ISO/IEC 27035-1:2023 / 27035-2:2023). Defines a five-phase process: plan-and-prepare, detect-and-report, assess-and-decide, respond, and learn. Applicable to any organization managing technology or information assets, regardless of sector.'
);

INSERT INTO public.incident_type_catalogue
  (standard_id, code, name, description, default_severity, min_severity, notifiable, position)
SELECT
  s.id,
  v.code, v.name, v.description,
  v.default_severity, v.min_severity,
  v.notifiable, v.position
FROM public.incident_standards s,
(VALUES
  ('MAL', 'Malware / malicious code',
   'Malicious software on systems or endpoints — ransomware, spyware, trojans, worms',
   'high', NULL, true, 1),
  ('UAC', 'Unauthorized access',
   'Intrusion into systems, accounts, or networks without authorization',
   'high', 'high', true, 2),
  ('INF', 'Information leakage / disclosure',
   'Unauthorized or unintentional disclosure of confidential or proprietary information',
   'high', NULL, true, 3),
  ('INT', 'Integrity violation',
   'Unauthorized modification, corruption, deletion, or fabrication of data or system configuration',
   'high', NULL, false, 4),
  ('DOS', 'Denial of service',
   'Disruption to service availability by resource exhaustion, flooding, or other attack vectors',
   'high', NULL, true, 5),
  ('SCA', 'Reconnaissance / scanning',
   'Unauthorized scanning, probing, or mapping of network topology, systems, or services',
   'medium', NULL, false, 6),
  ('PHI', 'Phishing / social engineering',
   'Deceptive attacks targeting human vulnerabilities to gain credentials or access',
   'high', NULL, true, 7),
  ('PHY', 'Physical security incident',
   'Theft, loss, or damage to physical IT assets; unauthorized physical access to data facilities',
   'high', NULL, false, 8),
  ('SUP', 'Supply chain / third-party',
   'Security incident at a vendor, partner, or contractor that affects the organization',
   'high', 'high', true, 9),
  ('INU', 'Inappropriate use',
   'Violation of acceptable use policy by authorized users; misuse of organizational resources',
   'medium', NULL, false, 10)
) AS v(code, name, description, default_severity, min_severity, notifiable, position)
WHERE s.slug = 'iso_27035';

INSERT INTO public.incident_severity_levels
  (standard_id, slug, label, color, escalate_hrs, regulatory_hrs, resolve_days, position)
SELECT
  s.id,
  v.slug, v.label, v.color,
  v.escalate_hrs::INT, v.regulatory_hrs::INT, v.resolve_days::INT,
  v.position::INT
FROM public.incident_standards s,
(VALUES
  ('critical', 'Critical', '#dc2626',  1,   4,    1,  1),
  ('high',     'High',     '#d97706',  4,   72,   7,  2),
  ('medium',   'Medium',   '#ca8a04',  24,  168,  30, 3),
  ('low',      'Low',      '#64748b',  168, NULL, 90, 4)
) AS v(slug, label, color, escalate_hrs, regulatory_hrs, resolve_days, position)
WHERE s.slug = 'iso_27035';

-- ============================================================
-- PDPA Malaysia — Personal Data Protection Act 2010 (amended 2024)
-- ============================================================

INSERT INTO public.incident_standards (slug, name, regulatory_body, sector, description)
VALUES (
  'pdpa_my',
  'Personal Data Protection Act (Malaysia)',
  'Personal Data Protection Commissioner (PDPC)',
  'All sectors processing personal data',
  'Malaysia''s Personal Data Protection Act 2010, as amended 2024 to include mandatory breach notification. Requires organizations to notify the PDPC within 72 hours for significant personal data breaches affecting 500 or more data subjects or involving sensitive data as defined under the Act.'
);

INSERT INTO public.incident_type_catalogue
  (standard_id, code, name, description, default_severity, min_severity, notifiable, position)
SELECT
  s.id,
  v.code, v.name, v.description,
  v.default_severity, v.min_severity,
  v.notifiable, v.position
FROM public.incident_standards s,
(VALUES
  ('PDB', 'Personal data breach',
   'Unauthorized access to personal data held by the organization',
   'significant', NULL, true, 1),
  ('UDC', 'Unauthorized disclosure',
   'Personal data disclosed to unauthorized parties, whether intentionally or through negligence',
   'critical', 'significant', true, 2),
  ('DLD', 'Data loss / destruction',
   'Accidental or deliberate loss, destruction, or inaccessibility of personal data',
   'significant', NULL, true, 3),
  ('ACC', 'Accidental exposure',
   'Personal data inadvertently made publicly accessible, e.g. misconfigured storage or email mis-send',
   'critical', 'significant', true, 4),
  ('ULP', 'Unlawful processing',
   'Processing of personal data without a valid legal basis, consent, or in breach of the data processing conditions under the Act',
   'significant', NULL, false, 5),
  ('CBT', 'Cross-border transfer violation',
   'Transfer of personal data outside Malaysia without adequate protection or in breach of PDPA Section 129',
   'significant', NULL, true, 6),
  ('DSR', 'Data subject rights failure',
   'Failure to fulfill a data subject''s access, correction, or erasure request within the required timeframe',
   'limited', NULL, false, 7),
  ('SEC', 'Security failure',
   'Technical vulnerability or misconfiguration creating material risk to personal data, even without confirmed disclosure',
   'limited', NULL, false, 8)
) AS v(code, name, description, default_severity, min_severity, notifiable, position)
WHERE s.slug = 'pdpa_my';

-- Severity levels keyed to PDPC notification thresholds
INSERT INTO public.incident_severity_levels
  (standard_id, slug, label, color, escalate_hrs, regulatory_hrs, resolve_days, position)
SELECT
  s.id,
  v.slug, v.label, v.color,
  v.escalate_hrs::INT, v.regulatory_hrs::INT, v.resolve_days::INT,
  v.position::INT
FROM public.incident_standards s,
(VALUES
  ('critical',    'Critical — notify PDPC', '#dc2626', 1,   72,   30,  1),
  ('significant', 'Significant',            '#d97706', 4,   NULL, 60,  2),
  ('limited',     'Limited',                '#ca8a04', 48,  NULL, 90,  3),
  ('minor',       'Minor / contained',      '#64748b', 168, NULL, 120, 4)
) AS v(slug, label, color, escalate_hrs, regulatory_hrs, resolve_days, position)
WHERE s.slug = 'pdpa_my';
