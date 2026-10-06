-- ============================================================
-- 157_sign_foundation.sql
--
-- Doc Sign (electronic signing inside Halo), work package 1: the foundation
-- (docs/vircle-sign-plan.md, sections 3 to 5 and 10). No screens and no routes
-- yet; this is what everything after it stands on.
--
--   1. Capabilities: menu.sign (see Doc Sign and its documents), sign.send,
--      sign.templates, sign.settings (table guards), sign.void and sign.sign
--      (server-enforced).
--   2. Platform flags `sign` and `sign_merchant`: OFF for every workspace,
--      existing and new. The operator switches Doc Sign on per workspace
--      (Vircle first), and the Merchant Registration add-on separately.
--   3. Tables: sign_settings, sign_certificates, sign_categories, sign_addons,
--      sign_templates (+ immutable sign_template_versions), sign_documents,
--      sign_document_files, sign_signers (+ server-only sign_signer_secrets),
--      sign_step_invites, sign_answers, sign_events.
--   4. Integrity in the database, not only in the app:
--        * document status moves are checked by a trigger; a sent document's
--          content, signing order and base file are frozen; the final file is
--          write-once;
--        * sign_events is an append-only hash chain (prev_hash, row_hash under
--          a per-document lock) with sign_verify_chain() to recompute it;
--        * every child row carries the account of its document (composite
--          foreign key), so a bug cannot attach a row across workspaces.
--   5. Private storage bucket `sign-documents`. No storage policies at all:
--      only the server (service role) reads and writes it, and hands the
--      browser short-lived signed links.
--   6. account_usage() gains `sign_documents_month` for the limit
--      `sign_documents_per_month`.
--
-- Signers never log in: their screens call the server, which uses the service
-- role and a hashed link token. Nothing here is granted to anon.
--
-- The retention period is a placeholder until the owner decides it
-- (sign_settings.retention_years, default 7). Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Capabilities
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('menu.sign',      'agent', 'database'),
  ('sign.send',      'agent', 'database'),
  ('sign.void',      'agent', 'app'),
  ('sign.templates', 'agent', 'database'),
  ('sign.settings',  'agent', 'database'),
  ('sign.sign',      'agent', 'app')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'menu.sign'),
  ('admin', 'menu.sign'),
  ('agent', 'menu.sign'),
  ('owner', 'sign.send'),
  ('admin', 'sign.send'),
  ('agent', 'sign.send'),
  ('owner', 'sign.void'),
  ('admin', 'sign.void'),
  ('owner', 'sign.templates'),
  ('admin', 'sign.templates'),
  ('owner', 'sign.settings'),
  ('admin', 'sign.settings'),
  ('owner', 'sign.sign'),
  ('admin', 'sign.sign')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Platform flags: off everywhere until the operator turns them on
-- ------------------------------------------------------------
UPDATE public.account_platform
SET features = features || '{"sign": false}'::jsonb
WHERE NOT (features ? 'sign');

UPDATE public.account_platform
SET features = features || '{"sign_merchant": false}'::jsonb
WHERE NOT (features ? 'sign_merchant');

CREATE OR REPLACE FUNCTION public.account_platform_seed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.account_platform (account_id, features)
  VALUES (NEW.id,
          '{"incidents": false, "jira": false, "vircle_chat": false, "sign": false, "sign_merchant": false}'::jsonb)
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block signup; readers treat a missing row as active/all-features.
  RAISE WARNING 'account_platform_seed failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.account_platform_seed() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_platform_seed() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Tables
-- ------------------------------------------------------------

-- Per-workspace counter behind the document reference (SGN-2026-000123).
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS sign_seq INTEGER NOT NULL DEFAULT 0;

