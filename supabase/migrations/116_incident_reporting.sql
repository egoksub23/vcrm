-- ============================================================
-- 116_incident_reporting.sql — Security Incident Reporting System
--
-- Digitizes the Incident Management Register required by Vircle's
-- Security Incident Reporting and Management Policy (VCL-ISP-IRP-001
-- v1.0, §16.1: "Every incident is logged as a ticket in Vircle's
-- internal incident ticketing system, which serves as the Incident
-- Management Register"). A dedicated `incidents` domain, architecturally
-- modeled on the Tickets engine's proven patterns (schema shape, RLS
-- convention, SLA-clock-and-cron pattern) — NOT literal rows in the
-- `tickets` table. See the plan file for the "why a new table" reasoning
-- (fixed ticket.category enum, ticket-specific board/list components,
-- §16.3 confidentiality requirements a shared table would make hard to
-- enforce via RLS).
--
-- What this migration does
--   1. Capabilities menu.incidents / incidents.raise / incidents.manage
--      (mirrors src/lib/auth/capabilities.ts; capabilities-sql.test.ts
--      fails if the two disagree).
--   2. incidents (parent record) + next_incident_number() (mirrors
--      next_ticket_number, migration 063).
--   3. Child tables: incident_activity (append-only audit trail),
--      incident_comments (+ @mention notifications, mirrors
--      ticket_comments), incident_attachments (evidence files),
--      incident_evidence_log (chain-of-custody, auto-appended on every
--      attachment upload), incident_watchers (auto-watch, mirrors
--      ticket_watchers), incident_notifications_sent (manual log of
--      external notifications a human actually sent — this system never
--      sends them), incident_actions (PIR corrective actions),
--      incident_escalation_events (escalation audit log).
--   4. incident_escalation_policies (per-account, per-severity timers)
--      + incident_escalation_default_minutes() fallback +
--      incident_escalation_sweep() (mirrors sla_sweep, migration 086) —
--      called by GET /api/incidents/escalation-cron.
--   5. notifications.type widened (incident_raised, incident_escalated,
--      incident_assigned, incident_comment, incident_mention) — built
--      from the LIVE constraint (mirrors migration 084's pattern) so
--      this cannot drop a type another migration added.
--   6. RLS: a reporter/watcher sees only their own incidents;
--      incidents.manage (Compliance Officer / Admin / Owner) sees the
--      full register — enforced in Postgres, not just the UI.
--
-- What this system is NOT: it does not itself notify BNM, the sponsor
-- EMI, the PDP Commissioner or anyone external — incident_notifications_sent
-- is where a human RECORDS that they sent one through the real channel.
-- No real-time SMS/phone paging either — auto-escalation reaches people
-- through in-app notifications + email only.
--
-- Depends on: 063/081/086 (tickets — the patterns this mirrors), 079
-- (capabilities), 112-114 (custom roles — Compliance Officer is built
-- through that engine, unchanged by this migration).
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Capabilities
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('menu.incidents',    'viewer', 'app'),
  ('incidents.raise',   'viewer', 'database'),
  ('incidents.manage',  'agent',  'database')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner',  'menu.incidents'),
  ('admin',  'menu.incidents'),
  ('agent',  'menu.incidents'),
  ('viewer', 'menu.incidents'),
  ('owner',  'incidents.raise'),
  ('admin',  'incidents.raise'),
  ('agent',  'incidents.raise'),
  ('viewer', 'incidents.raise'),
  ('owner',  'incidents.manage'),
  ('admin',  'incidents.manage')
ON CONFLICT (role, capability) DO NOTHING;

-- capabilities-sql.test.ts requires the SQL mirror to equal the TS
-- catalogue's DEFAULT_CAPABILITIES exactly, which (per capabilities.ts)
-- always includes 'owner' for every capability regardless of
-- defaultRoles — has_capability()/effective_capability() already
-- short-circuit true for the owner role, so this row is redundant at
-- runtime but required for the TS/SQL parity check.

-- ------------------------------------------------------------
-- 2. Sequential per-account incident numbers (mirrors next_ticket_number)
-- ------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS incident_seq INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.next_incident_number(p_account_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next INTEGER;
BEGIN
  IF NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Not a member of account %', p_account_id;
  END IF;

  UPDATE accounts SET incident_seq = incident_seq + 1
  WHERE id = p_account_id
  RETURNING incident_seq INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Account % not found', p_account_id;
  END IF;

  RETURN v_next;
END;
$$;

ALTER FUNCTION public.next_incident_number(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.next_incident_number(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_incident_number(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 3. incidents
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incidents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  incident_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,

  -- Policy §8's 14 primary type codes; incident_type_secondary for the
  -- "secondary types where relevant" the policy also allows.
  incident_type TEXT NOT NULL CHECK (incident_type IN (
    'SB', 'DB', 'FL', 'LI', 'TF', 'QF', 'AT', 'IF', 'UA', 'MW', 'AV', 'TP', 'SA', 'DF'
  )),
  incident_type_secondary TEXT[] NOT NULL DEFAULT '{}',

  severity TEXT NOT NULL DEFAULT 'P3' CHECK (severity IN ('P1', 'P2', 'P3', 'P4')),
  severity_downgrade_reason TEXT,

  status TEXT NOT NULL DEFAULT 'reported' CHECK (status IN (
    'reported', 'triaged', 'contained', 'investigating', 'recovered', 'closed'
  )),

  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detection_source TEXT NOT NULL DEFAULT 'other' CHECK (detection_source IN (
    'monitoring_alert', 'staff', 'customer', 'merchant', 'regulator_partner',
    'reconciliation', 'vendor', 'other'
  )),

  reporter_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Deliberately a plain UUID with no FK, mirroring
  -- tickets.assigned_agent_id (migration 063) — untyped-FK into
  -- auth.users via profiles, same convention the rest of the app uses.
  incident_lead_id UUID,

  notifiable BOOLEAN,
  notifiable_rationale TEXT,
  pdpa_relevant BOOLEAN,
  aml_relevant BOOLEAN,

  affected_systems TEXT,
  affected_identifiers JSONB NOT NULL DEFAULT '{}'::jsonb,

  financial_impact_myr NUMERIC,
  customers_affected_count INTEGER,
  merchants_affected_count INTEGER,
  data_records_affected_count INTEGER,
  downtime_minutes INTEGER,

  contained_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  resumed_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,

  root_cause TEXT,
  closed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- P1/P2 PIR due 10 calendar days after closing (§17). Business-day-aware
  -- timing is a flagged fast-follow (reusing business_hours_schedules).
  pir_due_at TIMESTAMPTZ,

  escalation_level INTEGER NOT NULL DEFAULT 1 CHECK (escalation_level BETWEEN 1 AND 3),
  escalation_level_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, incident_number)
);

CREATE INDEX IF NOT EXISTS idx_incidents_account_status ON public.incidents(account_id, status);
CREATE INDEX IF NOT EXISTS idx_incidents_account_created ON public.incidents(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_reporter ON public.incidents(reporter_id);
CREATE INDEX IF NOT EXISTS idx_incidents_lead ON public.incidents(incident_lead_id);
CREATE INDEX IF NOT EXISTS idx_incidents_escalation_open
  ON public.incidents(escalation_level_entered_at) WHERE status = 'reported';

DROP TRIGGER IF EXISTS set_updated_at ON public.incidents;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS on incidents is enabled further below (after incident_watchers
-- exists, section 4) — incidents_select references it.

-- ------------------------------------------------------------
-- 4. incident_watchers (the IRT for this incident — auto-watch mirrors
-- ticket_watchers, migration 081)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_watchers (
  incident_id UUID NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (incident_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_incident_watchers_user ON public.incident_watchers(user_id);
CREATE INDEX IF NOT EXISTS idx_incident_watchers_account ON public.incident_watchers(account_id);

ALTER TABLE public.incident_watchers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_watchers_select ON public.incident_watchers;
DROP POLICY IF EXISTS incident_watchers_insert ON public.incident_watchers;
DROP POLICY IF EXISTS incident_watchers_delete ON public.incident_watchers;
CREATE POLICY incident_watchers_select ON public.incident_watchers FOR SELECT USING (
  has_capability(account_id, 'incidents.manage') OR user_id = auth.uid()
);
-- Watching is personal — the reporter/lead rows below come from the
-- SECURITY DEFINER trigger, which bypasses RLS.
CREATE POLICY incident_watchers_insert ON public.incident_watchers
  FOR INSERT WITH CHECK (is_account_member(account_id) AND user_id = auth.uid());
CREATE POLICY incident_watchers_delete ON public.incident_watchers
  FOR DELETE USING (is_account_member(account_id) AND user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.add_incident_auto_watchers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID;
BEGIN
  FOR v_user IN
    SELECT DISTINCT u FROM unnest(ARRAY[
      COALESCE(NEW.reporter_id, auth.uid()),
      NEW.incident_lead_id
    ]) AS u
    WHERE u IS NOT NULL
  LOOP
    IF EXISTS (SELECT 1 FROM profiles WHERE user_id = v_user AND account_id = NEW.account_id) THEN
      INSERT INTO incident_watchers (incident_id, user_id, account_id)
      VALUES (NEW.id, v_user, NEW.account_id)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to add auto-watchers for incident %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.add_incident_auto_watchers() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_incident_auto_watchers ON public.incidents;
CREATE TRIGGER on_incident_auto_watchers
  AFTER INSERT OR UPDATE OF incident_lead_id ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.add_incident_auto_watchers();

-- incidents RLS (deferred to here: incidents_select reads incident_watchers).
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incidents_select ON public.incidents;
DROP POLICY IF EXISTS incidents_insert ON public.incidents;
DROP POLICY IF EXISTS incidents_update ON public.incidents;
DROP POLICY IF EXISTS incidents_delete ON public.incidents;

-- A reporter or watcher sees only their own incident; incidents.manage
-- (Compliance Officer / Admin / Owner) sees the whole register — the
-- confidentiality requirement (policy §16.3) enforced in Postgres.
CREATE POLICY incidents_select ON public.incidents FOR SELECT USING (
  has_capability(account_id, 'incidents.manage')
  OR reporter_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.incident_watchers w
    WHERE w.incident_id = incidents.id AND w.user_id = auth.uid()
  )
);
CREATE POLICY incidents_insert ON public.incidents FOR INSERT WITH CHECK (
  has_capability(account_id, 'incidents.raise') AND reporter_id = auth.uid()
);
-- Only Compliance Officer / Admin / Owner reclassify, assign, escalate,
-- or close — a reporter can comment (incident_comments) but not edit.
CREATE POLICY incidents_update ON public.incidents FOR UPDATE
  USING (has_capability(account_id, 'incidents.manage'))
  WITH CHECK (has_capability(account_id, 'incidents.manage'));
CREATE POLICY incidents_delete ON public.incidents FOR DELETE
  USING (is_account_member(account_id, 'owner'));

-- ------------------------------------------------------------
-- 5. incident_activity — append-only audit trail (mirrors ticket_activity,
-- migration 064). Satisfies Appendix E's "Timeline of actions."
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_activity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id UUID NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'status_changed', 'severity_changed', 'type_changed',
    'lead_changed', 'escalated', 'closed'
  )),
  from_value TEXT,
  to_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_activity_incident_created
  ON public.incident_activity(incident_id, created_at);

ALTER TABLE public.incident_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_activity_select ON public.incident_activity;
CREATE POLICY incident_activity_select ON public.incident_activity FOR SELECT USING (
  has_capability(account_id, 'incidents.manage')
  OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_id AND i.reporter_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.incident_watchers w WHERE w.incident_id = incident_activity.incident_id AND w.user_id = auth.uid())
);
-- No client INSERT policy — only the SECURITY DEFINER triggers below write here.

CREATE OR REPLACE FUNCTION public.log_incident_created()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, to_value)
  VALUES (NEW.id, NEW.account_id, COALESCE(NEW.reporter_id, auth.uid()), 'created', NEW.status);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log incident creation for incident %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.log_incident_created() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_incident_created_activity ON public.incidents;
CREATE TRIGGER on_incident_created_activity
  AFTER INSERT ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.log_incident_created();

CREATE OR REPLACE FUNCTION public.log_incident_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'status_changed', OLD.status, NEW.status);
    IF NEW.status = 'closed' THEN
      INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, to_value)
      VALUES (NEW.id, NEW.account_id, auth.uid(), 'closed', NEW.status);
    END IF;
  END IF;

  IF NEW.severity IS DISTINCT FROM OLD.severity THEN
    INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'severity_changed', OLD.severity, NEW.severity);
  END IF;

  IF NEW.incident_type IS DISTINCT FROM OLD.incident_type THEN
    INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (NEW.id, NEW.account_id, auth.uid(), 'type_changed', OLD.incident_type, NEW.incident_type);
  END IF;

  IF NEW.incident_lead_id IS DISTINCT FROM OLD.incident_lead_id THEN
    INSERT INTO incident_activity (incident_id, account_id, actor_id, event_type, from_value, to_value)
    VALUES (
      NEW.id, NEW.account_id, auth.uid(), 'lead_changed',
      OLD.incident_lead_id::text, NEW.incident_lead_id::text
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log incident activity for incident %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.log_incident_activity() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_incident_activity ON public.incidents;
CREATE TRIGGER on_incident_activity
  AFTER UPDATE ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.log_incident_activity();

-- ------------------------------------------------------------
-- 6. incident_comments — investigator notes with @mentions (mirrors
-- ticket_comments' mentions JSONB column exactly, migration 063).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id UUID NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_incident_comments_incident_created
  ON public.incident_comments(incident_id, created_at);

ALTER TABLE public.incident_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_comments_select ON public.incident_comments;
DROP POLICY IF EXISTS incident_comments_insert ON public.incident_comments;

-- Visibility mirrors the parent incident: reporter, watcher, or
-- incidents.manage. A reporter may add notes to their own report even
-- though they cannot edit the incident record itself.
CREATE POLICY incident_comments_select ON public.incident_comments FOR SELECT USING (
  has_capability(account_id, 'incidents.manage')
  OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_id AND i.reporter_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.incident_watchers w WHERE w.incident_id = incident_comments.incident_id AND w.user_id = auth.uid())
);
CREATE POLICY incident_comments_insert ON public.incident_comments FOR INSERT WITH CHECK (
  author_id = auth.uid()
  AND (
    has_capability(account_id, 'incidents.manage')
    OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_id AND i.reporter_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.incident_watchers w WHERE w.incident_id = incident_comments.incident_id AND w.user_id = auth.uid())
  )
);

