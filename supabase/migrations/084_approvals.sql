-- ============================================================
-- 084_approvals.sql — Propose and approve (Access Control phase 4)
--
-- Agents PROPOSE, a reviewer APPROVES: new snippets, new conversation
-- labels, new contact tags, and edits to existing snippets, labels and
-- tags. Applying an existing label or tag to a chat stays free. The
-- knowledge base keeps its own draft / publish flow and is only LISTED
-- in the same queue (drafts by people without knowledge.publish).
--
-- What this migration does
--   1. Capabilities (mirrors src/lib/auth/capabilities.ts, checked by
--      capabilities-sql.test.ts):
--        approvals.review   Owner + Admin   see and decide proposals
--        snippets.propose   Owner, Admin, Agent   propose snippets
--        tags.propose       Owner, Admin, Agent   propose tags / labels
--      and tags.manage / snippets.manage become database-enforced (the
--      write policies of `tags` and `quick_replies` now call
--      has_capability()), because a review step means nothing if the
--      role floor lets a person write the table directly. Defaults are
--      identical to today, so nothing changes for anyone until an Owner
--      or Admin edits a role.
--   2. Status columns on `tags` (contact tags AND conversation labels
--      share it) and `quick_replies` (snippets): approval_status
--      (approved | pending | rejected), proposed_by / proposed_at,
--      decided_by / decided_at / decision_note, pending_edit (proposed
--      replacement values for an edit of a LIVE row; the live columns
--      stay unchanged until approval) and edit_status (pending |
--      rejected: the state of pending_edit). Existing rows are
--      'approved'. A BEFORE trigger stops any direct client write from
--      changing these columns: only the RPCs below do.
--   3. Visibility: the SELECT policies show a row when it is approved,
--      or the caller proposed it, or the caller can review. Name
--      uniqueness only binds approved rows. A pending or rejected tag
--      can never be applied to a contact or a chat (link trigger) or
--      used by an auto-label rule.
--   4. SECURITY DEFINER RPCs (the only write path for proposals):
--      propose_tag, propose_tag_edit, propose_snippet,
--      propose_snippet_edit, withdraw_proposal, decide_proposal,
--      approvals_list, approvals_pending_count. Each checks
--      membership and the right capability itself: manage => live
--      directly, else propose => pending, else denied.
--   5. Audit + notifications: proposals log 'created', decisions log
--      'approved' / 'rejected' (with the note), and in-app
--      notifications go to every reviewer except the actor
--      (approval_requested) and to the proposer (approval_decided).
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Capabilities
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('approvals.review', 'agent', 'database'),
  ('snippets.propose', 'agent', 'database'),
  ('tags.propose', 'agent', 'database'),
  ('tags.manage', 'admin', 'database'),
  ('snippets.manage', 'agent', 'database')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'approvals.review'),
  ('owner', 'snippets.propose'),
  ('owner', 'tags.propose'),
  ('admin', 'approvals.review'),
  ('admin', 'snippets.propose'),
  ('admin', 'tags.propose'),
  ('agent', 'snippets.propose'),
  ('agent', 'tags.propose')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Columns
-- ------------------------------------------------------------
ALTER TABLE public.tags
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS proposed_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decided_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_note   TEXT,
  ADD COLUMN IF NOT EXISTS pending_edit    JSONB,
  ADD COLUMN IF NOT EXISTS edit_status     TEXT;

ALTER TABLE public.quick_replies
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS proposed_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decided_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_note   TEXT,
  ADD COLUMN IF NOT EXISTS pending_edit    JSONB,
  ADD COLUMN IF NOT EXISTS edit_status     TEXT;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tags', 'quick_replies'] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_approval_status_check');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (approval_status IN (''approved'', ''pending'', ''rejected''))',
      t, t || '_approval_status_check');
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_edit_status_check');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (edit_status IS NULL OR edit_status IN (''pending'', ''rejected''))',
      t, t || '_edit_status_check');
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_pending_edit_shape');
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (pending_edit IS NULL OR (jsonb_typeof(pending_edit) = ''object'' AND edit_status IS NOT NULL))',
      t, t || '_pending_edit_shape');
  END LOOP;
END $$;

-- Queue lookups: the rows that wait for a decision.
CREATE INDEX IF NOT EXISTS idx_tags_awaiting_review
  ON public.tags (account_id, proposed_at)
  WHERE deleted_at IS NULL AND (approval_status = 'pending' OR edit_status = 'pending');
CREATE INDEX IF NOT EXISTS idx_quick_replies_awaiting_review
  ON public.quick_replies (account_id, proposed_at)
  WHERE deleted_at IS NULL AND (approval_status = 'pending' OR edit_status = 'pending');

-- Names only bind LIVE approved rows: a pending or rejected proposal never
-- blocks (or is blocked by) a name; the check happens at proposal time and
-- again at approval time.
DROP INDEX IF EXISTS public.idx_tags_account_name_ci;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_account_name_ci
  ON public.tags (account_id, lower(name))
  WHERE deleted_at IS NULL AND approval_status = 'approved';

-- ------------------------------------------------------------
-- Guard: a direct client write can never set or change the approval
-- columns. Only the RPCs below (they set vircle.approval_rpc) and code
-- with no user (service role, migrations) can.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approval_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('vircle.approval_rpc', true), '') = 'on'
     OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.approval_status := 'approved';
    NEW.proposed_by     := NULL;
    NEW.proposed_at     := NULL;
    NEW.decided_by      := NULL;
    NEW.decided_at      := NULL;
    NEW.decision_note   := NULL;
    NEW.pending_edit    := NULL;
    NEW.edit_status     := NULL;
  ELSE
    NEW.approval_status := OLD.approval_status;
    NEW.proposed_by     := OLD.proposed_by;
    NEW.proposed_at     := OLD.proposed_at;
    NEW.decided_by      := OLD.decided_by;
    NEW.decided_at      := OLD.decided_at;
    NEW.decision_note   := OLD.decision_note;
    NEW.pending_edit    := OLD.pending_edit;
    NEW.edit_status     := OLD.edit_status;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.approval_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS approval_guard ON public.tags;
CREATE TRIGGER approval_guard
  BEFORE INSERT OR UPDATE ON public.tags
  FOR EACH ROW EXECUTE FUNCTION public.approval_guard();

DROP TRIGGER IF EXISTS approval_guard ON public.quick_replies;
CREATE TRIGGER approval_guard
  BEFORE INSERT OR UPDATE ON public.quick_replies
  FOR EACH ROW EXECUTE FUNCTION public.approval_guard();

-- ------------------------------------------------------------
-- 3. Policies
--   * SELECT: soft-deleted rows stay hidden (082); a row that is not
--     approved is visible to its proposer and to reviewers only.
--   * Writes: has_capability() instead of the old minimum role. The
--     defaults give exactly the old floors (tags: Owner + Admin,
--     snippets: Owner + Admin + Agent).
-- ------------------------------------------------------------
DROP POLICY IF EXISTS tags_select ON public.tags;
CREATE POLICY tags_select ON public.tags
  FOR SELECT USING (
    is_account_member(account_id)
    AND deleted_at IS NULL
    AND (approval_status = 'approved'
         OR proposed_by = auth.uid()
         OR has_capability(account_id, 'approvals.review'))
  );

DROP POLICY IF EXISTS quick_replies_select ON public.quick_replies;
CREATE POLICY quick_replies_select ON public.quick_replies
  FOR SELECT USING (
    is_account_member(account_id)
    AND deleted_at IS NULL
    AND (approval_status = 'approved'
         OR proposed_by = auth.uid()
         OR has_capability(account_id, 'approvals.review'))
  );

DROP POLICY IF EXISTS tags_insert ON public.tags;
DROP POLICY IF EXISTS tags_update ON public.tags;
DROP POLICY IF EXISTS tags_delete ON public.tags;
CREATE POLICY tags_insert ON public.tags
  FOR INSERT WITH CHECK (has_capability(account_id, 'tags.manage'));
CREATE POLICY tags_update ON public.tags
  FOR UPDATE USING (has_capability(account_id, 'tags.manage'));
CREATE POLICY tags_delete ON public.tags
  FOR DELETE USING (has_capability(account_id, 'tags.manage'));

