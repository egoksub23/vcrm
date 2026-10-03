-- Verify migration 151. Self-contained (builds its own workspace), so it runs against an empty database as
-- well as production. Concatenate the migration text in front when the database does not have it yet, then
-- run it. Ends in a deliberate error so nothing is kept: "ROLLBACK-OK: ..." means every check passed.
DO $verify$
DECLARE
  uA    uuid := gen_random_uuid();
  acctA uuid;
  contA uuid;
  convA uuid;
  v_flag boolean;
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    UPDATE public.platform_settings SET value = 'true'::jsonb WHERE key = 'open_signup';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, email_confirmed_at)
  VALUES (uA, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a-' || uA || '@example.invalid', '{"full_name":"Tenant A"}', now());
  SELECT account_id INTO acctA FROM profiles WHERE user_id = uA;
  INSERT INTO contacts (account_id, user_id, name, phone, wallet_id) VALUES (acctA, uA, 'Aisha', '+60100000151', 'W151') RETURNING id INTO contA;
  INSERT INTO conversations (account_id, user_id, contact_id) VALUES (acctA, uA, contA) RETURNING id INTO convA;

  -- 1. The column exists, is boolean, NOT NULL, default false.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'media_animated'
      AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'FAIL messages.media_animated is missing or has the wrong definition';
  END IF;

  -- 2. A message written without saying anything is not animated; one that says so keeps it.
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, channel_type, status)
  VALUES (convA, 'customer', 'text', 'plain', 'vircle_chat', 'sent');
  SELECT media_animated INTO v_flag FROM messages WHERE conversation_id = convA AND content_text = 'plain';
  IF v_flag IS DISTINCT FROM false THEN RAISE EXCEPTION 'FAIL a plain message is flagged animated'; END IF;

  INSERT INTO messages (conversation_id, sender_type, content_type, media_url, media_type, channel_type, status, media_animated)
  VALUES (convA, 'customer', 'video', 'https://example.invalid/g.mp4', 'video/mp4', 'vircle_chat', 'sent', true);
  SELECT media_animated INTO v_flag FROM messages WHERE conversation_id = convA AND media_type = 'video/mp4';
  IF v_flag IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL the animated flag was not kept'; END IF;

  RAISE EXCEPTION 'ROLLBACK-OK: migration 151 verified (media_animated: column, default, kept)';
END
$verify$;