-- 3.1 Settings: one row per workspace (the app creates it on first use).
CREATE TABLE IF NOT EXISTS public.sign_certificates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name           TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  subject        TEXT,
  valid_until    TIMESTAMPTZ,
  -- Encrypted by the app (key ring); never readable from the browser.
  p12_enc        TEXT NOT NULL,
  passphrase_enc TEXT NOT NULL,
  is_default     BOOLEAN NOT NULL DEFAULT FALSE,
  created_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sign_certificates_one_default
  ON public.sign_certificates (account_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS public.sign_settings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  default_expiry_days INTEGER NOT NULL DEFAULT 14 CHECK (default_expiry_days BETWEEN 1 AND 365),
  reminder_days       INTEGER[] NOT NULL DEFAULT '{3,7}',
  default_language    TEXT NOT NULL DEFAULT 'en' CHECK (default_language IN ('en', 'ms', 'zh', 'ko')),
  consent_texts       JSONB NOT NULL DEFAULT '{}'::jsonb,
  sender_name         TEXT CHECK (sender_name IS NULL OR length(sender_name) <= 120),
  logo_path           TEXT,
  -- Placeholder until the owner decides the retention period (plan section 15).
  retention_years     INTEGER NOT NULL DEFAULT 7 CHECK (retention_years BETWEEN 1 AND 50),
  certificate_id      UUID REFERENCES public.sign_certificates(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_settings_account_key UNIQUE (account_id)
);

-- 3.2 Categories and add-ons
CREATE TABLE IF NOT EXISTS public.sign_categories (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key            TEXT NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name           TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description    TEXT,
  -- Presets. NULL means "use the workspace setting". The sender can change all of them on a document.
  expiry_days    INTEGER CHECK (expiry_days IS NULL OR expiry_days BETWEEN 1 AND 365),
  reminder_days  INTEGER[],
  code_required  BOOLEAN NOT NULL DEFAULT FALSE,
  sign_in_order  BOOLEAN NOT NULL DEFAULT FALSE,
  consent_text   JSONB,
  retention_years INTEGER CHECK (retention_years IS NULL OR retention_years BETWEEN 1 AND 50),
  -- Set when an add-on created the category.
  addon_key      TEXT,
  position       INTEGER NOT NULL DEFAULT 0,
  archived       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_categories_key UNIQUE (account_id, key),
  CONSTRAINT sign_categories_id_account UNIQUE (id, account_id)
);

CREATE TABLE IF NOT EXISTS public.sign_addons (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  addon_key         TEXT NOT NULL CHECK (addon_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  installed_version TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'removed')),
  installed_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  installed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_addons_key UNIQUE (account_id, addon_key)
);

-- 3.3 Templates and their immutable versions
CREATE TABLE IF NOT EXISTS public.sign_templates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name               TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description        TEXT,
  category_id        UUID,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  current_version_id UUID,
  tags               TEXT[] NOT NULL DEFAULT '{}',
  -- Set when an add-on installed it; an installer never overwrites one that was edited.
  addon_key          TEXT,
  addon_version      TEXT,
  customised         BOOLEAN NOT NULL DEFAULT FALSE,
  created_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_templates_id_account UNIQUE (id, account_id),
  CONSTRAINT sign_templates_category_fk FOREIGN KEY (category_id, account_id)
    REFERENCES public.sign_categories (id, account_id)
);
CREATE INDEX IF NOT EXISTS sign_templates_account_idx ON public.sign_templates (account_id, status);