CREATE OR REPLACE FUNCTION public.set_incident_comment_edited_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.edited_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_incident_comment_edited ON public.incident_comments;
CREATE TRIGGER on_incident_comment_edited BEFORE UPDATE ON public.incident_comments
  FOR EACH ROW EXECUTE FUNCTION public.set_incident_comment_edited_at();

-- ------------------------------------------------------------
-- 7. incident_attachments — evidence files (screenshots, log bundles,
-- zips). Mirrors ticket_attachments (migration 081); files live in the
-- chat-media bucket under account-<id>/incidents/. Linkable to the
-- incident directly or to a specific comment.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id UUID NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  comment_id UUID REFERENCES public.incident_comments(id) ON DELETE SET NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  url TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_attachments_incident
  ON public.incident_attachments(incident_id, created_at);

ALTER TABLE public.incident_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_attachments_select ON public.incident_attachments;
DROP POLICY IF EXISTS incident_attachments_insert ON public.incident_attachments;
DROP POLICY IF EXISTS incident_attachments_delete ON public.incident_attachments;
CREATE POLICY incident_attachments_select ON public.incident_attachments FOR SELECT USING (
  has_capability(account_id, 'incidents.manage')
  OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_id AND i.reporter_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.incident_watchers w WHERE w.incident_id = incident_attachments.incident_id AND w.user_id = auth.uid())
);
CREATE POLICY incident_attachments_insert ON public.incident_attachments FOR INSERT WITH CHECK (
  uploaded_by = auth.uid()
  AND (
    has_capability(account_id, 'incidents.manage')
    OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_id AND i.reporter_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.incident_watchers w WHERE w.incident_id = incident_attachments.incident_id AND w.user_id = auth.uid())
  )
);
CREATE POLICY incident_attachments_delete ON public.incident_attachments FOR DELETE USING (
  uploaded_by = auth.uid() OR has_capability(account_id, 'incidents.manage')
);