DROP POLICY IF EXISTS quick_replies_insert ON public.quick_replies;
DROP POLICY IF EXISTS quick_replies_update ON public.quick_replies;
DROP POLICY IF EXISTS quick_replies_delete ON public.quick_replies;
CREATE POLICY quick_replies_insert ON public.quick_replies
  FOR INSERT WITH CHECK (has_capability(account_id, 'snippets.manage'));
CREATE POLICY quick_replies_update ON public.quick_replies
  FOR UPDATE USING (has_capability(account_id, 'snippets.manage'));
CREATE POLICY quick_replies_delete ON public.quick_replies
  FOR DELETE USING (has_capability(account_id, 'snippets.manage'));

-- A pending or rejected tag can never be applied to a contact or a chat.
-- (082's link trigger already refuses a soft-deleted tag; same place.)
CREATE OR REPLACE FUNCTION public.audit_link_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_col TEXT := TG_ARGV[0];
  v_uid UUID := auth.uid();
BEGIN
  IF EXISTS (SELECT 1 FROM tags t WHERE t.id = NEW.tag_id AND t.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'tag % was deleted', NEW.tag_id USING ERRCODE = '23503';
  END IF;
  IF EXISTS (SELECT 1 FROM tags t WHERE t.id = NEW.tag_id AND t.approval_status <> 'approved') THEN
    RAISE EXCEPTION 'tag % is not approved yet', NEW.tag_id USING ERRCODE = '23503';
  END IF;
  IF v_uid IS NOT NULL THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object(v_col, v_uid));
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_link_before_insert() FROM PUBLIC, anon, authenticated;

-- Auto-label rules apply a label to chats: only an approved one.
CREATE OR REPLACE FUNCTION public.approval_rule_tag_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tags t WHERE t.id = NEW.tag_id AND t.approval_status <> 'approved') THEN
    RAISE EXCEPTION 'tag % is not approved yet', NEW.tag_id USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.approval_rule_tag_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS approval_rule_tag_guard ON public.auto_label_rules;
CREATE TRIGGER approval_rule_tag_guard
  BEFORE INSERT OR UPDATE OF tag_id ON public.auto_label_rules
  FOR EACH ROW EXECUTE FUNCTION public.approval_rule_tag_guard();

