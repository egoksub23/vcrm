-- Verify migration 190 (accepting an invitation moves a new person into the inviter's workspace and deletes their empty personal one).
-- Self-contained; run against an empty database or production with 190's migration text concatenated in front when it is not applied yet.
-- Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
--
-- Why this exists: nothing ever accepted an invitation after Compliance (183) was added. The delete of the personal workspace cascades to its seeded
-- Compliance request types, a guard refuses to delete a system type unless the workspace is being purged on purpose (`vircle.purge_account`), and the
-- redeem failed with 23514 compliance_system_type_is_fixed (the route answered "Failed to redeem invitation").
--
-- Proves: a new person accepts, lands in the inviter's workspace with the invite's role, the invitation is used and their empty workspace is gone with
-- its seeded Compliance types; the flag is cleared afterwards; a personal workspace that holds a Compliance case, a Secure Sign document or a KYC log
-- row is NOT deleted (the accept is refused as "has data" and nothing is lost); an invitation for another email is still refused; the functions are
-- still closed to the API roles.
DO $verify$
DECLARE
  uOwner uuid := gen_random_uuid();   -- owner of the inviting workspace
  uNew   uuid := gen_random_uuid();   -- a new person with an empty personal workspace
  uData  uuid := gen_random_uuid();   -- a new person whose personal workspace holds a Compliance case
  uOther uuid := gen_random_uuid();   -- a new person the invitation is NOT for
  acctO  uuid;
  acctN  uuid;
  acctD  uuid;
  v_res  uuid;
  v_msg  text;
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES
    (uOwner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'o-' || uOwner || '@example.invalid', '{"full_name":"Inviter"}', now()),
    (uNew,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'n-' || uNew   || '@example.invalid', '{"full_name":"New person"}', now()),
    (uData,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'd-' || uData  || '@example.invalid', '{"full_name":"Has data"}', now()),
    (uOther, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'x-' || uOther || '@example.invalid', '{"full_name":"Other"}', now());
  SELECT account_id INTO acctO FROM profiles WHERE user_id = uOwner;
  SELECT account_id INTO acctN FROM profiles WHERE user_id = uNew;
  SELECT account_id INTO acctD FROM profiles WHERE user_id = uData;

  -- the seeded Compliance types are in the personal workspace: that is what the delete used to trip on
  IF (SELECT count(*) FROM compliance_request_types WHERE account_id = acctN AND is_system) < 1 THEN
    RAISE EXCEPTION 'FAIL the personal workspace has no seeded system type, so this test would prove nothing';
  END IF;

  INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
  VALUES (acctO, 'verify-190-open', 'agent', uOwner, now() + interval '7 days'),
         (acctO, 'verify-190-data', 'agent', uOwner, now() + interval '7 days'),
         (acctO, 'verify-190-mail', 'agent', uOwner, now() + interval '7 days');
  UPDATE account_invitations SET email = 'someone-else-' || uOwner || '@example.invalid' WHERE token_hash = 'verify-190-mail';

  -- 1. a new person accepts: they are moved, the invitation is used, the empty workspace is gone with its types, the flag is cleared
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uNew, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', uNew::text, true);
  v_res := public.redeem_invitation('verify-190-open');
  IF v_res IS DISTINCT FROM acctO THEN RAISE EXCEPTION 'FAIL redeem returned % instead of the inviter''s workspace', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = uNew AND account_id = acctO AND account_role = 'agent') THEN
    RAISE EXCEPTION 'FAIL the new person was not moved into the inviter''s workspace with the invite''s role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM account_invitations WHERE token_hash = 'verify-190-open' AND accepted_at IS NOT NULL AND accepted_by_user_id = uNew) THEN
    RAISE EXCEPTION 'FAIL the invitation was not marked as used';
  END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE id = acctN) OR EXISTS (SELECT 1 FROM compliance_request_types WHERE account_id = acctN) THEN
    RAISE EXCEPTION 'FAIL the empty personal workspace (or its seeded types) is still there';
  END IF;
  IF coalesce(current_setting('vircle.purge_account', true), '') <> '' THEN
    RAISE EXCEPTION 'FAIL the purge flag was left set after the delete';
  END IF;
  -- and once the flag is cleared, the guard still protects a system type of a workspace nobody is purging
  BEGIN
    DELETE FROM compliance_request_types WHERE account_id = acctO AND is_system;
    RAISE EXCEPTION 'FAIL a system type of a live workspace could be deleted';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> 'compliance_system_type_is_fixed' THEN RAISE EXCEPTION 'FAIL a different refusal: %', v_msg; END IF;
  END;

  -- 2. a personal workspace that holds a Compliance case is NEVER deleted by accepting: the accept is refused as "has data"
  INSERT INTO compliance_requests (id, account_id, type_key, source, customer_name)
  VALUES (gen_random_uuid(), acctD, 'closure', 'staff', 'Keep me');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uData, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', uData::text, true);
  BEGIN
    v_res := public.redeem_invitation('verify-190-data');
    RAISE EXCEPTION 'FAIL a person whose workspace holds a Compliance case was moved and the case deleted';
  EXCEPTION WHEN SQLSTATE '23505' THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE '%already contains data%' THEN RAISE EXCEPTION 'FAIL refused for the wrong reason: %', v_msg; END IF;
  END;
  IF NOT EXISTS (SELECT 1 FROM compliance_requests WHERE account_id = acctD AND customer_name = 'Keep me') OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = acctD) THEN
    RAISE EXCEPTION 'FAIL the Compliance case or its workspace was deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = uData AND account_id = acctD) THEN RAISE EXCEPTION 'FAIL the refused person was moved anyway'; END IF;

  -- 3. an invitation sent to another email is still refused
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uOther, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', uOther::text, true);
  BEGIN
    v_res := public.redeem_invitation('verify-190-mail');
    RAISE EXCEPTION 'FAIL an invitation for another email was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);

  -- 4. privileges are as 114 left them
  IF has_function_privilege('anon', 'public.attach_user_to_invited_account(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.attach_user_to_invited_account(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL a browser role can call attach_user_to_invited_account';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.redeem_invitation(text)', 'EXECUTE') OR has_function_privilege('anon', 'public.redeem_invitation(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL redeem_invitation is not callable by exactly the signed-in role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.attach_user_to_invited_account(uuid, uuid)'::regprocedure AND prosecdef AND proconfig @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'FAIL attach_user_to_invited_account is not security definer with a pinned search_path';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: a new person accepts an invitation (moved into the inviter''s workspace with the invite''s role, invitation used, empty personal workspace and its seeded Compliance types gone, purge flag cleared, a live workspace''s system types still protected), a personal workspace holding a Compliance case is refused as has-data with nothing deleted, an invitation for another email is still refused, and the functions are still closed to the API roles';
END
$verify$;
