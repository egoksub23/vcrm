-- ============================================================
-- 069_contact_country_language
--
-- Two contact fields agents can now set from the Inbox's contact column:
--
--   country          ISO 3166-1 alpha-2, upper-case ("MY").
--   language         the customer's preferred conversation language, a
--                    lower-case ISO 639 code with an optional region
--                    ("ms", "zh", "pt-BR"). AI drafts and auto-replies
--                    use it as the language to answer in.
--   language_source  who set it: 'manual' (an agent) or 'detected'
--                    (reserved for AI language detection, so a detected
--                    value never overwrites what an agent chose).
--
-- All three are nullable — most contacts have none set. Shapes are
-- enforced by CHECK constraints rather than fixed lists, so any valid
-- code works. Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS language TEXT,
  ADD COLUMN IF NOT EXISTS language_source TEXT;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_country_format;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_country_format
  CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_language_format;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_language_format
  CHECK (language IS NULL OR language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$');

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_language_source_values;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_language_source_values
  CHECK (language_source IS NULL OR language_source IN ('manual', 'detected'));