-- ------------------------------------------------------------
-- 8. incident_evidence_log — chain-of-custody (Appendix F.2). An
-- attachment upload is automatically appended here, so custody tracking
-- is never a separate manual step.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_evidence_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id UUID NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  attachment_id UUID REFERENCES public.incident_attachments(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  source TEXT,
  collected_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  file_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_incident_evidence_log_incident
  ON public.incident_evidence_log(incident_id, collected_at);

ALTER TABLE public.incident_evidence_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_evidence_log_select ON public.incident_evidence_log;
CREATE POLICY incident_evidence_log_select ON public.incident_evidence_log FOR SELECT USING (
  has_capability(account_id, 'incidents.manage')
  OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_id AND i.reporter_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.incident_watchers w WHERE w.incident_id = incident_evidence_log.incident_id AND w.user_id = auth.uid())
);
-- No client INSERT policy — only the trigger below (and, later, a
-- Compliance Officer RPC for manually logged evidence) writes here.

CREATE OR REPLACE FUNCTION public.log_incident_attachment_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO incident_evidence_log (
    incident_id, account_id, attachment_id, description, source, collected_by
  ) VALUES (
    NEW.incident_id, NEW.account_id, NEW.id,
    'File uploaded: ' || NEW.filename,
    'attachment_upload',
    NEW.uploaded_by
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to log evidence for attachment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.log_incident_attachment_evidence() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_incident_attachment_evidence ON public.incident_attachments;
CREATE TRIGGER on_incident_attachment_evidence
  AFTER INSERT ON public.incident_attachments
  FOR EACH ROW EXECUTE FUNCTION public.log_incident_attachment_evidence();

-- ------------------------------------------------------------
-- 9. incident_notifications_sent — the manual log of EXTERNAL
-- notifications a human actually sent (BNM / sponsor EMI / partner /
-- Commissioner / data subjects / police / etc). This system never sends
-- these itself (see Context in the plan) — this table just records that
-- it was done. Satisfies Appendix E's "Notifications" field.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_notifications_sent (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id UUID NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  recipient_party TEXT NOT NULL CHECK (recipient_party IN (
    'bnm', 'sponsor_emi', 'partner', 'pdp_commissioner', 'data_subjects', 'police', 'other'
  )),
  recipient_detail TEXT,
  method TEXT,
  reference TEXT,
  sent_at TIMESTAMPTZ NOT NULL,
  recorded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_notifications_sent_incident
  ON public.incident_notifications_sent(incident_id, sent_at);

