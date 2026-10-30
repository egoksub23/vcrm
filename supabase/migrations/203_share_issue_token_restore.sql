-- ============================================================
-- Migration 203: restore share_issue_token to original signature
--
-- Migrations 200-202 tried to add p_allowed_emails to the RPC.
-- The simpler approach is to leave the RPC untouched and set
-- allowed_emails via a separate UPDATE in the application layer
-- after the share row is created. Restore the original function.
-- ============================================================

DROP FUNCTION IF EXISTS public.share_issue_token(
  uuid, uuid, text, text, text, bigint,
  uuid, text, boolean, timestamptz, text[]
);

CREATE OR REPLACE FUNCTION public.share_issue_token(
  p_account_id       uuid,
  p_created_by       uuid,
  p_title            text,
  p_file_path        text,
  p_file_name        text,
  p_file_size        bigint,
  p_contact_id       uuid        DEFAULT NULL,
  p_gate_type        text        DEFAULT 'none',
  p_download_enabled boolean     DEFAULT true,
  p_expires_at       timestamptz DEFAULT NULL
)
RETURNS TABLE (id uuid, token text)
LANGUAGE plpgsql SECURITY DEFINER AS $$
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
