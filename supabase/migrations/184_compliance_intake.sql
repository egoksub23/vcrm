-- ============================================================
-- 184_compliance_intake.sql
--
-- Compliance requests, Part B: how requests arrive and how the customer is told. Spec: docs/compliance-requests-spec.md; how it works:
-- docs/compliance-requests.md (sections 14 to 21).
--
--   1. Capability      compliance.raise: an agent may raise a request from an Inbox conversation or a ticket. App tier (min grant: agent), Owner
--                      and Admin by default. It needs NOT menu.compliance: a person who only raises sees a status chip and nothing else.
--   2. The raiser      Part A let the person who raised a case read its whole row through the browser's own database access. That is tightened here:
--                      the policies on the case, its events, checklist and files now follow menu.compliance ONLY. A raiser gets the minimal
--                      projection (reference, type, status) through a dedicated server route.
--   3. The public form compliance_public_forms (per workspace and type: switch, slug, notice text, Turnstile, maximum amount, bank list),
--                      compliance_email_codes (the emailed 6-digit code, stored as a keyed hash with an expiry and an attempt counter).
--                      Only the two customer types (closure, withdrawal) can have a public form: a phone change is raised by staff.
--   4. The case        customer_locale (the language the customer's emails go out in), email_verified_at (the code was entered), a partial unique
--                      index so one OPEN request per type per verified email can never be duplicated by two posts at once, and the fields the
--                      public form needs on the standard types (declaration, reason_kind, proof).
--   5. The exports     compliance_exports: who exported the reports' CSV and with which filters (written before the file is handed over, never changed).
--   5b. The notices    compliance_notices: one row per email the workspace sent about a case (customer or staff), UNIQUE per (case, kind, key), so a
--                      claim is made once and a retry never sends twice. The timeline gets a 'notice' event kind.
--   6. The decision    compliance_transition (183) is replaced: a rejection now also stores the reason CATEGORY (for the reports) and the
--                      customer-facing reason (separate from the internal note). Everything else in it is unchanged.
--   7. Notifications   a type for "a request is waiting for your sign-off".
--
-- No function here is callable by a signed-in or signed-out user (all REVOKEd; EXECUTE to service_role only; every SECURITY DEFINER function pins its
-- search_path), so verify-guard-catalog.sql's authenticated_ok / anon_ok lists need no change. Every new table has row level security on and no
-- privilege for a browser role: the server (service role) is the only one that reads or writes them.
--
-- Apply this migration BEFORE the code that goes with it is deployed. It needs 183. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Capability
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('compliance.raise', 'agent', 'app')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'compliance.raise'), ('admin', 'compliance.raise')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Notifications: a type for "waiting for your sign-off" (the same rebuild as 183 used for compliance_clock)
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
                FROM unnest(v_types || ARRAY['compliance_signoff']) AS x);

  IF EXISTS (SELECT 1 FROM public.notifications n WHERE n.type IS NOT NULL AND NOT (n.type = ANY (v_types))) THEN
    RAISE EXCEPTION 'notifications_type_check rebuild would drop a type in use: %', v_def;
  END IF;

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

-- ------------------------------------------------------------
-- 3. The timeline gets a kind for the emails (sent / failed, with who sent a manual one)
-- ------------------------------------------------------------
ALTER TABLE public.compliance_request_events DROP CONSTRAINT IF EXISTS compliance_request_events_kind_check;
ALTER TABLE public.compliance_request_events
  ADD CONSTRAINT compliance_request_events_kind_check
  CHECK (kind IN ('created', 'edited', 'status', 'identity_check', 'review', 'signoff', 'execute_step', 'note', 'link',
                  'reveal', 'view', 'export', 'clock_pause', 'clock_resume', 'attachment', 'standing', 'assigned', 'clock_alert', 'notice'));

