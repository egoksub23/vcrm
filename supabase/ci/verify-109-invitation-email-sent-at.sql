-- ============================================================
-- Verification for migration 109 (account_invitations.email_sent_at).
--
-- Migrations 001-106 are confirmed applied to production; 107/108 are
-- NOT yet applied (owner still needs to `supabase db push`), and this
-- migration has no dependency on either (account_invitations has
-- existed since 017; 109 only adds a column to it). So this can be
-- verified standalone:
--   cat supabase/migrations/109_invitation_email_sent_at.sql \
--       supabase/ci/verify-109-invitation-email-sent-at.sql > /tmp/all.sql
--   supabase db query --linked -f /tmp/all.sql
--
-- One DO block ending RAISE EXCEPTION 'ROLLBACK-OK: ...' — nothing is
-- ever committed. Same pg_temp.run(user, sql, role) helper as every
-- prior verify script this session.
-- ============================================================

DO $verify$
DECLARE
  admin_a UUID := gen_random_uuid();
  acct_a  UUID;
  inv_id  UUID;
  res     TEXT;
  seen    TIMESTAMPTZ;
BEGIN
  EXECUTE $f$
    CREATE FUNCTION pg_temp.run(u UUID, q TEXT, r TEXT DEFAULT 'authenticated') RETURNS TEXT
    LANGUAGE plpgsql AS $b$
    DECLARE res TEXT;
    BEGIN
      IF u IS NULL THEN
        PERFORM set_config('request.jwt.claims', '', true);
        PERFORM set_config('request.jwt.claim.sub', '', true);
      ELSE
        PERFORM set_config('request.jwt.claims',
          json_build_object('sub', u, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.jwt.claim.sub', u::text, true);
      END IF;
      EXECUTE format('SET LOCAL ROLE %I', r);
      BEGIN
        IF q ~* '^\s*(select|with)' THEN
          EXECUTE q INTO res;
        ELSE
          EXECUTE q;
        END IF;
        res := COALESCE(res, 'OK');
      EXCEPTION WHEN OTHERS THEN
        res := 'ERR ' || SQLSTATE || ': ' || SQLERRM;
      END;
      EXECUTE 'RESET ROLE';
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      RETURN res;
    END;
    $b$;
  $f$;

  -- 1. Column exists with the expected type.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'account_invitations'
       AND column_name = 'email_sent_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'FAIL: account_invitations.email_sent_at missing or wrong type';
  END IF;

  -- 2. Set up an account owned by admin_a, insert an invite, confirm the
  --    admin (via the existing members.invite-gated UPDATE policy from
  --    088) can stamp email_sent_at through ordinary RLS — the same
  --    write path POST /api/account/invitations uses after a successful
  --    Resend call.
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at)
  VALUES (admin_a, 'admin-109@example.com', 'x', NOW());
  SELECT account_id INTO acct_a FROM profiles WHERE user_id = admin_a;
  IF acct_a IS NULL THEN RAISE EXCEPTION 'FAIL: admin has no account (handle_new_user did not run)'; END IF;

  -- Deliberately omits the `email` column (migration 108) — not yet
  -- applied to production at the time this was written, and 109 has
  -- no dependency on it anyway.
  INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
  VALUES (acct_a, encode(gen_random_bytes(32), 'hex'), 'agent', admin_a, NOW() + INTERVAL '7 days')
  RETURNING id INTO inv_id;

  res := pg_temp.run(admin_a, format(
    'UPDATE account_invitations SET email_sent_at = NOW() WHERE id = %L', inv_id
  ));
  IF res <> 'OK' THEN
    RAISE EXCEPTION 'FAIL: admin could not stamp email_sent_at via RLS: %', res;
  END IF;

  SELECT email_sent_at INTO seen FROM account_invitations WHERE id = inv_id;
  IF seen IS NULL THEN
    RAISE EXCEPTION 'FAIL: email_sent_at was not actually persisted';
  END IF;

  -- 3. A caller with no session (anon-equivalent) cannot stamp it on
  --    someone else's invitation — the existing 088 policy, unaffected
  --    by this additive column, should still block it. An RLS-filtered
  --    UPDATE that matches zero rows still returns 'OK' (no exception),
  --    so the real check is that the row's value didn't move — not
  --    that the statement itself errored.
  PERFORM pg_temp.run(NULL, format(
    'UPDATE account_invitations SET email_sent_at = NOW() + INTERVAL ''1 hour'' WHERE id = %L', inv_id
  ), 'anon');
  IF (SELECT email_sent_at FROM account_invitations WHERE id = inv_id) <> seen THEN
    RAISE EXCEPTION 'FAIL: anon was able to overwrite email_sent_at (RLS regression)';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: migration 109 verified (column present, RLS-gated write works, anon still blocked)';
END;
$verify$;
