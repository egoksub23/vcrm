-- ============================================================
-- 183_compliance_requests.sql
--
-- Compliance requests, Part A (the core). A customer's instruction that Vircle must act on and be able to prove it acted on: closing an
-- account, withdrawing funds, changing a registered phone number. Visible to a small group, with a regulatory clock, an identity check, a
-- maker-checker sign-off, an operations checklist, private evidence files and an append-only trail kept for seven years. Spec:
-- docs/compliance-requests-spec.md; how it works: docs/compliance-requests.md.
--
--   1. Capabilities   menu.compliance (see the area), compliance.review, compliance.approve, compliance.reveal, compliance.execute,
--                     compliance.manage. App tier (min grant: agent). Owner and Admin by default; nobody else until an admin grants them
--                     (the owner defines "Head of Compliance" and "Compliance Officer" as custom roles in the roles screen).
--   2. The flag       platform feature `compliance`, OFF for every workspace (explicit false) and for every new one (account_platform_seed).
--   3. Tables         compliance_request_types, compliance_requests, compliance_request_events (append-only), compliance_request_checklist,
--                     compliance_request_files (metadata; the bytes are in the private bucket 'compliance-files'), compliance_request_counters.
--   4. The rules in the database, not only in the app:
--        * reference CMP-YYYY-NNNNNN from a per-workspace, per-year counter (race-safe upsert), never changed
--        * the clocks (target and hard stop) are stamped from the type's settings when the case is created and not rewritten afterwards
--        * status moves ONLY through compliance_transition(): one function, a transition table, a row lock, the capability the move needs
--          (checked in the database against the named person), the maker-checker rule (the person who recorded the identity check cannot sign
--          the case off), the stamps and the event. A plain UPDATE of any protected column is refused for every role, the service role included
--        * edits, the dues standing, the clock pause and the checklist ticks have their own functions that check their capability and write
--          their event in the same transaction
--        * the case, its events, its checklist and its files cannot be deleted while retention_until (7 years from the end) is in the future;
--          events are append-only. The only exception is the one the audit log has: a workspace being purged by delete_workspace_data() (153)
--   5. Visibility     row level security: a member sees a case only with menu.compliance in that workspace, or when they raised it. The ciphertext
--                     and the storage path are not granted to the browser at all (column privileges).
--   6. The clock sweep compliance_clock_alert_sweep(): once per case per threshold (10 days, 5 days before the hard stop, and at the stop) it
--                     writes a clock_alert event and an in-app notification for the holders of compliance.approve / compliance.review.
--   7. Storage        private bucket 'compliance-files'. Private buckets need no entry in verify-guard-catalog.sql (that list is for PUBLIC buckets).
--
-- No function here is callable by a signed-in or signed-out user (all REVOKEd; EXECUTE to service_role only), so verify-guard-catalog.sql's
-- authenticated_ok / anon_ok lists need no change. Trigger functions pin their search_path.
--
-- Apply this migration BEFORE the code that goes with it is deployed. It needs 182 (the seed function replaced here carries its `kyc` key).
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Capabilities
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('menu.compliance',    'agent', 'app'),
  ('compliance.review',  'agent', 'app'),
  ('compliance.approve', 'agent', 'app'),
  ('compliance.reveal',  'agent', 'app'),
  ('compliance.execute', 'agent', 'app'),
  ('compliance.manage',  'agent', 'app')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'menu.compliance'),    ('admin', 'menu.compliance'),
  ('owner', 'compliance.review'),  ('admin', 'compliance.review'),
  ('owner', 'compliance.approve'), ('admin', 'compliance.approve'),
  ('owner', 'compliance.reveal'),  ('admin', 'compliance.reveal'),
  ('owner', 'compliance.execute'), ('admin', 'compliance.execute'),
  ('owner', 'compliance.manage'),  ('admin', 'compliance.manage')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2. The platform flag: off everywhere until the operator turns it on
-- ------------------------------------------------------------
UPDATE public.account_platform
SET features = features || '{"compliance": false}'::jsonb
WHERE NOT (features ? 'compliance');

-- 182's seed with one more key. A workspace made from now on starts with Compliance requests off.
CREATE OR REPLACE FUNCTION public.account_platform_seed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.account_platform (account_id, features)
  VALUES (NEW.id,
          '{"incidents": false, "jira": false, "vircle_chat": false, "sign": false, "sign_merchant": false, "kyc": false, "compliance": false}'::jsonb)
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block signup; readers treat a missing row as active/all-features (except kyc and compliance, which the app reads as off).
  RAISE WARNING 'account_platform_seed failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.account_platform_seed() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_platform_seed() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Notifications: a type for the clock alerts and the case they are about