-- ------------------------------------------------------------
-- 4. The case: the customer's language, whether the email was proven, one open request per type per verified email
-- ------------------------------------------------------------
ALTER TABLE public.compliance_requests ADD COLUMN IF NOT EXISTS customer_locale TEXT;
ALTER TABLE public.compliance_requests DROP CONSTRAINT IF EXISTS compliance_requests_customer_locale_check;
ALTER TABLE public.compliance_requests
  ADD CONSTRAINT compliance_requests_customer_locale_check CHECK (customer_locale IS NULL OR customer_locale IN ('en', 'ms', 'zh', 'ko'));
ALTER TABLE public.compliance_requests ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Two posts from the same verified email at the same moment: the second one fails here and is answered like a repeat. A case counts as open until it is
-- decided against or finished (a rejected case waiting to be closed does not stop a corrected request).
CREATE UNIQUE INDEX IF NOT EXISTS compliance_requests_form_open_email
  ON public.compliance_requests (account_id, type_key, lower(customer_email))
  WHERE source = 'form' AND customer_email IS NOT NULL
    AND status IN ('received', 'identity_check', 'officer_review', 'awaiting_signoff', 'approved', 'executing');
-- the app's own repeat check (any source) and the raise dialog's duplicate check
CREATE INDEX IF NOT EXISTS compliance_requests_email_idx
  ON public.compliance_requests (account_id, type_key, lower(customer_email)) WHERE customer_email IS NOT NULL;

-- ------------------------------------------------------------
-- 5. Tightening: the raiser no longer reads the case. menu.compliance only.
--    (Part A: "or the person who raised it". The raiser now gets {reference, type, status} from a server route, never the row.)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS compliance_requests_select ON public.compliance_requests;
CREATE POLICY compliance_requests_select ON public.compliance_requests
  FOR SELECT TO authenticated
  USING (public.has_capability(account_id, 'menu.compliance'));

DROP POLICY IF EXISTS compliance_request_events_select ON public.compliance_request_events;
CREATE POLICY compliance_request_events_select ON public.compliance_request_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.compliance_requests r
                  WHERE r.id = request_id AND r.account_id = compliance_request_events.account_id
                    AND public.has_capability(r.account_id, 'menu.compliance')));

DROP POLICY IF EXISTS compliance_request_checklist_select ON public.compliance_request_checklist;
CREATE POLICY compliance_request_checklist_select ON public.compliance_request_checklist
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.compliance_requests r
                  WHERE r.id = request_id AND r.account_id = compliance_request_checklist.account_id
                    AND public.has_capability(r.account_id, 'menu.compliance')));

DROP POLICY IF EXISTS compliance_request_files_select ON public.compliance_request_files;
CREATE POLICY compliance_request_files_select ON public.compliance_request_files
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.compliance_requests r
                  WHERE r.id = request_id AND r.account_id = compliance_request_files.account_id
                    AND public.has_capability(r.account_id, 'menu.compliance')));

-- ------------------------------------------------------------
-- 6. The public forms (per workspace and type)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compliance_public_forms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- only the two customer-facing types: a phone number change is raised by staff after an identity check in a chat
  type_key    TEXT NOT NULL CHECK (type_key IN ('closure', 'withdrawal')),
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  -- /c/<slug>: random and unguessable (the Secure Sign registration slug rules)
  slug        TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{4,38}[a-z0-9]$'),
  -- {"en": "...", "ms": "...", "zh": "...", "ko": "..."}: shown above the form
  notice      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(notice) = 'object' AND length(notice::text) <= 8000),
  -- the Cloudflare Turnstile check, when the operator has set both keys
  turnstile   BOOLEAN NOT NULL DEFAULT FALSE,
  -- the largest amount a withdrawal form accepts (RM)
  max_amount  NUMERIC(14, 2) NOT NULL DEFAULT 10000 CHECK (max_amount > 0 AND max_amount <= 100000000),
  -- the banks offered in the list; null: the built-in list of Malaysian banks
  banks       JSONB CHECK (banks IS NULL OR CASE WHEN jsonb_typeof(banks) = 'array' THEN jsonb_array_length(banks) BETWEEN 1 AND 80 ELSE FALSE END),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT compliance_public_forms_slug UNIQUE (slug),
  CONSTRAINT compliance_public_forms_type UNIQUE (account_id, type_key),
  CONSTRAINT compliance_public_forms_id_account UNIQUE (id, account_id),
  CONSTRAINT compliance_public_forms_type_fk FOREIGN KEY (account_id, type_key)
    REFERENCES public.compliance_request_types (account_id, key) ON DELETE CASCADE
);