CREATE TABLE IF NOT EXISTS public.sign_template_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  template_id   UUID NOT NULL,
  version_no    INTEGER NOT NULL CHECK (version_no >= 1),
  -- The PDF that is edited and signed. Word files are converted first; the original is kept.
  source_path   TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  original_path TEXT,
  original_type TEXT,
  page_count    INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 200),
  fields        JSONB NOT NULL DEFAULT '[]'::jsonb,
  roles         JSONB NOT NULL DEFAULT '[]'::jsonb,
  defaults      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_template_versions_no UNIQUE (template_id, version_no),
  CONSTRAINT sign_template_versions_id_account UNIQUE (id, account_id),
  CONSTRAINT sign_template_versions_template_fk FOREIGN KEY (template_id, account_id)
    REFERENCES public.sign_templates (id, account_id) ON DELETE CASCADE
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_templates_current_version_fk') THEN
    ALTER TABLE public.sign_templates
      ADD CONSTRAINT sign_templates_current_version_fk FOREIGN KEY (current_version_id)
      REFERENCES public.sign_template_versions (id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3.4 Documents
CREATE TABLE IF NOT EXISTS public.sign_documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  reference           TEXT,
  title               TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                        ('draft', 'sent', 'in_progress', 'sealing', 'completed', 'declined', 'expired', 'voided', 'failed')),
  category_id         UUID,
  template_version_id UUID REFERENCES public.sign_template_versions(id) ON DELETE SET NULL,
  contact_id          UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  ticket_id           UUID REFERENCES public.tickets(id) ON DELETE SET NULL,
  deal_id             UUID REFERENCES public.deals(id) ON DELETE SET NULL,
  merge_values        JSONB NOT NULL DEFAULT '{}'::jsonb,
  fields_snapshot     JSONB NOT NULL DEFAULT '[]'::jsonb,
  roles_snapshot      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- "This document needs signing order": off by default; fixed once sent.
  sign_in_order       BOOLEAN NOT NULL DEFAULT FALSE,
  code_required       BOOLEAN NOT NULL DEFAULT FALSE,
  locale              TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ms', 'zh', 'ko')),
  message             TEXT CHECK (message IS NULL OR length(message) <= 2000),
  expires_at          TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  retain_until        TIMESTAMPTZ,
  -- The upload as received (a Word file stays here), the PDF that is signed, and the sealed result.
  original_path       TEXT,
  original_type       TEXT,
  original_sha256     TEXT CHECK (original_sha256 IS NULL OR original_sha256 ~ '^[0-9a-f]{64}$'),
  base_path           TEXT,
  base_sha256         TEXT CHECK (base_sha256 IS NULL OR base_sha256 ~ '^[0-9a-f]{64}$'),
  page_count          INTEGER CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 200),
  final_path          TEXT,
  final_sha256        TEXT CHECK (final_sha256 IS NULL OR final_sha256 ~ '^[0-9a-f]{64}$'),
  void_reason         TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 1000),
  created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_documents_id_account UNIQUE (id, account_id),
  CONSTRAINT sign_documents_reference UNIQUE (account_id, reference),
  CONSTRAINT sign_documents_category_fk FOREIGN KEY (category_id, account_id)
    REFERENCES public.sign_categories (id, account_id)
);
CREATE INDEX IF NOT EXISTS sign_documents_list_idx ON public.sign_documents (account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS sign_documents_contact_idx ON public.sign_documents (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sign_documents_expiry_idx ON public.sign_documents (expires_at)
  WHERE status IN ('sent', 'in_progress');

CREATE TABLE IF NOT EXISTS public.sign_document_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  document_id UUID NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('source', 'converted', 'annex', 'signer_upload', 'signed', 'certificate')),
  signer_id   UUID,
  path        TEXT NOT NULL,
  name        TEXT NOT NULL,
  mime        TEXT,
  size_bytes  BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sha256      TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_document_files_doc_fk FOREIGN KEY (document_id, account_id)
    REFERENCES public.sign_documents (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sign_document_files_doc_idx ON public.sign_document_files (document_id);

-- 3.5 Signers. The link token and code hashes live in a separate table the browser can never read.
CREATE TABLE IF NOT EXISTS public.sign_signers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  document_id       UUID NOT NULL,
  role_key          TEXT NOT NULL CHECK (length(role_key) BETWEEN 1 AND 40),
  -- A signer signs; a filler completes fields and never reaches the sign step.
  kind              TEXT NOT NULL DEFAULT 'signer' CHECK (kind IN ('signer', 'filler')),
  full_name         TEXT NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 160),
  email             TEXT NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  phone             TEXT CHECK (phone IS NULL OR length(phone) <= 32),
  channel           TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'whatsapp')),
  -- Used only when the document needs signing order; one person per number in phase 1.
  order_no          INTEGER NOT NULL DEFAULT 1 CHECK (order_no >= 1),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'viewed', 'signed', 'declined')),
  -- An internal countersigner signs inside Halo.
  internal_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  invited_at        TIMESTAMPTZ,
  viewed_at         TIMESTAMPTZ,
  signed_at         TIMESTAMPTZ,
  declined_at       TIMESTAMPTZ,
  decline_reason    TEXT CHECK (decline_reason IS NULL OR length(decline_reason) <= 1000),
  ip                TEXT,
  device            TEXT,
  locale            TEXT CHECK (locale IS NULL OR locale IN ('en', 'ms', 'zh', 'ko')),
  consent_version   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_signers_id_account UNIQUE (id, account_id),
  CONSTRAINT sign_signers_doc_fk FOREIGN KEY (document_id, account_id)
    REFERENCES public.sign_documents (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sign_signers_doc_idx ON public.sign_signers (document_id, order_no);
CREATE INDEX IF NOT EXISTS sign_signers_email_idx ON public.sign_signers (account_id, lower(email));

CREATE TABLE IF NOT EXISTS public.sign_signer_secrets (
  signer_id        UUID PRIMARY KEY,
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- SHA-256 of the random link token; the token itself is only ever in the message sent.
  token_hash       TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  code_hash        TEXT,
  code_expires_at  TIMESTAMPTZ,
  code_attempts    INTEGER NOT NULL DEFAULT 0 CHECK (code_attempts >= 0),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_signer_secrets_signer_fk FOREIGN KEY (signer_id, account_id)
    REFERENCES public.sign_signers (id, account_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS sign_signer_secrets_token_idx ON public.sign_signer_secrets (token_hash);

-- One row per document and step actually invited, so two signers finishing at the same moment
-- invite the next step once.
CREATE TABLE IF NOT EXISTS public.sign_step_invites (
  document_id UUID NOT NULL,
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  step        INTEGER NOT NULL CHECK (step >= 1),
  invited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (document_id, step),
  CONSTRAINT sign_step_invites_doc_fk FOREIGN KEY (document_id, account_id)
    REFERENCES public.sign_documents (id, account_id) ON DELETE CASCADE
);

-- Everything entered on a document. In phase 1 these are the values of the placed fields.
CREATE TABLE IF NOT EXISTS public.sign_answers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  document_id UUID NOT NULL,
  signer_id   UUID NOT NULL,
  field_key   TEXT NOT NULL CHECK (length(field_key) BETWEEN 1 AND 80),
  value       JSONB,
  file_path   TEXT,
  source      TEXT NOT NULL DEFAULT 'signer' CHECK (source IN ('signer', 'sender', 'contact', 'forwarded')),
  sensitive   BOOLEAN NOT NULL DEFAULT FALSE,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_answers_unique UNIQUE (document_id, signer_id, field_key),
  CONSTRAINT sign_answers_doc_fk FOREIGN KEY (document_id, account_id)
    REFERENCES public.sign_documents (id, account_id) ON DELETE CASCADE,
  CONSTRAINT sign_answers_signer_fk FOREIGN KEY (signer_id, account_id)
    REFERENCES public.sign_signers (id, account_id) ON DELETE CASCADE
);

-- 3.6 The audit chain. No foreign key on the people: a deleted login must not touch a logged row.
CREATE TABLE IF NOT EXISTS public.sign_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL,
  doc_seq       INTEGER NOT NULL DEFAULT 0,
  signer_id     UUID,
  type          TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 60),
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('user', 'signer', 'system')),
  actor_user_id UUID,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip            TEXT,
  device        TEXT,
  prev_hash     TEXT NOT NULL DEFAULT '',
  row_hash      TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_events_doc_seq UNIQUE (document_id, doc_seq),
  CONSTRAINT sign_events_doc_fk FOREIGN KEY (document_id, account_id)
    REFERENCES public.sign_documents (id, account_id) ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- 4. Row level security