-- ------------------------------------------------------------
DO $$
DECLARE
  v_def   TEXT;
  v_types TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';

  -- The live definition is either ANY ('{a,b}'::text[]) or ANY (ARRAY['a'::text, 'b'::text]); read both.
  IF v_def ~ '\{[^}]*\}' THEN
    v_types := string_to_array(substring(v_def FROM '\{([^}]*)\}'), ',');
  ELSE
    SELECT COALESCE(array_agg(DISTINCT m[1]), ARRAY[]::text[])
      INTO v_types
      FROM regexp_matches(COALESCE(v_def, ''), '''([^'']+)''::text', 'g') AS m;
  END IF;
  v_types := (SELECT array_agg(DISTINCT replace(x, '"', '') ORDER BY replace(x, '"', ''))
                FROM unnest(v_types || ARRAY['compliance_clock']) AS x);

  IF EXISTS (SELECT 1 FROM public.notifications n WHERE n.type IS NOT NULL AND NOT (n.type = ANY (v_types))) THEN
    RAISE EXCEPTION 'notifications_type_check rebuild would drop a type in use: %', v_def;
  END IF;

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

-- ------------------------------------------------------------
-- 4. Request types (a definition per workspace; three system types are seeded below)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compliance_request_types (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key                     TEXT NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label                   TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  -- {"ms": "...", "zh": "...", "ko": "..."}; the screen falls back to `label`
  label_l10n              JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(label_l10n) = 'object'),
  -- [{ key, type, required, sensitive, label: {en, ms, zh, ko}, help?, options? }]; validated by the app (src/lib/compliance/fields.ts)
  fields                  JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fields) = 'array' AND length(fields::text) <= 60000),
  -- [{ key, label: {en, ms, zh, ko} }]: copied onto each case when it is created
  checklist               JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checklist) = 'array' AND length(checklist::text) <= 20000),
  target_days             INTEGER CHECK (target_days IS NULL OR target_days BETWEEN 1 AND 365),
  hard_stop_days          INTEGER CHECK (hard_stop_days IS NULL OR hard_stop_days BETWEEN 1 AND 730),
  requires_identity_check BOOLEAN NOT NULL DEFAULT TRUE,
  -- the "Account standing" block (outstanding dues, manual yes/no for now) on this type's cases
  check_dues              BOOLEAN NOT NULL DEFAULT FALSE,
  -- may the Head of Compliance pause the clock on this type's cases (default no)
  allow_pause             BOOLEAN NOT NULL DEFAULT FALSE,
  active                  BOOLEAN NOT NULL DEFAULT TRUE,
  is_system               BOOLEAN NOT NULL DEFAULT FALSE,
  position                INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT compliance_request_types_key UNIQUE (account_id, key),
  CONSTRAINT compliance_request_types_id_account UNIQUE (id, account_id),
  CONSTRAINT compliance_request_types_clocks CHECK (hard_stop_days IS NULL OR target_days IS NULL OR hard_stop_days >= target_days)
);

-- ------------------------------------------------------------
-- 5. Reference counters (per workspace, per year)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compliance_request_counters (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  year       INTEGER NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, year)
);

-- ------------------------------------------------------------
-- 6. The requests
--    Sensitive answers (bank details, anything the type marks sensitive) are ONLY in data_enc, encrypted by the app with the key ring and
--    bound to the case's id; `data` holds the ordinary answers. The identity check, the recommendation, the sign-off and the dues standing are
--    written only by the functions below.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compliance_requests (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  reference            TEXT NOT NULL DEFAULT '',
  type_key             TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'received'
                         CHECK (status IN ('received', 'identity_check', 'officer_review', 'awaiting_signoff', 'approved', 'rejected', 'executing', 'completed', 'closed')),
  -- the request date: the clock starts here. Staff may set it for a chat-raised case (audited).
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  source               TEXT NOT NULL CHECK (source IN ('form', 'staff', 'inbox', 'ticket')),
  channel              TEXT CHECK (channel IS NULL OR length(channel) <= 60),
  customer_name        TEXT NOT NULL CHECK (length(btrim(customer_name)) BETWEEN 1 AND 200),
  customer_email       TEXT CHECK (customer_email IS NULL OR length(customer_email) <= 320),
  customer_phone       TEXT CHECK (customer_phone IS NULL OR customer_phone ~ '^\+[0-9]{7,15}$'),
  contact_id           UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id      UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  ticket_id            UUID REFERENCES public.tickets(id) ON DELETE SET NULL,
  incident_id          UUID REFERENCES public.incidents(id) ON DELETE SET NULL,
  kyc_validation_ref   TEXT CHECK (kyc_validation_ref IS NULL OR length(kyc_validation_ref) BETWEEN 1 AND 200),
  data                 JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object' AND length(data::text) <= 100000),
  data_enc             TEXT CHECK (data_enc IS NULL OR length(data_enc) <= 100000),
  identity_check       JSONB NOT NULL DEFAULT '{}'::jsonb,
  review               JSONB NOT NULL DEFAULT '{}'::jsonb,
  signoff              JSONB NOT NULL DEFAULT '{}'::jsonb,
  account_standing     JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome_reason       TEXT CHECK (outcome_reason IS NULL OR length(outcome_reason) <= 2000),
  -- the clocks, stamped from the type when the case is created (a later change of the type does not rewrite them)
  target_days          INTEGER,
  hard_stop_days       INTEGER,
  target_due_at        TIMESTAMPTZ,
  hard_stop_at         TIMESTAMPTZ,
  clock_paused_at      TIMESTAMPTZ,
  paused_total_seconds BIGINT NOT NULL DEFAULT 0,
  -- 0 none, 1 the 10-day alert was sent, 2 the 5-day alert, 3 the alert at the hard stop (compliance_clock_alert_sweep)
  clock_alert_level    SMALLINT NOT NULL DEFAULT 0 CHECK (clock_alert_level BETWEEN 0 AND 3),
  decided_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  closed_at            TIMESTAMPTZ,
  -- seven years from closure (from the request while it is open); only ever moves later
  retention_until      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 years'),
  -- no foreign key on the people: deleting a login must not touch a case under retention
  created_by           UUID,
  assigned_to          UUID,
  is_test              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT compliance_requests_reference UNIQUE (account_id, reference),
  CONSTRAINT compliance_requests_id_account UNIQUE (id, account_id),
  CONSTRAINT compliance_requests_type_fk FOREIGN KEY (account_id, type_key)
    REFERENCES public.compliance_request_types (account_id, key)
);

CREATE INDEX IF NOT EXISTS compliance_requests_status_idx   ON public.compliance_requests (account_id, status, received_at DESC);
CREATE INDEX IF NOT EXISTS compliance_requests_received_idx ON public.compliance_requests (account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS compliance_requests_stop_idx     ON public.compliance_requests (account_id, hard_stop_at) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS compliance_requests_assignee_idx ON public.compliance_requests (account_id, assigned_to);
CREATE INDEX IF NOT EXISTS compliance_requests_contact_idx  ON public.compliance_requests (contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS compliance_request_id UUID REFERENCES public.compliance_requests(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- 7. Events, checklist, files
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compliance_request_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- the order events happened in (two events can share a timestamp)
  seq         BIGINT GENERATED ALWAYS AS IDENTITY,
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  request_id  UUID NOT NULL,
  -- clock_timestamp(), not now(): the events of one transaction (a move writes its own event and the status event) keep their order
  at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- no foreign key on the person (the same choice as sign_events and kyc_access_log)
  actor       UUID,
  kind        TEXT NOT NULL CHECK (kind IN ('created', 'edited', 'status', 'identity_check', 'review', 'signoff', 'execute_step', 'note', 'link',
                                            'reveal', 'view', 'export', 'clock_pause', 'clock_resume', 'attachment', 'standing', 'assigned', 'clock_alert')),
  -- never a secret: ids, field names, statuses, the note the person typed (the app builds it from named arguments)
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND length(detail::text) <= 8000),
  CONSTRAINT compliance_request_events_request_fk FOREIGN KEY (request_id, account_id)
    REFERENCES public.compliance_requests (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS compliance_request_events_request_idx ON public.compliance_request_events (request_id, seq DESC);

CREATE TABLE IF NOT EXISTS public.compliance_request_checklist (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  step_key   TEXT NOT NULL CHECK (step_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label      TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 300),
  label_l10n JSONB NOT NULL DEFAULT '{}'::jsonb,
  done_by    UUID,
  done_at    TIMESTAMPTZ,
  note       TEXT CHECK (note IS NULL OR length(note) <= 2000),
  CONSTRAINT compliance_request_checklist_step UNIQUE (request_id, step_key),
  CONSTRAINT compliance_request_checklist_request_fk FOREIGN KEY (request_id, account_id)
    REFERENCES public.compliance_requests (id, account_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.compliance_request_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  request_id  UUID NOT NULL,
  -- the field of the type this file answers (e.g. authorization_letter), or null for a free attachment
  field_key   TEXT CHECK (field_key IS NULL OR field_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mime        TEXT NOT NULL CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes  BIGINT NOT NULL CHECK (size_bytes > 0),
  sha256      TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- the storage path (account-<id>/<request>/<file>): the app's own, never sent to a browser
  path        TEXT NOT NULL CHECK (path LIKE 'account-%'),
  uploaded_by UUID,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT compliance_request_files_request_fk FOREIGN KEY (request_id, account_id)
    REFERENCES public.compliance_requests (id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS compliance_request_files_request_idx ON public.compliance_request_files (request_id);

-- ------------------------------------------------------------
-- 8. Privileges and row level security
--    The browser may READ (with the rules in 9) the columns granted below, and write nothing. Everything is written by the server (service role).
-- ------------------------------------------------------------
ALTER TABLE public.compliance_request_types     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_request_counters  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_requests          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_request_events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_request_checklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_request_files     ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.compliance_request_types, public.compliance_request_counters, public.compliance_requests,
              public.compliance_request_events, public.compliance_request_checklist, public.compliance_request_files
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.compliance_request_types TO authenticated;
-- not data_enc (ciphertext) and not the storage path
GRANT SELECT (id, account_id, reference, type_key, status, received_at, source, channel, customer_name, customer_email, customer_phone,
              contact_id, conversation_id, ticket_id, incident_id, kyc_validation_ref, data, identity_check, review, signoff, account_standing,
              outcome_reason, target_days, hard_stop_days, target_due_at, hard_stop_at, clock_paused_at, paused_total_seconds, clock_alert_level,
              decided_at, completed_at, closed_at, retention_until, created_by, assigned_to, is_test, created_at, updated_at)
  ON public.compliance_requests TO authenticated;
GRANT SELECT ON public.compliance_request_events TO authenticated;
GRANT SELECT ON public.compliance_request_checklist TO authenticated;
GRANT SELECT (id, account_id, request_id, field_key, name, mime, size_bytes, sha256, uploaded_by, uploaded_at)
  ON public.compliance_request_files TO authenticated;

-- ------------------------------------------------------------
-- 9. Who sees what
--    A case: a member holding menu.compliance in that workspace, or the person who raised it. Its events, checklist and files: the same, through
--    the case. The type definitions: menu.compliance. (The operator's `compliance` flag is applied by the app; the database does not know it.)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS compliance_request_types_select ON public.compliance_request_types;
CREATE POLICY compliance_request_types_select ON public.compliance_request_types
  FOR SELECT TO authenticated
  USING (public.has_capability(account_id, 'menu.compliance'));

DROP POLICY IF EXISTS compliance_requests_select ON public.compliance_requests;
CREATE POLICY compliance_requests_select ON public.compliance_requests
  FOR SELECT TO authenticated
  USING (public.has_capability(account_id, 'menu.compliance') OR created_by = auth.uid());

DROP POLICY IF EXISTS compliance_request_events_select ON public.compliance_request_events;
CREATE POLICY compliance_request_events_select ON public.compliance_request_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.compliance_requests r
                  WHERE r.id = request_id AND r.account_id = compliance_request_events.account_id
                    AND (public.has_capability(r.account_id, 'menu.compliance') OR r.created_by = auth.uid())));

DROP POLICY IF EXISTS compliance_request_checklist_select ON public.compliance_request_checklist;
CREATE POLICY compliance_request_checklist_select ON public.compliance_request_checklist
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.compliance_requests r
                  WHERE r.id = request_id AND r.account_id = compliance_request_checklist.account_id
                    AND (public.has_capability(r.account_id, 'menu.compliance') OR r.created_by = auth.uid())));

DROP POLICY IF EXISTS compliance_request_files_select ON public.compliance_request_files;
CREATE POLICY compliance_request_files_select ON public.compliance_request_files
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.compliance_requests r
                  WHERE r.id = request_id AND r.account_id = compliance_request_files.account_id
                    AND (public.has_capability(r.account_id, 'menu.compliance') OR r.created_by = auth.uid())));

-- ------------------------------------------------------------
-- 10. Helpers (internal: service role only)
-- ------------------------------------------------------------

-- Does THIS person hold this capability in this workspace? The same resolution has_capability() does for auth.uid() (079, 113), for a named
-- person, so the functions below can check the permission of the actor the server verified. A person with no profile in the workspace: no.
CREATE OR REPLACE FUNCTION public.compliance_user_can(p_account UUID, p_user UUID, p_cap TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT CASE
             WHEN p.custom_role_id IS NOT NULL THEN public.effective_custom_role_capability(p.custom_role_id, p_cap)
             ELSE public.effective_capability(p.account_id, p.account_role, p_cap)
           END
      FROM public.profiles p
     WHERE p.user_id = p_user AND p.account_id = p_account
  ), FALSE);
$$;
ALTER FUNCTION public.compliance_user_can(UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_user_can(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_user_can(UUID, UUID, TEXT) TO service_role;

-- The people of a workspace who hold a capability (the assignee list, the recipients of an alert): one call instead of one per member.
CREATE OR REPLACE FUNCTION public.compliance_holders(p_account UUID, p_cap TEXT)
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(p.user_id ORDER BY p.user_id), ARRAY[]::UUID[])
    FROM public.profiles p
   WHERE p.account_id = p_account AND public.compliance_user_can(p_account, p.user_id, p_cap);
$$;
ALTER FUNCTION public.compliance_holders(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_holders(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_holders(UUID, TEXT) TO service_role;

-- {en, ms, zh, ko} label object for the seeded definitions.
CREATE OR REPLACE FUNCTION public.compliance_label(en TEXT, ms TEXT, zh TEXT, ko TEXT)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT jsonb_build_object('en', en, 'ms', ms, 'zh', zh, 'ko', ko); $$;
ALTER FUNCTION public.compliance_label(TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_label(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_label(TEXT, TEXT, TEXT, TEXT) TO service_role;

-- The three system types of a workspace (closure, withdrawal, phone_change). Idempotent: never overwrites a type that exists, so an
-- administrator's edits survive a second run.
CREATE OR REPLACE FUNCTION public.compliance_seed_types(p_account UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bank JSONB;
BEGIN
  v_bank := jsonb_build_array(
    jsonb_build_object('key', 'bank_name', 'type', 'text', 'required', true, 'sensitive', true,
      'label', public.compliance_label('Bank name', 'Nama bank', '银行名称', '은행 이름')),
    jsonb_build_object('key', 'bank_account_number', 'type', 'text', 'required', true, 'sensitive', true,
      'label', public.compliance_label('Bank account number', 'Nombor akaun bank', '银行账号', '은행 계좌 번호')),
    jsonb_build_object('key', 'bank_account_holder', 'type', 'text', 'required', true, 'sensitive', true,
      'label', public.compliance_label('Bank account holder name', 'Nama pemegang akaun bank', '银行账户持有人姓名', '은행 계좌 예금주 이름'))
  );

  INSERT INTO public.compliance_request_types
    (account_id, key, label, label_l10n, fields, checklist, target_days, hard_stop_days, requires_identity_check, check_dues, allow_pause, is_system, position)
  VALUES
    (p_account, 'closure', 'Account closure',
     jsonb_build_object('ms', 'Penutupan akaun', 'zh', '关闭账户', 'ko', '계정 해지'),
     jsonb_build_array(
       jsonb_build_object('key', 'confirm_closure', 'type', 'acknowledge', 'required', true, 'sensitive', false,
         'label', public.compliance_label('I confirm I want to close this account', 'Saya mengesahkan saya mahu menutup akaun ini', '我确认要关闭此账户', '이 계정을 해지하는 것을 확인합니다')),
       jsonb_build_object('key', 'children_finished_school', 'type', 'acknowledge', 'required', true, 'sensitive', false,
         'label', public.compliance_label('Every child on this account has finished school', 'Setiap anak dalam akaun ini telah tamat persekolahan', '此账户下的每个孩子都已完成学业', '이 계정의 모든 자녀가 학교를 마쳤습니다')),
       jsonb_build_object('key', 'allowances_cancelled', 'type', 'acknowledge', 'required', true, 'sensitive', false,
         'label', public.compliance_label('Every allowance has been cancelled', 'Setiap elaun telah dibatalkan', '所有零用钱设置均已取消', '모든 용돈 설정이 취소되었습니다')),
       jsonb_build_object('key', 'reason', 'type', 'multiline', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Reason for closing (optional)', 'Sebab penutupan (pilihan)', '关闭原因（选填）', '해지 사유(선택)'))
     ) || v_bank || jsonb_build_array(
       jsonb_build_object('key', 'authorization_letter', 'type', 'file', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Authorization letter (needed when the bank account holder name differs)', 'Surat kebenaran (diperlukan jika nama pemegang akaun bank berbeza)', '授权书（银行账户持有人姓名不同时需要）', '위임장(은행 계좌 예금주 이름이 다를 때 필요)'))
     ),
     jsonb_build_array(
       jsonb_build_object('key', 'close_in_backoffice', 'label', public.compliance_label('Close the account in the back office', 'Tutup akaun di back office', '在后台关闭账户', '백오피스에서 계정 해지')),
       jsonb_build_object('key', 'refund', 'label', public.compliance_label('Refund the balance to the customer''s bank account', 'Pulangkan baki ke akaun bank pelanggan', '将余额退还至客户的银行账户', '잔액을 고객의 은행 계좌로 환불')),
       jsonb_build_object('key', 'confirm_customer', 'label', public.compliance_label('Tell the customer it is done', 'Maklumkan pelanggan bahawa ia telah selesai', '告知客户已完成', '고객에게 완료되었음을 안내'))
     ),
     14, 30, TRUE, TRUE, FALSE, TRUE, 1),
    (p_account, 'withdrawal', 'Fund withdrawal',
     jsonb_build_object('ms', 'Pengeluaran dana', 'zh', '资金提取', 'ko', '자금 인출'),
     jsonb_build_array(
       jsonb_build_object('key', 'amount', 'type', 'number', 'required', true, 'sensitive', false,
         'label', public.compliance_label('Amount to withdraw (RM)', 'Jumlah untuk dikeluarkan (RM)', '提取金额（令吉）', '인출 금액(RM)')),
       jsonb_build_object('key', 'reason', 'type', 'multiline', 'required', true, 'sensitive', false,
         'label', public.compliance_label('Reason for the withdrawal', 'Sebab pengeluaran', '提取原因', '인출 사유')),
       jsonb_build_object('key', 'transaction_refs', 'type', 'multiline', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Transaction references or proof', 'Rujukan transaksi atau bukti', '交易参考编号或证明', '거래 참조 번호 또는 증빙'))
     ) || v_bank || jsonb_build_array(
       jsonb_build_object('key', 'authorization_letter', 'type', 'file', 'required', false, 'sensitive', false,
         'label', public.compliance_label('Authorization letter (needed when the bank account holder name differs)', 'Surat kebenaran (diperlukan jika nama pemegang akaun bank berbeza)', '授权书（银行账户持有人姓名不同时需要）', '위임장(은행 계좌 예금주 이름이 다를 때 필요)'))
     ),
     jsonb_build_array(
       jsonb_build_object('key', 'check_balance', 'label', public.compliance_label('Check the balance covers the amount', 'Semak baki mencukupi untuk jumlah ini', '核对余额是否足够', '잔액이 금액을 충당하는지 확인')),
       jsonb_build_object('key', 'transfer', 'label', public.compliance_label('Transfer the amount to the customer''s bank account', 'Pindahkan jumlah ke akaun bank pelanggan', '将金额转入客户的银行账户', '금액을 고객의 은행 계좌로 이체')),
       jsonb_build_object('key', 'confirm_customer', 'label', public.compliance_label('Tell the customer it is done', 'Maklumkan pelanggan bahawa ia telah selesai', '告知客户已完成', '고객에게 완료되었음을 안내'))
     ),
     NULL, NULL, TRUE, FALSE, FALSE, TRUE, 2),
    (p_account, 'phone_change', 'Phone number change',
     jsonb_build_object('ms', 'Pertukaran nombor telefon', 'zh', '更改手机号码', 'ko', '전화번호 변경'),
     jsonb_build_array(
       jsonb_build_object('key', 'current_phone', 'type', 'phone', 'required', true, 'sensitive', false,
         'label', public.compliance_label('Current phone number', 'Nombor telefon semasa', '当前手机号码', '현재 전화번호')),
       jsonb_build_object('key', 'new_phone', 'type', 'phone', 'required', true, 'sensitive', false,
         'label', public.compliance_label('New phone number', 'Nombor telefon baharu', '新手机号码', '새 전화번호'))
     ),
     jsonb_build_array(
       jsonb_build_object('key', 'update_phone', 'label', public.compliance_label('Change the phone number in the back office', 'Tukar nombor telefon di back office', '在后台更改手机号码', '백오피스에서 전화번호 변경')),
       jsonb_build_object('key', 'confirm_customer', 'label', public.compliance_label('Tell the customer it is done', 'Maklumkan pelanggan bahawa ia telah selesai', '告知客户已完成', '고객에게 완료되었음을 안내'))
     ),
     NULL, NULL, TRUE, FALSE, FALSE, TRUE, 3)
  ON CONFLICT (account_id, key) DO NOTHING;
END;
$$;
ALTER FUNCTION public.compliance_seed_types(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_seed_types(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_seed_types(UUID) TO service_role;

-- A workspace made from now on gets the types. Never blocks signup.
CREATE OR REPLACE FUNCTION public.compliance_accounts_seed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.compliance_seed_types(NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'compliance_accounts_seed failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.compliance_accounts_seed() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_accounts_seed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS compliance_accounts_seed ON public.accounts;
CREATE TRIGGER compliance_accounts_seed
  AFTER INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.compliance_accounts_seed();

-- the workspaces that exist now
DO $$
BEGIN
  PERFORM public.compliance_seed_types(a.id) FROM public.accounts a;
END $$;

-- ------------------------------------------------------------
-- 11. Triggers
-- ------------------------------------------------------------

-- Types: the key and the system mark never change; a system type is never deleted (a workspace purge excepted).
CREATE OR REPLACE FUNCTION public.compliance_types_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user NOT IN ('anon', 'authenticated', 'service_role')
       AND current_setting('vircle.purge_account', true) = OLD.account_id::text THEN
      RETURN OLD;
    END IF;
    IF OLD.is_system THEN
      RAISE EXCEPTION 'compliance_system_type_is_fixed' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.key IS DISTINCT FROM OLD.key OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.is_system IS DISTINCT FROM OLD.is_system THEN
    RAISE EXCEPTION 'compliance_type_key_is_fixed' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.compliance_types_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_types_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS compliance_types_guard ON public.compliance_request_types;
CREATE TRIGGER compliance_types_guard
  BEFORE UPDATE OR DELETE ON public.compliance_request_types
  FOR EACH ROW EXECUTE FUNCTION public.compliance_types_guard();

-- The case: reference, clocks, retention on the way in; on the way through, only the functions below change it.
CREATE OR REPLACE FUNCTION public.compliance_requests_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type  public.compliance_request_types%ROWTYPE;
  v_seq   INTEGER;
  v_year  INTEGER;
  v_fn    BOOLEAN := COALESCE(current_setting('vircle.compliance_fn', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'received' THEN
      RAISE EXCEPTION 'compliance_must_start_received' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_type FROM public.compliance_request_types t WHERE t.account_id = NEW.account_id AND t.key = NEW.type_key;
    IF NOT FOUND OR NOT v_type.active THEN
      RAISE EXCEPTION 'compliance_type_unavailable' USING ERRCODE = '23514';
    END IF;
    IF NEW.received_at > now() + interval '5 minutes' OR NEW.received_at < now() - interval '400 days' THEN
      RAISE EXCEPTION 'compliance_received_at_out_of_range' USING ERRCODE = '23514';
    END IF;

    -- the reference: a counter per workspace per year, one atomic upsert (two cases made together get two numbers)
    v_year := extract(year FROM (now() AT TIME ZONE 'utc'))::INTEGER;
    INSERT INTO public.compliance_request_counters AS c (account_id, year, last_seq) VALUES (NEW.account_id, v_year, 1)
      ON CONFLICT (account_id, year) DO UPDATE SET last_seq = c.last_seq + 1
      RETURNING c.last_seq INTO v_seq;
    NEW.reference := 'CMP-' || v_year::TEXT || '-' || lpad(v_seq::TEXT, 6, '0');

    -- the clocks, from the type as it is now
    NEW.target_days    := v_type.target_days;
    NEW.hard_stop_days := v_type.hard_stop_days;
    NEW.target_due_at  := CASE WHEN v_type.target_days    IS NULL THEN NULL ELSE NEW.received_at + make_interval(days => v_type.target_days) END;
    NEW.hard_stop_at   := CASE WHEN v_type.hard_stop_days IS NULL THEN NULL ELSE NEW.received_at + make_interval(days => v_type.hard_stop_days) END;
    NEW.clock_paused_at := NULL;
    NEW.paused_total_seconds := 0;
    NEW.clock_alert_level := 0;
    NEW.retention_until := GREATEST(NEW.received_at, now()) + interval '7 years';
    NEW.identity_check := '{}'::jsonb;
    NEW.review := '{}'::jsonb;
    NEW.signoff := '{}'::jsonb;
    NEW.account_standing := '{}'::jsonb;
    NEW.outcome_reason := NULL;
    NEW.decided_at := NULL;
    NEW.completed_at := NULL;
    NEW.closed_at := NULL;
    NEW.created_at := now();
    NEW.updated_at := now();
  ELSE
    -- UPDATE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.type_key IS DISTINCT FROM OLD.type_key OR NEW.source IS DISTINCT FROM OLD.source OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.is_test IS DISTINCT FROM OLD.is_test OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'compliance_request_fixed_fields' USING ERRCODE = '23514';
    END IF;

    IF NOT v_fn THEN
      -- Two changes need no function: the cleanup that empties a link when the thing it pointed at is deleted (nothing else changes), and the
      -- operator's key re-encryption job rewriting data_enc (nothing else changes). Anything else, from any role, is refused.
      IF (to_jsonb(NEW) - 'contact_id' - 'conversation_id' - 'ticket_id' - 'incident_id' - 'updated_at')
           = (to_jsonb(OLD) - 'contact_id' - 'conversation_id' - 'ticket_id' - 'incident_id' - 'updated_at')
         AND (NEW.contact_id IS NULL OR NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id)
         AND (NEW.conversation_id IS NULL OR NEW.conversation_id IS NOT DISTINCT FROM OLD.conversation_id)
         AND (NEW.ticket_id IS NULL OR NEW.ticket_id IS NOT DISTINCT FROM OLD.ticket_id)
         AND (NEW.incident_id IS NULL OR NEW.incident_id IS NOT DISTINCT FROM OLD.incident_id) THEN
        RETURN NEW;
      END IF;
      IF (to_jsonb(NEW) - 'data_enc' - 'updated_at') = (to_jsonb(OLD) - 'data_enc' - 'updated_at') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'compliance_request_change_refused: use the compliance functions' USING ERRCODE = '42501';
    END IF;

    -- retention only ever moves later
    NEW.retention_until := GREATEST(OLD.retention_until, NEW.retention_until);
    NEW.updated_at := now();
  END IF;

  -- a link must point at something of the SAME workspace (the composite-foreign-key rule for tables whose key is just their id)
  IF NEW.contact_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id)
     AND NOT EXISTS (SELECT 1 FROM public.contacts x WHERE x.id = NEW.contact_id AND x.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'compliance_link_other_workspace: contact' USING ERRCODE = '23514';
  END IF;
  IF NEW.conversation_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id)
     AND NOT EXISTS (SELECT 1 FROM public.conversations x WHERE x.id = NEW.conversation_id AND x.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'compliance_link_other_workspace: conversation' USING ERRCODE = '23514';
  END IF;
  IF NEW.ticket_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id)
     AND NOT EXISTS (SELECT 1 FROM public.tickets x WHERE x.id = NEW.ticket_id AND x.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'compliance_link_other_workspace: ticket' USING ERRCODE = '23514';
  END IF;
  IF NEW.incident_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.incident_id IS DISTINCT FROM OLD.incident_id)
     AND NOT EXISTS (SELECT 1 FROM public.incidents x WHERE x.id = NEW.incident_id AND x.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'compliance_link_other_workspace: incident' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.compliance_requests_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_requests_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS compliance_requests_guard ON public.compliance_requests;
CREATE TRIGGER compliance_requests_guard
  BEFORE INSERT OR UPDATE ON public.compliance_requests
  FOR EACH ROW EXECUTE FUNCTION public.compliance_requests_guard();

-- The case exists: its 'created' event and its checklist (copied from the type as it is now), in the same transaction.
CREATE OR REPLACE FUNCTION public.compliance_requests_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.compliance_request_events (account_id, request_id, actor, kind, detail)
  VALUES (NEW.account_id, NEW.id, NEW.created_by, 'created',
          jsonb_build_object('type', NEW.type_key, 'source', NEW.source, 'channel', NEW.channel, 'reference', NEW.reference,
                             'received_at', NEW.received_at, 'backdated', NEW.received_at < now() - interval '1 minute'));
  INSERT INTO public.compliance_request_checklist (account_id, request_id, position, step_key, label, label_l10n)
  SELECT NEW.account_id, NEW.id, (s.ord - 1)::INTEGER, s.item ->> 'key',
         COALESCE(s.item #>> '{label,en}', s.item ->> 'key'),
         COALESCE(s.item -> 'label', '{}'::jsonb)
    FROM public.compliance_request_types t,
         LATERAL jsonb_array_elements(t.checklist) WITH ORDINALITY AS s(item, ord)
   WHERE t.account_id = NEW.account_id AND t.key = NEW.type_key;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.compliance_requests_after_insert() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_requests_after_insert() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS compliance_requests_after_insert ON public.compliance_requests;
CREATE TRIGGER compliance_requests_after_insert
  AFTER INSERT ON public.compliance_requests
  FOR EACH ROW EXECUTE FUNCTION public.compliance_requests_after_insert();

-- Retention: nothing is deleted while retention_until is in the future. NOT SECURITY DEFINER: current_user must be the caller's role.
--   * a workspace being purged by delete_workspace_data() sets vircle.purge_account (only a database owner role can; the API roles are refused
--     whatever they set), exactly as for audit_log and kyc_access_log
--   * a child row (event, checklist item, file) may go when its case is gone or past its retention (the cascade of a case that was allowed to go)
CREATE OR REPLACE FUNCTION public.compliance_requests_no_delete()
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
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' AND OLD.retention_until <= now() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'compliance_request_under_retention' USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.compliance_requests_no_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_requests_no_delete() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS compliance_requests_no_delete ON public.compliance_requests;
CREATE TRIGGER compliance_requests_no_delete
  BEFORE DELETE ON public.compliance_requests
  FOR EACH ROW EXECUTE FUNCTION public.compliance_requests_no_delete();
DROP TRIGGER IF EXISTS compliance_requests_no_truncate ON public.compliance_requests;
CREATE TRIGGER compliance_requests_no_truncate
  BEFORE TRUNCATE ON public.compliance_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public.compliance_requests_no_delete();

CREATE OR REPLACE FUNCTION public.compliance_children_no_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW' THEN
    IF current_user NOT IN ('anon', 'authenticated', 'service_role')
       AND current_setting('vircle.purge_account', true) = OLD.account_id::text THEN
      RETURN OLD;
    END IF;
    -- the case is gone (its cascade) or has outlived its retention
    IF NOT EXISTS (SELECT 1 FROM public.compliance_requests r WHERE r.id = OLD.request_id AND r.retention_until > now()) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'compliance_request_under_retention' USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.compliance_children_no_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_children_no_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS compliance_request_events_no_delete ON public.compliance_request_events;
CREATE TRIGGER compliance_request_events_no_delete
  BEFORE DELETE ON public.compliance_request_events
  FOR EACH ROW EXECUTE FUNCTION public.compliance_children_no_delete();
DROP TRIGGER IF EXISTS compliance_request_events_no_truncate ON public.compliance_request_events;
CREATE TRIGGER compliance_request_events_no_truncate
  BEFORE TRUNCATE ON public.compliance_request_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.compliance_children_no_delete();
DROP TRIGGER IF EXISTS compliance_request_checklist_no_delete ON public.compliance_request_checklist;
CREATE TRIGGER compliance_request_checklist_no_delete
  BEFORE DELETE ON public.compliance_request_checklist
  FOR EACH ROW EXECUTE FUNCTION public.compliance_children_no_delete();
DROP TRIGGER IF EXISTS compliance_request_files_no_delete ON public.compliance_request_files;
CREATE TRIGGER compliance_request_files_no_delete
  BEFORE DELETE ON public.compliance_request_files
  FOR EACH ROW EXECUTE FUNCTION public.compliance_children_no_delete();

-- Events never change (the one UPDATE nobody may do); checklist items change only in who/when/note; files never change.
CREATE OR REPLACE FUNCTION public.compliance_events_no_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'compliance_request_events is append-only' USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.compliance_events_no_update() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_events_no_update() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS compliance_request_events_no_update ON public.compliance_request_events;
CREATE TRIGGER compliance_request_events_no_update
  BEFORE UPDATE ON public.compliance_request_events
  FOR EACH ROW EXECUTE FUNCTION public.compliance_events_no_update();
DROP TRIGGER IF EXISTS compliance_request_files_no_update ON public.compliance_request_files;
CREATE TRIGGER compliance_request_files_no_update
  BEFORE UPDATE ON public.compliance_request_files
  FOR EACH ROW EXECUTE FUNCTION public.compliance_events_no_update();

CREATE OR REPLACE FUNCTION public.compliance_checklist_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('vircle.compliance_fn', true), '') <> 'on' THEN
    RAISE EXCEPTION 'compliance_checklist_change_refused: use compliance_tick_step' USING ERRCODE = '42501';
  END IF;
  IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.step_key IS DISTINCT FROM OLD.step_key
     OR NEW.label IS DISTINCT FROM OLD.label OR NEW.position IS DISTINCT FROM OLD.position OR NEW.label_l10n IS DISTINCT FROM OLD.label_l10n THEN
    RAISE EXCEPTION 'compliance_checklist_item_is_fixed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.compliance_checklist_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_checklist_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS compliance_request_checklist_guard ON public.compliance_request_checklist;
CREATE TRIGGER compliance_request_checklist_guard
  BEFORE UPDATE ON public.compliance_request_checklist
  FOR EACH ROW EXECUTE FUNCTION public.compliance_checklist_guard();

-- A file row is an 'attachment' event (the upload cannot be recorded without it).
CREATE OR REPLACE FUNCTION public.compliance_files_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.compliance_request_events (account_id, request_id, actor, kind, detail)
  VALUES (NEW.account_id, NEW.request_id, NEW.uploaded_by, 'attachment',
          jsonb_build_object('file', NEW.id, 'name', NEW.name, 'size', NEW.size_bytes, 'hash', left(NEW.sha256, 16), 'field', NEW.field_key));
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.compliance_files_after_insert() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_files_after_insert() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS compliance_request_files_after_insert ON public.compliance_request_files;
CREATE TRIGGER compliance_request_files_after_insert
  AFTER INSERT ON public.compliance_request_files
  FOR EACH ROW EXECUTE FUNCTION public.compliance_files_after_insert();

-- ------------------------------------------------------------
-- 12. compliance_update_request: edits (the customer's details, the answers, the request date, the links, the assignee)
--     The patch may hold only the keys below. The answers, the customer's details and the request date are frozen once the case is with the
--     Head of Compliance (awaiting_signoff and later); links and the assignee can change until it is closed. Needs compliance.review or
--     compliance.approve. Every change is an event (field names and ids, never a value that is personal or secret).
-- ------------------------------------------------------------
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
    r.customer_name := p_patch ->> 'customer_name'; v_changed := v_changed || 'customer_name';
  END IF;
  IF p_patch ? 'customer_email' THEN
    r.customer_email := CASE WHEN jsonb_typeof(p_patch -> 'customer_email') = 'null' THEN NULL ELSE p_patch ->> 'customer_email' END;
    v_changed := v_changed || 'customer_email';
  END IF;
  IF p_patch ? 'customer_phone' THEN
    r.customer_phone := CASE WHEN jsonb_typeof(p_patch -> 'customer_phone') = 'null' THEN NULL ELSE p_patch ->> 'customer_phone' END;
    v_changed := v_changed || 'customer_phone';
  END IF;
  IF p_patch ? 'channel' THEN
    r.channel := CASE WHEN jsonb_typeof(p_patch -> 'channel') = 'null' THEN NULL ELSE p_patch ->> 'channel' END;
    v_changed := v_changed || 'channel';
  END IF;
  IF p_patch ? 'kyc_validation_ref' THEN
    r.kyc_validation_ref := CASE WHEN jsonb_typeof(p_patch -> 'kyc_validation_ref') = 'null' THEN NULL ELSE p_patch ->> 'kyc_validation_ref' END;
    PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'link', jsonb_build_object('field', 'kyc_validation_ref', 'set', r.kyc_validation_ref IS NOT NULL));
  END IF;
  IF p_patch ? 'data' THEN
    r.data := p_patch -> 'data'; v_data_changed := TRUE; v_changed := v_changed || 'data';
  END IF;
  IF p_patch ? 'data_enc' THEN
    r.data_enc := CASE WHEN jsonb_typeof(p_patch -> 'data_enc') = 'null' THEN NULL ELSE p_patch ->> 'data_enc' END;
    v_changed := v_changed || 'sensitive_data';
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

-- One event row, built from named arguments (used by the functions here).
CREATE OR REPLACE FUNCTION public.compliance_event(p_account UUID, p_request UUID, p_actor UUID, p_kind TEXT, p_detail JSONB)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.compliance_request_events (account_id, request_id, actor, kind, detail)
  VALUES (p_account, p_request, p_actor, p_kind, COALESCE(p_detail, '{}'::jsonb));
$$;
ALTER FUNCTION public.compliance_event(UUID, UUID, UUID, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_event(UUID, UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_event(UUID, UUID, UUID, TEXT, JSONB) TO service_role;

-- ------------------------------------------------------------
-- 13. compliance_transition: the ONE way a case changes status.
--
--     received         -> identity_check, officer_review, closed
--     identity_check   -> officer_review, closed
--     officer_review   -> awaiting_signoff, identity_check, closed
--     awaiting_signoff -> approved, rejected, officer_review (sent back)
--     approved         -> executing, completed (a type with no checklist)
--     rejected         -> closed
--     executing        -> completed
--     completed        -> closed
--     closed           -> (nothing)
--
--     p_note is the note of the step (required to reject, to send back and to close without a decision); p_payload carries
--       identity check:  { method, method_other?, outcome }          (on the move to officer_review from received / identity_check)
--       recommendation:  { recommendation: approve | reject | more_info }   (on the move to awaiting_signoff)
--       sign-off:        { override_reason? }                         (approve a closure whose dues are outstanding)
--     The capability each move needs is checked HERE against p_actor (compliance_user_can), as well as by the route.
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
                                        'override_reason', CASE WHEN p_to = 'approved' AND (r.account_standing ->> 'dues_outstanding') = 'true' THEN v_override END)
     WHERE id = r.id;
    PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'signoff',
      jsonb_build_object('decision', p_to, 'override', p_to = 'approved' AND (r.account_standing ->> 'dues_outstanding') = 'true'));

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

-- ------------------------------------------------------------
-- 14. compliance_tick_step: the operations checklist (compliance.execute; the case is approved or executing)
--     The first tick moves an approved case to executing.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_tick_step(p_request UUID, p_step TEXT, p_done BOOLEAN, p_actor UUID, p_note TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r      public.compliance_requests%ROWTYPE;
  c      public.compliance_request_checklist%ROWTYPE;
  v_note TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  SELECT * INTO r FROM public.compliance_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'compliance_request_not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.compliance_user_can(r.account_id, p_actor, 'compliance.execute') THEN
    RAISE EXCEPTION 'compliance_not_allowed: execute' USING ERRCODE = '42501';
  END IF;
  IF r.status NOT IN ('approved', 'executing') THEN
    RAISE EXCEPTION 'compliance_not_ready_to_execute' USING ERRCODE = '23514';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'compliance_note_too_long' USING ERRCODE = '22023'; END IF;
  SELECT * INTO c FROM public.compliance_request_checklist x WHERE x.request_id = r.id AND x.step_key = p_step FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'compliance_step_not_found' USING ERRCODE = 'P0002'; END IF;

  PERFORM set_config('vircle.compliance_fn', 'on', true);
  IF p_done THEN
    UPDATE public.compliance_request_checklist SET done_by = p_actor, done_at = now(), note = v_note WHERE id = c.id;
  ELSE
    UPDATE public.compliance_request_checklist SET done_by = NULL, done_at = NULL, note = v_note WHERE id = c.id;
  END IF;
  IF r.status = 'approved' THEN
    UPDATE public.compliance_requests SET status = 'executing' WHERE id = r.id;
    PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'status', jsonb_build_object('from', 'approved', 'to', 'executing', 'note', NULL));
  END IF;
  PERFORM set_config('vircle.compliance_fn', 'off', true);
  PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'execute_step', jsonb_build_object('step', p_step, 'done', p_done, 'note', v_note));
  RETURN jsonb_build_object('id', r.id, 'step', p_step, 'done', p_done);
END;
$$;
ALTER FUNCTION public.compliance_tick_step(UUID, TEXT, BOOLEAN, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_tick_step(UUID, TEXT, BOOLEAN, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_tick_step(UUID, TEXT, BOOLEAN, UUID, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 15. compliance_set_standing: the "Account standing" block (outstanding dues). Manual yes / no now; the shape is ready for the back-office API
--     (source 'manual' | 'api'). compliance.review or compliance.approve; only on a type with check_dues; not after sign-off.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_set_standing(p_request UUID, p_actor UUID, p_dues BOOLEAN, p_notes TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r       public.compliance_requests%ROWTYPE;
  t       public.compliance_request_types%ROWTYPE;
  v_notes TEXT := NULLIF(btrim(COALESCE(p_notes, '')), '');
BEGIN
  SELECT * INTO r FROM public.compliance_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'compliance_request_not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (public.compliance_user_can(r.account_id, p_actor, 'compliance.review') OR public.compliance_user_can(r.account_id, p_actor, 'compliance.approve')) THEN
    RAISE EXCEPTION 'compliance_not_allowed: review' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM public.compliance_request_types x WHERE x.account_id = r.account_id AND x.key = r.type_key;
  IF NOT t.check_dues THEN RAISE EXCEPTION 'compliance_no_standing_for_type' USING ERRCODE = '23514'; END IF;
  IF r.status NOT IN ('received', 'identity_check', 'officer_review') THEN
    RAISE EXCEPTION 'compliance_frozen' USING ERRCODE = '23514';
  END IF;
  IF p_dues IS NULL THEN RAISE EXCEPTION 'compliance_standing_required' USING ERRCODE = '22023'; END IF;
  IF v_notes IS NOT NULL AND length(v_notes) > 2000 THEN RAISE EXCEPTION 'compliance_note_too_long' USING ERRCODE = '22023'; END IF;

  PERFORM set_config('vircle.compliance_fn', 'on', true);
  UPDATE public.compliance_requests
     SET account_standing = jsonb_build_object('dues_outstanding', p_dues, 'notes', v_notes, 'source', 'manual', 'set_by', p_actor, 'set_at', now())
   WHERE id = r.id;
  PERFORM set_config('vircle.compliance_fn', 'off', true);
  PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'standing', jsonb_build_object('dues_outstanding', p_dues, 'source', 'manual'));
  RETURN jsonb_build_object('id', r.id, 'dues_outstanding', p_dues);
END;
$$;
ALTER FUNCTION public.compliance_set_standing(UUID, UUID, BOOLEAN, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_set_standing(UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_set_standing(UUID, UUID, BOOLEAN, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 16. compliance_clock: pause and resume (compliance.approve, a note, only on a type that allows it, never on a finished case)
--     On resume the stored target and hard-stop dates move later by the time paused, so they always hold the effective deadline.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_clock(p_request UUID, p_actor UUID, p_action TEXT, p_note TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r       public.compliance_requests%ROWTYPE;
  t       public.compliance_request_types%ROWTYPE;
  v_note  TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_secs  BIGINT;
  v_gap   INTERVAL;
BEGIN
  IF p_action NOT IN ('pause', 'resume') THEN RAISE EXCEPTION 'compliance_bad_clock_action' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.compliance_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'compliance_request_not_found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.compliance_user_can(r.account_id, p_actor, 'compliance.approve') THEN
    RAISE EXCEPTION 'compliance_not_allowed: approve' USING ERRCODE = '42501';
  END IF;
  IF v_note IS NULL THEN RAISE EXCEPTION 'compliance_note_required' USING ERRCODE = '22023'; END IF;
  IF length(v_note) > 2000 THEN RAISE EXCEPTION 'compliance_note_too_long' USING ERRCODE = '22023'; END IF;
  IF r.status IN ('completed', 'closed') THEN RAISE EXCEPTION 'compliance_closed' USING ERRCODE = '23514'; END IF;
  SELECT * INTO t FROM public.compliance_request_types x WHERE x.account_id = r.account_id AND x.key = r.type_key;
  IF r.target_due_at IS NULL AND r.hard_stop_at IS NULL THEN RAISE EXCEPTION 'compliance_no_clock' USING ERRCODE = '23514'; END IF;

  PERFORM set_config('vircle.compliance_fn', 'on', true);
  IF p_action = 'pause' THEN
    IF NOT t.allow_pause THEN RAISE EXCEPTION 'compliance_pause_not_allowed' USING ERRCODE = '23514'; END IF;
    IF r.clock_paused_at IS NOT NULL THEN RAISE EXCEPTION 'compliance_already_paused' USING ERRCODE = '23514'; END IF;
    UPDATE public.compliance_requests SET clock_paused_at = now() WHERE id = r.id;
    PERFORM set_config('vircle.compliance_fn', 'off', true);
    PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'clock_pause', jsonb_build_object('note', v_note));
  ELSE
    IF r.clock_paused_at IS NULL THEN RAISE EXCEPTION 'compliance_not_paused' USING ERRCODE = '23514'; END IF;
    v_gap := now() - r.clock_paused_at;
    v_secs := extract(epoch FROM v_gap)::BIGINT;
    UPDATE public.compliance_requests
       SET clock_paused_at = NULL, paused_total_seconds = paused_total_seconds + v_secs,
           target_due_at = target_due_at + v_gap, hard_stop_at = hard_stop_at + v_gap
     WHERE id = r.id;
    PERFORM set_config('vircle.compliance_fn', 'off', true);
    PERFORM public.compliance_event(r.account_id, r.id, p_actor, 'clock_resume', jsonb_build_object('note', v_note, 'paused_seconds', v_secs));
  END IF;
  RETURN jsonb_build_object('id', r.id, 'action', p_action);
END;
$$;
ALTER FUNCTION public.compliance_clock(UUID, UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_clock(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_clock(UUID, UUID, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 17. compliance_clock_alert_sweep: called by the hourly job. For every open, unpaused case whose hard stop is within 10 days, within 5 days or
--     reached, in a workspace where the `compliance` flag is on, and which has not been alerted for that threshold yet: claim it (clock_alert_level
--     moves up, so it never repeats), write a clock_alert event and an in-app notification for each holder of compliance.approve or compliance.review.
--     Does not send email (Part B).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compliance_clock_alert_sweep(p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r        RECORD;
  p        RECORD;
  v_level  INTEGER;
  v_left   INTERVAL;
  v_days   INTEGER;
  v_title  TEXT;
  v_alerted INTEGER := 0;
  v_notified INTEGER := 0;
BEGIN
  FOR r IN
    SELECT q.id, q.account_id, q.reference, q.hard_stop_at, q.clock_alert_level
      FROM public.compliance_requests q
     WHERE q.closed_at IS NULL AND q.completed_at IS NULL AND q.clock_paused_at IS NULL AND q.hard_stop_at IS NOT NULL
       AND q.hard_stop_at - interval '10 days' <= p_now
       AND q.clock_alert_level < 3
       AND EXISTS (SELECT 1 FROM public.account_platform ap WHERE ap.account_id = q.account_id AND (ap.features ->> 'compliance') = 'true')
     ORDER BY q.hard_stop_at
       FOR UPDATE OF q SKIP LOCKED
     LIMIT 500
  LOOP
    v_left := r.hard_stop_at - p_now;
    v_level := CASE WHEN v_left <= interval '0' THEN 3 WHEN v_left <= interval '5 days' THEN 2 ELSE 1 END;
    CONTINUE WHEN v_level <= r.clock_alert_level;

    PERFORM set_config('vircle.compliance_fn', 'on', true);
    UPDATE public.compliance_requests SET clock_alert_level = v_level WHERE id = r.id;
    PERFORM set_config('vircle.compliance_fn', 'off', true);

    v_days := GREATEST(0, ceil(extract(epoch FROM v_left) / 86400)::INTEGER);
    PERFORM public.compliance_event(r.account_id, r.id, NULL, 'clock_alert',
      jsonb_build_object('threshold', CASE v_level WHEN 1 THEN 10 WHEN 2 THEN 5 ELSE 0 END, 'days_left', CASE WHEN v_level = 3 THEN 0 ELSE v_days END));
    v_alerted := v_alerted + 1;

    v_title := CASE v_level
      WHEN 3 THEN r.reference || ': the hard stop date has been reached'
      ELSE r.reference || ': ' || v_days::TEXT || CASE WHEN v_days = 1 THEN ' day' ELSE ' days' END || ' to the hard stop date'
    END;
    FOR p IN SELECT pr.user_id FROM public.profiles pr WHERE pr.account_id = r.account_id LOOP
      IF public.compliance_user_can(r.account_id, p.user_id, 'compliance.approve') OR public.compliance_user_can(r.account_id, p.user_id, 'compliance.review') THEN
        INSERT INTO public.notifications (account_id, user_id, type, title, body, compliance_request_id)
        VALUES (r.account_id, p.user_id, 'compliance_clock', v_title, 'Compliance request ' || r.reference, r.id);
        v_notified := v_notified + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('alerted', v_alerted, 'notified', v_notified);
END;
$$;
ALTER FUNCTION public.compliance_clock_alert_sweep(TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.compliance_clock_alert_sweep(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compliance_clock_alert_sweep(TIMESTAMPTZ) TO service_role;

-- ------------------------------------------------------------
-- 18. Storage: a private bucket only the server touches (a signed-in user gets no policy on it)
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('compliance-files', 'compliance-files', FALSE, 10485760, ARRAY['application/pdf', 'image/jpeg', 'image/png'])
ON CONFLICT (id) DO UPDATE
SET public = FALSE,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;
