-- ============================================================
-- Verification for invite-by-email (migration 108).
--
-- Migrations 001-107 are confirmed applied to production (checked via
-- `supabase migration list --linked` before writing this), so this
-- only needs its own draft in front:
--   cat supabase/ci/drafts/108_invite_by_email.sql \
--       supabase/ci/verify-108-invite-by-email.sql > /tmp/all.sql
--   supabase db query --linked -f /tmp/all.sql
--
-- One DO block ending RAISE EXCEPTION 'ROLLBACK-OK: ...' — nothing is
-- ever committed. Same pg_temp.run(user, sql, role) helper as every
-- prior verify script this session.
-- ============================================================

DO $verify$
DECLARE
  a             UUID;
  admin_a       UUID := gen_random_uuid();
  oauth_u       UUID := gen_random_uuid(); -- already-verified signup (simulates Google/MS SSO)
  pw_u          UUID := gen_random_uuid(); -- unconfirmed-at-signup, confirmed later (simulates password signup)
  hasdata_u     UUID := gen_random_uuid(); -- confirmed later, but real data lands in their personal account first
  manual_u      UUID := gen_random_uuid(); -- signs up BEFORE any invite exists for their email
  inv1          UUID;
  inv3          UUID;
  inv5          UUID;
  inv5_hash     TEXT := encode(gen_random_bytes(32), 'hex');
  inv4_hash     TEXT := encode(gen_random_bytes(32), 'hex');
  res           TEXT;
  cnt           TEXT;
  personal_acct UUID;
  joined_acct   UUID;
  joined_role   TEXT;
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
    END $b$;
  $f$;

  -- ---------------------------------------------------------
  -- fixtures: an admin whose account will be the invite target
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (admin_a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'verify108-admin-' || admin_a || '@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

  SELECT account_id INTO a FROM profiles WHERE user_id = admin_a;
  IF a IS NULL THEN RAISE EXCEPTION 'FAIL fixtures: signup trigger did not create an account for admin'; END IF;

  -- ---------------------------------------------------------
  -- 1. Create a pending email-targeted invitation
  -- ---------------------------------------------------------
  INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, email, expires_at)
  VALUES (a, encode(gen_random_bytes(32), 'hex'), 'agent', admin_a, 'verify108-target@example.invalid', now() + interval '7 days')
  RETURNING id INTO inv1;

  -- ---------------------------------------------------------
  -- 2. A second pending invite for the same email (any casing) is
  --    rejected by the partial unique index
  -- ---------------------------------------------------------
  res := pg_temp.run(NULL, format(
    'INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, email, expires_at) VALUES (%L, encode(gen_random_bytes(32),''hex''), ''viewer'', %L, ''Verify108-Target@Example.invalid'', now() + interval ''7 days'')',
    a, admin_a), 'postgres');
  IF res NOT LIKE '%ERR%' THEN RAISE EXCEPTION 'FAIL 2 a duplicate pending email invite (different casing) should be rejected: %', res; END IF;

  -- ---------------------------------------------------------
  -- 3. A fresh, ALREADY-VERIFIED signup (simulates Google/Microsoft SSO)
  --    auto-joins the invited account immediately, at the invited role,
  --    the invitation is marked accepted, and the ephemeral personal
  --    account handle_new_user created for them is cleaned up.
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (oauth_u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'verify108-target@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

  SELECT account_id, account_role INTO joined_acct, joined_role FROM profiles WHERE user_id = oauth_u;
  IF joined_acct IS DISTINCT FROM a THEN
    RAISE EXCEPTION 'FAIL 3 an already-verified signup should auto-join the invited account: got %, expected %', joined_acct, a;
  END IF;
  IF joined_role <> 'agent' THEN
    RAISE EXCEPTION 'FAIL 3b should get the invited role: got %', joined_role;
  END IF;

  res := pg_temp.run(NULL, format(
    'SELECT (accepted_at IS NOT NULL)::text FROM account_invitations WHERE id = %L', inv1), 'postgres');
  IF res <> 'true' THEN RAISE EXCEPTION 'FAIL 3c invitation should be marked accepted: %', res; END IF;

  cnt := pg_temp.run(NULL, format('SELECT count(*)::text FROM accounts WHERE owner_user_id = %L', oauth_u), 'postgres');
  IF cnt <> '0' THEN RAISE EXCEPTION 'FAIL 3d the ephemeral personal account should have been deleted: %', cnt; END IF;

  -- ---------------------------------------------------------
  -- 4/5. A fresh, UNCONFIRMED signup (simulates password signup before
  --    clicking the verification link) does NOT auto-join yet; once
  --    confirmed (simulated by flipping email_confirmed_at), it does.
  -- ---------------------------------------------------------
  INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, email, expires_at)
  VALUES (a, encode(gen_random_bytes(32), 'hex'), 'viewer', admin_a, 'verify108-pw-target@example.invalid', now() + interval '7 days');

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (pw_u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'verify108-pw-target@example.invalid', '', NULL, '{}'::jsonb, '{}'::jsonb, now(), now());

  SELECT account_id INTO joined_acct FROM profiles WHERE user_id = pw_u;
  IF joined_acct = a THEN
    RAISE EXCEPTION 'FAIL 4 an unconfirmed password signup should NOT auto-join yet: got %', joined_acct;
  END IF;

  UPDATE auth.users SET email_confirmed_at = now() WHERE id = pw_u;

  SELECT account_id, account_role INTO joined_acct, joined_role FROM profiles WHERE user_id = pw_u;
  IF joined_acct IS DISTINCT FROM a THEN
    RAISE EXCEPTION 'FAIL 5 confirming the email should auto-join the invited account: got %, expected %', joined_acct, a;
  END IF;
  IF joined_role <> 'viewer' THEN
    RAISE EXCEPTION 'FAIL 5b should get the invited role: got %', joined_role;
  END IF;

  -- ---------------------------------------------------------
  -- 6. A user whose personal account already holds real data does NOT
  --    get auto-attached even once their matching email is confirmed —
  --    the invitation stays pending for manual resolution instead of
  --    silently discarding their data.
  -- ---------------------------------------------------------
  INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, email, expires_at)
  VALUES (a, encode(gen_random_bytes(32), 'hex'), 'viewer', admin_a, 'verify108-hasdata@example.invalid', now() + interval '7 days')
  RETURNING id INTO inv3;

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (hasdata_u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'verify108-hasdata@example.invalid', '', NULL, '{}'::jsonb, '{}'::jsonb, now(), now());

  SELECT account_id INTO personal_acct FROM profiles WHERE user_id = hasdata_u;
  INSERT INTO tags (account_id, name, user_id) VALUES (personal_acct, 'verify108-tag', hasdata_u);

  UPDATE auth.users SET email_confirmed_at = now() WHERE id = hasdata_u;

  SELECT account_id INTO joined_acct FROM profiles WHERE user_id = hasdata_u;
  IF joined_acct IS DISTINCT FROM personal_acct THEN
    RAISE EXCEPTION 'FAIL 6 a user with real data should NOT be auto-attached: got %, expected to stay at %', joined_acct, personal_acct;
  END IF;
  res := pg_temp.run(NULL, format(
    'SELECT (accepted_at IS NULL)::text FROM account_invitations WHERE id = %L', inv3), 'postgres');
  IF res <> 'true' THEN RAISE EXCEPTION 'FAIL 6b the invitation should remain pending, not silently consumed: %', res; END IF;

  -- ---------------------------------------------------------
  -- 7. Manual link redemption (redeem_invitation) for an email-targeted
  --    invite, attempted by someone whose OWN email does not match, is
  --    rejected.
  -- ---------------------------------------------------------
  INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, email, expires_at)
  VALUES (a, inv4_hash, 'viewer', admin_a, 'verify108-manual-target@example.invalid', now() + interval '7 days');

  res := pg_temp.run(admin_a, format('SELECT redeem_invitation(%L)::text', inv4_hash));
  IF res NOT LIKE '%ERR%' THEN RAISE EXCEPTION 'FAIL 7 redeeming with a mismatched email should be rejected: %', res; END IF;

  -- ---------------------------------------------------------
  -- 8. Manual link redemption succeeds when the caller's email matches
  --    the invitation's email — the realistic case where someone
  --    already has an account here and gets invited afterward, so no
  --    signup/confirmation event exists to auto-match them.
  -- ---------------------------------------------------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (manual_u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'verify108-manual-match@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

  INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, email, expires_at)
  VALUES (a, inv5_hash, 'agent', admin_a, 'verify108-manual-match@example.invalid', now() + interval '7 days')
  RETURNING id INTO inv5;

  res := pg_temp.run(manual_u, format('SELECT redeem_invitation(%L)::text', inv5_hash));
  IF res <> a::text THEN RAISE EXCEPTION 'FAIL 8 redeeming with a matching email should succeed and return the account id: %', res; END IF;

  SELECT account_id, account_role INTO joined_acct, joined_role FROM profiles WHERE user_id = manual_u;
  IF joined_acct IS DISTINCT FROM a OR joined_role <> 'agent' THEN
    RAISE EXCEPTION 'FAIL 8b profile should reflect the joined account/role: account=%, role=%', joined_acct, joined_role;
  END IF;

  -- ---------------------------------------------------------
  -- 9. attach_user_to_invited_account is internal-only — a regular
  --    authenticated session cannot call it directly (it takes an
  --    arbitrary p_user_id with no auth.uid() check of its own).
  -- ---------------------------------------------------------
  res := pg_temp.run(admin_a, format('SELECT attach_user_to_invited_account(%L, %L)::text', oauth_u, inv1));
  IF res NOT LIKE '%ERR%' THEN RAISE EXCEPTION 'FAIL 9 attach_user_to_invited_account should not be directly callable: %', res; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: invite-by-email (dup-email rejected, SSO auto-join, password-confirm auto-join, has-data guard, mismatched-email rejected, matching-email manual redeem, internal function locked down) checked in 9 groups';
END
$verify$;