--    Reading follows menu.sign. Writes by people are limited to what the capability
--    guards; everything about a document in flight (status, signers, answers, events)
--    is written by the server with the service role.
-- ------------------------------------------------------------
ALTER TABLE public.sign_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_certificates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_categories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_addons            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_templates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_document_files    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_signers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_signer_secrets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_step_invites      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_answers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sign_events            ENABLE ROW LEVEL SECURITY;

-- Server only (no policy, no privilege for the API roles): certificates with their encrypted
-- keys, and the signer link hashes.
REVOKE ALL ON public.sign_certificates   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sign_signer_secrets FROM PUBLIC, anon, authenticated;

-- Read-only for people: the server writes these.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sign_addons', 'sign_document_files', 'sign_signers', 'sign_step_invites',
                           'sign_answers', 'sign_events']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (has_capability(account_id, %L))',
                   t || '_select', t, 'menu.sign');
  END LOOP;
END $$;

-- Settings and categories: sign.settings.
DROP POLICY IF EXISTS sign_settings_select ON public.sign_settings;
DROP POLICY IF EXISTS sign_settings_insert ON public.sign_settings;
DROP POLICY IF EXISTS sign_settings_update ON public.sign_settings;
CREATE POLICY sign_settings_select ON public.sign_settings
  FOR SELECT USING (has_capability(account_id, 'menu.sign'));
CREATE POLICY sign_settings_insert ON public.sign_settings
  FOR INSERT WITH CHECK (has_capability(account_id, 'sign.settings'));
CREATE POLICY sign_settings_update ON public.sign_settings
  FOR UPDATE USING (has_capability(account_id, 'sign.settings'))
  WITH CHECK (has_capability(account_id, 'sign.settings'));

DROP POLICY IF EXISTS sign_categories_select ON public.sign_categories;
DROP POLICY IF EXISTS sign_categories_insert ON public.sign_categories;
DROP POLICY IF EXISTS sign_categories_update ON public.sign_categories;
CREATE POLICY sign_categories_select ON public.sign_categories
  FOR SELECT USING (has_capability(account_id, 'menu.sign'));
CREATE POLICY sign_categories_insert ON public.sign_categories
  FOR INSERT WITH CHECK (has_capability(account_id, 'sign.settings'));
