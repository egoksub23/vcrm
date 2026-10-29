-- ============================================================
-- Migration 200: Secure Share — email allowlist
--
-- Adds `allowed_emails` to share_links so OTP and email-capture
-- gates can be restricted to a specific set of recipients.
-- When the column is NULL or empty the gate stays open (any
-- email gets in), preserving existing behaviour for all existing
-- shares. When one or more addresses are set, only those
-- addresses may request an OTP / submit an email gate.
-- ============================================================

ALTER TABLE share_links
  ADD COLUMN IF NOT EXISTS allowed_emails text[] NOT NULL DEFAULT '{}';

-- Index so the gate route can check containment cheaply
CREATE INDEX IF NOT EXISTS share_links_allowed_emails_gin
  ON share_links USING gin(allowed_emails);

-- Expose via the share_issue_token RPC so the create endpoint
-- can pass the list at creation time
CREATE OR REPLACE FUNCTION share_issue_token(
  p_account_id        uuid,
  p_created_by        uuid,
  p_title             text,
  p_file_path         text,
  p_file_name         text,
  p_file_size         bigint,
  p_contact_id        uuid     DEFAULT NULL,
  p_gate_type         text     DEFAULT 'none',
  p_download_enabled  boolean  DEFAULT true,
  p_expires_at        timestamptz DEFAULT NULL,
  p_allowed_emails    text[]   DEFAULT '{}'
)
RETURNS TABLE (id uuid, token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token      text;
  v_token_hash text;
  v_id         uuid;
BEGIN
  -- generate a URL-safe random token (32 bytes → 43 base64url chars)
  v_token      := encode(gen_random_bytes(32), 'base64');
  v_token      := translate(v_token, '+/=', '-_');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');

  INSERT INTO share_links (
    account_id, created_by, title,
    file_path, file_name, file_size,
    contact_id, token_hash,
    gate_type, download_enabled, expires_at,
    allowed_emails
  ) VALUES (
    p_account_id, p_created_by, p_title,
    p_file_path, p_file_name, p_file_size,
    p_contact_id, v_token_hash,
    p_gate_type, p_download_enabled, p_expires_at,
    COALESCE(p_allowed_emails, '{}')
  )
  RETURNING share_links.id INTO v_id;

  -- secrets row (always created alongside)
  INSERT INTO share_link_secrets (share_id) VALUES (v_id)
  ON CONFLICT (share_id) DO NOTHING;

  RETURN QUERY SELECT v_id, v_token;
END;
$$;
