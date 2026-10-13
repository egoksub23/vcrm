-- ============================================================
-- 185_compliance_chat_link.sql
--
-- Compliance requests, linked to the chat. Spec: docs/compliance-requests-spec.md; how it works: docs/compliance-requests.md (section 22).
--
--   1. The link        compliance_form_links: a PERSONAL, SINGLE-USE, EXPIRING link to the account closure form, made for one case and sent in the
--                      conversation the case was raised from. Only a keyed hash of the token is stored (never the token); one ACTIVE link per case
--                      (a new one replaces the old); the rows follow the case's retention; nothing can write them but the functions below.
--   2. The functions   compliance_mint_form_link (mint, replacing the old link), compliance_form_link_sent (delivered, or not delivered with the
--                      reason), compliance_revoke_form_link, compliance_form_link_opened, compliance_apply_form_link (the ATOMIC claim: the link is
--                      used and the case is updated in one transaction, so a double submit cannot apply twice). All service role only.
--   3. The timeline    two more event kinds: form_link (minted, sent, resent, opened, revoked, not sent) and form_submitted.
--   4. The message     messages.content_type accepts 'link_card' (a tappable card with a button; the row keeps the words and the link's id, never the
--                      address).
--   5. Notifications   a type for "a closure form was submitted".
--   6. Account change  the system type phone_change becomes "Account change": what changes (parent phone number, parent email address or a child's
--                      name: never a parent's name), with the current and new value asked according to the choice. Never overwrites an edit made by an
--                      administrator (the same rule as 184's intake fields); the signup seed calls it for a workspace made later.
--
-- No function here is callable by a signed-in or signed-out user (all REVOKEd; EXECUTE to service_role only; every SECURITY DEFINER function pins its
-- search_path), so verify-guard-catalog.sql's authenticated_ok / anon_ok lists need no change. The new table has row level security on; a member holding
-- menu.compliance may read it (not the token hash), nobody can write it from a browser role.
--
-- Apply this migration BEFORE the code that goes with it is deployed. It needs 183 and 184. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The timeline: two more kinds (184's list plus form_link and form_submitted)
-- ------------------------------------------------------------
ALTER TABLE public.compliance_request_events DROP CONSTRAINT IF EXISTS compliance_request_events_kind_check;
ALTER TABLE public.compliance_request_events
  ADD CONSTRAINT compliance_request_events_kind_check
  CHECK (kind IN ('created', 'edited', 'status', 'identity_check', 'review', 'signoff', 'execute_step', 'note', 'link',
                  'reveal', 'view', 'export', 'clock_pause', 'clock_resume', 'attachment', 'standing', 'assigned', 'clock_alert', 'notice',
                  'form_link', 'form_submitted'));

-- ------------------------------------------------------------
-- 2. Notifications: a type for "a closure form was submitted" (the same rebuild as 183 and 184)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_def   TEXT;
  v_types TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';

  IF v_def ~ '\{[^}]*\}' THEN
    v_types := string_to_array(substring(v_def FROM '\{([^}]*)\}'), ',');
  ELSE
    SELECT COALESCE(array_agg(DISTINCT m[1]), ARRAY[]::text[])
      INTO v_types
      FROM regexp_matches(COALESCE(v_def, ''), '''([^'']+)''::text', 'g') AS m;
  END IF;
  v_types := (SELECT array_agg(DISTINCT replace(x, '"', '') ORDER BY replace(x, '"', ''))
                FROM unnest(v_types || ARRAY['compliance_form']) AS x);

  IF EXISTS (SELECT 1 FROM public.notifications n WHERE n.type IS NOT NULL AND NOT (n.type = ANY (v_types))) THEN
    RAISE EXCEPTION 'notifications_type_check rebuild would drop a type in use: %', v_def;
  END IF;

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

-- ------------------------------------------------------------
-- 3. The message: content_type accepts 'link_card'. The existing values are read from the live constraint and kept (the list has been widened by more
--    than one migration); the new constraint is added NOT VALID and then validated, so the check does not hold a lock on the messages table while it
--    reads every row (widening a list cannot make an existing row invalid).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_def   TEXT;
  v_name  TEXT;
  v_types TEXT[];
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO v_name, v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.messages'::regclass AND c.contype = 'c'
     AND (c.conname = 'messages_content_type_check' OR pg_get_constraintdef(c.oid) ~ 'content_type[^=]*= ANY')
   ORDER BY (c.conname = 'messages_content_type_check') DESC, c.conname
   LIMIT 1;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'messages has no content_type check to widen';
  END IF;

  IF v_def ~ '\{[^}]*\}' THEN
    v_types := string_to_array(substring(v_def FROM '\{([^}]*)\}'), ',');
  ELSE
    SELECT COALESCE(array_agg(DISTINCT m[1]), ARRAY[]::text[])
      INTO v_types
      FROM regexp_matches(COALESCE(v_def, ''), '''([^'']+)''::text', 'g') AS m;
  END IF;
  IF cardinality(v_types) = 0 THEN
    RAISE EXCEPTION 'could not read the content types from %', v_def;
  END IF;
  v_types := (SELECT array_agg(DISTINCT replace(x, '"', '') ORDER BY replace(x, '"', ''))
                FROM unnest(v_types || ARRAY['link_card']) AS x);

  EXECUTE format('ALTER TABLE public.messages DROP CONSTRAINT %I', v_name);
  EXECUTE format(
    'ALTER TABLE public.messages ADD CONSTRAINT messages_content_type_check CHECK (content_type = ANY (%L::text[])) NOT VALID',
    v_types);
  ALTER TABLE public.messages VALIDATE CONSTRAINT messages_content_type_check;
END $$;

-- ------------------------------------------------------------
-- 4. The personal closure form link
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compliance_form_links (
  id              UUID PRIMARY KEY,
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  request_id      UUID NOT NULL,
  -- an HMAC-SHA-256 of the token under a key derived from the key ring: hex. The token itself is never stored.
  token_hash      TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- the conversation it was sent in, and the channel (set null when the conversation or the message is deleted)
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  channel         TEXT CHECK (channel IS NULL OR channel ~ '^[a-z_]{2,30}$'),
  message_id      UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  -- the language the form opens in
  locale          TEXT CHECK (locale IS NULL OR locale IN ('en', 'ms', 'zh', 'ko')),
  -- no foreign key on the people (deleting a login never touches a case under retention)
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  sent_at         TIMESTAMPTZ,
  opened_at       TIMESTAMPTZ,
  submitted_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID,
  -- 'replaced': a newer link was made for the case; 'revoked': an agent withdrew it
  revoked_reason  TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN ('replaced', 'revoked')),
  CONSTRAINT compliance_form_links_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '31 days'),
  CONSTRAINT compliance_form_links_revoked CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT compliance_form_links_token UNIQUE (token_hash),
  CONSTRAINT compliance_form_links_id_account UNIQUE (id, account_id),
  CONSTRAINT compliance_form_links_request_fk FOREIGN KEY (request_id, account_id)
    REFERENCES public.compliance_requests (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS compliance_form_links_request_idx ON public.compliance_form_links (request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS compliance_form_links_conversation_idx ON public.compliance_form_links (conversation_id) WHERE conversation_id IS NOT NULL;
-- ONE active link per case: minting a new one revokes the old, and two minted at the same moment cannot both stand
CREATE UNIQUE INDEX IF NOT EXISTS compliance_form_links_one_active
  ON public.compliance_form_links (request_id) WHERE revoked_at IS NULL AND submitted_at IS NULL;

ALTER TABLE public.compliance_form_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.compliance_form_links FROM PUBLIC, anon, authenticated;
-- the browser may read the state of a link (never the token hash), and write nothing
GRANT SELECT (id, account_id, request_id, conversation_id, channel, message_id, locale, created_by, created_at, expires_at, sent_at, opened_at,
              submitted_at, revoked_at, revoked_by, revoked_reason)
  ON public.compliance_form_links TO authenticated;

DROP POLICY IF EXISTS compliance_form_links_select ON public.compliance_form_links;
CREATE POLICY compliance_form_links_select ON public.compliance_form_links
  FOR SELECT TO authenticated
  USING (public.has_capability(account_id, 'menu.compliance'));

-- Nothing writes a link but the functions below (they switch on the same transaction-local flag the case's functions use). The one change that needs no
-- function is the cleanup when the conversation or the message it points at is deleted: that column is emptied and nothing else changes.
CREATE OR REPLACE FUNCTION public.compliance_form_links_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_fn BOOLEAN := COALESCE(current_setting('vircle.compliance_fn', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT v_fn THEN
      RAISE EXCEPTION 'compliance_form_link_change_refused: use compliance_mint_form_link' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'compliance_form_link_fixed_fields' USING ERRCODE = '23514';
  END IF;

  -- the cleanup of a deleted conversation or message
  IF (to_jsonb(NEW) - 'conversation_id' - 'message_id') = (to_jsonb(OLD) - 'conversation_id' - 'message_id')
     AND (NEW.conversation_id IS NULL OR NEW.conversation_id IS NOT DISTINCT FROM OLD.conversation_id)
     AND (NEW.message_id IS NULL OR NEW.message_id IS NOT DISTINCT FROM OLD.message_id) THEN
    RETURN NEW;
  END IF;

  IF NOT v_fn THEN
    RAISE EXCEPTION 'compliance_form_link_change_refused: use the compliance functions' USING ERRCODE = '42501';
  END IF;
  -- a link that was filled in is final
  IF OLD.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION 'compliance_form_link_fixed_fields' USING ERRCODE = '23514';
  END IF;
  -- times only ever move from empty to set
  IF (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at AND NEW.sent_at IS NULL)
     OR (OLD.opened_at IS NOT NULL AND NEW.opened_at IS DISTINCT FROM OLD.opened_at)
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason)) THEN
    RAISE EXCEPTION 'compliance_form_link_fixed_fields' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.compliance_form_links_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_form_links_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS compliance_form_links_guard ON public.compliance_form_links;
CREATE TRIGGER compliance_form_links_guard
  BEFORE INSERT OR UPDATE ON public.compliance_form_links
  FOR EACH ROW EXECUTE FUNCTION public.compliance_form_links_guard();

-- Retention: the link rows follow the case (not deletable while it is under retention; a purged workspace excepted), the same trigger as the events.
DROP TRIGGER IF EXISTS compliance_form_links_no_delete ON public.compliance_form_links;
CREATE TRIGGER compliance_form_links_no_delete
  BEFORE DELETE ON public.compliance_form_links
  FOR EACH ROW EXECUTE FUNCTION public.compliance_children_no_delete();
DROP TRIGGER IF EXISTS compliance_form_links_no_truncate ON public.compliance_form_links;
CREATE TRIGGER compliance_form_links_no_truncate
  BEFORE TRUNCATE ON public.compliance_form_links
  FOR EACH STATEMENT EXECUTE FUNCTION public.compliance_children_no_delete();

-- ------------------------------------------------------------
-- 5. compliance_mint_form_link: a new personal link for a closure case. The token is made by the app (it is inside the token that the link's id
--    travels) and only its keyed hash arrives here. Any link still active for the case is revoked as "replaced" in the same transaction.
--    Needs compliance.raise, compliance.review or compliance.approve for the named person. Only a closure still in received / identity check / officer
--    review can be sent a form, and not after a form came back.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_mint_form_link(
  p_request UUID, p_actor UUID, p_link UUID, p_token_hash TEXT, p_conversation UUID, p_channel TEXT,
  p_locale TEXT DEFAULT NULL, p_ttl_days INTEGER DEFAULT 14
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r        public.compliance_requests%ROWTYPE;
  v_old    RECORD;
  v_replaced UUID[] := '{}';
  v_days   INTEGER := LEAST(30, GREATEST(1, COALESCE(p_ttl_days, 14)));
  v_expires TIMESTAMPTZ;
BEGIN
  SELECT * INTO r FROM public.compliance_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'compliance_request_not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (public.compliance_user_can(r.account_id, p_actor, 'compliance.raise')
          OR public.compliance_user_can(r.account_id, p_actor, 'compliance.review')
          OR public.compliance_user_can(r.account_id, p_actor, 'compliance.approve')) THEN
    RAISE EXCEPTION 'compliance_not_allowed: raise' USING ERRCODE = '42501';
  END IF;
  IF r.type_key <> 'closure' OR r.status NOT IN ('received', 'identity_check', 'officer_review') THEN
    RAISE EXCEPTION 'compliance_form_link_not_allowed' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.compliance_form_links l WHERE l.request_id = r.id AND l.submitted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'compliance_form_link_submitted' USING ERRCODE = '23514';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_link IS NULL THEN
    RAISE EXCEPTION 'compliance_bad_patch' USING ERRCODE = '22023';
  END IF;
  IF p_conversation IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = p_conversation AND c.account_id = r.account_id) THEN
    RAISE EXCEPTION 'compliance_link_other_workspace: conversation' USING ERRCODE = '23514';
  END IF;
  v_expires := now() + make_interval(days => v_days);

  PERFORM set_config('vircle.compliance_fn', 'on', true);

  FOR v_old IN
    SELECT l.id FROM public.compliance_form_links l
     WHERE l.request_id = r.id AND l.revoked_at IS NULL AND l.submitted_at IS NULL
     FOR UPDATE
  LOOP
    UPDATE public.compliance_form_links SET revoked_at = now(), revoked_by = p_actor, revoked_reason = 'replaced' WHERE id = v_old.id;
    v_replaced := v_replaced || v_old.id;
    PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'form_link', jsonb_build_object('action', 'revoked', 'reason', 'replaced', 'link', v_old.id));
  END LOOP;

  INSERT INTO public.compliance_form_links (id, account_id, request_id, token_hash, conversation_id, channel, locale, created_by, expires_at)
  VALUES (p_link, r.account_id, r.id, p_token_hash, p_conversation, NULLIF(p_channel, ''), p_locale, p_actor, v_expires);
  PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'form_link',
    jsonb_build_object('action', 'minted', 'link', p_link, 'channel', NULLIF(p_channel, ''), 'expires_at', v_expires));

  PERFORM set_config('vircle.compliance_fn', 'off', true);
  RETURN jsonb_build_object('id', p_link, 'expires_at', v_expires, 'replaced', to_jsonb(v_replaced));
END;
$$;
ALTER FUNCTION public.compliance_mint_form_link(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_mint_form_link(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_mint_form_link(UUID, UUID, UUID, TEXT, UUID, TEXT, TEXT, INTEGER) TO service_role;

-- ------------------------------------------------------------
-- 6. compliance_form_link_sent: the outcome of putting the link in the chat. Delivered: sent_at is stamped and the message is remembered (a resend is
--    told apart in the timeline). Not delivered (the window had closed, the channel cannot take it, the send failed): the timeline says so with a named
--    reason, and a failed message row is remembered too. Only a link that can still be used.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_form_link_sent(
  p_link UUID, p_actor UUID, p_message UUID, p_delivered BOOLEAN, p_resend BOOLEAN DEFAULT FALSE, p_reason TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l        public.compliance_form_links%ROWTYPE;
  v_reason TEXT := CASE WHEN p_reason IN ('window_expired', 'channel_unsupported', 'send_failed', 'no_channel', 'not_configured') THEN p_reason END;
BEGIN
  SELECT * INTO l FROM public.compliance_form_links WHERE id = p_link FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'compliance_form_link_not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (public.compliance_user_can(l.account_id, p_actor, 'compliance.raise')
          OR public.compliance_user_can(l.account_id, p_actor, 'compliance.review')
          OR public.compliance_user_can(l.account_id, p_actor, 'compliance.approve')) THEN
    RAISE EXCEPTION 'compliance_not_allowed: raise' USING ERRCODE = '42501';
  END IF;
  IF l.revoked_at IS NOT NULL OR l.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION 'compliance_form_link_not_allowed' USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('vircle.compliance_fn', 'on', true);
  UPDATE public.compliance_form_links
     SET sent_at = CASE WHEN p_delivered THEN now() ELSE sent_at END,
         message_id = CASE WHEN p_message IS NOT NULL AND EXISTS (SELECT 1 FROM public.messages m WHERE m.id = p_message AND m.account_id = l.account_id)
                           THEN p_message ELSE message_id END
   WHERE id = l.id;
  PERFORM set_config('vircle.compliance_fn', 'off', true);

  PERFORM public.compliance_event(l.account_id, l.request_id, p_actor, 'form_link',
    jsonb_build_object('action', CASE WHEN p_delivered AND p_resend THEN 'resent' WHEN p_delivered THEN 'sent' ELSE 'not_sent' END,
                       'link', l.id, 'channel', l.channel, 'reason', v_reason));
  RETURN TRUE;
END;
$$;
ALTER FUNCTION public.compliance_form_link_sent(UUID, UUID, UUID, BOOLEAN, BOOLEAN, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_form_link_sent(UUID, UUID, UUID, BOOLEAN, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_form_link_sent(UUID, UUID, UUID, BOOLEAN, BOOLEAN, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 7. compliance_revoke_form_link: withdraw the case's active link. Returns the link's id, or null when there is none.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_revoke_form_link(p_request UUID, p_actor UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r      public.compliance_requests%ROWTYPE;
  v_link UUID;
BEGIN
  SELECT * INTO r FROM public.compliance_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'compliance_request_not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (public.compliance_user_can(r.account_id, p_actor, 'compliance.raise')
          OR public.compliance_user_can(r.account_id, p_actor, 'compliance.review')
          OR public.compliance_user_can(r.account_id, p_actor, 'compliance.approve')) THEN
    RAISE EXCEPTION 'compliance_not_allowed: raise' USING ERRCODE = '42501';
  END IF;
  SELECT l.id INTO v_link FROM public.compliance_form_links l
   WHERE l.request_id = r.id AND l.revoked_at IS NULL AND l.submitted_at IS NULL
   FOR UPDATE;
  IF v_link IS NULL THEN RETURN NULL; END IF;

  PERFORM set_config('vircle.compliance_fn', 'on', true);
  UPDATE public.compliance_form_links SET revoked_at = now(), revoked_by = p_actor, revoked_reason = 'revoked' WHERE id = v_link;
  PERFORM set_config('vircle.compliance_fn', 'off', true);
  PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'form_link', jsonb_build_object('action', 'revoked', 'reason', 'revoked', 'link', v_link));
  RETURN v_link;
END;
$$;
ALTER FUNCTION public.compliance_revoke_form_link(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_revoke_form_link(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_revoke_form_link(UUID, UUID) TO service_role;

-- ------------------------------------------------------------
-- 8. compliance_form_link_opened: the customer opened the page (the first time only). No actor. Returns whether the link can still be used.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_form_link_opened(p_link UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l public.compliance_form_links%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.compliance_form_links WHERE id = p_link FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  IF l.revoked_at IS NOT NULL OR l.submitted_at IS NOT NULL OR l.expires_at <= now() THEN RETURN FALSE; END IF;
  IF l.opened_at IS NULL THEN
    PERFORM set_config('vircle.compliance_fn', 'on', true);
    UPDATE public.compliance_form_links SET opened_at = now() WHERE id = l.id;
    PERFORM set_config('vircle.compliance_fn', 'off', true);
    PERFORM public.compliance_event(l.account_id, l.request_id, NULL, 'form_link', jsonb_build_object('action', 'opened', 'link', l.id, 'channel', l.channel));
  END IF;
  RETURN TRUE;
END;
$$;
ALTER FUNCTION public.compliance_form_link_opened(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_form_link_opened(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_form_link_opened(UUID) TO service_role;

-- ------------------------------------------------------------
-- 9. compliance_apply_form_link: the customer submitted the form. THE atomic claim: under a lock on the link and on the case, the link must still be
--    usable (not used, not revoked, not expired) and the case must still be editable (received / identity check / officer review); then in one
--    transaction the link is marked used, the case takes the customer's name, the email they typed, the phone only when the case had none, the
--    ordinary answers (merged into what is there), the protected answers (already encrypted by the app; replaces data_enc) and their language, and the
--    form_submitted event is written. Two submissions at once: the second finds the link used and fails with compliance_form_link_invalid, so nothing
--    is applied twice. identity_check is not touched: the identity check stays NOT done.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_apply_form_link(
  p_link UUID, p_name TEXT, p_email TEXT, p_phone TEXT, p_data JSONB, p_data_enc TEXT, p_locale TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l public.compliance_form_links%ROWTYPE;
  r public.compliance_requests%ROWTYPE;
  v_name  TEXT := btrim(COALESCE(p_name, ''));
  v_email TEXT := btrim(COALESCE(p_email, ''));
BEGIN
  SELECT * INTO l FROM public.compliance_form_links WHERE id = p_link FOR UPDATE;
  IF NOT FOUND OR l.revoked_at IS NOT NULL OR l.submitted_at IS NOT NULL OR l.expires_at <= now() THEN
    RAISE EXCEPTION 'compliance_form_link_invalid' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO r FROM public.compliance_requests WHERE id = l.request_id AND account_id = l.account_id FOR UPDATE;
  IF NOT FOUND OR r.type_key <> 'closure' OR r.status NOT IN ('received', 'identity_check', 'officer_review') THEN
    RAISE EXCEPTION 'compliance_form_link_invalid' USING ERRCODE = '23514';
  END IF;
  IF v_name = '' OR length(v_name) > 200 OR v_email = '' OR length(v_email) > 320 OR v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
     OR p_data IS NULL OR jsonb_typeof(p_data) <> 'object' OR (p_locale IS NOT NULL AND p_locale NOT IN ('en', 'ms', 'zh', 'ko')) THEN
    RAISE EXCEPTION 'compliance_bad_patch' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('vircle.compliance_fn', 'on', true);
  UPDATE public.compliance_requests
     SET customer_name = v_name,
         customer_email = v_email,
         customer_phone = COALESCE(customer_phone, NULLIF(btrim(COALESCE(p_phone, '')), '')),
         data = COALESCE(data, '{}'::jsonb) || p_data,
         data_enc = COALESCE(p_data_enc, data_enc),
         customer_locale = COALESCE(p_locale, customer_locale)
   WHERE id = r.id;
  UPDATE public.compliance_form_links SET submitted_at = now() WHERE id = l.id;
  PERFORM set_config('vircle.compliance_fn', 'off', true);

  PERFORM public.compliance_event(r.account_id, r.id, NULL, 'form_submitted', jsonb_build_object('link', l.id, 'channel', l.channel));
  RETURN jsonb_build_object('request_id', r.id, 'reference', r.reference, 'account_id', r.account_id, 'created_by', l.created_by,
                            'conversation_id', l.conversation_id, 'contact_id', r.contact_id, 'phone_known', r.customer_phone IS NOT NULL);
END;
$$;
ALTER FUNCTION public.compliance_apply_form_link(UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_apply_form_link(UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_apply_form_link(UUID, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 10. Account change: the system type phone_change. What changes (parent phone number, parent email address, a child's name) decides which current and
--     new values are asked (showIf); a parent's name is deliberately not an option. Never overwrites an administrator's edit: the type is relabelled only
--     while it still has the words 184 seeded, a field is added only when its key is absent, and showIf is set only on a field that has none.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_account_change_fields(p_account UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_what   JSONB;
  v_cemail JSONB;
  v_nemail JSONB;
  v_cchild JSONB;
  v_nchild JSONB;
  v_show_phone JSONB := jsonb_build_object('field', 'what_changes', 'in', jsonb_build_array('parent_phone'));
  v_show_email JSONB := jsonb_build_object('field', 'what_changes', 'in', jsonb_build_array('parent_email'));
  v_show_child JSONB := jsonb_build_object('field', 'what_changes', 'in', jsonb_build_array('child_name'));
BEGIN
  v_what := jsonb_build_object('key', 'what_changes', 'type', 'choice', 'required', true, 'sensitive', false,
    'label', public.compliance_label('What is changing', 'Apakah yang berubah', '变更内容', '변경 내용'),
    'help', public.compliance_label('A parent''s name cannot be changed here.', 'Nama ibu bapa tidak boleh ditukar di sini.', '此处无法更改家长的姓名。', '부모의 이름은 여기에서 변경할 수 없습니다.'),
    'options', jsonb_build_array(
      jsonb_build_object('value', 'parent_phone', 'label', public.compliance_label('Parent phone number', 'Nombor telefon ibu bapa', '家长手机号码', '부모 전화번호')),
      jsonb_build_object('value', 'parent_email', 'label', public.compliance_label('Parent email address', 'Alamat e-mel ibu bapa', '家长电子邮件地址', '부모 이메일 주소')),
      jsonb_build_object('value', 'child_name', 'label', public.compliance_label('Child''s name', 'Nama anak', '孩子的姓名', '자녀 이름'))));
  v_cemail := jsonb_build_object('key', 'current_email', 'type', 'email', 'required', true, 'sensitive', false, 'showIf', v_show_email,
    'label', public.compliance_label('Current email address', 'Alamat e-mel semasa', '当前电子邮件地址', '현재 이메일 주소'));
  v_nemail := jsonb_build_object('key', 'new_email', 'type', 'email', 'required', true, 'sensitive', false, 'showIf', v_show_email,
    'label', public.compliance_label('New email address', 'Alamat e-mel baharu', '新电子邮件地址', '새 이메일 주소'));
  v_cchild := jsonb_build_object('key', 'child_current_name', 'type', 'text', 'required', true, 'sensitive', false, 'showIf', v_show_child,
    'label', public.compliance_label('Child''s current name', 'Nama semasa anak', '孩子当前的姓名', '자녀의 현재 이름'));
  v_nchild := jsonb_build_object('key', 'child_new_name', 'type', 'text', 'required', true, 'sensitive', false, 'showIf', v_show_child,
    'label', public.compliance_label('Child''s new name', 'Nama baharu anak', '孩子的新姓名', '자녀의 새 이름'));

  -- the words: only while they are still the ones 183 seeded
  UPDATE public.compliance_request_types t
     SET label = 'Account change',
         label_l10n = jsonb_build_object('ms', 'Pertukaran maklumat akaun', 'zh', '账户信息变更', 'ko', '계정 정보 변경')
   WHERE t.account_id = p_account AND t.key = 'phone_change' AND t.label = 'Phone number change'
     AND t.label_l10n = jsonb_build_object('ms', 'Pertukaran nombor telefon', 'zh', '更改手机号码', 'ko', '전화번호 변경');

  -- what_changes first
  UPDATE public.compliance_request_types t SET fields = jsonb_build_array(v_what) || t.fields
   WHERE t.account_id = p_account AND t.key = 'phone_change'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'what_changes');

  -- the two phone fields are asked for a phone change only
  UPDATE public.compliance_request_types t
     SET fields = (SELECT jsonb_agg(CASE WHEN e.f ->> 'key' IN ('current_phone', 'new_phone') AND NOT (e.f ? 'showIf')
                                         THEN e.f || jsonb_build_object('showIf', v_show_phone) ELSE e.f END ORDER BY e.ord)
                     FROM jsonb_array_elements(t.fields) WITH ORDINALITY AS e(f, ord))
   WHERE t.account_id = p_account AND t.key = 'phone_change'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'what_changes')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' IN ('current_phone', 'new_phone') AND NOT (f ? 'showIf'));

  -- the email and child-name pairs
  UPDATE public.compliance_request_types t SET fields = t.fields || jsonb_build_array(v_cemail)
   WHERE t.account_id = p_account AND t.key = 'phone_change'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'current_email');
  UPDATE public.compliance_request_types t SET fields = t.fields || jsonb_build_array(v_nemail)
   WHERE t.account_id = p_account AND t.key = 'phone_change'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'new_email');
  UPDATE public.compliance_request_types t SET fields = t.fields || jsonb_build_array(v_cchild)
   WHERE t.account_id = p_account AND t.key = 'phone_change'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'child_current_name');
  UPDATE public.compliance_request_types t SET fields = t.fields || jsonb_build_array(v_nchild)
   WHERE t.account_id = p_account AND t.key = 'phone_change'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'child_new_name');

  -- the operations step is no longer only about a phone number (its key stays; only the words the template still has from 183 change)
  UPDATE public.compliance_request_types t
     SET checklist = (SELECT jsonb_agg(CASE WHEN c.item ->> 'key' = 'update_phone' AND c.item #>> '{label,en}' = 'Change the phone number in the back office'
                                            THEN c.item || jsonb_build_object('label', public.compliance_label('Make the change in the back office', 'Buat perubahan di back office', '在后台进行变更', '백오피스에서 변경 처리'))
                                            ELSE c.item END ORDER BY c.ord)
                        FROM jsonb_array_elements(t.checklist) WITH ORDINALITY AS c(item, ord))
   WHERE t.account_id = p_account AND t.key = 'phone_change' AND jsonb_array_length(t.checklist) > 0
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.checklist) c WHERE c ->> 'key' = 'update_phone' AND c #>> '{label,en}' = 'Change the phone number in the back office');
END;
$$;
ALTER FUNCTION public.compliance_account_change_fields(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_account_change_fields(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_account_change_fields(UUID) TO service_role;

-- A workspace made from now on gets the three types, 184's intake fields and the account change fields. Never blocks signup.
CREATE OR REPLACE FUNCTION public.compliance_accounts_seed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.compliance_seed_types(NEW.id);
  PERFORM public.compliance_intake_fields(NEW.id);
  PERFORM public.compliance_account_change_fields(NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'compliance_accounts_seed failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.compliance_accounts_seed() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_accounts_seed() FROM PUBLIC, anon, authenticated;

-- the workspaces that exist now
DO $$
BEGIN
  PERFORM public.compliance_account_change_fields(a.id) FROM public.accounts a;
END $$;
