-- Verify migration 093. Run ALONE after the migration is applied, or concatenate the
-- migration file in front of it. Ends in a deliberate error so nothing is kept.
DO $$
DECLARE
  v_visitor uuid;
  v_conv    uuid;
  v_msgs    bigint;
  v_rows    bigint;
  v_other   bigint;
BEGIN
  -- The policy exists and is scoped to the visitor's own row.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'widget_visitors'
       AND policyname = 'widget_visitors_self_select' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'FAIL widget_visitors_self_select missing';
  END IF;

  SELECT wv.id INTO v_visitor
    FROM widget_visitors wv
    JOIN conversations c ON c.contact_id = wv.contact_id
    JOIN messages m ON m.conversation_id = c.id
   WHERE m.is_internal IS NOT TRUE
   LIMIT 1;

  IF v_visitor IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK-OK: policy present (no visitor with messages to test the read path)';
  END IF;

  -- Act as that anonymous visitor.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_visitor, 'role', 'authenticated', 'is_anonymous', true)::text, true);

  SELECT count(*) INTO v_rows FROM widget_visitors;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL visitor should see exactly their own widget_visitors row, saw %', v_rows;
  END IF;

  SELECT count(*) INTO v_msgs FROM messages;
  IF v_msgs = 0 THEN
    RAISE EXCEPTION 'FAIL visitor still cannot read messages';
  END IF;

  -- Another (random) visitor sees nothing.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'is_anonymous', true)::text, true);
  SELECT count(*) INTO v_other FROM messages;
  IF v_other <> 0 OR (SELECT count(*) FROM widget_visitors) <> 0 THEN
    RAISE EXCEPTION 'FAIL an unrelated visitor can read data (messages %)', v_other;
  END IF;

  RESET ROLE;
  RAISE EXCEPTION 'ROLLBACK-OK: visitor reads own row and % messages; stranger reads nothing', v_msgs;
END $$;
