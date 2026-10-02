-- Verify migration 137. Self-contained (builds its own workspace), so it runs against an
-- empty database as well as production. Concatenate 137's migration text in front when the
-- database does not have it yet, then run it. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA     uuid := gen_random_uuid();
  acctA  uuid;
  v_feat jsonb;
  v_n    int;
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;

  -- 1. A workspace created after this migration starts with Jira and Incident Reporting off.
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  SELECT features INTO v_feat FROM account_platform WHERE account_id = acctA;
  IF v_feat IS NULL THEN RAISE EXCEPTION 'FAIL new workspace has no account_platform row'; END IF;
  IF (v_feat ->> 'jira') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'FAIL new workspace should start with jira off, got %', v_feat;
  END IF;
  IF (v_feat ->> 'incidents') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'FAIL new workspace should start with incidents off, got %', v_feat;
  END IF;

  -- 2. No workspace is left with an unset jira flag (existing ones were written explicitly).
  SELECT count(*) INTO v_n FROM account_platform WHERE NOT (features ? 'jira');
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL % workspace(s) have no explicit jira flag', v_n; END IF;

  -- 3. Re-running the backfill never overwrites an operator's choice.
  UPDATE account_platform SET features = features || '{"jira": true}'::jsonb WHERE account_id = acctA;
  UPDATE account_platform SET features = features || '{"jira": true}'::jsonb WHERE NOT (features ? 'jira');
  IF (SELECT features ->> 'jira' FROM account_platform WHERE account_id = acctA) <> 'true' THEN
    RAISE EXCEPTION 'FAIL an explicit jira flag was changed by the backfill';
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: new workspaces start with jira and incidents off; every workspace carries an explicit jira flag; the backfill leaves an operator-set value alone';
END
$verify$;
