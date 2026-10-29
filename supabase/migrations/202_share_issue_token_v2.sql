-- ============================================================
-- Migration 202: correct share_issue_token with allowed_emails
--
-- Migration 200's function body was wrong (missing token and
-- content_type columns, wrong share_link_secrets insert, wrong
-- return pattern). This replaces it with the correct body
-- based on the original migration 198 function, adding only
-- the allowed_emails insert.
-- ============================================================

CREATE OR REPLACE FUNCTION public.share_issue_token(
  p_account_id        uuid,
  p_created_by        uuid,
  p_title             text,
  p_file_path         text,
  p_file_name         text,
  p_file_size         bigint,
  p_contact_id        uuid        DEFAULT NULL,
  p_gate_type         text        DEFAULT 'none',
  p_download_enabled  boolean     DEFAULT true,
  p_expires_at        timestamptz DEFAULT NULL,
  p_allowed_emails    text[]      DEFAULT '{}'
)
RETURNS TABLE (id uuid, token text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token      text;
  v_token_hash text;
  v_id         uuid;
BEGIN
  v_token      := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(sha256(v_token::bytea), 'hex');

  INSERT INTO public.share_links (
    account_id, created_by, contact_id, title,
    file_path, file_name, file_size, content_type,
    token, token_hash, gate_type, download_enabled, expires_at,
    allowed_emails
  )
  VALUES (
    p_account_id, p_created_by, p_contact_id, p_title,
    p_file_path, p_file_name, p_file_size,
    CASE
      WHEN p_file_name ILIKE '%.pptx' THEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      ELSE 'application/pdf'
    END,
    v_token, v_token_hash, p_gate_type, p_download_enabled, p_expires_at,
    COALESCE(p_allowed_emails, '{}')
  )
  RETURNING share_links.id INTO v_id;

  INSERT INTO public.share_link_secrets (share_id, account_id)
  VALUES (v_id, p_account_id);

  id    := v_id;
  token := v_token;
  RETURN NEXT;
END;
$$;
