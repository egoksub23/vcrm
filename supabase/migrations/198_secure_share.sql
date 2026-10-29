-- ============================================================
-- 198_secure_share.sql
--
-- Secure Share: DocSend-style tracked document sharing.
--
-- share_links      — one record per shareable file, holds the token hash,
--                    gate type, download toggle and view counter.
-- share_link_secrets — OTP and gate-email state for the link (Phase 2).
-- share_views      — one row per visit: ip, agent, page dwell times.
--
-- The `share-files` bucket (private) stores the uploaded files.
-- Only the service role reads/writes secrets and views; members can
-- SELECT their own links through RLS.
-- ============================================================

-- ============================================================
-- 1. Tables
-- ============================================================

CREATE TABLE public.share_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_by       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id       uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  title            text NOT NULL,
  file_path        text NOT NULL,
  file_name        text NOT NULL,
  file_size        bigint NOT NULL,
  content_type     text NOT NULL DEFAULT 'application/pdf',
  token            text NOT NULL UNIQUE,   -- raw token, readable by account members only (RLS)
  token_hash       text NOT NULL UNIQUE,   -- SHA-256 of token, used for public lookup
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'revoked')),
  gate_type        text NOT NULL DEFAULT 'none'
                     CHECK (gate_type IN ('none', 'email', 'otp')),
  download_enabled boolean NOT NULL DEFAULT true,
  expires_at       timestamptz,
  first_opened_at  timestamptz,
  view_count       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.share_link_secrets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id        uuid NOT NULL UNIQUE REFERENCES public.share_links(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL,
  otp_hash        text,
  otp_expires_at  timestamptz,
  otp_attempts    integer NOT NULL DEFAULT 0,
  gate_email      text,
  gate_email_at   timestamptz
);

CREATE TABLE public.share_views (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id     uuid NOT NULL REFERENCES public.share_links(id) ON DELETE CASCADE,
  viewer_email text,
  ip           text,
  user_agent   text,
  viewed_at    timestamptz NOT NULL DEFAULT now(),
  duration_ms  integer,
  page_dwells  jsonb
);

-- ============================================================
-- 2. Indexes
-- ============================================================

CREATE INDEX share_links_account_id_idx   ON public.share_links(account_id);
CREATE INDEX share_links_contact_id_idx   ON public.share_links(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX share_links_token_hash_idx   ON public.share_links(token_hash);
CREATE INDEX share_views_share_id_idx     ON public.share_views(share_id);

-- ============================================================
-- 3. updated_at trigger
-- ============================================================

CREATE OR REPLACE FUNCTION public.share_links_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER share_links_updated_at
  BEFORE UPDATE ON public.share_links
  FOR EACH ROW EXECUTE FUNCTION public.share_links_set_updated_at();

-- ============================================================
-- 4. Storage bucket
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'share-files',
  'share-files',
  false,
  26214400,  -- 25 MB
  ARRAY['application/pdf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 5. Token issuance function
-- ============================================================

CREATE OR REPLACE FUNCTION public.share_issue_token(
  p_account_id       uuid,
  p_created_by       uuid,
  p_title            text,
  p_file_path        text,
  p_file_name        text,
  p_file_size        bigint,
  p_contact_id       uuid    DEFAULT NULL,
  p_gate_type        text    DEFAULT 'none',
  p_download_enabled boolean DEFAULT true,
  p_expires_at       timestamptz DEFAULT NULL
)
RETURNS TABLE (id uuid, token text)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_token      text;
  v_token_hash text;
  v_id         uuid;
BEGIN
  -- 64 hex chars = 32 random bytes
  v_token      := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(sha256(v_token::bytea), 'hex');

  INSERT INTO public.share_links (
    account_id, created_by, contact_id, title,
    file_path, file_name, file_size, content_type,
    token, token_hash, gate_type, download_enabled, expires_at
  )
  VALUES (
    p_account_id, p_created_by, p_contact_id, p_title,
    p_file_path, p_file_name, p_file_size,
    CASE
      WHEN p_file_name ILIKE '%.pptx' THEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      ELSE 'application/pdf'
    END,
    v_token, v_token_hash, p_gate_type, p_download_enabled, p_expires_at
  )
  RETURNING share_links.id INTO v_id;

  INSERT INTO public.share_link_secrets (share_id, account_id)
  VALUES (v_id, p_account_id);

  id    := v_id;
  token := v_token;
  RETURN NEXT;
END;
$$;

-- ============================================================
-- 6. RLS
-- ============================================================

ALTER TABLE public.share_links        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_link_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_views        ENABLE ROW LEVEL SECURITY;

-- share_links: members SELECT their account's links
CREATE POLICY share_links_select ON public.share_links
  FOR SELECT TO authenticated
  USING (is_account_member(account_id));

-- share_links INSERT/UPDATE require share.send capability
CREATE POLICY share_links_insert ON public.share_links
  FOR INSERT TO authenticated
  WITH CHECK (has_capability(auth.uid(), account_id, 'share.send'));

CREATE POLICY share_links_update ON public.share_links
  FOR UPDATE TO authenticated
  USING  (has_capability(auth.uid(), account_id, 'share.send'))
  WITH CHECK (has_capability(auth.uid(), account_id, 'share.send'));

-- share_link_secrets and share_views: service role only
CREATE POLICY share_link_secrets_service ON public.share_link_secrets
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY share_views_service ON public.share_views
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- storage: service role only (files are served through an API route, never direct)
CREATE POLICY share_files_service ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'share-files')
  WITH CHECK (bucket_id = 'share-files');

-- ============================================================
-- 7. Seed: enable share for all existing accounts
--    (missing key reads as on, but be explicit like sign does)
-- ============================================================

UPDATE public.account_platform
SET features = features || '{"share": true}'::jsonb
WHERE features->>'share' IS NULL;