-- ------------------------------------------------------------
-- 7. The emailed codes. Only a keyed hash of the email and of the code are kept, never the address or the digits.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compliance_email_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  form_id     UUID NOT NULL,
  email_hash  TEXT NOT NULL CHECK (length(email_hash) BETWEEN 16 AND 128),
  code_hash   TEXT NOT NULL CHECK (length(code_hash) BETWEEN 16 AND 128),
  attempts    SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  ip_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT compliance_email_codes_form_fk FOREIGN KEY (form_id, account_id)
    REFERENCES public.compliance_public_forms (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS compliance_email_codes_lookup_idx ON public.compliance_email_codes (form_id, email_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS compliance_email_codes_created_idx ON public.compliance_email_codes (created_at);

-- ------------------------------------------------------------
-- 8. The notices: one claim per email about a case, once only
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compliance_notices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  request_id  UUID NOT NULL,
  -- received, more_info, approved, rejected, completed go to the customer; signoff_waiting and clock_alert go to staff
  kind        TEXT NOT NULL CHECK (kind IN ('received', 'more_info', 'approved', 'rejected', 'completed', 'signoff_waiting', 'clock_alert')),
  -- what makes this the same notice again: 'once', the alert's threshold, the sign-off hand-over's timestamp, a nonce a manual send carries
  key         TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 80),
  audience    TEXT NOT NULL CHECK (audience IN ('customer', 'staff')),
  status      TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'failed', 'skipped')),
  -- a named reason when it did not go ("mailbox_reconnect", "not_set_up", "no_address"); never an address
  detail      TEXT CHECK (detail IS NULL OR length(detail) <= 300),
  language    TEXT CHECK (language IS NULL OR language IN ('en', 'ms', 'zh', 'ko')),
  recipients  INTEGER NOT NULL DEFAULT 0 CHECK (recipients >= 0),
  claimed_by  UUID,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at  TIMESTAMPTZ,
  CONSTRAINT compliance_notices_once UNIQUE (request_id, kind, key),
  CONSTRAINT compliance_notices_request_fk FOREIGN KEY (request_id, account_id)
    REFERENCES public.compliance_requests (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS compliance_notices_request_idx ON public.compliance_notices (request_id);

-- ------------------------------------------------------------
-- 8b. The exports log: who exported the reports' CSV, with which filters, how many rows. Written BEFORE the file is handed over (the same rule as the KYC
--     access log), never changed, never deleted (a purged workspace excepted). No name, phone number or bank detail is in it, nor in the export.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compliance_exports (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- no foreign key on the person: deleting a login never touches the log
  actor      UUID,
  kind       TEXT NOT NULL DEFAULT 'csv' CHECK (kind IN ('csv')),
  filters    JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object' AND length(filters::text) <= 2000),
  row_count  INTEGER NOT NULL CHECK (row_count >= 0),
  truncated  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS compliance_exports_account_idx ON public.compliance_exports (account_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.compliance_exports_no_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW'
     AND current_user NOT IN ('anon', 'authenticated', 'service_role')
     AND current_setting('vircle.purge_account', true) = OLD.account_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'compliance_exports is append-only' USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.compliance_exports_no_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_exports_no_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS compliance_exports_no_change ON public.compliance_exports;
CREATE TRIGGER compliance_exports_no_change
  BEFORE UPDATE OR DELETE ON public.compliance_exports
  FOR EACH ROW EXECUTE FUNCTION public.compliance_exports_no_change();
DROP TRIGGER IF EXISTS compliance_exports_no_truncate ON public.compliance_exports;
CREATE TRIGGER compliance_exports_no_truncate
  BEFORE TRUNCATE ON public.compliance_exports
  FOR EACH STATEMENT EXECUTE FUNCTION public.compliance_exports_no_change();

-- ------------------------------------------------------------
-- 9. Privileges: the server only. No policy, no grant for a browser role.
-- ------------------------------------------------------------
ALTER TABLE public.compliance_public_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_email_codes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_notices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_exports      ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.compliance_public_forms, public.compliance_email_codes, public.compliance_notices, public.compliance_exports FROM PUBLIC, anon, authenticated;

-- The notices follow the case's retention: not deletable while the case is under it (the same trigger as the events and the files).
DROP TRIGGER IF EXISTS compliance_notices_no_delete ON public.compliance_notices;
CREATE TRIGGER compliance_notices_no_delete
  BEFORE DELETE ON public.compliance_notices
  FOR EACH ROW EXECUTE FUNCTION public.compliance_children_no_delete();

-- ------------------------------------------------------------
-- 10. The fields the public form needs on the two standard types (a workspace made later gets them through the seed trigger below)
--     declaration: the customer's declaration (optional for staff-raised cases; the public form requires it)
--     reason_kind: withdrawal only, over top-up or other
--     proof: withdrawal only, an optional file
--     Never overwrites a field that exists, so an administrator's edit survives a second run.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_intake_fields(p_account UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_decl JSONB;
  v_kind JSONB;
  v_proof JSONB;
BEGIN
  v_decl := jsonb_build_object('key', 'declaration', 'type', 'acknowledge', 'required', false, 'sensitive', false,
    'label', public.compliance_label('I declare that the details I have given are true and that I am the holder of this account',
      'Saya mengesahkan bahawa maklumat yang diberikan adalah benar dan saya ialah pemegang akaun ini',
      '我声明所提供的资料真实无误，并且我是此账户的持有人',
      '제가 제공한 정보가 사실이며 제가 이 계정의 명의자임을 선언합니다'));
  v_kind := jsonb_build_object('key', 'reason_kind', 'type', 'choice', 'required', false, 'sensitive', false,
    'label', public.compliance_label('Why are you withdrawing', 'Mengapa anda mengeluarkan dana', '提取原因类别', '인출 사유 구분'),
    'options', jsonb_build_array(
      jsonb_build_object('value', 'over_topup', 'label', public.compliance_label('I topped up more than I meant to', 'Saya menambah nilai lebih daripada yang dimaksudkan', '充值金额超出了我的预期', '의도한 것보다 많이 충전했습니다')),
      jsonb_build_object('value', 'other', 'label', public.compliance_label('Another reason', 'Sebab lain', '其他原因', '기타 사유'))));
  v_proof := jsonb_build_object('key', 'proof', 'type', 'file', 'required', false, 'sensitive', false,
    'label', public.compliance_label('Proof of the transaction (optional)', 'Bukti transaksi (pilihan)', '交易证明（选填）', '거래 증빙(선택)'));

  UPDATE public.compliance_request_types t SET fields = t.fields || jsonb_build_array(v_decl)
   WHERE t.account_id = p_account AND t.key IN ('closure', 'withdrawal')
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'declaration');
  UPDATE public.compliance_request_types t SET fields = t.fields || jsonb_build_array(v_kind)
   WHERE t.account_id = p_account AND t.key = 'withdrawal'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'reason_kind');
  UPDATE public.compliance_request_types t SET fields = t.fields || jsonb_build_array(v_proof)
   WHERE t.account_id = p_account AND t.key = 'withdrawal'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'proof');
