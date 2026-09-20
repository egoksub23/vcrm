-- Run together with the migration (concatenate the two files); ends in a
-- deliberate error so nothing is kept.
DO $$
DECLARE
  f text;
  fns text[] := ARRAY[
    'public._bcast_bump(uuid,text,integer)',
    'public.recompute_broadcast_counts(uuid)',
    'public.claim_ai_reply_slot(uuid,integer)',
    'public.record_webhook_failure(uuid,integer)'];
BEGIN
  FOREACH f IN ARRAY fns LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL anon can still execute %', f;
    END IF;
    IF has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL authenticated can still execute %', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL service_role lost execute on %', f;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'ROLLBACK-OK: 4 internal functions locked to service_role';
END $$;