-- ------------------------------------------------------------
-- Audit trigger: proposals and decisions are logged by the RPCs (with the
-- note and the proposer), so the row trigger stays quiet for anything that
-- is not (or was not) a live approved row.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o        JSONB;
  n        JSONB;
  base     JSONB;
  v_lbl    TEXT := TG_ARGV[1];
  v_soft   BOOLEAN := COALESCE(TG_ARGV[4], '') = 'soft';
  v_actcol TEXT := COALESCE(TG_ARGV[5], '');
  v_action TEXT;
  v_summary JSONB;
  v_actor  UUID;
  v_extra  TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    o := to_jsonb(OLD);
    base := o;
  ELSIF TG_OP = 'INSERT' THEN
    n := to_jsonb(NEW);
    base := n;
  ELSE
    o := to_jsonb(OLD);
    n := to_jsonb(NEW);
    base := n;
  END IF;

  -- Approval RPCs write their own rows (with the note and the proposer).
  IF COALESCE(current_setting('vircle.audit_skip', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' AND n ? 'approval_status' AND n ->> 'approval_status' <> 'approved' THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' AND o ? 'approval_status' AND o ->> 'approval_status' <> 'approved' THEN
    RETURN NULL;
  END IF;

  IF left(v_lbl, 1) = '=' THEN
    v_lbl := substr(v_lbl, 2);
  ELSE
    v_lbl := base ->> v_lbl;
    -- a webhook URL may carry a secret in its query string
    IF TG_ARGV[1] = 'url' THEN v_lbl := split_part(v_lbl, '?', 1); END IF;
  END IF;

  IF v_actcol <> '' AND auth.uid() IS NULL
     AND (TG_OP = 'INSERT' OR n -> v_actcol IS DISTINCT FROM o -> v_actcol) THEN
    v_actor := NULLIF(n ->> v_actcol, '')::uuid;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'created';
    v_summary := audit_diff('{}'::jsonb, n, audit_cols(TG_ARGV[2]), ARRAY[]::text[]);
    -- for a creation `changes` would be {col: {from: null, to: x}}: keep just the values
    IF v_summary ? 'changes' THEN
      v_summary := NULLIF(jsonb_build_object('values', COALESCE(
        (SELECT jsonb_object_agg(k, v -> 'to')
           FROM jsonb_each(v_summary -> 'changes') AS e(k, v)
          WHERE v -> 'to' <> 'null'::jsonb), '{}'::jsonb)), '{"values": {}}'::jsonb);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
  ELSIF v_soft AND o ->> 'deleted_at' IS NULL AND n ->> 'deleted_at' IS NOT NULL THEN
    v_action := 'deleted';
    v_extra := NULLIF(current_setting('vircle.audit_extra', true), '');
    IF v_extra IS NOT NULL THEN v_summary := v_extra::jsonb; END IF;
  ELSIF v_soft AND o ->> 'deleted_at' IS NOT NULL AND n ->> 'deleted_at' IS NULL THEN
    v_action := 'restored';
  ELSE
    v_action := 'updated';
    v_summary := audit_diff(o, n, audit_cols(TG_ARGV[2]), audit_cols(TG_ARGV[3]));
    IF v_summary IS NULL THEN RETURN NULL; END IF;
  END IF;

  PERFORM log_audit(
    (base ->> 'account_id')::uuid, v_action, TG_ARGV[0],
    NULLIF(base ->> 'id', '')::uuid, v_lbl, v_summary, v_actor);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'audit_row_change failed on %: %', TG_TABLE_NAME, SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_row_change() FROM PUBLIC, anon, authenticated;

-- "Recently removed" lists live items only: a withdrawn proposal is not a
-- removed tag or snippet.
CREATE OR REPLACE FUNCTION public.audit_removed_items(p_limit integer DEFAULT 200)
RETURNS TABLE (
  entity_type     text,
  entity_id       uuid,
  label           text,
  kind            text,
  deleted_at      timestamptz,
  deleted_by      uuid,
  deleted_by_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct UUID;
  v_cut  TIMESTAMPTZ := now() - interval '90 days';
BEGIN
  SELECT p.account_id INTO v_acct FROM profiles p WHERE p.user_id = auth.uid();
  IF v_acct IS NULL OR NOT has_capability(v_acct, 'audit.view') THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT x.entity_type, x.entity_id, x.label, x.kind, x.deleted_at, x.deleted_by,
         COALESCE(NULLIF(btrim(pr.full_name), ''), pr.email)
    FROM (
      SELECT 'tag'::text AS entity_type, t.id AS entity_id, t.name AS label,
             CASE WHEN t.for_contacts AND t.for_conversations THEN 'both'
                  WHEN t.for_conversations THEN 'label'
                  ELSE 'tag' END AS kind,
             t.deleted_at, t.deleted_by
        FROM tags t
       WHERE t.account_id = v_acct AND t.deleted_at IS NOT NULL AND t.deleted_at >= v_cut
         AND t.approval_status = 'approved'
      UNION ALL
      SELECT 'snippet', q.id, q.title, q.kind, q.deleted_at, q.deleted_by
        FROM quick_replies q
       WHERE q.account_id = v_acct AND q.deleted_at IS NOT NULL AND q.deleted_at >= v_cut
         AND q.approval_status = 'approved'
      UNION ALL
      SELECT 'article', d.id, d.title, d.language, d.deleted_at, d.deleted_by
        FROM ai_knowledge_documents d
       WHERE d.account_id = v_acct AND d.deleted_at IS NOT NULL AND d.deleted_at >= v_cut
         AND NOT EXISTS (
           SELECT 1 FROM ai_knowledge_documents b
            WHERE b.id = d.translation_of AND b.deleted_at = d.deleted_at)
    ) x
    LEFT JOIN profiles pr ON pr.user_id = x.deleted_by
   ORDER BY x.deleted_at DESC
   LIMIT GREATEST(LEAST(p_limit, 500), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.audit_removed_items(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_removed_items(integer) TO authenticated;

-- ------------------------------------------------------------
-- 5. Notification types: keep whatever is already allowed (tickets, AI
-- budget ...) and add the two approval types. Built from the live
-- constraint so this cannot drop a type another migration added.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_def   TEXT;
  v_types TEXT[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.notifications'::regclass AND conname = 'notifications_type_check';

  SELECT COALESCE(array_agg(DISTINCT m[1]), ARRAY[]::text[])
    INTO v_types
    FROM regexp_matches(COALESCE(v_def, ''), '''([^'']+)''::text', 'g') AS m;

  v_types := (SELECT array_agg(DISTINCT x ORDER BY x)
                FROM unnest(v_types || ARRAY['approval_requested', 'approval_decided']) AS x);

  ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
  EXECUTE format(
    'ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (%L::text[]))',
    v_types);
END $$;

-- ------------------------------------------------------------
-- Helpers (internal, not callable by clients)
-- ------------------------------------------------------------

-- The caller's account, or an error.
CREATE OR REPLACE FUNCTION public.approvals_caller()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_acct FROM profiles WHERE user_id = auth.uid();
  IF v_acct IS NULL THEN
    RAISE EXCEPTION 'You are not a member of an account' USING ERRCODE = '42501';
  END IF;
  RETURN v_acct;
END;
$$;

CREATE OR REPLACE FUNCTION public.approvals_person(p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(NULLIF(btrim(full_name), ''), email) FROM profiles WHERE user_id = p_user;
$$;

-- Live values of a tag / snippet as the four-or-five key JSON the queue shows.
CREATE OR REPLACE FUNCTION public.approvals_tag_values(t public.tags)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'name', t.name, 'color', t.color, 'description', t.description,
    'for_contacts', t.for_contacts, 'for_conversations', t.for_conversations);
$$;

CREATE OR REPLACE FUNCTION public.approvals_snippet_values(q public.quick_replies)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'title', q.title, 'kind', q.kind, 'content_text', q.content_text,
    'interactive_payload', q.interactive_payload);
$$;

CREATE OR REPLACE FUNCTION public.approvals_tag_kind(p_values jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN (p_values ->> 'for_contacts')::boolean AND (p_values ->> 'for_conversations')::boolean THEN 'both'
    WHEN (p_values ->> 'for_conversations')::boolean THEN 'label'
    ELSE 'tag'
  END;
$$;

-- Validate a tag patch (only the keys present) and return the clean one.
CREATE OR REPLACE FUNCTION public.approvals_clean_tag_patch(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_out jsonb := '{}'::jsonb;
  v     text;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RETURN v_out;
  END IF;

  IF p_patch ? 'name' THEN
    IF jsonb_typeof(p_patch -> 'name') <> 'string' THEN
      RAISE EXCEPTION 'invalid_name' USING ERRCODE = '22023';
    END IF;
    v := btrim(p_patch ->> 'name');
    IF v = '' OR char_length(v) > 60 THEN
      RAISE EXCEPTION 'invalid_name' USING ERRCODE = '22023';
    END IF;
    v_out := v_out || jsonb_build_object('name', v);
  END IF;

  IF p_patch ? 'color' THEN
    IF jsonb_typeof(p_patch -> 'color') <> 'string' OR (p_patch ->> 'color') !~ '^#[0-9a-fA-F]{6}$' THEN
      RAISE EXCEPTION 'invalid_color' USING ERRCODE = '22023';
    END IF;
    v_out := v_out || jsonb_build_object('color', lower(p_patch ->> 'color'));
  END IF;

  IF p_patch ? 'description' THEN
    IF jsonb_typeof(p_patch -> 'description') = 'null' THEN
      v_out := v_out || jsonb_build_object('description', NULL);
    ELSIF jsonb_typeof(p_patch -> 'description') = 'string' THEN
      v := btrim(p_patch ->> 'description');
      IF char_length(v) > 240 THEN
        RAISE EXCEPTION 'invalid_description' USING ERRCODE = '22023';
      END IF;
      v_out := v_out || jsonb_build_object('description', NULLIF(v, ''));
    ELSE
      RAISE EXCEPTION 'invalid_description' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_patch ? 'for_contacts' THEN
    IF jsonb_typeof(p_patch -> 'for_contacts') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_usage' USING ERRCODE = '22023';
    END IF;
    v_out := v_out || jsonb_build_object('for_contacts', p_patch -> 'for_contacts');
  END IF;
  IF p_patch ? 'for_conversations' THEN
    IF jsonb_typeof(p_patch -> 'for_conversations') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_usage' USING ERRCODE = '22023';
    END IF;
    v_out := v_out || jsonb_build_object('for_conversations', p_patch -> 'for_conversations');
  END IF;

  RETURN v_out;
END;
$$;

-- Validate a snippet patch.
CREATE OR REPLACE FUNCTION public.approvals_clean_snippet_patch(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_out jsonb := '{}'::jsonb;
  v     text;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RETURN v_out;
  END IF;

  IF p_patch ? 'title' THEN
    IF jsonb_typeof(p_patch -> 'title') <> 'string' THEN
      RAISE EXCEPTION 'invalid_title' USING ERRCODE = '22023';
    END IF;
    v := btrim(p_patch ->> 'title');
    IF v = '' OR char_length(v) > 200 THEN
      RAISE EXCEPTION 'invalid_title' USING ERRCODE = '22023';
    END IF;
    v_out := v_out || jsonb_build_object('title', v);
  END IF;

  IF p_patch ? 'kind' THEN
    IF p_patch ->> 'kind' NOT IN ('text', 'interactive') THEN
      RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023';
    END IF;
    v_out := v_out || jsonb_build_object('kind', p_patch ->> 'kind');
  END IF;

  IF p_patch ? 'content_text' THEN
    IF jsonb_typeof(p_patch -> 'content_text') = 'null' THEN
      v_out := v_out || jsonb_build_object('content_text', NULL);
    ELSIF jsonb_typeof(p_patch -> 'content_text') = 'string' THEN
      IF char_length(p_patch ->> 'content_text') > 4096 THEN
        RAISE EXCEPTION 'invalid_content' USING ERRCODE = '22023';
      END IF;
      v_out := v_out || jsonb_build_object('content_text', p_patch ->> 'content_text');
    ELSE
      RAISE EXCEPTION 'invalid_content' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_patch ? 'interactive_payload' THEN
    IF jsonb_typeof(p_patch -> 'interactive_payload') NOT IN ('object', 'null') THEN
      RAISE EXCEPTION 'invalid_content' USING ERRCODE = '22023';
    END IF;
    v_out := v_out || jsonb_build_object('interactive_payload', p_patch -> 'interactive_payload');
  END IF;

  RETURN v_out;
END;
$$;

-- A merged snippet value must be coherent (text has text, interactive has a payload).
CREATE OR REPLACE FUNCTION public.approvals_check_snippet(p_values jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_values ->> 'kind' = 'text' THEN
    IF btrim(COALESCE(p_values ->> 'content_text', '')) = '' THEN
      RAISE EXCEPTION 'invalid_content' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF jsonb_typeof(p_values -> 'interactive_payload') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'invalid_content' USING ERRCODE = '22023';
    END IF;
  END IF;
END;
$$;

-- Notify every reviewer except the actor.
CREATE OR REPLACE FUNCTION public.approvals_notify_reviewers(
  p_account uuid, p_actor uuid, p_title text, p_body text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO notifications (account_id, user_id, type, actor_user_id, title, body)
  SELECT p.account_id, p.user_id, 'approval_requested', p_actor,
         left(p_title, 200), left(p_body, 500)
    FROM profiles p
   WHERE p.account_id = p_account
     AND p.user_id IS DISTINCT FROM p_actor
     AND effective_capability(p.account_id, p.account_role, 'approvals.review');
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'approvals_notify_reviewers failed: %', SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION public.approvals_notify_proposer(
  p_account uuid, p_actor uuid, p_proposer uuid, p_title text, p_body text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_proposer IS NULL OR p_proposer IS NOT DISTINCT FROM p_actor THEN RETURN; END IF;
  INSERT INTO notifications (account_id, user_id, type, actor_user_id, title, body)
  SELECT p.account_id, p.user_id, 'approval_decided', p_actor,
         left(p_title, 200), left(p_body, 500)
    FROM profiles p
   WHERE p.account_id = p_account AND p.user_id = p_proposer;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'approvals_notify_proposer failed: %', SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.approvals_caller()                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approvals_person(uuid)                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approvals_tag_values(public.tags)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approvals_snippet_values(public.quick_replies)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approvals_tag_kind(jsonb)                            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approvals_clean_tag_patch(jsonb)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approvals_clean_snippet_patch(jsonb)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approvals_check_snippet(jsonb)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approvals_notify_reviewers(uuid, uuid, text, text)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approvals_notify_proposer(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- propose_tag(kind, name, color, description, also_other)
--
--   tags.manage  -> the tag goes live (today's behaviour)
--   tags.propose -> a pending proposal, reviewers are notified
--   neither      -> denied
-- Name conflicts are checked against LIVE approved names only.
-- Returns {id, mode: 'created' | 'proposed'}.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.propose_tag(
  p_kind       text,
  p_name       text,
  p_color      text    DEFAULT NULL,
  p_description text   DEFAULT NULL,
  p_also_other boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_acct    UUID := approvals_caller();
  v_manage  BOOLEAN := has_capability(v_acct, 'tags.manage');
  v_clean   JSONB;
  v_name    TEXT;
  v_for_c   BOOLEAN;
  v_for_l   BOOLEAN;
  v_id      UUID;
  v_who     TEXT;
BEGIN
  IF NOT v_manage AND NOT has_capability(v_acct, 'tags.propose') THEN
    RAISE EXCEPTION 'This action requires the ''tags.propose'' permission' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('tag', 'label') THEN
    RAISE EXCEPTION 'invalid_usage' USING ERRCODE = '22023';
  END IF;

  v_clean := approvals_clean_tag_patch(jsonb_build_object(
    'name', p_name,
    'color', COALESCE(p_color, '#3b82f6'),
    'description', to_jsonb(p_description)));
  v_name  := v_clean ->> 'name';
  v_for_c := p_kind = 'tag'   OR COALESCE(p_also_other, false);
  v_for_l := p_kind = 'label' OR COALESCE(p_also_other, false);

  IF EXISTS (SELECT 1 FROM tags t
              WHERE t.account_id = v_acct AND t.deleted_at IS NULL
                AND t.approval_status = 'approved' AND lower(t.name) = lower(v_name)) THEN
    RAISE EXCEPTION 'name_conflict' USING ERRCODE = '23505';
  END IF;
  IF NOT v_manage AND EXISTS (SELECT 1 FROM tags t
              WHERE t.account_id = v_acct AND t.deleted_at IS NULL
                AND t.approval_status = 'pending' AND t.proposed_by = v_uid
                AND lower(t.name) = lower(v_name)) THEN
    RAISE EXCEPTION 'name_conflict' USING ERRCODE = '23505';
  END IF;

  PERFORM set_config('vircle.approval_rpc', 'on', true);
  IF v_manage THEN
    INSERT INTO tags (user_id, account_id, name, color, description, for_contacts, for_conversations)
    VALUES (v_uid, v_acct, v_name, v_clean ->> 'color', v_clean ->> 'description', v_for_c, v_for_l)
    RETURNING id INTO v_id;
    PERFORM set_config('vircle.approval_rpc', 'off', true);
    RETURN jsonb_build_object('id', v_id, 'mode', 'created');
  END IF;

  INSERT INTO tags (user_id, account_id, name, color, description, for_contacts, for_conversations,
                    approval_status, proposed_by, proposed_at)
  VALUES (v_uid, v_acct, v_name, v_clean ->> 'color', v_clean ->> 'description', v_for_c, v_for_l,
          'pending', v_uid, now())
  RETURNING id INTO v_id;
  PERFORM set_config('vircle.approval_rpc', 'off', true);

  PERFORM log_audit(v_acct, 'created', 'tag', v_id, v_name,
    jsonb_build_object('proposal', 'new',
      'kind', CASE WHEN v_for_c AND v_for_l THEN 'both' WHEN v_for_l THEN 'label' ELSE 'tag' END,
      'values', jsonb_build_object('name', v_name, 'color', v_clean ->> 'color')));

  v_who := COALESCE(approvals_person(v_uid), '');
  PERFORM approvals_notify_reviewers(v_acct, v_uid,
    CASE WHEN v_for_l AND NOT v_for_c THEN 'Approval needed: new label' ELSE 'Approval needed: new tag' END,
    v_who || ' proposed "' || v_name || '"');

  RETURN jsonb_build_object('id', v_id, 'mode', 'proposed');
END;
$$;

-- ------------------------------------------------------------
-- propose_tag_edit(id, patch)
--   patch keys: name, color, description, for_contacts, for_conversations
--   tags.manage  -> applied to the live row
--   tags.propose -> stored as pending_edit on a LIVE row (the live values
--                   stay), or applied to the caller's own pending /
--                   rejected proposal (resubmit)
-- Returns {id, mode: 'updated' | 'proposed'}.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.propose_tag_edit(p_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_acct    UUID := approvals_caller();
  v_manage  BOOLEAN := has_capability(v_acct, 'tags.manage');
  r         tags%ROWTYPE;
  v_clean   JSONB;
  v_diff    JSONB := '{}'::jsonb;
  v_live    JSONB;
  v_merged  JSONB;
  k         TEXT;
  v_who     TEXT;
BEGIN
  IF NOT v_manage AND NOT has_capability(v_acct, 'tags.propose') THEN
    RAISE EXCEPTION 'This action requires the ''tags.propose'' permission' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO r FROM tags
   WHERE id = p_id AND account_id = v_acct AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  v_clean  := approvals_clean_tag_patch(p_patch);
  v_live   := approvals_tag_values(r);
  v_merged := v_live || v_clean;

  IF NOT (v_merged ->> 'for_contacts')::boolean AND NOT (v_merged ->> 'for_conversations')::boolean THEN
    RAISE EXCEPTION 'invalid_usage' USING ERRCODE = '22023';
  END IF;
  IF v_clean ? 'name' AND EXISTS (
       SELECT 1 FROM tags t
        WHERE t.account_id = v_acct AND t.deleted_at IS NULL AND t.id <> r.id
          AND t.approval_status = 'approved' AND lower(t.name) = lower(v_clean ->> 'name')) THEN
    RAISE EXCEPTION 'name_conflict' USING ERRCODE = '23505';
  END IF;

  IF v_manage THEN
    IF r.approval_status <> 'approved' THEN
      RAISE EXCEPTION 'not_live' USING ERRCODE = 'P0001';
    END IF;
    PERFORM set_config('vircle.approval_rpc', 'on', true);
    UPDATE tags SET
      name = v_merged ->> 'name', color = v_merged ->> 'color',
      description = v_merged ->> 'description',
      for_contacts = (v_merged ->> 'for_contacts')::boolean,
      for_conversations = (v_merged ->> 'for_conversations')::boolean
     WHERE id = r.id;
    PERFORM set_config('vircle.approval_rpc', 'off', true);
    RETURN jsonb_build_object('id', r.id, 'mode', 'updated');
  END IF;

  -- The caller's own pending / rejected creation: edit it in place and
  -- send it back to the queue.
  IF r.approval_status <> 'approved' THEN
    IF r.proposed_by IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'This proposal belongs to someone else' USING ERRCODE = '42501';
    END IF;
    PERFORM set_config('vircle.approval_rpc', 'on', true);
    UPDATE tags SET
      name = v_merged ->> 'name', color = v_merged ->> 'color',
      description = v_merged ->> 'description',
      for_contacts = (v_merged ->> 'for_contacts')::boolean,
      for_conversations = (v_merged ->> 'for_conversations')::boolean,
      approval_status = 'pending', proposed_at = now(),
      decided_by = NULL, decided_at = NULL, decision_note = NULL
     WHERE id = r.id;
    PERFORM set_config('vircle.approval_rpc', 'off', true);
    PERFORM log_audit(v_acct, 'created', 'tag', r.id, v_merged ->> 'name',
      jsonb_build_object('proposal', 'new', 'resubmitted', true,
                         'kind', approvals_tag_kind(v_merged)));
    v_who := COALESCE(approvals_person(v_uid), '');
    PERFORM approvals_notify_reviewers(v_acct, v_uid, 'Approval needed: new tag',
      v_who || ' proposed "' || (v_merged ->> 'name') || '"');
    RETURN jsonb_build_object('id', r.id, 'mode', 'proposed');
  END IF;

  -- An edit of a live tag.
  IF r.edit_status = 'pending' AND r.proposed_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'edit_pending' USING ERRCODE = 'P0001';
  END IF;
  FOR k IN SELECT jsonb_object_keys(v_clean) LOOP
    IF v_clean -> k IS DISTINCT FROM v_live -> k THEN
      v_diff := v_diff || jsonb_build_object(k, v_clean -> k);
    END IF;
  END LOOP;
  IF v_diff = '{}'::jsonb THEN
    RAISE EXCEPTION 'no_changes' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('vircle.approval_rpc', 'on', true);
  PERFORM set_config('vircle.audit_skip', 'on', true);
  UPDATE tags SET
    pending_edit = v_diff, edit_status = 'pending',
    proposed_by = v_uid, proposed_at = now(),
    decided_by = NULL, decided_at = NULL, decision_note = NULL
   WHERE id = r.id;
  PERFORM set_config('vircle.approval_rpc', 'off', true);
  PERFORM set_config('vircle.audit_skip', 'off', true);

  PERFORM log_audit(v_acct, 'created', 'tag', r.id, r.name,
    jsonb_build_object('proposal', 'edit', 'kind', approvals_tag_kind(v_live || v_diff),
                       'changed', (SELECT jsonb_agg(x) FROM jsonb_object_keys(v_diff) AS x)));
  v_who := COALESCE(approvals_person(v_uid), '');
  PERFORM approvals_notify_reviewers(v_acct, v_uid, 'Approval needed: tag change',
    v_who || ' proposed a change to "' || r.name || '"');
  RETURN jsonb_build_object('id', r.id, 'mode', 'proposed');
END;
$$;

-- ------------------------------------------------------------
-- propose_snippet(title, kind, content_text, interactive_payload)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.propose_snippet(
  p_title               text,
  p_kind                text  DEFAULT 'text',
  p_content_text        text  DEFAULT NULL,
  p_interactive_payload jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_acct   UUID := approvals_caller();
  v_manage BOOLEAN := has_capability(v_acct, 'snippets.manage');
  v_clean  JSONB;
  v_vals   JSONB;
  v_id     UUID;
  v_who    TEXT;
BEGIN
  IF NOT v_manage AND NOT has_capability(v_acct, 'snippets.propose') THEN
    RAISE EXCEPTION 'This action requires the ''snippets.propose'' permission' USING ERRCODE = '42501';
  END IF;

  v_clean := approvals_clean_snippet_patch(jsonb_build_object(
    'title', p_title, 'kind', COALESCE(p_kind, 'text'),
    'content_text', to_jsonb(p_content_text),
    'interactive_payload', COALESCE(p_interactive_payload, 'null'::jsonb)));
  v_vals := jsonb_build_object(
    'title', v_clean ->> 'title', 'kind', v_clean ->> 'kind',
    'content_text', CASE WHEN v_clean ->> 'kind' = 'text' THEN v_clean -> 'content_text' ELSE 'null'::jsonb END,
    'interactive_payload', CASE WHEN v_clean ->> 'kind' = 'interactive' THEN v_clean -> 'interactive_payload' ELSE 'null'::jsonb END);
  PERFORM approvals_check_snippet(v_vals);

  PERFORM set_config('vircle.approval_rpc', 'on', true);
  IF v_manage THEN
    INSERT INTO quick_replies (account_id, user_id, title, kind, content_text, interactive_payload)
    VALUES (v_acct, v_uid, v_vals ->> 'title', v_vals ->> 'kind', v_vals ->> 'content_text',
            NULLIF(v_vals -> 'interactive_payload', 'null'::jsonb))
    RETURNING id INTO v_id;
    PERFORM set_config('vircle.approval_rpc', 'off', true);
    RETURN jsonb_build_object('id', v_id, 'mode', 'created');
  END IF;

  INSERT INTO quick_replies (account_id, user_id, title, kind, content_text, interactive_payload,
                             approval_status, proposed_by, proposed_at)
  VALUES (v_acct, v_uid, v_vals ->> 'title', v_vals ->> 'kind', v_vals ->> 'content_text',
          NULLIF(v_vals -> 'interactive_payload', 'null'::jsonb), 'pending', v_uid, now())
  RETURNING id INTO v_id;
  PERFORM set_config('vircle.approval_rpc', 'off', true);

  PERFORM log_audit(v_acct, 'created', 'snippet', v_id, v_vals ->> 'title',
    jsonb_build_object('proposal', 'new', 'kind', v_vals ->> 'kind'));
  v_who := COALESCE(approvals_person(v_uid), '');
  PERFORM approvals_notify_reviewers(v_acct, v_uid, 'Approval needed: new snippet',
    v_who || ' proposed "' || (v_vals ->> 'title') || '"');
  RETURN jsonb_build_object('id', v_id, 'mode', 'proposed');
END;
$$;

CREATE OR REPLACE FUNCTION public.propose_snippet_edit(p_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_acct   UUID := approvals_caller();
  v_manage BOOLEAN := has_capability(v_acct, 'snippets.manage');
  r        quick_replies%ROWTYPE;
  v_clean  JSONB;
  v_live   JSONB;
  v_merged JSONB;
  v_diff   JSONB := '{}'::jsonb;
  k        TEXT;
  v_who    TEXT;
BEGIN
  IF NOT v_manage AND NOT has_capability(v_acct, 'snippets.propose') THEN
    RAISE EXCEPTION 'This action requires the ''snippets.propose'' permission' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO r FROM quick_replies
   WHERE id = p_id AND account_id = v_acct AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  v_clean  := approvals_clean_snippet_patch(p_patch);
  v_live   := approvals_snippet_values(r);
  v_merged := v_live || v_clean;
  -- The kind decides which content column is authoritative (the same rule
  -- as the snippet route): the other one is cleared.
  IF v_merged ->> 'kind' = 'text' THEN
    v_merged := v_merged || jsonb_build_object('interactive_payload', NULL);
  ELSE
    v_merged := v_merged || jsonb_build_object('content_text', NULL);
  END IF;
  PERFORM approvals_check_snippet(v_merged);

  IF v_manage THEN
    IF r.approval_status <> 'approved' THEN
      RAISE EXCEPTION 'not_live' USING ERRCODE = 'P0001';
    END IF;
    PERFORM set_config('vircle.approval_rpc', 'on', true);
    UPDATE quick_replies SET
      title = v_merged ->> 'title', kind = v_merged ->> 'kind',
      content_text = v_merged ->> 'content_text',
      interactive_payload = NULLIF(v_merged -> 'interactive_payload', 'null'::jsonb)
     WHERE id = r.id;
    PERFORM set_config('vircle.approval_rpc', 'off', true);
    RETURN jsonb_build_object('id', r.id, 'mode', 'updated');
  END IF;

  IF r.approval_status <> 'approved' THEN
    IF r.proposed_by IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'This proposal belongs to someone else' USING ERRCODE = '42501';
    END IF;
    PERFORM set_config('vircle.approval_rpc', 'on', true);
    UPDATE quick_replies SET
      title = v_merged ->> 'title', kind = v_merged ->> 'kind',
      content_text = v_merged ->> 'content_text',
      interactive_payload = NULLIF(v_merged -> 'interactive_payload', 'null'::jsonb),
      approval_status = 'pending', proposed_at = now(),
      decided_by = NULL, decided_at = NULL, decision_note = NULL
     WHERE id = r.id;
    PERFORM set_config('vircle.approval_rpc', 'off', true);
    PERFORM log_audit(v_acct, 'created', 'snippet', r.id, v_merged ->> 'title',
      jsonb_build_object('proposal', 'new', 'resubmitted', true, 'kind', v_merged ->> 'kind'));
    v_who := COALESCE(approvals_person(v_uid), '');
    PERFORM approvals_notify_reviewers(v_acct, v_uid, 'Approval needed: new snippet',
      v_who || ' proposed "' || (v_merged ->> 'title') || '"');
    RETURN jsonb_build_object('id', r.id, 'mode', 'proposed');
  END IF;

  IF r.edit_status = 'pending' AND r.proposed_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'edit_pending' USING ERRCODE = 'P0001';
  END IF;
  FOR k IN SELECT jsonb_object_keys(v_merged) LOOP
    IF v_merged -> k IS DISTINCT FROM v_live -> k THEN
      v_diff := v_diff || jsonb_build_object(k, v_merged -> k);
    END IF;
  END LOOP;
  IF v_diff = '{}'::jsonb THEN
    RAISE EXCEPTION 'no_changes' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('vircle.approval_rpc', 'on', true);
  PERFORM set_config('vircle.audit_skip', 'on', true);
  UPDATE quick_replies SET
    pending_edit = v_diff, edit_status = 'pending',
    proposed_by = v_uid, proposed_at = now(),
    decided_by = NULL, decided_at = NULL, decision_note = NULL
   WHERE id = r.id;
  PERFORM set_config('vircle.approval_rpc', 'off', true);
  PERFORM set_config('vircle.audit_skip', 'off', true);

  PERFORM log_audit(v_acct, 'created', 'snippet', r.id, r.title,
    jsonb_build_object('proposal', 'edit', 'kind', v_merged ->> 'kind',
                       'changed', (SELECT jsonb_agg(x) FROM jsonb_object_keys(v_diff) AS x)));
  v_who := COALESCE(approvals_person(v_uid), '');
  PERFORM approvals_notify_reviewers(v_acct, v_uid, 'Approval needed: snippet change',
    v_who || ' proposed a change to "' || r.title || '"');
  RETURN jsonb_build_object('id', r.id, 'mode', 'proposed');
END;
$$;

-- ------------------------------------------------------------
-- withdraw_proposal(type, id): the proposer takes back (or dismisses a
-- rejected) proposal.
--   * a creation (pending or rejected): soft-deleted through the phase 2
--     mechanism, so the audit history stays;
--   * an edit of a live item: pending_edit is cleared, the live item is
--     untouched.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.withdraw_proposal(p_entity_type text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_acct   UUID := approvals_caller();
  v_status TEXT;
  v_edit   JSONB;
  v_by     UUID;
  v_label  TEXT;
BEGIN
  IF p_entity_type = 'tag' THEN
    SELECT approval_status, pending_edit, proposed_by, name INTO v_status, v_edit, v_by, v_label
      FROM tags WHERE id = p_id AND account_id = v_acct AND deleted_at IS NULL FOR UPDATE;
  ELSIF p_entity_type = 'snippet' THEN
    SELECT approval_status, pending_edit, proposed_by, title INTO v_status, v_edit, v_by, v_label
      FROM quick_replies WHERE id = p_id AND account_id = v_acct AND deleted_at IS NULL FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'Unknown item type: %', p_entity_type USING ERRCODE = '22023';
  END IF;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_by IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Only the person who proposed it can withdraw it' USING ERRCODE = '42501';
  END IF;

  IF v_status <> 'approved' THEN
    -- a creation: the row is hidden by the soft delete
    IF p_entity_type = 'tag' THEN
      DELETE FROM tags WHERE id = p_id;
    ELSE
      DELETE FROM quick_replies WHERE id = p_id;
    END IF;
    PERFORM log_audit(v_acct, 'deleted', p_entity_type, p_id, v_label,
      jsonb_build_object('proposal', 'new', 'withdrawn', true));
    RETURN jsonb_build_object('withdrawn', true);
  END IF;

  IF v_edit IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('vircle.approval_rpc', 'on', true);
  PERFORM set_config('vircle.audit_skip', 'on', true);
  IF p_entity_type = 'tag' THEN
    UPDATE tags SET pending_edit = NULL, edit_status = NULL,
           decided_by = NULL, decided_at = NULL, decision_note = NULL
     WHERE id = p_id;
  ELSE
    UPDATE quick_replies SET pending_edit = NULL, edit_status = NULL,
           decided_by = NULL, decided_at = NULL, decision_note = NULL
     WHERE id = p_id;
  END IF;
  PERFORM set_config('vircle.approval_rpc', 'off', true);
  PERFORM set_config('vircle.audit_skip', 'off', true);
  PERFORM log_audit(v_acct, 'deleted', p_entity_type, p_id, v_label,
    jsonb_build_object('proposal', 'edit', 'withdrawn', true));
  RETURN jsonb_build_object('withdrawn', true);
END;
$$;

-- ------------------------------------------------------------
-- decide_proposal(type, id, decision, note, edited)
--   type      'tag' (tags AND labels) | 'snippet' | 'article'
--   decision  'approve' | 'reject'   (reject needs a note of 3+ characters)
--   edited    optional replacement values for "edit then approve"
-- Needs approvals.review (and knowledge.publish for an article). Nobody
-- decides their own proposal. An article can only be approved (= published):
-- a rejected article simply stays a draft.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decide_proposal(
  p_entity_type text,
  p_id          uuid,
  p_decision    text,
  p_note        text  DEFAULT NULL,
  p_edited      jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_acct    UUID := approvals_caller();
  v_note    TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_approve BOOLEAN;
  v_type_label TEXT;
  tg        tags%ROWTYPE;
  sn        quick_replies%ROWTYPE;
  ar        ai_knowledge_documents%ROWTYPE;
  v_new     BOOLEAN;
  v_live    JSONB;
  v_proposed JSONB;
  v_clean   JSONB;
  v_title   TEXT;
  v_proposer UUID;
  v_proposed_at TIMESTAMPTZ;
  v_kind    TEXT;
  v_summary JSONB;
BEGIN
  IF NOT has_capability(v_acct, 'approvals.review') THEN
    RAISE EXCEPTION 'This action requires the ''approvals.review'' permission' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'invalid_decision' USING ERRCODE = '22023';
  END IF;
  v_approve := p_decision = 'approve';
  IF NOT v_approve AND (v_note IS NULL OR char_length(v_note) < 3) THEN
    RAISE EXCEPTION 'note_required' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 500 THEN
    v_note := left(v_note, 500);
  END IF;

  IF p_entity_type = 'article' THEN
    IF NOT has_capability(v_acct, 'knowledge.publish') THEN
      RAISE EXCEPTION 'This action requires the ''knowledge.publish'' permission' USING ERRCODE = '42501';
    END IF;
    IF NOT v_approve THEN
      RAISE EXCEPTION 'reject_not_supported' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO ar FROM ai_knowledge_documents
     WHERE id = p_id AND account_id = v_acct AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND OR ar.status <> 'draft' THEN
      RAISE EXCEPTION 'not_pending' USING ERRCODE = 'P0001';
    END IF;
    IF ar.created_by IS NOT DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'own_proposal' USING ERRCODE = '42501';
    END IF;
    UPDATE ai_knowledge_documents SET status = 'published', updated_by = v_uid WHERE id = p_id;
    PERFORM log_audit(v_acct, 'approved', 'article', COALESCE(ar.translation_of, ar.id), ar.title,
      jsonb_build_object('proposal', 'new', 'kind', 'article',
        'proposer_id', ar.created_by, 'proposer_name', approvals_person(ar.created_by),
        'proposed_at', ar.updated_at, 'note', v_note));
    PERFORM approvals_notify_proposer(v_acct, v_uid, ar.created_by,
      'Your article was approved', '"' || ar.title || '" is now published');
    RETURN jsonb_build_object('decision', 'approve', 'published', true);
  END IF;

  PERFORM set_config('vircle.approval_rpc', 'on', true);
  PERFORM set_config('vircle.audit_skip', 'on', true);

  IF p_entity_type = 'tag' THEN
    SELECT * INTO tg FROM tags
     WHERE id = p_id AND account_id = v_acct AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
    END IF;
    v_new := tg.approval_status <> 'approved';
    IF (v_new AND tg.approval_status <> 'pending')
       OR (NOT v_new AND (tg.edit_status IS DISTINCT FROM 'pending' OR tg.pending_edit IS NULL)) THEN
      RAISE EXCEPTION 'not_pending' USING ERRCODE = 'P0001';
    END IF;
    IF tg.proposed_by IS NOT DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'own_proposal' USING ERRCODE = '42501';
    END IF;

    v_live     := approvals_tag_values(tg);
    v_proposed := CASE WHEN v_new THEN v_live ELSE v_live || tg.pending_edit END;
    v_proposer := tg.proposed_by;
    v_proposed_at := tg.proposed_at;
    v_title    := tg.name;
    v_type_label := CASE approvals_tag_kind(v_proposed) WHEN 'label' THEN 'label' ELSE 'tag' END;

    IF v_approve THEN
      v_clean := approvals_clean_tag_patch(p_edited);
      v_proposed := v_proposed || v_clean;
      IF NOT (v_proposed ->> 'for_contacts')::boolean AND NOT (v_proposed ->> 'for_conversations')::boolean THEN
        RAISE EXCEPTION 'invalid_usage' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM tags t
                  WHERE t.account_id = v_acct AND t.deleted_at IS NULL AND t.id <> tg.id
                    AND t.approval_status = 'approved'
                    AND lower(t.name) = lower(v_proposed ->> 'name')) THEN
        RAISE EXCEPTION 'name_conflict' USING ERRCODE = '23505';
      END IF;
      UPDATE tags SET
        name = v_proposed ->> 'name', color = v_proposed ->> 'color',
        description = v_proposed ->> 'description',
        for_contacts = (v_proposed ->> 'for_contacts')::boolean,
        for_conversations = (v_proposed ->> 'for_conversations')::boolean,
        approval_status = 'approved', pending_edit = NULL, edit_status = NULL,
        decided_by = v_uid, decided_at = now(), decision_note = v_note
       WHERE id = tg.id;
    ELSIF v_new THEN
      UPDATE tags SET approval_status = 'rejected',
             decided_by = v_uid, decided_at = now(), decision_note = v_note
       WHERE id = tg.id;
    ELSE
      UPDATE tags SET edit_status = 'rejected',
             decided_by = v_uid, decided_at = now(), decision_note = v_note
       WHERE id = tg.id;
    END IF;
    v_kind := approvals_tag_kind(v_proposed);

  ELSIF p_entity_type = 'snippet' THEN
    SELECT * INTO sn FROM quick_replies
     WHERE id = p_id AND account_id = v_acct AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
    END IF;
    v_new := sn.approval_status <> 'approved';
    IF (v_new AND sn.approval_status <> 'pending')
       OR (NOT v_new AND (sn.edit_status IS DISTINCT FROM 'pending' OR sn.pending_edit IS NULL)) THEN
      RAISE EXCEPTION 'not_pending' USING ERRCODE = 'P0001';
    END IF;
    IF sn.proposed_by IS NOT DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'own_proposal' USING ERRCODE = '42501';
    END IF;

    v_live     := approvals_snippet_values(sn);
    v_proposed := CASE WHEN v_new THEN v_live ELSE v_live || sn.pending_edit END;
    v_proposer := sn.proposed_by;
    v_proposed_at := sn.proposed_at;
    v_title    := sn.title;
    v_type_label := 'snippet';

    IF v_approve THEN
      v_clean := approvals_clean_snippet_patch(p_edited);
      v_proposed := v_proposed || v_clean;
      IF v_proposed ->> 'kind' = 'text' THEN
        v_proposed := v_proposed || jsonb_build_object('interactive_payload', NULL);
      ELSE
        v_proposed := v_proposed || jsonb_build_object('content_text', NULL);
      END IF;
      PERFORM approvals_check_snippet(v_proposed);
      UPDATE quick_replies SET
        title = v_proposed ->> 'title', kind = v_proposed ->> 'kind',
        content_text = v_proposed ->> 'content_text',
        interactive_payload = NULLIF(v_proposed -> 'interactive_payload', 'null'::jsonb),
        approval_status = 'approved', pending_edit = NULL, edit_status = NULL,
        decided_by = v_uid, decided_at = now(), decision_note = v_note
       WHERE id = sn.id;
    ELSIF v_new THEN
      UPDATE quick_replies SET approval_status = 'rejected',
             decided_by = v_uid, decided_at = now(), decision_note = v_note
       WHERE id = sn.id;
    ELSE
      UPDATE quick_replies SET edit_status = 'rejected',
             decided_by = v_uid, decided_at = now(), decision_note = v_note
       WHERE id = sn.id;
    END IF;
    v_kind := v_proposed ->> 'kind';
  ELSE
    PERFORM set_config('vircle.approval_rpc', 'off', true);
    PERFORM set_config('vircle.audit_skip', 'off', true);
    RAISE EXCEPTION 'Unknown item type: %', p_entity_type USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('vircle.approval_rpc', 'off', true);
  PERFORM set_config('vircle.audit_skip', 'off', true);

  v_summary := jsonb_build_object(
    'proposal', CASE WHEN v_new THEN 'new' ELSE 'edit' END,
    'kind', v_kind,
    'proposer_id', v_proposer,
    'proposer_name', approvals_person(v_proposer),
    'proposed_at', v_proposed_at,
    'note', v_note,
    'edited', p_edited IS NOT NULL AND p_edited <> '{}'::jsonb AND v_approve,
    'current', CASE WHEN v_new THEN NULL ELSE v_live END,
    'proposed', v_proposed);
  PERFORM log_audit(v_acct, CASE WHEN v_approve THEN 'approved' ELSE 'rejected' END,
                    p_entity_type, p_id, v_title, v_summary);

  PERFORM approvals_notify_proposer(v_acct, v_uid, v_proposer,
    CASE WHEN v_approve THEN 'Your ' || v_type_label || ' was approved'
         ELSE 'Your ' || v_type_label || ' was rejected' END,
    '"' || COALESCE(v_proposed ->> 'name', v_proposed ->> 'title', v_title) || '"'
      || CASE WHEN v_note IS NOT NULL THEN ': ' || v_note ELSE '' END);

  RETURN jsonb_build_object('decision', p_decision, 'mode', CASE WHEN v_new THEN 'new' ELSE 'edit' END);
END;
$$;

-- ------------------------------------------------------------
-- approvals_pending_count() — the badge. 0 for anyone without
-- approvals.review.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approvals_pending_count()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct UUID;
  v_n    INTEGER;
BEGIN
  SELECT account_id INTO v_acct FROM profiles WHERE user_id = auth.uid();
  IF v_acct IS NULL OR NOT has_capability(v_acct, 'approvals.review') THEN
    RETURN 0;
  END IF;

  SELECT
    (SELECT count(*) FROM tags t
      WHERE t.account_id = v_acct AND t.deleted_at IS NULL
        AND (t.approval_status = 'pending'
             OR (t.approval_status = 'approved' AND t.edit_status = 'pending' AND t.pending_edit IS NOT NULL)))
  + (SELECT count(*) FROM quick_replies q
      WHERE q.account_id = v_acct AND q.deleted_at IS NULL
        AND (q.approval_status = 'pending'
             OR (q.approval_status = 'approved' AND q.edit_status = 'pending' AND q.pending_edit IS NOT NULL)))
  + (SELECT count(*) FROM ai_knowledge_documents d
       JOIN profiles p ON p.user_id = d.created_by AND p.account_id = d.account_id
      WHERE d.account_id = v_acct AND d.status = 'draft' AND d.deleted_at IS NULL
        AND btrim(d.content) <> ''
        AND NOT effective_capability(p.account_id, p.account_role, 'knowledge.publish'))
  INTO v_n;
  RETURN COALESCE(v_n, 0);
END;
$$;

-- ------------------------------------------------------------
-- approvals_list(tab, type, proposer, since, limit)
--   tab 'pending': everything waiting for a decision (live tables)
--   tab 'decided': approvals and rejections of the last 90 days (audit log)
--   type 'tag' | 'label' | 'snippet' | 'article' (a tag used both ways
--   matches tag and label)
-- One jsonb array; each element carries current (null for a creation) and
-- proposed values so the screen can draw Current vs Proposed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approvals_list(
  p_tab      text        DEFAULT 'pending',
  p_type     text        DEFAULT NULL,
  p_proposer uuid        DEFAULT NULL,
  p_since    timestamptz DEFAULT NULL,
  p_limit    integer     DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct  UUID := approvals_caller();
  v_limit INTEGER := GREATEST(LEAST(COALESCE(p_limit, 200), 500), 1);
  v_since TIMESTAMPTZ := GREATEST(COALESCE(p_since, now() - interval '90 days'), now() - interval '90 days');
  v_out   JSONB;
BEGIN
  IF NOT has_capability(v_acct, 'approvals.review') THEN
    RAISE EXCEPTION 'This action requires the ''approvals.review'' permission' USING ERRCODE = '42501';
  END IF;
  IF p_type IS NOT NULL AND p_type NOT IN ('tag', 'label', 'snippet', 'article') THEN
    RAISE EXCEPTION 'invalid_type' USING ERRCODE = '22023';
  END IF;

  IF p_tab = 'decided' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY (item ->> 'decided_at') DESC), '[]'::jsonb) INTO v_out
      FROM (
        SELECT jsonb_build_object(
                 'entity_type', l.entity_type,
                 'entity_id', l.entity_id,
                 'action', COALESCE(l.summary ->> 'proposal', 'new'),
                 'kind', l.summary ->> 'kind',
                 'title', l.entity_label,
                 'status', CASE l.action WHEN 'approved' THEN 'approved' ELSE 'rejected' END,
                 'proposer_id', l.summary ->> 'proposer_id',
                 'proposer_name', l.summary ->> 'proposer_name',
                 'proposed_at', l.summary ->> 'proposed_at',
                 'current', l.summary -> 'current',
                 'proposed', l.summary -> 'proposed',
                 'decided_by', l.actor_id,
                 'decided_by_name', l.actor_label,
                 'decided_at', l.created_at,
                 'decision_note', l.summary ->> 'note') AS item
          FROM audit_log l
         WHERE l.account_id = v_acct
           AND l.action IN ('approved', 'rejected')
           AND l.entity_type IN ('tag', 'snippet', 'article')
           AND l.summary ? 'proposal'
           AND l.created_at >= v_since
           AND (p_proposer IS NULL OR l.summary ->> 'proposer_id' = p_proposer::text)
           AND (p_type IS NULL
                OR (p_type = 'snippet' AND l.entity_type = 'snippet')
                OR (p_type = 'article' AND l.entity_type = 'article')
                OR (p_type = 'tag'    AND l.entity_type = 'tag' AND l.summary ->> 'kind' IN ('tag', 'both'))
                OR (p_type = 'label'  AND l.entity_type = 'tag' AND l.summary ->> 'kind' IN ('label', 'both')))
         ORDER BY l.created_at DESC
         LIMIT v_limit
      ) x;
    RETURN v_out;
  END IF;

  SELECT COALESCE(jsonb_agg(item ORDER BY (item ->> 'proposed_at') ASC), '[]'::jsonb) INTO v_out
    FROM (
      SELECT * FROM (
        -- tags and labels
        SELECT jsonb_build_object(
                 'entity_type', 'tag',
                 'entity_id', t.id,
                 'action', CASE WHEN t.approval_status = 'pending' THEN 'new' ELSE 'edit' END,
                 'kind', approvals_tag_kind(CASE WHEN t.approval_status = 'pending'
                                                 THEN approvals_tag_values(t)
                                                 ELSE approvals_tag_values(t) || t.pending_edit END),
                 'title', t.name,
                 'status', 'pending',
                 'proposer_id', t.proposed_by,
                 'proposer_name', approvals_person(t.proposed_by),
                 'proposed_at', t.proposed_at,
                 'current', CASE WHEN t.approval_status = 'pending' THEN NULL ELSE approvals_tag_values(t) END,
                 'proposed', CASE WHEN t.approval_status = 'pending'
                                  THEN approvals_tag_values(t)
                                  ELSE approvals_tag_values(t) || t.pending_edit END,
                 'changed', CASE WHEN t.approval_status = 'pending' THEN NULL
                                 ELSE (SELECT jsonb_agg(k) FROM jsonb_object_keys(t.pending_edit) AS k) END
               ) AS item
          FROM tags t
         WHERE t.account_id = v_acct AND t.deleted_at IS NULL
           AND (t.approval_status = 'pending'
                OR (t.approval_status = 'approved' AND t.edit_status = 'pending' AND t.pending_edit IS NOT NULL))
           AND (p_proposer IS NULL OR t.proposed_by = p_proposer)
           AND (p_type IS NULL OR p_type IN ('tag', 'label'))
        UNION ALL
        -- snippets
        SELECT jsonb_build_object(
                 'entity_type', 'snippet',
                 'entity_id', q.id,
                 'action', CASE WHEN q.approval_status = 'pending' THEN 'new' ELSE 'edit' END,
                 'kind', CASE WHEN q.approval_status = 'pending' THEN q.kind
                              ELSE COALESCE(q.pending_edit ->> 'kind', q.kind) END,
                 'title', q.title,
                 'status', 'pending',
                 'proposer_id', q.proposed_by,
                 'proposer_name', approvals_person(q.proposed_by),
                 'proposed_at', q.proposed_at,
                 'current', CASE WHEN q.approval_status = 'pending' THEN NULL ELSE approvals_snippet_values(q) END,
                 'proposed', CASE WHEN q.approval_status = 'pending'
                                  THEN approvals_snippet_values(q)
                                  ELSE approvals_snippet_values(q) || q.pending_edit END,
                 'changed', CASE WHEN q.approval_status = 'pending' THEN NULL
                                 ELSE (SELECT jsonb_agg(k) FROM jsonb_object_keys(q.pending_edit) AS k) END
               ) AS item
          FROM quick_replies q
         WHERE q.account_id = v_acct AND q.deleted_at IS NULL
           AND (q.approval_status = 'pending'
                OR (q.approval_status = 'approved' AND q.edit_status = 'pending' AND q.pending_edit IS NOT NULL))
           AND (p_proposer IS NULL OR q.proposed_by = p_proposer)
           AND (p_type IS NULL OR p_type = 'snippet')
        UNION ALL
        -- knowledge drafts written by people who cannot publish
        SELECT jsonb_build_object(
                 'entity_type', 'article',
                 'entity_id', d.id,
                 'action', 'new',
                 'kind', 'article',
                 'title', d.title,
                 'status', 'pending',
                 'proposer_id', d.created_by,
                 'proposer_name', approvals_person(d.created_by),
                 'proposed_at', d.updated_at,
                 'language', d.language,
                 'current', NULL,
                 'proposed', jsonb_build_object('title', d.title, 'language', d.language,
                                                'content_text', left(d.content, 600)),
                 'changed', NULL
               ) AS item
          FROM ai_knowledge_documents d
          JOIN profiles p ON p.user_id = d.created_by AND p.account_id = d.account_id
         WHERE d.account_id = v_acct AND d.status = 'draft' AND d.deleted_at IS NULL
           AND btrim(d.content) <> ''
           AND NOT effective_capability(p.account_id, p.account_role, 'knowledge.publish')
           AND (p_proposer IS NULL OR d.created_by = p_proposer)
           AND (p_type IS NULL OR p_type = 'article')
      ) u
      WHERE p_type IS NULL
         OR p_type IN ('snippet', 'article')
         OR (p_type = 'tag'   AND u.item ->> 'kind' IN ('tag', 'both'))
         OR (p_type = 'label' AND u.item ->> 'kind' IN ('label', 'both'))
      ORDER BY (u.item ->> 'proposed_at') ASC
      LIMIT v_limit
    ) x;
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.propose_tag(text, text, text, text, boolean)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.propose_tag_edit(uuid, jsonb)                     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.propose_snippet(text, text, text, jsonb)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.propose_snippet_edit(uuid, jsonb)                 FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.withdraw_proposal(text, uuid)                     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_proposal(text, uuid, text, text, jsonb)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approvals_pending_count()                         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approvals_list(text, text, uuid, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propose_tag(text, text, text, text, boolean)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_tag_edit(uuid, jsonb)                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_snippet(text, text, text, jsonb)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.propose_snippet_edit(uuid, jsonb)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_proposal(text, uuid)                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_proposal(text, uuid, text, text, jsonb)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.approvals_pending_count()                         TO authenticated;
GRANT EXECUTE ON FUNCTION public.approvals_list(text, text, uuid, timestamptz, integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
