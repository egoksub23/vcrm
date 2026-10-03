-- Verify migration 149. Self-contained; concatenate 147's and 149's migration text in front
-- when the database does not have them yet. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA    uuid := gen_random_uuid();
  acctA uuid;
  v_n   int;
  v_def text;
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;

  -- 1. The push column is gone.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vircle_chat_config' AND column_name = 'push_alerts_enabled'
  ) THEN
    RAISE EXCEPTION 'FAIL vircle_chat_config.push_alerts_enabled still exists';
  END IF;

  -- 2. Every other column is still there.
  SELECT count(*) INTO v_n
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'vircle_chat_config'
    AND column_name IN ('id', 'account_id', 'workspace_key', 'gateway_base_url', 'signing_secret', 'api_token',
                        'enabled', 'last_inbound_at', 'last_error', 'connected_by_user_id', 'created_at', 'updated_at');
  IF v_n <> 12 THEN RAISE EXCEPTION 'FAIL vircle_chat_config lost a column it should keep (found % of 12)', v_n; END IF;

  -- 3. An insert without the column works, and the pause switch still defaults to on.
  INSERT INTO vircle_chat_config (account_id, workspace_key, gateway_base_url, signing_secret, api_token)
  VALUES (acctA, 'vcw_abcdefghijklmnop1234', 'https://gw.example.com', 'enc-secret', 'enc-token');
  IF (SELECT enabled FROM vircle_chat_config WHERE account_id = acctA) IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL a new connection should start enabled';
  END IF;
  UPDATE vircle_chat_config SET enabled = false WHERE account_id = acctA;
  IF (SELECT enabled FROM vircle_chat_config WHERE account_id = acctA) IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL the pause switch could not be turned off';
  END IF;

  -- 4. The audit trigger is in place and no longer names the dropped column.
  SELECT pg_get_triggerdef(t.oid) INTO v_def
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.vircle_chat_config'::regclass AND t.tgname = 'audit_row_change' AND NOT t.tgisinternal;
  IF v_def IS NULL THEN RAISE EXCEPTION 'FAIL the audit trigger is missing on vircle_chat_config'; END IF;
  IF v_def LIKE '%push_alerts_enabled%' THEN RAISE EXCEPTION 'FAIL the audit trigger still names push_alerts_enabled'; END IF;
  IF v_def NOT LIKE '%workspace_key,gateway_base_url,signing_secret,api_token,enabled%' THEN
    RAISE EXCEPTION 'FAIL the audit trigger has an unexpected column list: %', v_def;
  END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: vircle_chat_config has no push_alerts_enabled column, keeps every other column, accepts an insert without it, and its audit trigger no longer tracks it';
END
$verify$;