END;
$$;
ALTER FUNCTION public.compliance_intake_fields(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_intake_fields(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_intake_fields(UUID) TO service_role;

-- A workspace made from now on gets the three types and the intake fields. Never blocks signup.
CREATE OR REPLACE FUNCTION public.compliance_accounts_seed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.compliance_seed_types(NEW.id);
  PERFORM public.compliance_intake_fields(NEW.id);
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
  PERFORM public.compliance_intake_fields(a.id) FROM public.accounts a;
END $$;

-- ------------------------------------------------------------
-- 11. compliance_transition, replaced: 183's function with one addition. A rejection can carry
--       reason_category   one of identity_failed, incomplete_information, dues_outstanding, not_eligible, duplicate, customer_withdrew, other
--                         (what the reports group the rejections by)
--       customer_reason   the words the customer is told, separate from the internal note (p_note)
--     Both are stored in `signoff`. They are validated when given and never required here (the route and the screen require them), so a request in
--     flight between the migration and the deploy cannot fail. The transition table, the capability each move needs, the maker-checker rule and every
--     stamp are 183's, unchanged.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_transition(
  p_request UUID, p_to TEXT, p_actor UUID, p_note TEXT DEFAULT NULL, p_payload JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r        public.compliance_requests%ROWTYPE;
  t        public.compliance_request_types%ROWTYPE;
  v_ok     BOOLEAN;
  v_note   TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_from   TEXT;
  v_open   INTEGER;
  v_method TEXT;
  v_outcome TEXT;
  v_rec    TEXT;
  v_override TEXT := NULLIF(btrim(COALESCE(p_payload ->> 'override_reason', '')), '');
  v_cat    TEXT := NULLIF(btrim(COALESCE(p_payload ->> 'reason_category', '')), '');
  v_cust   TEXT := NULLIF(btrim(COALESCE(p_payload ->> 'customer_reason', '')), '');
  v_now    TIMESTAMPTZ := now();
  v_can_review BOOLEAN;
  v_can_approve BOOLEAN;
BEGIN
  SELECT * INTO r FROM public.compliance_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'compliance_request_not_found' USING ERRCODE = 'P0002'; END IF;
  v_from := r.status;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN
    RAISE EXCEPTION 'compliance_note_too_long' USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN p_payload := '{}'::jsonb; END IF;
  IF v_cat IS NOT NULL AND NOT (v_cat IN ('identity_failed', 'incomplete_information', 'dues_outstanding', 'not_eligible', 'duplicate', 'customer_withdrew', 'other')) THEN
    RAISE EXCEPTION 'compliance_bad_category' USING ERRCODE = '22023';
  END IF;
  IF v_cust IS NOT NULL AND length(v_cust) > 1000 THEN
    RAISE EXCEPTION 'compliance_note_too_long' USING ERRCODE = '22023';
  END IF;

  v_ok := CASE r.status
    WHEN 'received'         THEN p_to IN ('identity_check', 'officer_review', 'closed')
    WHEN 'identity_check'   THEN p_to IN ('officer_review', 'closed')
    WHEN 'officer_review'   THEN p_to IN ('awaiting_signoff', 'identity_check', 'closed')
    WHEN 'awaiting_signoff' THEN p_to IN ('approved', 'rejected', 'officer_review')
    WHEN 'approved'         THEN p_to IN ('executing', 'completed')
    WHEN 'rejected'         THEN p_to IN ('closed')
    WHEN 'executing'        THEN p_to IN ('completed')
    WHEN 'completed'        THEN p_to IN ('closed')
    ELSE FALSE
  END;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'compliance_invalid_transition' USING ERRCODE = '23514', DETAIL = format('%s -> %s', r.status, p_to);
  END IF;

  -- the capability this move needs, for this person
  v_can_review  := public.compliance_user_can(r.account_id, p_actor, 'compliance.review');
  v_can_approve := public.compliance_user_can(r.account_id, p_actor, 'compliance.approve');
  IF p_to IN ('approved', 'rejected') OR (r.status = 'awaiting_signoff' AND p_to = 'officer_review') THEN
    IF NOT v_can_approve THEN RAISE EXCEPTION 'compliance_not_allowed: approve' USING ERRCODE = '42501'; END IF;
  ELSIF p_to IN ('executing', 'completed') THEN
    IF NOT public.compliance_user_can(r.account_id, p_actor, 'compliance.execute') THEN RAISE EXCEPTION 'compliance_not_allowed: execute' USING ERRCODE = '42501'; END IF;
  ELSE
    IF NOT (v_can_review OR v_can_approve) THEN RAISE EXCEPTION 'compliance_not_allowed: review' USING ERRCODE = '42501'; END IF;
  END IF;

  SELECT * INTO t FROM public.compliance_request_types x WHERE x.account_id = r.account_id AND x.key = r.type_key;

  PERFORM set_config('vircle.compliance_fn', 'on', true);

  -- ---- per target ----
  IF p_to = 'identity_check' THEN
    IF r.status = 'officer_review' AND v_note IS NULL THEN
      RAISE EXCEPTION 'compliance_note_required' USING ERRCODE = '22023';
    END IF;
    UPDATE public.compliance_requests SET status = 'identity_check', assigned_to = COALESCE(assigned_to, p_actor) WHERE id = r.id;

  ELSIF p_to = 'officer_review' AND r.status = 'awaiting_signoff' THEN
    -- the Head of Compliance sends it back to the officer
    IF v_note IS NULL THEN RAISE EXCEPTION 'compliance_note_required' USING ERRCODE = '22023'; END IF;
    UPDATE public.compliance_requests
       SET status = 'officer_review', review = review || jsonb_build_object('sent_back_at', v_now, 'sent_back_by', p_actor, 'sent_back_note', v_note)
     WHERE id = r.id;

  ELSIF p_to = 'officer_review' THEN
    -- the identity check is recorded with this move
    IF t.requires_identity_check THEN
      v_method := p_payload ->> 'method';
      v_outcome := p_payload ->> 'outcome';
      IF v_method IS NULL OR NOT (v_method IN ('call_back', 'video_call', 'id_document', 'chat_verification', 'in_person', 'other')) THEN
        RAISE EXCEPTION 'compliance_identity_method_required' USING ERRCODE = '22023';
      END IF;
      IF v_method = 'other' AND NULLIF(btrim(COALESCE(p_payload ->> 'method_other', '')), '') IS NULL THEN
        RAISE EXCEPTION 'compliance_identity_method_other_required' USING ERRCODE = '22023';
      END IF;
      IF v_outcome IS NULL OR NOT (v_outcome IN ('pass', 'fail')) THEN
        RAISE EXCEPTION 'compliance_identity_outcome_required' USING ERRCODE = '22023';
      END IF;
      IF v_outcome = 'fail' AND v_note IS NULL THEN
        RAISE EXCEPTION 'compliance_note_required' USING ERRCODE = '22023';
      END IF;
      UPDATE public.compliance_requests
         SET status = 'officer_review',
             identity_check = jsonb_build_object('method', v_method, 'method_other', NULLIF(btrim(COALESCE(p_payload ->> 'method_other', '')), ''),
                                                 'outcome', v_outcome, 'notes', v_note, 'verified_by', p_actor, 'recorded_by', p_actor, 'verified_at', v_now)
       WHERE id = r.id;
      PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'identity_check',
        jsonb_build_object('method', v_method, 'outcome', v_outcome));
    ELSE
      UPDATE public.compliance_requests
         SET status = 'officer_review', identity_check = jsonb_build_object('outcome', 'not_required', 'verified_at', v_now)
       WHERE id = r.id;
    END IF;

  ELSIF p_to = 'awaiting_signoff' THEN
    v_rec := p_payload ->> 'recommendation';
    IF v_rec IS NULL OR NOT (v_rec IN ('approve', 'reject', 'more_info')) THEN
      RAISE EXCEPTION 'compliance_recommendation_required' USING ERRCODE = '22023';
    END IF;
    IF v_rec = 'approve' AND t.requires_identity_check AND COALESCE(r.identity_check ->> 'outcome', '') <> 'pass' THEN
      RAISE EXCEPTION 'compliance_identity_not_passed' USING ERRCODE = '23514';
    END IF;
    IF v_rec IN ('reject', 'more_info') AND v_note IS NULL THEN
      RAISE EXCEPTION 'compliance_note_required' USING ERRCODE = '22023';
    END IF;
    UPDATE public.compliance_requests
       SET status = 'awaiting_signoff',
           review = jsonb_build_object('recommendation', v_rec, 'notes', v_note, 'by', p_actor, 'at', v_now)
     WHERE id = r.id;
    PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'review', jsonb_build_object('recommendation', v_rec));

  ELSIF p_to IN ('approved', 'rejected') THEN
    -- maker-checker: the person who recorded the identity check cannot sign the case off
    IF p_actor IS NOT NULL AND (
         p_actor::TEXT = COALESCE(r.identity_check ->> 'verified_by', '') OR p_actor::TEXT = COALESCE(r.identity_check ->> 'recorded_by', '')) THEN
      RAISE EXCEPTION 'compliance_maker_checker' USING ERRCODE = '42501';
    END IF;
    IF p_to = 'rejected' AND v_note IS NULL THEN
      RAISE EXCEPTION 'compliance_note_required' USING ERRCODE = '22023';
    END IF;
    IF p_to = 'approved' THEN
      IF t.requires_identity_check AND COALESCE(r.identity_check ->> 'outcome', '') <> 'pass' THEN
        RAISE EXCEPTION 'compliance_identity_not_passed' USING ERRCODE = '23514';
      END IF;
      IF t.check_dues AND (r.account_standing ->> 'dues_outstanding') = 'true' AND v_override IS NULL THEN
        RAISE EXCEPTION 'compliance_dues_outstanding' USING ERRCODE = '23514';
      END IF;
    END IF;
    UPDATE public.compliance_requests
       SET status = p_to, decided_at = v_now,
           outcome_reason = CASE WHEN p_to = 'rejected' THEN v_note ELSE outcome_reason END,
           signoff = jsonb_build_object('decision', CASE WHEN p_to = 'approved' THEN 'approved' ELSE 'rejected' END,
                                        'by', p_actor, 'at', v_now, 'reason', v_note,
                                        'override_reason', CASE WHEN p_to = 'approved' AND (r.account_standing ->> 'dues_outstanding') = 'true' THEN v_override END,
                                        'reason_category', CASE WHEN p_to = 'rejected' THEN v_cat END,
                                        'customer_reason', CASE WHEN p_to = 'rejected' THEN v_cust END)
     WHERE id = r.id;
    PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'signoff',
      jsonb_build_object('decision', p_to, 'override', p_to = 'approved' AND (r.account_standing ->> 'dues_outstanding') = 'true',
                         'category', CASE WHEN p_to = 'rejected' THEN v_cat END));

  ELSIF p_to = 'executing' THEN
    UPDATE public.compliance_requests SET status = 'executing' WHERE id = r.id;

  ELSIF p_to = 'completed' THEN
    SELECT count(*) INTO v_open FROM public.compliance_request_checklist c WHERE c.request_id = r.id AND c.done_at IS NULL;
    IF v_open > 0 THEN RAISE EXCEPTION 'compliance_checklist_incomplete' USING ERRCODE = '23514'; END IF;
    UPDATE public.compliance_requests SET status = 'completed', completed_at = v_now WHERE id = r.id;

  ELSIF p_to = 'closed' THEN
    IF r.status IN ('received', 'identity_check', 'officer_review') AND v_note IS NULL THEN
      RAISE EXCEPTION 'compliance_note_required' USING ERRCODE = '22023';
    END IF;
    UPDATE public.compliance_requests
       SET status = 'closed', closed_at = v_now, clock_paused_at = NULL,
           outcome_reason = CASE WHEN r.status IN ('received', 'identity_check', 'officer_review') THEN v_note ELSE outcome_reason END,
           retention_until = GREATEST(retention_until, v_now + interval '7 years')
     WHERE id = r.id;
  END IF;

  PERFORM set_config('vircle.compliance_fn', 'off', true);
  PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'status', jsonb_build_object('from', v_from, 'to', p_to, 'note', v_note));
  RETURN jsonb_build_object('id', r.id, 'from', v_from, 'to', p_to);
END;
$$;
ALTER FUNCTION public.compliance_transition(UUID, TEXT, UUID, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_transition(UUID, TEXT, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_transition(UUID, TEXT, UUID, TEXT, JSONB) TO service_role;
