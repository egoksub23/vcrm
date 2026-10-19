-- ============================================================
-- 189_compliance_edit_fix.sql
--
-- Saving an edit to a compliance request failed with "That could not be done. Check what you entered and try again." for EVERY edit of the
-- customer's name, e-mail, phone, channel or the answers (a change to the assignee, the links or the request date was unaffected).
--
-- Cause: compliance_update_request (migration 183) listed what it had changed with `v_changed := v_changed || 'customer_email'`. `v_changed` is a
-- text[] and `'customer_email'` is an untyped literal, so Postgres reads the right-hand side as an ARRAY literal and refuses it:
--   ERROR 22P02 malformed array literal: "customer_email"
-- The route maps 22P02 to invalid_request, which is the sentence the screen showed. It never worked on production: no test ran the function.
--
-- Fix: the six appends use array_append(), which takes the element as an element. Nothing else in the function changes (the body below is
-- 183's, character for character, apart from those six lines), and the owner, the revoked and granted privileges are re-stated as they were.
--
-- Idempotent (CREATE OR REPLACE). No table, column, policy, trigger or grant is added or changed.
-- ============================================================

CREATE OR REPLACE FUNCTION public.compliance_update_request(p_request UUID, p_actor UUID, p_patch JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r          public.compliance_requests%ROWTYPE;
  k          TEXT;
  v_changed  TEXT[] := '{}';
  v_data_changed BOOLEAN := FALSE;
  v_new_received TIMESTAMPTZ;
  v_delta    INTERVAL;
  v_to       UUID;
  v_old      UUID;
  v_link     TEXT;
  v_links    TEXT[] := ARRAY['contact_id', 'conversation_id', 'ticket_id', 'incident_id'];
  v_allowed  TEXT[] := ARRAY['customer_name', 'customer_email', 'customer_phone', 'channel', 'contact_id', 'conversation_id', 'ticket_id',
                             'incident_id', 'kyc_validation_ref', 'data', 'data_enc', 'assigned_to', 'received_at'];
  v_frozen   BOOLEAN;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'compliance_bad_patch' USING ERRCODE = '22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT (k = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'compliance_unknown_field: %', k USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT * INTO r FROM public.compliance_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'compliance_request_not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (public.compliance_user_can(r.account_id, p_actor, 'compliance.review') OR public.compliance_user_can(r.account_id, p_actor, 'compliance.approve')) THEN
    RAISE EXCEPTION 'compliance_not_allowed: review' USING ERRCODE = '42501';
  END IF;
  IF r.status = 'closed' THEN RAISE EXCEPTION 'compliance_closed' USING ERRCODE = '23514'; END IF;
  v_frozen := r.status IN ('awaiting_signoff', 'approved', 'rejected', 'executing', 'completed');
  IF v_frozen AND (p_patch ?| ARRAY['customer_name', 'customer_email', 'customer_phone', 'channel', 'data', 'data_enc', 'received_at']) THEN
    RAISE EXCEPTION 'compliance_frozen' USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('vircle.compliance_fn', 'on', true);

  IF p_patch ? 'customer_name' THEN
    r.customer_name := p_patch ->> 'customer_name'; v_changed := array_append(v_changed, 'customer_name');
  END IF;
  IF p_patch ? 'customer_email' THEN
    r.customer_email := CASE WHEN jsonb_typeof(p_patch -> 'customer_email') = 'null' THEN NULL ELSE p_patch ->> 'customer_email' END;
    v_changed := array_append(v_changed, 'customer_email');
  END IF;
  IF p_patch ? 'customer_phone' THEN
    r.customer_phone := CASE WHEN jsonb_typeof(p_patch -> 'customer_phone') = 'null' THEN NULL ELSE p_patch ->> 'customer_phone' END;
    v_changed := array_append(v_changed, 'customer_phone');
  END IF;
  IF p_patch ? 'channel' THEN
    r.channel := CASE WHEN jsonb_typeof(p_patch -> 'channel') = 'null' THEN NULL ELSE p_patch ->> 'channel' END;
    v_changed := array_append(v_changed, 'channel');
  END IF;
  IF p_patch ? 'kyc_validation_ref' THEN
    r.kyc_validation_ref := CASE WHEN jsonb_typeof(p_patch -> 'kyc_validation_ref') = 'null' THEN NULL ELSE p_patch ->> 'kyc_validation_ref' END;
    PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'link', jsonb_build_object('field', 'kyc_validation_ref', 'set', r.kyc_validation_ref IS NOT NULL));
  END IF;
  IF p_patch ? 'data' THEN
    r.data := p_patch -> 'data'; v_data_changed := TRUE; v_changed := array_append(v_changed, 'data');
  END IF;
  IF p_patch ? 'data_enc' THEN
    r.data_enc := CASE WHEN jsonb_typeof(p_patch -> 'data_enc') = 'null' THEN NULL ELSE p_patch ->> 'data_enc' END;
    v_changed := array_append(v_changed, 'sensitive_data');
  END IF;

  IF p_patch ? 'received_at' THEN
    v_new_received := (p_patch ->> 'received_at')::TIMESTAMPTZ;
    IF v_new_received IS NULL OR v_new_received > now() + interval '5 minutes' OR v_new_received < now() - interval '400 days' THEN
      RAISE EXCEPTION 'compliance_received_at_out_of_range' USING ERRCODE = '23514';
    END IF;
    IF v_new_received IS DISTINCT FROM r.received_at THEN
      v_delta := v_new_received - r.received_at;
      -- the clocks move with the request date (the stored dates already include any pause)
      r.target_due_at := r.target_due_at + v_delta;
      r.hard_stop_at  := r.hard_stop_at + v_delta;
      PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'edited',
        jsonb_build_object('fields', jsonb_build_array('received_at'), 'from', r.received_at, 'to', v_new_received));
      r.received_at := v_new_received;
    END IF;
  END IF;

  FOREACH v_link IN ARRAY v_links LOOP
    IF p_patch ? v_link THEN
      v_to := CASE WHEN jsonb_typeof(p_patch -> v_link) = 'null' THEN NULL ELSE (p_patch ->> v_link)::UUID END;
      v_old := CASE v_link WHEN 'contact_id' THEN r.contact_id WHEN 'conversation_id' THEN r.conversation_id
                           WHEN 'ticket_id' THEN r.ticket_id ELSE r.incident_id END;
      IF v_to IS DISTINCT FROM v_old THEN
        IF v_link = 'contact_id' THEN r.contact_id := v_to;
        ELSIF v_link = 'conversation_id' THEN r.conversation_id := v_to;
        ELSIF v_link = 'ticket_id' THEN r.ticket_id := v_to;
        ELSE r.incident_id := v_to; END IF;
        PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'link', jsonb_build_object('field', v_link, 'from', v_old, 'to', v_to));
      END IF;
    END IF;
  END LOOP;

  IF p_patch ? 'assigned_to' THEN
    v_to := CASE WHEN jsonb_typeof(p_patch -> 'assigned_to') = 'null' THEN NULL ELSE (p_patch ->> 'assigned_to')::UUID END;
    IF v_to IS NOT NULL AND NOT public.compliance_user_can(r.account_id, v_to, 'menu.compliance') THEN
      RAISE EXCEPTION 'compliance_assignee_cannot_see_requests' USING ERRCODE = '23514';
    END IF;
    IF v_to IS DISTINCT FROM r.assigned_to THEN
      PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'assigned', jsonb_build_object('from', r.assigned_to, 'to', v_to));
      r.assigned_to := v_to;
    END IF;
  END IF;

  UPDATE public.compliance_requests SET
    customer_name = r.customer_name, customer_email = r.customer_email, customer_phone = r.customer_phone, channel = r.channel,
    kyc_validation_ref = r.kyc_validation_ref, data = r.data, data_enc = r.data_enc, received_at = r.received_at,
    target_due_at = r.target_due_at, hard_stop_at = r.hard_stop_at,
    contact_id = r.contact_id, conversation_id = r.conversation_id, ticket_id = r.ticket_id, incident_id = r.incident_id,
    assigned_to = r.assigned_to
   WHERE id = r.id;
  PERFORM set_config('vircle.compliance_fn', 'off', true);

  IF cardinality(v_changed) > 0 THEN
    PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'edited', jsonb_build_object('fields', to_jsonb(v_changed)));
  END IF;
  RETURN jsonb_build_object('id', r.id, 'changed', to_jsonb(v_changed));
END;
$$;
ALTER FUNCTION public.compliance_update_request(UUID, UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_update_request(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_update_request(UUID, UUID, JSONB) TO service_role;
