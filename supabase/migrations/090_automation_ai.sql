-- ============================================================
-- 090_automation_ai
--
-- AI in automations (docs/automation-ai.md).
--
--   1. ai_task_routing.task accepts the new AI job 'automation'
--      ("Steps inside automations" in Settings > AI Agents > Connections).
--   2. ai_usage_log.mode accepts 'automation' (one usage row per AI step call).
--   3. If trigger types (or step types) of automations are constrained in a
--      database, the new 'conversation_closed' trigger and the new step types
--      are accepted too. In the live database they are NOT constrained
--      (automations.trigger_type and automation_steps.step_type are plain
--      text), so this is a no-op there; it only widens a CHECK if one exists.
--   4. next_ticket_number_system(account): the per-account ticket number for
--      tickets an automation creates. The people-facing next_ticket_number()
--      (088) refuses any caller without the 'tickets.work' capability, and the
--      server-side engine has no user session, so it cannot use it. This twin
--      uses the SAME counter (accounts.ticket_seq), so numbering stays one
--      sequence, and only the service role can run it.
--
-- The CHECKs are widened from their LIVE definitions (pg_constraint), the way
-- 078 did it, so a value another migration or a fork added is never lost: the
-- new value is appended inside the definition's ARRAY[...] and the constraint
-- keeps its name. Idempotent: safe to run twice.
-- ============================================================

DO $$
DECLARE
  w     RECORD;
  c     RECORD;
  v_new text;
BEGIN
  FOR w IN
    SELECT * FROM (VALUES
      -- table,                    a value the live CHECK lists,  the value to add
      ('public.ai_task_routing',   'closing_note',                'automation'),
      ('public.ai_usage_log',      'closing_note',                'automation'),
      ('public.automations',       'new_message_received',        'conversation_closed'),
      ('public.automation_steps',  'send_webhook',                'ai_reply'),
      ('public.automation_steps',  'send_webhook',                'ai_extract'),
      ('public.automation_steps',  'send_webhook',                'ai_summarize'),
      ('public.automation_steps',  'send_webhook',                'ai_translate'),
      ('public.automation_steps',  'send_webhook',                'create_ticket')
    ) AS x(tbl, marker, val)
  LOOP
    FOR c IN
      SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = w.tbl::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%' || w.marker || '%'
    LOOP
      IF c.def LIKE '%' || quote_literal(w.val) || '%' THEN
        CONTINUE;  -- already accepted (a re-run)
      END IF;
      -- CHECK ((task = ANY (ARRAY['a'::text, 'b'::text]))) -> append inside the array.
      v_new := regexp_replace(c.def, '(::text)\]', '\1, ' || quote_literal(w.val) || '::text]');
      IF v_new = c.def THEN
        RAISE EXCEPTION 'cannot widen % on %: unexpected definition %', c.conname, w.tbl, c.def;
      END IF;
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', w.tbl, c.conname);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', w.tbl, c.conname, v_new);
    END LOOP;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- Ticket numbers for tickets an automation creates (no user session).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.next_ticket_number_system(p_account_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next INTEGER;
BEGIN
  UPDATE accounts SET ticket_seq = ticket_seq + 1
   WHERE id = p_account_id
  RETURNING ticket_seq INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Account % not found', p_account_id;
  END IF;

  RETURN v_next;
END;
$$;

ALTER FUNCTION public.next_ticket_number_system(uuid) OWNER TO postgres;
-- Nobody but the server may run it: no member, and not signed-out callers
-- either, can bump an account's ticket counter through this door.
REVOKE ALL ON FUNCTION public.next_ticket_number_system(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_ticket_number_system(uuid) TO service_role;