CREATE POLICY sign_categories_update ON public.sign_categories
  FOR UPDATE USING (has_capability(account_id, 'sign.settings'))
  WITH CHECK (has_capability(account_id, 'sign.settings'));
-- No delete: a category is archived, so documents keep their label.

-- Templates: sign.templates. A version, once written, never changes.
DROP POLICY IF EXISTS sign_templates_select ON public.sign_templates;
DROP POLICY IF EXISTS sign_templates_insert ON public.sign_templates;
DROP POLICY IF EXISTS sign_templates_update ON public.sign_templates;
DROP POLICY IF EXISTS sign_templates_delete ON public.sign_templates;
CREATE POLICY sign_templates_select ON public.sign_templates
  FOR SELECT USING (has_capability(account_id, 'menu.sign'));
CREATE POLICY sign_templates_insert ON public.sign_templates
  FOR INSERT WITH CHECK (has_capability(account_id, 'sign.templates'));
CREATE POLICY sign_templates_update ON public.sign_templates
  FOR UPDATE USING (has_capability(account_id, 'sign.templates'))
  WITH CHECK (has_capability(account_id, 'sign.templates'));
CREATE POLICY sign_templates_delete ON public.sign_templates
  FOR DELETE USING (has_capability(account_id, 'sign.templates'));

DROP POLICY IF EXISTS sign_template_versions_select ON public.sign_template_versions;
DROP POLICY IF EXISTS sign_template_versions_insert ON public.sign_template_versions;
CREATE POLICY sign_template_versions_select ON public.sign_template_versions
  FOR SELECT USING (has_capability(account_id, 'menu.sign'));
CREATE POLICY sign_template_versions_insert ON public.sign_template_versions
  FOR INSERT WITH CHECK (has_capability(account_id, 'sign.templates'));

-- Documents: a person prepares drafts (sign.send). Sending, signing, sealing, voiding are the server's.
DROP POLICY IF EXISTS sign_documents_select ON public.sign_documents;
DROP POLICY IF EXISTS sign_documents_insert ON public.sign_documents;
DROP POLICY IF EXISTS sign_documents_update ON public.sign_documents;
DROP POLICY IF EXISTS sign_documents_delete ON public.sign_documents;
CREATE POLICY sign_documents_select ON public.sign_documents
  FOR SELECT USING (has_capability(account_id, 'menu.sign'));
CREATE POLICY sign_documents_insert ON public.sign_documents
  FOR INSERT WITH CHECK (has_capability(account_id, 'sign.send') AND status = 'draft' AND created_by = auth.uid());
CREATE POLICY sign_documents_update ON public.sign_documents
  FOR UPDATE USING (has_capability(account_id, 'sign.send') AND status = 'draft')
  WITH CHECK (has_capability(account_id, 'sign.send') AND status = 'draft');
CREATE POLICY sign_documents_delete ON public.sign_documents
  FOR DELETE USING (has_capability(account_id, 'sign.send') AND status = 'draft');

-- ------------------------------------------------------------
-- 5. updated_at and audit triggers
-- ------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sign_settings', 'sign_certificates', 'sign_categories', 'sign_addons',
                           'sign_templates', 'sign_documents', 'sign_signers', 'sign_signer_secrets']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON public.%I', t);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS audit_row_change ON public.sign_templates;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_templates
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'sign_template', 'name', 'name,status,category_id', 'description,tags', '', 'created_by');

DROP TRIGGER IF EXISTS audit_row_change ON public.sign_categories;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_categories
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'sign_category', 'name', 'name,archived,expiry_days,code_required,sign_in_order,retention_years', 'description,consent_text', '', '');

DROP TRIGGER IF EXISTS audit_row_change ON public.sign_settings;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_settings
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'sign_settings', '=Doc Sign settings', 'default_expiry_days,default_language,retention_years,certificate_id',
    'sender_name,logo_path,consent_texts,reminder_days', '', '');

DROP TRIGGER IF EXISTS audit_row_change ON public.sign_certificates;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_certificates
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'sign_certificate', 'name', 'name,is_default,valid_until', 'p12_enc,passphrase_enc,subject', '', 'created_by');

DROP TRIGGER IF EXISTS audit_row_change ON public.sign_addons;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_addons
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'sign_addon', 'addon_key', 'installed_version,status', '', '', 'installed_by');

DROP TRIGGER IF EXISTS audit_row_change ON public.sign_documents;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.sign_documents
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'sign_document', 'title', 'title,status,category_id', '', '', 'created_by');