ALTER TABLE public.incident_notifications_sent ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_notifications_sent_select ON public.incident_notifications_sent;
DROP POLICY IF EXISTS incident_notifications_sent_insert ON public.incident_notifications_sent;
CREATE POLICY incident_notifications_sent_select ON public.incident_notifications_sent
  FOR SELECT USING (has_capability(account_id, 'incidents.manage'));
CREATE POLICY incident_notifications_sent_insert ON public.incident_notifications_sent
  FOR INSERT WITH CHECK (has_capability(account_id, 'incidents.manage') AND recorded_by = auth.uid());

-- ------------------------------------------------------------
-- 10. incident_actions — PIR corrective/preventive actions (Form C §6)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id UUID NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  closed_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_actions_incident ON public.incident_actions(incident_id);

DROP TRIGGER IF EXISTS set_updated_at ON public.incident_actions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incident_actions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.incident_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_actions_select ON public.incident_actions;
DROP POLICY IF EXISTS incident_actions_insert ON public.incident_actions;
DROP POLICY IF EXISTS incident_actions_update ON public.incident_actions;
CREATE POLICY incident_actions_select ON public.incident_actions FOR SELECT USING (
  has_capability(account_id, 'incidents.manage')
  OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_id AND i.reporter_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.incident_watchers w WHERE w.incident_id = incident_actions.incident_id AND w.user_id = auth.uid())
);
CREATE POLICY incident_actions_insert ON public.incident_actions
  FOR INSERT WITH CHECK (has_capability(account_id, 'incidents.manage'));
