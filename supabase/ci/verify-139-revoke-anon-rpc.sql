-- Verify migration 139. Read-only apart from role switches, so it runs on an empty database
-- as well as production. Concatenate 139's migration text in front when the database does
-- not have it yet, then run it. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  v_res text;
BEGIN
  -- 1. A signed-out caller is refused at the door, not inside the function.
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.next_ticket_number(gen_random_uuid());
    RESET ROLE;
    RAISE EXCEPTION 'FAIL anon could execute next_ticket_number';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.touch_presence('online');
    RESET ROLE;
    RAISE EXCEPTION 'FAIL anon could execute touch_presence';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  -- 2. What a signed-out visitor legitimately needs still works.
  SET LOCAL ROLE anon;
  PERFORM public.signup_is_open();
  PERFORM public.peek_invitation('0000000000000000000000000000000000000000000000000000000000000000');
  RESET ROLE;

  -- 3. Signed-in users and the server keep access; only the signed-out role lost it.
  IF NOT has_function_privilege('authenticated', 'public.touch_presence(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL authenticated lost touch_presence';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.next_ticket_number(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL service_role lost next_ticket_number';
  END IF;
  IF has_function_privilege('anon', 'public.set_member_role(uuid, account_role_enum)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL anon can still execute set_member_role';
  END IF;

  -- 4. RLS helper functions stay callable for every role: policies applying to anon
  --    evaluate them, and a revoked helper would turn an empty result into an error.
  SET LOCAL ROLE anon;
  v_res := public.is_account_member(gen_random_uuid())::text;
  v_res := public.has_capability(gen_random_uuid(), 'messages.send')::text;
  RESET ROLE;

  RAISE EXCEPTION 'ROLLBACK-OK: signed-out callers are refused on RPCs that need a login; signup_is_open, peek_invitation and the RLS helper functions still work for them; signed-in users and the server keep access';
END
$verify$;