-- ------------------------------------------------------------
-- 6. Documents: reference, status moves, frozen content
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_documents_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq INTEGER;
  v_ok  BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'sign_document_must_start_as_draft' USING ERRCODE = '23514';
    END IF;
    IF NEW.reference IS NULL OR NEW.reference = '' THEN
      UPDATE public.accounts SET sign_seq = sign_seq + 1 WHERE id = NEW.account_id
        RETURNING sign_seq INTO v_seq;
      IF v_seq IS NULL THEN
        RAISE EXCEPTION 'Account % not found', NEW.account_id USING ERRCODE = '22023';
      END IF;
      NEW.reference := 'SGN-' || to_char(now() AT TIME ZONE 'utc', 'YYYY') || '-' || lpad(v_seq::text, 6, '0');
    END IF;
    RETURN NEW;
  END IF;

  -- The reference never changes.
  IF NEW.reference IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION 'sign_document_reference_is_fixed' USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_ok := CASE OLD.status
      WHEN 'draft'       THEN NEW.status IN ('sent', 'voided')
      WHEN 'sent'        THEN NEW.status IN ('in_progress', 'sealing', 'declined', 'expired', 'voided')
      WHEN 'in_progress' THEN NEW.status IN ('sealing', 'declined', 'expired', 'voided')
      WHEN 'sealing'     THEN NEW.status IN ('completed', 'failed', 'voided')
      WHEN 'failed'      THEN NEW.status IN ('sealing', 'voided')
      ELSE FALSE
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'invalid_sign_status_move' USING ERRCODE = '23514',
        DETAIL = format('%s -> %s', OLD.status, NEW.status);
    END IF;
    IF NEW.status = 'sent' THEN
      IF NEW.base_path IS NULL OR NEW.base_sha256 IS NULL THEN
        RAISE EXCEPTION 'sign_document_needs_a_base_file_to_send' USING ERRCODE = '23514';
      END IF;
      NEW.sent_at := COALESCE(NEW.sent_at, now());
    ELSIF NEW.status = 'completed' THEN
      IF NEW.final_path IS NULL OR NEW.final_sha256 IS NULL THEN
        RAISE EXCEPTION 'sign_document_needs_a_final_file_to_complete' USING ERRCODE = '23514';
      END IF;
      NEW.completed_at := COALESCE(NEW.completed_at, now());
    END IF;
  END IF;

  -- Once sent, what the signers were shown cannot change.
  IF OLD.status <> 'draft' AND (
       NEW.title               IS DISTINCT FROM OLD.title
    OR NEW.category_id         IS DISTINCT FROM OLD.category_id
    -- (cleared to NULL when its template is deleted: the document keeps its own snapshot)
    OR (NEW.template_version_id IS DISTINCT FROM OLD.template_version_id AND NEW.template_version_id IS NOT NULL)
    OR NEW.merge_values       IS DISTINCT FROM OLD.merge_values
    OR NEW.fields_snapshot     IS DISTINCT FROM OLD.fields_snapshot
    OR NEW.roles_snapshot      IS DISTINCT FROM OLD.roles_snapshot
    OR NEW.sign_in_order       IS DISTINCT FROM OLD.sign_in_order
    OR NEW.code_required       IS DISTINCT FROM OLD.code_required
    OR NEW.original_path       IS DISTINCT FROM OLD.original_path
    OR NEW.original_sha256     IS DISTINCT FROM OLD.original_sha256
    OR NEW.base_path           IS DISTINCT FROM OLD.base_path
    OR NEW.base_sha256         IS DISTINCT FROM OLD.base_sha256
    OR NEW.page_count          IS DISTINCT FROM OLD.page_count
  ) THEN
    RAISE EXCEPTION 'sign_document_is_frozen' USING ERRCODE = '23514',
      DETAIL = 'A document that was sent cannot be edited. Void it and send a new one.';
  END IF;

  -- The sealed file is written once.
  IF OLD.final_path IS NOT NULL AND (
       NEW.final_path   IS DISTINCT FROM OLD.final_path
    OR NEW.final_sha256 IS DISTINCT FROM OLD.final_sha256
  ) THEN
    RAISE EXCEPTION 'sign_document_final_file_is_write_once' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_documents_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_documents_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_documents_guard ON public.sign_documents;
CREATE TRIGGER sign_documents_guard
  BEFORE INSERT OR UPDATE ON public.sign_documents
  FOR EACH ROW EXECUTE FUNCTION public.sign_documents_guard();