CREATE POLICY incident_actions_update ON public.incident_actions
  FOR UPDATE USING (has_capability(account_id, 'incidents.manage'));

-- ------------------------------------------------------------
-- 11. incident_escalation_events — escalation audit log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_escalation_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  incident_id UUID NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  from_level INTEGER NOT NULL,
  to_level INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'auto_timeout')),
  triggered_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_escalation_events_incident
  ON public.incident_escalation_events(incident_id, created_at);

ALTER TABLE public.incident_escalation_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_escalation_events_select ON public.incident_escalation_events;
CREATE POLICY incident_escalation_events_select ON public.incident_escalation_events FOR SELECT USING (
  has_capability(account_id, 'incidents.manage')
  OR EXISTS (SELECT 1 FROM public.incidents i WHERE i.id = incident_id AND i.reporter_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.incident_watchers w WHERE w.incident_id = incident_escalation_events.incident_id AND w.user_id = auth.uid())
);
-- No client INSERT policy — only incident_escalation_sweep() (service
-- role) and the manual-escalate RPC below write here.

-- ------------------------------------------------------------
-- 12. incident_escalation_policies — per-account, per-severity timer
-- overrides. incident_escalation_default_minutes() supplies the
-- fallback (policy §11.1's own targets) when an account has no row.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.incident_escalation_policies (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('P1', 'P2', 'P3', 'P4')),
  -- Minutes at level 1 before auto-advancing to level 2 (notifies Admins),
  -- and minutes at level 2 before auto-advancing to level 3 (notifies Owner).
  level_1_minutes INTEGER NOT NULL CHECK (level_1_minutes BETWEEN 1 AND 525600),
  level_2_minutes INTEGER NOT NULL CHECK (level_2_minutes BETWEEN 1 AND 525600),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, severity)
);

DROP TRIGGER IF EXISTS set_updated_at ON public.incident_escalation_policies;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incident_escalation_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.incident_escalation_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS incident_escalation_policies_select ON public.incident_escalation_policies;
DROP POLICY IF EXISTS incident_escalation_policies_insert ON public.incident_escalation_policies;
DROP POLICY IF EXISTS incident_escalation_policies_update ON public.incident_escalation_policies;
DROP POLICY IF EXISTS incident_escalation_policies_delete ON public.incident_escalation_policies;
CREATE POLICY incident_escalation_policies_select ON public.incident_escalation_policies
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY incident_escalation_policies_insert ON public.incident_escalation_policies
  FOR INSERT WITH CHECK (has_capability(account_id, 'incidents.manage'));
CREATE POLICY incident_escalation_policies_update ON public.incident_escalation_policies
  FOR UPDATE USING (has_capability(account_id, 'incidents.manage'))
  WITH CHECK (has_capability(account_id, 'incidents.manage'));
CREATE POLICY incident_escalation_policies_delete ON public.incident_escalation_policies
  FOR DELETE USING (has_capability(account_id, 'incidents.manage'));

