-- Verify migration 143. Self-contained (builds its own workspace), so it runs against an
-- empty database as well as production. Concatenate 143's migration text in front when the
-- database does not have it yet, then run it. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA uuid := gen_random_uuid();
  acctA uuid;
  v text;
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;

  -- 1. Both default to unset.
  IF (SELECT email_sender_name FROM accounts WHERE id = acctA) IS NOT NULL
     OR (SELECT email_reply_to FROM accounts WHERE id = acctA) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL the columns should default to NULL';
  END IF;

  -- 2. Ordinary values are accepted, including punctuation and non-Latin names.
  UPDATE accounts SET email_sender_name = 'Acme Support (MY)', email_reply_to = 'help+vip@acme.example' WHERE id = acctA;
  UPDATE accounts SET email_sender_name = '고객 지원' WHERE id = acctA;

  -- 3. Anything that could break out of a mail header is refused.
  FOREACH v IN ARRAY ARRAY['Evil" <x@y.z>', 'a<b', E'two\nlines', 'a,b', 'a;b', '', '   ', repeat('x', 61)] LOOP
    BEGIN
      UPDATE accounts SET email_sender_name = v WHERE id = acctA;
      RAISE EXCEPTION 'FAIL sender name accepted: %', v;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  FOREACH v IN ARRAY ARRAY['not-an-email', 'a@b', 'a b@c.d', 'a@b.c, d@e.f', '<a@b.c>', 'a@b.c;d@e.f', E'a@b.c\nBcc: x@y.z', '"a"@b.c'] LOOP
    BEGIN
      UPDATE accounts SET email_reply_to = v WHERE id = acctA;
      RAISE EXCEPTION 'FAIL reply-to accepted: %', v;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  -- 4. Clearing them is allowed.
  UPDATE accounts SET email_sender_name = NULL, email_reply_to = NULL WHERE id = acctA;

  RAISE EXCEPTION 'ROLLBACK-OK: sender name and reply-to default to unset, accept ordinary values, refuse anything that could inject into a mail header, and can be cleared';
END
$verify$;
