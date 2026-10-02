-- ============================================================
-- 134_invite_only_signup.sql
--
-- Sign-up by invitation only. Vircle (the platform operator) creates a
-- customer workspace and invites its first admin; that admin invites
-- their own team. Until now anyone could open /signup and get a free,
-- empty workspace of their own, because handle_new_user builds one for
-- every new auth user (017).
--
-- A BEFORE INSERT trigger on auth.users lets a new login through only if
-- it is one of:
--   * an anonymous widget visitor (is_anonymous), which never gets a
--     workspace anyway;
--   * created by the platform operator console (app_metadata.provisioned,
--     which only the admin API can set; a browser sign-up cannot);
--   * for an email that has a pending, unexpired email-targeted
--     invitation (including Google / Microsoft sign-in, which carries a
--     verified email);
--   * carrying the plaintext token of a pending, unexpired link
--     invitation in user_metadata.invite_token (the /signup?invite=...
--     page sends it);
--   * or the operator has switched self-service sign-up on
--     (platform_settings.open_signup).
-- Existing logins are untouched (this fires on INSERT only).
--
-- A deployment that already has workspaces keeps today's open behaviour
-- until the operator switches it off (so applying this migration changes
-- nothing by itself); a fresh deployment starts closed.
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.platform_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
-- No policies: only the DEFINER functions below touch it.

INSERT INTO public.platform_settings (key, value)
VALUES ('open_signup', to_jsonb(EXISTS (SELECT 1 FROM public.accounts)))
ON CONFLICT (key) DO NOTHING;

-- Anyone (including the signed-out /signup page) may ask whether
-- self-service sign-up is open. Reveals nothing else.
CREATE OR REPLACE FUNCTION public.signup_is_open()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT (value)::text = 'true' FROM public.platform_settings WHERE key = 'open_signup'), false);
$$;
ALTER FUNCTION public.signup_is_open() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.signup_is_open() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signup_is_open() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.platform_set_open_signup(p_open BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.platform_require_admin();
  IF p_open IS NULL THEN
    RAISE EXCEPTION 'p_open is required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.platform_settings (key, value, updated_at)
  VALUES ('open_signup', to_jsonb(p_open), NOW())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
END;
$$;
ALTER FUNCTION public.platform_set_open_signup(BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_set_open_signup(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_open_signup(BOOLEAN) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_invite_only_signup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token TEXT;
BEGIN
  IF COALESCE(NEW.is_anonymous, false) THEN
    RETURN NEW;
  END IF;

  IF public.signup_is_open() THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.raw_app_meta_data ->> 'provisioned', '') = 'true' THEN
    RETURN NEW;
  END IF;

  IF NEW.email IS NOT NULL AND public.find_pending_email_invitation(NEW.email) IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_token := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'invite_token', '')), '');
  IF v_token IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.account_invitations i
     WHERE i.token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex')
       AND i.accepted_at IS NULL
       AND i.expires_at > NOW()
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Sign-up is by invitation only' USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.enforce_invite_only_signup() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_invite_only_signup() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_invite_only_signup ON auth.users;
CREATE TRIGGER enforce_invite_only_signup
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_invite_only_signup();