-- A document that was sent is never deleted (void it); only a workspace purge (153) may.
CREATE OR REPLACE FUNCTION public.sign_documents_no_hard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN OLD;
  END IF;
  IF current_user NOT IN ('anon', 'authenticated', 'service_role')
     AND current_setting('vircle.purge_account', true) = OLD.account_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'sign_document_cannot_be_deleted' USING ERRCODE = '42501',
    DETAIL = 'Only a draft can be deleted. Void a document that was sent.';
END;
$$;

DROP TRIGGER IF EXISTS sign_documents_no_hard_delete ON public.sign_documents;
CREATE TRIGGER sign_documents_no_hard_delete
  BEFORE DELETE ON public.sign_documents
  FOR EACH ROW EXECUTE FUNCTION public.sign_documents_no_hard_delete();

-- A template version is immutable.
CREATE OR REPLACE FUNCTION public.sign_template_versions_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'sign_template_version_is_immutable' USING ERRCODE = '42501',
    DETAIL = 'Save a new version instead.';
END;
$$;

DROP TRIGGER IF EXISTS sign_template_versions_immutable ON public.sign_template_versions;
CREATE TRIGGER sign_template_versions_immutable
  BEFORE UPDATE ON public.sign_template_versions
  FOR EACH ROW EXECUTE FUNCTION public.sign_template_versions_immutable();

-- ------------------------------------------------------------
-- 7. The audit chain
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_event_hash(
  p_prev    TEXT,
  p_doc     UUID,
  p_seq     INTEGER,
  p_type    TEXT,
  p_actor   TEXT,
  p_signer  UUID,
  p_user    UUID,
  p_detail  JSONB,
  p_at      TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    p_prev, p_doc::text, p_seq::text, p_type, p_actor,
    COALESCE(p_signer::text, ''), COALESCE(p_user::text, ''),
    p_detail::text,
    to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'UTF8')), 'hex');
$$;
REVOKE ALL ON FUNCTION public.sign_event_hash(TEXT, UUID, INTEGER, TEXT, TEXT, UUID, UUID, JSONB, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;

-- Links each event to the one before it, under a per-document lock so two events written at
-- the same moment still form one chain. Whatever the writer put in the chain columns is replaced.
CREATE OR REPLACE FUNCTION public.sign_events_chain()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev TEXT;
  v_seq  INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('sign_events:' || NEW.document_id::text, 0));
  SELECT e.row_hash, e.doc_seq INTO v_prev, v_seq
    FROM public.sign_events e
   WHERE e.document_id = NEW.document_id
   ORDER BY e.doc_seq DESC
   LIMIT 1;
  NEW.doc_seq    := COALESCE(v_seq, 0) + 1;
  NEW.prev_hash  := COALESCE(v_prev, repeat('0', 64));
  NEW.created_at := clock_timestamp();
  NEW.row_hash   := public.sign_event_hash(NEW.prev_hash, NEW.document_id, NEW.doc_seq, NEW.type,
                                           NEW.actor_type, NEW.signer_id, NEW.actor_user_id,
                                           NEW.detail, NEW.created_at);
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_events_chain() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_events_chain() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_events_chain ON public.sign_events;
CREATE TRIGGER sign_events_chain
  BEFORE INSERT ON public.sign_events
  FOR EACH ROW EXECUTE FUNCTION public.sign_events_chain();

-- Append-only, with the same narrow exceptions as the audit log (153): a workspace being purged,
-- and the rows of a draft that was deleted (the parent row is already gone when the cascade runs).
CREATE OR REPLACE FUNCTION public.sign_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' THEN
    IF current_user NOT IN ('anon', 'authenticated', 'service_role')
       AND current_setting('vircle.purge_account', true) = OLD.account_id::text THEN
      RETURN OLD;
    END IF;
    IF current_user NOT IN ('anon', 'authenticated', 'service_role')
       AND NOT EXISTS (SELECT 1 FROM public.sign_documents d WHERE d.id = OLD.document_id) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'sign_events is append-only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS sign_events_no_change ON public.sign_events;
CREATE TRIGGER sign_events_no_change
  BEFORE UPDATE OR DELETE ON public.sign_events
  FOR EACH ROW EXECUTE FUNCTION public.sign_events_append_only();

DROP TRIGGER IF EXISTS sign_events_no_truncate ON public.sign_events;
CREATE TRIGGER sign_events_no_truncate
  BEFORE TRUNCATE ON public.sign_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.sign_events_append_only();