-- Fallback targets straight from policy §11.1's escalation matrix: P1 15
-- min/level, P2 30/60 min, P3 1 business day (approximated as 1440 min
-- in v1 — business-day-aware timing is a flagged fast-follow), P4 weekly
-- (10080 min).
CREATE OR REPLACE FUNCTION public.incident_escalation_default_minutes(p_severity TEXT, p_level INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_severity
    WHEN 'P1' THEN 15
    WHEN 'P2' THEN CASE WHEN p_level = 1 THEN 30 ELSE 60 END
    WHEN 'P3' THEN 1440
    WHEN 'P4' THEN 10080
    ELSE 1440
  END;
$$;

-- ------------------------------------------------------------
-- 13. incident_escalation_sweep() — mirrors sla_sweep (migration 086).
-- Advances any 'reported' incident whose current escalation level has
-- been open longer than its (severity, level) threshold, notifying the
-- new level's recipients. Stops auto-advancing once status leaves
-- 'reported' (triaged/acknowledged) or the incident reaches level 3.
-- Level 1 = raised (notified at INSERT, see notify_incident_raised).
-- Level 2 = every Admin. Level 3 = the Owner.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.incident_escalation_sweep(p_limit INTEGER DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_threshold INTEGER;
  v_new_level INTEGER;
  v_escalated INTEGER := 0;
  v_notified INTEGER := 0;
  v_recipient UUID;
  v_key TEXT;
  -- Per-recipient detail for the caller (the cron route) to send email
  -- with — SQL cannot make HTTP calls, so this is handed back rather
  -- than sent here.
  v_notified_detail JSONB := '[]'::jsonb;
BEGIN
  FOR v_row IN
    SELECT i.*
    FROM incidents i
    WHERE i.status = 'reported'
      AND i.escalation_level < 3
    ORDER BY i.escalation_level_entered_at
    LIMIT GREATEST(LEAST(p_limit, 500), 0)
    FOR UPDATE SKIP LOCKED
  LOOP
    v_threshold := COALESCE(
      (SELECT CASE WHEN v_row.escalation_level = 1 THEN level_1_minutes ELSE level_2_minutes END
         FROM incident_escalation_policies
        WHERE account_id = v_row.account_id AND severity = v_row.severity),
      incident_escalation_default_minutes(v_row.severity, v_row.escalation_level)
    );

    IF NOW() - v_row.escalation_level_entered_at <= make_interval(mins => v_threshold) THEN
      CONTINUE;
    END IF;

    v_new_level := v_row.escalation_level + 1;

    UPDATE incidents
       SET escalation_level = v_new_level,
           escalation_level_entered_at = NOW()
     WHERE id = v_row.id;

    INSERT INTO incident_escalation_events (incident_id, account_id, from_level, to_level, reason)
    VALUES (v_row.id, v_row.account_id, v_row.escalation_level, v_new_level, 'auto_timeout');

    v_escalated := v_escalated + 1;

    v_key := 'INC-' || to_char(v_row.created_at, 'YYYY') || '-' || v_row.incident_number;

    FOR v_recipient IN
      SELECT p.user_id FROM profiles p
       WHERE p.account_id = v_row.account_id
         AND p.account_role = (CASE WHEN v_new_level = 2 THEN 'admin' ELSE 'owner' END)::account_role_enum
    LOOP
      INSERT INTO notifications (account_id, user_id, type, incident_id, title, body)
      VALUES (
        v_row.account_id, v_recipient, 'incident_escalated', v_row.id,
        'Incident escalated to level ' || v_new_level,
        v_key || ' (' || v_row.severity || ') — ' || v_row.title
          || ' has been unacknowledged and was escalated to level ' || v_new_level
      );
      v_notified := v_notified + 1;
      v_notified_detail := v_notified_detail || jsonb_build_object(
        'user_id', v_recipient, 'account_id', v_row.account_id, 'incident_id', v_row.id,
        'key', v_key, 'severity', v_row.severity, 'title', v_row.title, 'level', v_new_level
      );
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'escalated', v_escalated, 'notifications', v_notified, 'notified', v_notified_detail
  );
END;
$$;

REVOKE ALL ON FUNCTION public.incident_escalation_sweep(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.incident_escalation_sweep(INTEGER) TO service_role;

-- Manual escalate: same bump-and-notify logic, immediately, logged as
-- 'manual'. Callable by anyone holding incidents.manage.
CREATE OR REPLACE FUNCTION public.incident_escalate_manual(p_incident_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row incidents%ROWTYPE;
  v_new_level INTEGER;
  v_recipient UUID;
  v_key TEXT;
  v_notified INTEGER := 0;
BEGIN
  SELECT * INTO v_row FROM incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incident not found' USING ERRCODE = '22023';
  END IF;
  IF NOT has_capability(v_row.account_id, 'incidents.manage') THEN
    RAISE EXCEPTION 'This action requires the incidents.manage capability' USING ERRCODE = '42501';
  END IF;
  IF v_row.escalation_level >= 3 THEN
    RAISE EXCEPTION 'Incident is already at the highest escalation level' USING ERRCODE = '22023';
  END IF;

  v_new_level := v_row.escalation_level + 1;

  UPDATE incidents
     SET escalation_level = v_new_level,
         escalation_level_entered_at = NOW()
   WHERE id = v_row.id;

  INSERT INTO incident_escalation_events (incident_id, account_id, from_level, to_level, reason, triggered_by)
  VALUES (v_row.id, v_row.account_id, v_row.escalation_level, v_new_level, 'manual', auth.uid());

  v_key := 'INC-' || to_char(v_row.created_at, 'YYYY') || '-' || v_row.incident_number;

  FOR v_recipient IN
    SELECT p.user_id FROM profiles p
     WHERE p.account_id = v_row.account_id
       AND p.account_role = (CASE WHEN v_new_level = 2 THEN 'admin' ELSE 'owner' END)::account_role_enum
  LOOP
    INSERT INTO notifications (account_id, user_id, type, incident_id, actor_user_id, title, body)
    VALUES (
      v_row.account_id, v_recipient, 'incident_escalated', v_row.id, auth.uid(),
      'Incident escalated to level ' || v_new_level,
      v_key || ' (' || v_row.severity || ') — ' || v_row.title || ' was manually escalated to level ' || v_new_level
    );
    v_notified := v_notified + 1;
  END LOOP;

  RETURN jsonb_build_object('escalation_level', v_new_level, 'notifications', v_notified);
END;
$$;

REVOKE ALL ON FUNCTION public.incident_escalate_manual(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.incident_escalate_manual(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 14. notifications — widen for incident_* types (built from the LIVE
-- constraint, mirrors migration 084's pattern, so this cannot drop a
-- type another migration added).
-- ------------------------------------------------------------
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS incident_id UUID REFERENCES public.incidents(id) ON DELETE CASCADE;

DO $$
DECLARE
  v_def   TEXT;
  v_types TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';

  -- The live definition has taken two different shapes across this
  -- database's migration history depending on how it was last rebuilt:
  --   ANY ('{a,b,c}'::text[])            (array-literal form — %L on a
  --                                        text[] renders this way)
  --   ANY (ARRAY['a'::text, 'b'::text])  (expanded ARRAY[] form)
  -- Handle both so this cannot silently drop existing values (confirmed
  -- against the live prod definition, which is the array-literal form).
  IF v_def ~ '\{[^}]*\}' THEN
    v_types := string_to_array(substring(v_def FROM '\{([^}]*)\}'), ',');
  ELSE
    SELECT COALESCE(array_agg(DISTINCT m[1]), ARRAY[]::text[])
      INTO v_types
      FROM regexp_matches(COALESCE(v_def, ''), '''([^'']+)''::text', 'g') AS m;
  END IF;

  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY[
                  'incident_raised', 'incident_escalated', 'incident_assigned',
                  'incident_comment', 'incident_mention'
                ]) AS x);

  IF EXISTS (
    SELECT 1 FROM public.notifications n
    WHERE n.type IS NOT NULL AND NOT (n.type = ANY (v_types))
  ) THEN
    RAISE EXCEPTION 'notifications_type_check rebuild would drop a type in use: %', v_def;
  END IF;

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

-- ------------------------------------------------------------
-- 15. TRIGGER — notify Level 1 recipients when an incident is raised
-- (incident lead if already set, else everyone holding incidents.manage
-- at agent rank — the Compliance Officer role holders).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_incident_raised()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
  v_reporter_name TEXT;
  v_recipient UUID;
  v_any BOOLEAN := false;
BEGIN
  v_key := 'INC-' || to_char(NEW.created_at, 'YYYY') || '-' || NEW.incident_number;

  SELECT full_name INTO v_reporter_name FROM profiles WHERE user_id = NEW.reporter_id;

  IF NEW.incident_lead_id IS NOT NULL THEN
    INSERT INTO notifications (account_id, user_id, type, incident_id, actor_user_id, title, body)
    VALUES (
      NEW.account_id, NEW.incident_lead_id, 'incident_raised', NEW.id, NEW.reporter_id,
      'New incident: ' || v_key,
      COALESCE(v_reporter_name, 'Someone') || ' raised ' || v_key || ' (' || NEW.severity || ') — ' || NEW.title
    );
    v_any := true;
  ELSE
    FOR v_recipient IN
      SELECT p.user_id FROM profiles p
       WHERE p.account_id = NEW.account_id
         AND p.account_role = 'agent'
         AND (
           CASE WHEN p.custom_role_id IS NOT NULL
                THEN effective_custom_role_capability(p.custom_role_id, 'incidents.manage')
                ELSE effective_capability(p.account_id, p.account_role, 'incidents.manage')
           END
         )
    LOOP
      INSERT INTO notifications (account_id, user_id, type, incident_id, actor_user_id, title, body)
      VALUES (
        NEW.account_id, v_recipient, 'incident_raised', NEW.id, NEW.reporter_id,
        'New incident: ' || v_key,
        COALESCE(v_reporter_name, 'Someone') || ' raised ' || v_key || ' (' || NEW.severity || ') — ' || NEW.title
      );
      v_any := true;
    END LOOP;
  END IF;

  -- No Compliance Officer configured yet: fall back to every Admin/Owner
  -- so a P1 report is never silently unseen.
  IF NOT v_any THEN
    FOR v_recipient IN
      SELECT p.user_id FROM profiles p
       WHERE p.account_id = NEW.account_id AND p.account_role IN ('admin', 'owner')
    LOOP
      INSERT INTO notifications (account_id, user_id, type, incident_id, actor_user_id, title, body)
      VALUES (
        NEW.account_id, v_recipient, 'incident_raised', NEW.id, NEW.reporter_id,
        'New incident: ' || v_key,
        COALESCE(v_reporter_name, 'Someone') || ' raised ' || v_key || ' (' || NEW.severity || ') — ' || NEW.title
      );
    END LOOP;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to notify on incident raised for incident %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.notify_incident_raised() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_incident_raised ON public.incidents;
CREATE TRIGGER on_incident_raised
  AFTER INSERT ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.notify_incident_raised();

-- TRIGGER — notify on incident lead assignment (mirrors notify_ticket_assigned)
CREATE OR REPLACE FUNCTION public.notify_incident_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key TEXT;
  v_actor_name TEXT;
BEGIN
  IF NEW.incident_lead_id IS NULL
     OR NEW.incident_lead_id IS NOT DISTINCT FROM OLD.incident_lead_id THEN
    RETURN NEW;
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.incident_lead_id THEN
    RETURN NEW;
  END IF;

  v_key := 'INC-' || to_char(NEW.created_at, 'YYYY') || '-' || NEW.incident_number;
  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO notifications (account_id, user_id, type, incident_id, actor_user_id, title, body)
  VALUES (
    NEW.account_id, NEW.incident_lead_id, 'incident_assigned', NEW.id, auth.uid(),
    'You are the incident lead',
    COALESCE(v_actor_name, 'Someone') || ' made you the incident lead on ' || v_key || ' — ' || NEW.title
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to notify incident lead for incident %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.notify_incident_assigned() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_incident_assigned ON public.incidents;
CREATE TRIGGER on_incident_assigned
  AFTER UPDATE OF incident_lead_id ON public.incidents
  FOR EACH ROW EXECUTE FUNCTION public.notify_incident_assigned();

-- TRIGGER — notify each mentioned teammate on an incident comment
-- (mirrors notify_ticket_comment_mentions, migration 063)
CREATE OR REPLACE FUNCTION public.notify_incident_comment_mentions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_key TEXT;
  v_title TEXT;
  v_actor_name TEXT;
  v_mentioned_id UUID;
BEGIN
  IF NEW.mentions IS NULL OR jsonb_array_length(NEW.mentions) = 0 THEN
    RETURN NEW;
  END IF;

  SELECT account_id, 'INC-' || to_char(created_at, 'YYYY') || '-' || incident_number, title
    INTO v_account_id, v_key, v_title
  FROM incidents WHERE id = NEW.incident_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM profiles WHERE user_id = auth.uid();
  END IF;

  FOR v_mentioned_id IN
    SELECT DISTINCT (elem.value#>>'{}')::UUID
    FROM jsonb_array_elements(NEW.mentions) AS elem(value)
  LOOP
    IF v_mentioned_id IS NULL OR v_mentioned_id = NEW.author_id THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = v_mentioned_id AND account_id = v_account_id) THEN
      CONTINUE;
    END IF;

    INSERT INTO notifications (account_id, user_id, type, incident_id, actor_user_id, title, body)
    VALUES (
      v_account_id, v_mentioned_id, 'incident_mention', NEW.incident_id, auth.uid(),
      'You were mentioned',
      COALESCE(v_actor_name, 'Someone') || ' mentioned you in a note on ' || v_key || ' — ' || v_title
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create mention notification(s) for incident comment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.notify_incident_comment_mentions() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_incident_comment_mentions ON public.incident_comments;
CREATE TRIGGER on_incident_comment_mentions
  AFTER INSERT ON public.incident_comments
  FOR EACH ROW EXECUTE FUNCTION public.notify_incident_comment_mentions();

-- TRIGGER — notify watchers of a new comment (except the author and
-- anyone already mentioned, mirrors notify_ticket_comment_watchers)
CREATE OR REPLACE FUNCTION public.notify_incident_comment_watchers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_incident incidents%ROWTYPE;
  v_key TEXT;
  v_actor_name TEXT;
  v_watcher UUID;
BEGIN
  SELECT * INTO v_incident FROM incidents WHERE id = NEW.incident_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_key := 'INC-' || to_char(v_incident.created_at, 'YYYY') || '-' || v_incident.incident_number;
  SELECT full_name INTO v_actor_name FROM profiles WHERE user_id = COALESCE(NEW.author_id, auth.uid());

  FOR v_watcher IN
    SELECT user_id FROM incident_watchers
    WHERE incident_id = NEW.incident_id
      AND user_id IS DISTINCT FROM NEW.author_id
      AND user_id IS DISTINCT FROM auth.uid()
      AND NOT (COALESCE(NEW.mentions, '[]'::jsonb) @> to_jsonb(user_id::text))
  LOOP
    INSERT INTO notifications (account_id, user_id, type, incident_id, actor_user_id, title, body)
    VALUES (
      v_incident.account_id, v_watcher, 'incident_comment', NEW.incident_id, COALESCE(NEW.author_id, auth.uid()),
      'New note on an incident',
      COALESCE(v_actor_name, 'Someone') || ' added a note on ' || v_key || ' — ' || v_incident.title
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to notify watchers of incident comment %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.notify_incident_comment_watchers() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_incident_comment_watchers ON public.incident_comments;
CREATE TRIGGER on_incident_comment_watchers
  AFTER INSERT ON public.incident_comments
  FOR EACH ROW EXECUTE FUNCTION public.notify_incident_comment_watchers();

-- ------------------------------------------------------------
-- 16. ENABLE REALTIME — live list/board/detail updates
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'incidents'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE incidents;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'incident_comments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE incident_comments;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'incident_activity'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE incident_activity;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'incident_escalation_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE incident_escalation_events;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
