-- ============================================================
-- Invite by email.
--
-- Today an invite is a shareable link (account_invitations.token_hash),
-- redeemable by whoever has it, with any email — see 017/019/083. This
-- adds an OPTIONAL email target: when an admin invites
-- "someone@company.com" instead of just generating a link, that person
-- is automatically placed into the invited account/role the moment
-- their OWN, VERIFIED email matches — including immediately on a
-- Google/Microsoft SSO sign-in (already-verified by the provider), or
-- once a password-signup confirms their email. No "click the link,
-- hit Accept" step required for that case, though the link still works
-- too (now additionally checked against the invited email).
--
-- Never sends an email itself — there is no outbound transactional-
-- email sender anywhere in this codebase to reuse (checked), and
-- standing one up is a real infra decision (provider, API key, sender
-- domain/DKIM) the app can't make unilaterally. The admin still shares
-- the link (WhatsApp, Slack, verbally) same as today; what's new is
-- that showing up via SSO with the matching email also works, with no
-- link needed at all.
-- ============================================================

-- ------------------------------------------------------------
-- 1. account_invitations.email (nullable — link-only invites are
--    unaffected, email stays NULL exactly like every row today).
-- ------------------------------------------------------------
ALTER TABLE public.account_invitations
  ADD COLUMN IF NOT EXISTS email TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.account_invitations'::regclass
       AND conname = 'account_invitations_email_format'
  ) THEN
    ALTER TABLE public.account_invitations
      ADD CONSTRAINT account_invitations_email_format
      CHECK (email IS NULL OR email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$');
  END IF;
END $$;

-- One pending email-targeted invite per (account, email) at a time —
-- re-inviting the same address while a prior invite is still open is a
-- 23505 the API route turns into a friendly "already invited" message,
-- not a silent duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_invitations_pending_email
  ON public.account_invitations (account_id, lower(email))
  WHERE email IS NOT NULL AND accepted_at IS NULL;

-- ------------------------------------------------------------
-- 2. find_pending_email_invitation — the one lookup both auto-match
--    triggers below share (kept as its own function purely so that
--    lookup exists in exactly one place, not two near-identical
--    inline SELECTs).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_pending_email_invitation(p_email TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT id FROM public.account_invitations
  WHERE email IS NOT NULL AND lower(email) = lower(p_email)
    AND accepted_at IS NULL AND expires_at > NOW()
  ORDER BY created_at ASC
  LIMIT 1;
$$;
ALTER FUNCTION public.find_pending_email_invitation(TEXT) OWNER TO postgres;
-- Supabase's default privileges grant EXECUTE on new functions to
-- `authenticated`/`anon` automatically — REVOKE FROM PUBLIC alone
-- doesn't undo that separate grant, so both are named explicitly.
REVOKE ALL ON FUNCTION public.find_pending_email_invitation(TEXT) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. attach_user_to_invited_account — the actual "move" mechanics,
--    factored out of redeem_invitation (083) so the manual link-click
--    path, the OAuth-signup auto-match, and the post-email-confirmation
--    auto-match all run the exact same eligibility checks and the exact
--    same move, instead of three copies drifting apart.
--
--    Deliberately NOT granted to `authenticated` — it takes an
--    arbitrary p_user_id with no auth.uid() check of its own, so it
--    must only ever be reached from another SECURITY DEFINER function
--    already scoped correctly (redeem_invitation checks auth.uid()
--    itself; the two auth.users triggers below only ever pass NEW.id).
--    Returns NULL on success, else a short reason code the caller
--    translates (redeem_invitation raises a real error from it; the
--    triggers just skip silently and leave the invitation pending).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.attach_user_to_invited_account(
  p_user_id UUID,
  p_invitation_id UUID
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
  v_team_ids UUID[];
BEGIN
  IF p_invitation_id IS NULL THEN
    RETURN 'not_found';
  END IF;

  SELECT * INTO v_inv FROM account_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_inv.accepted_at IS NOT NULL THEN RETURN 'already_redeemed'; END IF;
  IF v_inv.expires_at <= NOW() THEN RETURN 'expired'; END IF;

  SELECT p.account_id, a.owner_user_id INTO v_old_account_id, v_old_account_owner
  FROM profiles p JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = p_user_id;

  IF v_old_account_id IS NULL THEN RETURN 'no_profile'; END IF;
  IF v_old_account_id = v_inv.account_id THEN RETURN 'already_member'; END IF;
  IF v_old_account_owner <> p_user_id THEN RETURN 'not_sole_owner'; END IF;

  -- Same "does the caller's current account hold real domain data"
  -- guard redeem_invitation has always used — for the two automatic
  -- (non-user-initiated) callers below this just means "leave it
  -- alone, don't silently delete anything," not an error to surface.
  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;
  IF v_has_data THEN RETURN 'has_data'; END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id, account_role = v_inv.role
  WHERE user_id = p_user_id;

  UPDATE account_invitations
  SET accepted_at = NOW(), accepted_by_user_id = p_user_id
  WHERE id = v_inv.id;

  IF cardinality(v_inv.team_ids) > 0 THEN
    SELECT COALESCE(array_agg(t.id), '{}') INTO v_team_ids
      FROM teams t
     WHERE t.account_id = v_inv.account_id
       AND t.id = ANY(v_inv.team_ids);

    IF cardinality(v_team_ids) > 0 THEN
      INSERT INTO team_members (team_id, user_id)
      SELECT unnest(v_team_ids), p_user_id
      ON CONFLICT (team_id, user_id) DO NOTHING;

      IF v_inv.created_by_user_id IS NOT NULL THEN
        UPDATE team_members
           SET added_by = v_inv.created_by_user_id
         WHERE user_id = p_user_id
           AND team_id = ANY(v_team_ids);
      END IF;
    END IF;
  END IF;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN NULL;
END;
$$;
ALTER FUNCTION public.attach_user_to_invited_account(UUID, UUID) OWNER TO postgres;
-- Same reasoning as find_pending_email_invitation above — must name
-- `authenticated`/`anon` explicitly, not just PUBLIC.
REVOKE ALL ON FUNCTION public.attach_user_to_invited_account(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. redeem_invitation — same signature/return type as 083's version,
--    CREATE OR REPLACE in place. Adds one new check (an email-targeted
--    invite can only be redeemed by that email) and delegates the
--    actual move to attach_user_to_invited_account instead of
--    inlining it a second time. Every existing error message/ERRCODE
--    is preserved exactly, so this is not a behavior change for any
--    existing link-only invite.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_caller_email TEXT;
  v_inv account_invitations%ROWTYPE;
  v_reason TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  IF v_inv.email IS NOT NULL THEN
    SELECT email INTO v_caller_email FROM auth.users WHERE id = v_caller_id;
    IF v_caller_email IS NULL OR lower(v_caller_email) <> lower(v_inv.email) THEN
      RAISE EXCEPTION 'This invitation was sent to a different email address — sign in with % to accept it.', v_inv.email
        USING ERRCODE = '42501';
    END IF;
  END IF;

  v_reason := public.attach_user_to_invited_account(v_caller_id, v_inv.id);

  IF v_reason = 'already_member' THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  ELSIF v_reason = 'not_sole_owner' THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  ELSIF v_reason = 'has_data' THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  ELSIF v_reason IS NOT NULL THEN
    -- 'not_found' / 'already_redeemed' / 'expired' / 'no_profile' — the
    -- row-level checks above already ruled out the first three for
    -- THIS invitation, so reaching here means a concurrent redeem won
    -- the race between our SELECT and the FOR UPDATE lock; surface the
    -- same generic conflict rather than a confusing internal code.
    RAISE EXCEPTION 'Unable to join this account' USING ERRCODE = '23505';
  END IF;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 5. peek_invitation — additive: include the target email so the
--    /join/<token> page can warn BEFORE Accept if the signed-in
--    visitor's own email doesn't match, instead of only finding out
--    from redeem_invitation's error. Same signature/return type, safe
--    to CREATE OR REPLACE.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.peek_invitation(
  p_token_hash TEXT
) RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv account_invitations%ROWTYPE;
  v_account_name TEXT;
BEGIN
  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'reason', 'used');
  END IF;

  IF v_inv.expires_at <= NOW() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;

  SELECT name INTO v_account_name
  FROM accounts
  WHERE id = v_inv.account_id;

  RETURN json_build_object(
    'ok', true,
    'account_name', v_account_name,
    'role', v_inv.role,
    'expires_at', v_inv.expires_at,
    'email', v_inv.email
  );
END;
$$;

ALTER FUNCTION public.peek_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.peek_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO anon, authenticated;

-- ------------------------------------------------------------
-- 6. handle_new_user — additive branch only. Everything it already did
--    (bootstrap a personal account + profile for every new auth.users
--    row, unconditionally) is untouched; this just also auto-joins a
--    pending email-targeted invitation when the new row's email is
--    ALREADY verified at insert time — true immediately for a Google/
--    Microsoft OAuth sign-in, never true yet for a fresh password
--    signup (see the new trigger in step 7 for that path). Auto-
--    joining on an unverified email would let someone claim another
--    person's invited address before proving they own it, so this
--    check is load-bearing, not incidental.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  IF NEW.email IS NOT NULL AND NEW.email_confirmed_at IS NOT NULL THEN
    PERFORM public.attach_user_to_invited_account(
      NEW.id,
      public.find_pending_email_invitation(NEW.email)
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- ------------------------------------------------------------
-- 7. New: on_auth_user_email_confirmed — covers the password-signup
--    path. handle_new_user already ran at INSERT time (email
--    unconfirmed, so it left the person in their own personal
--    account); this fires once, exactly when email_confirmed_at first
--    gets set, and runs the same auto-match. No trigger on auth.users
--    UPDATE existed before this migration (checked).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_user_email_confirmed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NOT NULL AND NEW.email_confirmed_at IS NOT NULL THEN
    PERFORM public.attach_user_to_invited_account(
      NEW.id,
      public.find_pending_email_invitation(NEW.email)
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to auto-join invited account for user % on email confirmation: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.handle_user_email_confirmed() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_auth_user_email_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_email_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  WHEN (OLD.email_confirmed_at IS DISTINCT FROM NEW.email_confirmed_at AND NEW.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION public.handle_user_email_confirmed();