-- Recompute a document's chain. {"ok": true, "events": n, "head": "..."} or {"ok": false, "broken_at": seq}.
CREATE OR REPLACE FUNCTION public.sign_verify_chain(p_document UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_prev    TEXT := repeat('0', 64);
  v_expect  INTEGER := 1;
  v_n       INTEGER := 0;
  r         RECORD;
BEGIN
  SELECT d.account_id INTO v_account FROM public.sign_documents d WHERE d.id = p_document;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Document not found' USING ERRCODE = '22023';
  END IF;
  -- The service role (the app's own checks) has no auth.uid().
  IF auth.uid() IS NOT NULL AND NOT public.has_capability(v_account, 'menu.sign') THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  FOR r IN SELECT * FROM public.sign_events e WHERE e.document_id = p_document ORDER BY e.doc_seq LOOP
    v_n := v_n + 1;
    IF r.doc_seq <> v_expect
       OR r.prev_hash <> v_prev
       OR r.row_hash <> public.sign_event_hash(r.prev_hash, r.document_id, r.doc_seq, r.type, r.actor_type,
                                               r.signer_id, r.actor_user_id, r.detail, r.created_at) THEN
      RETURN jsonb_build_object('ok', false, 'events', v_n, 'broken_at', r.doc_seq);
    END IF;
    v_prev := r.row_hash;
    v_expect := v_expect + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'events', v_n, 'head', v_prev);
END;
$$;
ALTER FUNCTION public.sign_verify_chain(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_verify_chain(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sign_verify_chain(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 8. Starting categories (created the first time a workspace opens Doc Sign)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_ensure_defaults(p_account UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.sign_settings (account_id) VALUES (p_account)
  ON CONFLICT (account_id) DO NOTHING;

  INSERT INTO public.sign_categories (account_id, key, name, position) VALUES
    (p_account, 'merchant_agreements', 'Merchant agreements', 1),
    (p_account, 'nda',                 'NDA',                 2),
    (p_account, 'partnership',         'Partnership',         3),
    (p_account, 'sales',               'Sales',               4)
  ON CONFLICT (account_id, key) DO NOTHING;
END;
$$;
ALTER FUNCTION public.sign_ensure_defaults(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_ensure_defaults(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_ensure_defaults(UUID) TO service_role;

-- ------------------------------------------------------------
-- 9. Storage: a private bucket only the server touches
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sign-documents',
  'sign-documents',
  FALSE,
  26214400, -- 25 MB
  ARRAY[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg'
  ]
)
ON CONFLICT (id) DO UPDATE
SET public = FALSE,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ------------------------------------------------------------
-- 10. Usage: documents sent this month, for `sign_documents_per_month`
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_usage(p_account UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month_start TIMESTAMPTZ := date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc';
  v_storage     BIGINT;
  v_measured    TIMESTAMPTZ;
BEGIN
  -- The service role (the app's own checks) has no auth.uid(); a person must be an
  -- admin of this workspace (the capability that also reads the daily table) or an operator.
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_capability(p_account, 'settings.workspace') OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT d.storage_bytes, d.measured_at INTO v_storage, v_measured
    FROM public.account_usage_daily d
   WHERE d.account_id = p_account
   ORDER BY d.day DESC LIMIT 1;

  RETURN jsonb_build_object(
    'contacts',        (SELECT count(*) FROM public.contacts c WHERE c.account_id = p_account AND c.deleted_at IS NULL),
    'members',         (SELECT count(*) FROM public.profiles p WHERE p.account_id = p_account),
    'conversations',   (SELECT count(*) FROM public.conversations v WHERE v.account_id = p_account),
    'messages_month',  (SELECT count(*) FROM public.messages m
                         WHERE m.account_id = p_account AND m.created_at >= v_month_start
                           AND m.sender_type IN ('agent', 'bot') AND NOT m.is_internal AND m.status <> 'failed'),
    'ai_tokens_month', COALESCE((SELECT sum(l.total_tokens) FROM public.ai_usage_log l
                                  WHERE l.account_id = p_account AND l.created_at >= v_month_start), 0),
    'sign_documents_month', (SELECT count(*) FROM public.sign_documents s
                              WHERE s.account_id = p_account AND s.sent_at >= v_month_start),
    'storage_bytes',   COALESCE(v_storage, 0),
    'storage_measured_at', v_measured,
    'limits',          COALESCE((SELECT ap.limits FROM public.account_platform ap WHERE ap.account_id = p_account), '{}'::jsonb)
  );
END;
$$;
ALTER FUNCTION public.account_usage(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_usage(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_usage(UUID) TO authenticated, service_role;
