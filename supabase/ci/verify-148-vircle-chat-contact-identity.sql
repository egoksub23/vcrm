-- Verify migration 148. Self-contained; concatenate 148's migration text in front when the
-- database does not have it yet. Ends in a deliberate error so nothing is kept:
-- "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA    uuid := gen_random_uuid();
  acctA uuid;
  cA    uuid;
  cB    uuid;
  v_w   text;
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;

  -- 1. The lookup index exists and only covers live contacts that have a wallet id.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'contacts_account_wallet_idx'
      AND indexdef LIKE '%(account_id, wallet_id)%' AND indexdef LIKE '%deleted_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'FAIL the (account_id, wallet_id) index is missing or not partial';
  END IF;

  -- 2. Merging carries the wallet id to the survivor and clears it from the merged-away record.
  INSERT INTO contacts (account_id, user_id, phone, name, email) VALUES (acctA, uA, '60123456789', 'Aisha', NULL) RETURNING id INTO cA;
  INSERT INTO contacts (account_id, user_id, phone, name, wallet_id) VALUES (acctA, uA, '', 'Vircle user', 'W999') RETURNING id INTO cB;
  PERFORM merge_contacts(acctA, cA, cB);
  SELECT wallet_id INTO v_w FROM contacts WHERE id = cA;
  IF v_w IS DISTINCT FROM 'W999' THEN RAISE EXCEPTION 'FAIL the survivor did not receive the wallet id (got %)', v_w; END IF;
  SELECT wallet_id INTO v_w FROM contacts WHERE id = cB;
  IF v_w IS NOT NULL THEN RAISE EXCEPTION 'FAIL the merged-away contact kept its wallet id (%)', v_w; END IF;

  -- 3. A survivor that already has a wallet id keeps it.
  INSERT INTO contacts (account_id, user_id, phone, name, wallet_id) VALUES (acctA, uA, '60111111111', 'Bala', 'W1') RETURNING id INTO cA;
  INSERT INTO contacts (account_id, user_id, phone, name, wallet_id) VALUES (acctA, uA, '', 'Other', 'W2') RETURNING id INTO cB;
  PERFORM merge_contacts(acctA, cA, cB);
  SELECT wallet_id INTO v_w FROM contacts WHERE id = cA;
  IF v_w IS DISTINCT FROM 'W1' THEN RAISE EXCEPTION 'FAIL the survivor lost its own wallet id (got %)', v_w; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: wallet lookup index is in place; merging carries the wallet id and clears it from the merged-away contact';
END
$verify$;
