-- ============================================================
-- 088_access_control_phase5.sql — Editable role capabilities, phase 5:
-- database enforcement for every capability that guards data.
--
-- Until now only 12 of the capabilities were enforced by the database
-- (079, 082, 084, 086). The other tables were written straight from the
-- browser under the OLD role floor (is_account_member(account_id,
-- 'agent' | 'admin')), so removing such a capability blocked the app and
-- the API but not a person calling the database with their own login, and a
-- capability could not be granted BELOW the old floor. This migration moves
-- every remaining write policy onto the capability catalogue, so each
-- switch on Settings > Roles & permissions is real.
--
-- Defaults are unchanged: every capability's default roles equal the old
-- floor of the policies it now guards (a test proves it), so nothing changes
-- until an Owner or Admin edits the matrix.
--
-- What this migration does
--   1. capability_account_ids(cap)      — the accounts in which the caller
--                                         holds a capability. Policies test
--                                         `account_id = ANY ((SELECT
--                                         capability_account_ids('k'))::uuid[])`:
--                                         the sub-select does not depend on the
--                                         row, so Postgres evaluates it ONCE per
--                                         statement (an InitPlan) instead of
--                                         once per row (has_capability() per
--                                         row was 3x slower than the old floor
--                                         on bulk writes; this is as fast or
--                                         faster: docs/access-control-enforcement.md).
--   2. Catalogue: enforced_by = 'database' and min_grant_role = 'agent' for
--      every capability now enforced here, so it can be granted to a role
--      below its old floor (a Viewer still cannot hold a write capability).
--   3. About 104 write policies on 38 tables now call the helper (see the
--      section headers), split into INSERT / UPDATE / DELETE where the old
--      rule was one ALL policy. SELECT policies are untouched.
--   4. Two guard triggers for tables whose columns belong to different
--      capabilities: accounts (settings.workspace, tickets.configure-form,
--      tags.manage) and conversations (a sender may only touch the activity
--      columns, assigning / closing / prioritising needs conversations.manage).
--   5. close_conversation_with_note, reopen_conversation and
--      next_ticket_number check the capability, not the role.
--   6. pending_edit (084, decision 3) moves out of the live rows of tags and
--      quick_replies into approval_pending_edits, readable only by the
--      proposer and by approvals.review holders; the approval RPCs are
--      rewritten for it and the column is dropped.
--
-- Left on a role floor ON PURPOSE (and listed in the docs and the verify
-- script's allow-list): removing someone ELSE's contact note and someone
-- else's ticket attachment stay with admins.
--
-- Does not depend on 086 (ticket SLA) or 087 (Jira depth): their new tables
-- already write through has_capability() (sla.configure) or have no client
-- write policy at all (Jira).
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Helper: the accounts in which the caller holds a capability
--    (an empty array for no session, an unknown capability, or a
--    non-member; one element in practice, a profile belongs to one account)
-- ------------------------------------------------------------
-- One query, no nested function calls: the same rule as effective_capability(),
-- inlined. Owner => true; else the account's override, else the default; a GRANT
-- override for a role below the capability's min_grant_role is ignored.
-- account_role_enum sorts from the highest rank down (owner, admin, agent,
-- viewer), so "below" is `>`. The verify script proves it agrees with
-- effective_capability() for every capability, role and override state.
--
-- plpgsql, not sql, on purpose: a SQL function is re-planned in every statement
-- that calls it (an InitPlan gets a fresh call site each time), a plpgsql one
-- keeps its plan for the whole session. Measured on a single-row UPDATE that
-- was +0.35 ms with the sql version and is noise with this one.
CREATE OR REPLACE FUNCTION public.capability_account_ids(cap text)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT array_agg(p.account_id) INTO v_ids
    FROM profiles p
    JOIN capability_catalogue cc ON cc.capability = cap
   WHERE p.user_id = auth.uid()
     AND (
       p.account_role = 'owner'
       OR COALESCE(
            (SELECT CASE WHEN rc.granted AND p.account_role > cc.min_grant_role THEN NULL
                         ELSE rc.granted END
               FROM role_capabilities rc
              WHERE rc.account_id = p.account_id
                AND rc.role       = p.account_role
                AND rc.capability = cap),
            EXISTS (SELECT 1 FROM role_capability_defaults d
                     WHERE d.role = p.account_role AND d.capability = cap)
          )
     );
  RETURN COALESCE(v_ids, ARRAY[]::uuid[]);
END;
$$;

-- ------------------------------------------------------------
-- 2. Catalogue: database tier, and grantable below the old floor
--    (min_grant_role 'agent' keeps write capabilities away from Viewer).
--    Left on the app tier: menus, reports.view (they show or hide pages),
--    ai.use (the action is a call to the AI provider, made by the server),
--    contacts.merge (runs as a service-role function, no client path) and the
--    three jira.* capabilities (server-side only).
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('messages.send', 'agent', 'database'),
  ('conversations.manage', 'agent', 'database'),
  ('comments.moderate', 'agent', 'database'),
  ('comments.delete', 'agent', 'database'),
  ('inbox.shared-views', 'agent', 'database'),
  ('contacts.edit', 'agent', 'database'),
  ('deals.manage', 'agent', 'database'),
  ('pipelines.configure', 'agent', 'database'),
  ('broadcasts.send', 'agent', 'database'),
  ('automations.manage', 'agent', 'database'),
  ('flows.manage', 'agent', 'database'),
  ('tickets.work', 'agent', 'database'),
  ('tickets.delete', 'agent', 'database'),
  ('tickets.configure-form', 'agent', 'database'),
  ('tags.manage', 'agent', 'database'),
  ('knowledge.draft', 'agent', 'database'),
  ('knowledge.publish', 'agent', 'database'),
  ('knowledge.manage', 'agent', 'database'),
  ('settings.workspace', 'agent', 'database'),
  ('members.invite', 'agent', 'database'),
  ('teams.manage', 'agent', 'database')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

-- ------------------------------------------------------------
-- 3. Write policies. Each one keeps its old shape (own-row rules, draft
--    rules, the ticket link count, ...) and swaps the role floor for the
--    capability. SELECT policies, the widget visitor policies and the
--    soft-delete / approval visibility rules are not touched.
-- ------------------------------------------------------------

DROP POLICY IF EXISTS pipelines_insert ON public.pipelines;
DROP POLICY IF EXISTS pipelines_update ON public.pipelines;
DROP POLICY IF EXISTS pipelines_delete ON public.pipelines;
CREATE POLICY pipelines_insert ON public.pipelines
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('pipelines.configure'))::uuid[])
  );
CREATE POLICY pipelines_update ON public.pipelines
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('pipelines.configure'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('pipelines.configure'))::uuid[])
  );
CREATE POLICY pipelines_delete ON public.pipelines
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('pipelines.configure'))::uuid[])
  );

DROP POLICY IF EXISTS pipeline_stages_modify ON public.pipeline_stages;
DROP POLICY IF EXISTS pipeline_stages_insert ON public.pipeline_stages;
DROP POLICY IF EXISTS pipeline_stages_update ON public.pipeline_stages;
DROP POLICY IF EXISTS pipeline_stages_delete ON public.pipeline_stages;
CREATE POLICY pipeline_stages_insert ON public.pipeline_stages
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM pipelines p
       WHERE p.id = pipeline_stages.pipeline_id
         AND p.account_id = ANY ((SELECT public.capability_account_ids('pipelines.configure'))::uuid[])
    )
  );
CREATE POLICY pipeline_stages_update ON public.pipeline_stages
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM pipelines p
       WHERE p.id = pipeline_stages.pipeline_id
         AND p.account_id = ANY ((SELECT public.capability_account_ids('pipelines.configure'))::uuid[])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM pipelines p
       WHERE p.id = pipeline_stages.pipeline_id
         AND p.account_id = ANY ((SELECT public.capability_account_ids('pipelines.configure'))::uuid[])
    )
  );
CREATE POLICY pipeline_stages_delete ON public.pipeline_stages
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM pipelines p
       WHERE p.id = pipeline_stages.pipeline_id
         AND p.account_id = ANY ((SELECT public.capability_account_ids('pipelines.configure'))::uuid[])
    )
  );

DROP POLICY IF EXISTS custom_fields_insert ON public.custom_fields;
DROP POLICY IF EXISTS custom_fields_update ON public.custom_fields;
DROP POLICY IF EXISTS custom_fields_delete ON public.custom_fields;
CREATE POLICY custom_fields_insert ON public.custom_fields
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('settings.workspace'))::uuid[])
  );
CREATE POLICY custom_fields_update ON public.custom_fields
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('settings.workspace'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('settings.workspace'))::uuid[])
  );
CREATE POLICY custom_fields_delete ON public.custom_fields
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('settings.workspace'))::uuid[])
  );

DROP POLICY IF EXISTS ticket_field_definitions_insert ON public.ticket_field_definitions;
DROP POLICY IF EXISTS ticket_field_definitions_update ON public.ticket_field_definitions;
DROP POLICY IF EXISTS ticket_field_definitions_delete ON public.ticket_field_definitions;
DROP POLICY IF EXISTS ticket_field_defs_insert ON public.ticket_field_definitions;
DROP POLICY IF EXISTS ticket_field_defs_update ON public.ticket_field_definitions;
DROP POLICY IF EXISTS ticket_field_defs_delete ON public.ticket_field_definitions;
CREATE POLICY ticket_field_defs_insert ON public.ticket_field_definitions
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.configure-form'))::uuid[])
  );
CREATE POLICY ticket_field_defs_update ON public.ticket_field_definitions
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.configure-form'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.configure-form'))::uuid[])
  );
CREATE POLICY ticket_field_defs_delete ON public.ticket_field_definitions
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.configure-form'))::uuid[])
  );

DROP POLICY IF EXISTS auto_label_rules_insert ON public.auto_label_rules;
DROP POLICY IF EXISTS auto_label_rules_update ON public.auto_label_rules;
DROP POLICY IF EXISTS auto_label_rules_delete ON public.auto_label_rules;
CREATE POLICY auto_label_rules_insert ON public.auto_label_rules
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('tags.manage'))::uuid[])
  );
CREATE POLICY auto_label_rules_update ON public.auto_label_rules
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('tags.manage'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('tags.manage'))::uuid[])
  );
CREATE POLICY auto_label_rules_delete ON public.auto_label_rules
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('tags.manage'))::uuid[])
  );

-- Personal views (owner_id = the caller) need conversations.manage to create; shared
-- views (owner_id NULL) need inbox.shared-views. Changing or removing your OWN
-- personal view stays open to the owner (own-row clean-up), as before.
DROP POLICY IF EXISTS inbox_views_insert ON public.inbox_views;
DROP POLICY IF EXISTS inbox_views_update ON public.inbox_views;
DROP POLICY IF EXISTS inbox_views_delete ON public.inbox_views;
CREATE POLICY inbox_views_insert ON public.inbox_views
  FOR INSERT
  WITH CHECK (
    ((owner_id = auth.uid()
    AND account_id = ANY ((SELECT public.capability_account_ids('conversations.manage'))::uuid[]))
    OR (owner_id IS NULL
    AND account_id = ANY ((SELECT public.capability_account_ids('inbox.shared-views'))::uuid[])))
  );
CREATE POLICY inbox_views_update ON public.inbox_views
  FOR UPDATE
  USING (
    ((public.is_account_member(account_id)
    AND owner_id = auth.uid())
    OR (owner_id IS NULL
    AND account_id = ANY ((SELECT public.capability_account_ids('inbox.shared-views'))::uuid[])))
  )
  WITH CHECK (
    ((public.is_account_member(account_id)
    AND owner_id = auth.uid())
    OR (owner_id IS NULL
    AND account_id = ANY ((SELECT public.capability_account_ids('inbox.shared-views'))::uuid[])))
  );
CREATE POLICY inbox_views_delete ON public.inbox_views
  FOR DELETE
  USING (
    ((public.is_account_member(account_id)
    AND owner_id = auth.uid())
    OR (owner_id IS NULL
    AND account_id = ANY ((SELECT public.capability_account_ids('inbox.shared-views'))::uuid[])))
  );

DROP POLICY IF EXISTS knowledge_collections_insert ON public.knowledge_collections;
DROP POLICY IF EXISTS knowledge_collections_update ON public.knowledge_collections;
DROP POLICY IF EXISTS knowledge_collections_delete ON public.knowledge_collections;
CREATE POLICY knowledge_collections_insert ON public.knowledge_collections
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('knowledge.manage'))::uuid[])
  );
CREATE POLICY knowledge_collections_update ON public.knowledge_collections
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('knowledge.manage'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('knowledge.manage'))::uuid[])
  );
CREATE POLICY knowledge_collections_delete ON public.knowledge_collections
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('knowledge.manage'))::uuid[])
  );

DROP POLICY IF EXISTS knowledge_sources_insert ON public.knowledge_sources;
DROP POLICY IF EXISTS knowledge_sources_update ON public.knowledge_sources;
DROP POLICY IF EXISTS knowledge_sources_delete ON public.knowledge_sources;
CREATE POLICY knowledge_sources_insert ON public.knowledge_sources
  FOR INSERT
  WITH CHECK (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[])))
  );
CREATE POLICY knowledge_sources_update ON public.knowledge_sources
  FOR UPDATE
  USING (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[])))
  )
  WITH CHECK (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[])))
  );
CREATE POLICY knowledge_sources_delete ON public.knowledge_sources
  FOR DELETE
  USING (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.manage'))::uuid[])))
  );

DROP POLICY IF EXISTS ai_knowledge_chunks_insert ON public.ai_knowledge_chunks;
DROP POLICY IF EXISTS ai_knowledge_chunks_update ON public.ai_knowledge_chunks;
DROP POLICY IF EXISTS ai_knowledge_chunks_delete ON public.ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_insert ON public.ai_knowledge_chunks
  FOR INSERT
  WITH CHECK (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.manage'))::uuid[])))
  );
CREATE POLICY ai_knowledge_chunks_update ON public.ai_knowledge_chunks
  FOR UPDATE
  USING (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.manage'))::uuid[])))
  )
  WITH CHECK (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.manage'))::uuid[])))
  );
CREATE POLICY ai_knowledge_chunks_delete ON public.ai_knowledge_chunks
  FOR DELETE
  USING (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.manage'))::uuid[])))
  );

DROP POLICY IF EXISTS ai_knowledge_documents_insert ON public.ai_knowledge_documents;
DROP POLICY IF EXISTS ai_knowledge_documents_update ON public.ai_knowledge_documents;
DROP POLICY IF EXISTS ai_knowledge_documents_delete ON public.ai_knowledge_documents;
CREATE POLICY ai_knowledge_documents_insert ON public.ai_knowledge_documents
  FOR INSERT
  WITH CHECK (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[])
    AND status = 'draft'))
  );
CREATE POLICY ai_knowledge_documents_update ON public.ai_knowledge_documents
  FOR UPDATE
  USING (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[])
    AND created_by = auth.uid()
    AND status = 'draft'))
  )
  WITH CHECK (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[])
    AND created_by = auth.uid()
    AND status = 'draft'))
  );
CREATE POLICY ai_knowledge_documents_delete ON public.ai_knowledge_documents
  FOR DELETE
  USING (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[])
    AND created_by = auth.uid()
    AND status = 'draft'))
  );

DROP POLICY IF EXISTS knowledge_attachments_insert ON public.knowledge_attachments;
DROP POLICY IF EXISTS knowledge_attachments_update ON public.knowledge_attachments;
DROP POLICY IF EXISTS knowledge_attachments_delete ON public.knowledge_attachments;
CREATE POLICY knowledge_attachments_insert ON public.knowledge_attachments
  FOR INSERT
  WITH CHECK (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[])
    AND EXISTS (
        SELECT 1 FROM ai_knowledge_documents d
         WHERE d.id = knowledge_attachments.document_id
           AND d.account_id = knowledge_attachments.account_id
           AND d.created_by = auth.uid()
           AND d.status = 'draft'
      )))
  );
CREATE POLICY knowledge_attachments_update ON public.knowledge_attachments
  FOR UPDATE
  USING (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[])
    AND EXISTS (
        SELECT 1 FROM ai_knowledge_documents d
         WHERE d.id = knowledge_attachments.document_id
           AND d.created_by = auth.uid()
           AND d.status = 'draft'
      )))
  )
  WITH CHECK (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[])
    AND EXISTS (
        SELECT 1 FROM ai_knowledge_documents d
         WHERE d.id = knowledge_attachments.document_id
           AND d.account_id = knowledge_attachments.account_id
           AND d.created_by = auth.uid()
           AND d.status = 'draft'
      )))
  );
CREATE POLICY knowledge_attachments_delete ON public.knowledge_attachments
  FOR DELETE
  USING (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[])
    AND EXISTS (
        SELECT 1 FROM ai_knowledge_documents d
         WHERE d.id = knowledge_attachments.document_id
           AND d.created_by = auth.uid()
           AND d.status = 'draft'
      )))
  );

DROP POLICY IF EXISTS knowledge_gaps_update ON public.knowledge_gaps;
CREATE POLICY knowledge_gaps_update ON public.knowledge_gaps
  FOR UPDATE
  USING (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[])))
  )
  WITH CHECK (
    ((account_id = ANY ((SELECT public.capability_account_ids('knowledge.draft'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('knowledge.publish'))::uuid[])))
  );

DROP POLICY IF EXISTS automations_insert ON public.automations;
DROP POLICY IF EXISTS automations_update ON public.automations;
DROP POLICY IF EXISTS automations_delete ON public.automations;
CREATE POLICY automations_insert ON public.automations
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('automations.manage'))::uuid[])
  );
CREATE POLICY automations_update ON public.automations
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('automations.manage'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('automations.manage'))::uuid[])
  );
CREATE POLICY automations_delete ON public.automations
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('automations.manage'))::uuid[])
  );

DROP POLICY IF EXISTS automation_steps_modify ON public.automation_steps;
DROP POLICY IF EXISTS automation_steps_insert ON public.automation_steps;
DROP POLICY IF EXISTS automation_steps_update ON public.automation_steps;
DROP POLICY IF EXISTS automation_steps_delete ON public.automation_steps;
CREATE POLICY automation_steps_insert ON public.automation_steps
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM automations a
       WHERE a.id = automation_steps.automation_id
         AND a.account_id = ANY ((SELECT public.capability_account_ids('automations.manage'))::uuid[])
    )
  );
CREATE POLICY automation_steps_update ON public.automation_steps
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM automations a
       WHERE a.id = automation_steps.automation_id
         AND a.account_id = ANY ((SELECT public.capability_account_ids('automations.manage'))::uuid[])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM automations a
       WHERE a.id = automation_steps.automation_id
         AND a.account_id = ANY ((SELECT public.capability_account_ids('automations.manage'))::uuid[])
    )
  );
CREATE POLICY automation_steps_delete ON public.automation_steps
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM automations a
       WHERE a.id = automation_steps.automation_id
         AND a.account_id = ANY ((SELECT public.capability_account_ids('automations.manage'))::uuid[])
    )
  );

DROP POLICY IF EXISTS flows_insert ON public.flows;
DROP POLICY IF EXISTS flows_update ON public.flows;
DROP POLICY IF EXISTS flows_delete ON public.flows;
CREATE POLICY flows_insert ON public.flows
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('flows.manage'))::uuid[])
  );
CREATE POLICY flows_update ON public.flows
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('flows.manage'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('flows.manage'))::uuid[])
  );
CREATE POLICY flows_delete ON public.flows
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('flows.manage'))::uuid[])
  );

DROP POLICY IF EXISTS flow_nodes_modify ON public.flow_nodes;
DROP POLICY IF EXISTS flow_nodes_insert ON public.flow_nodes;
DROP POLICY IF EXISTS flow_nodes_update ON public.flow_nodes;
DROP POLICY IF EXISTS flow_nodes_delete ON public.flow_nodes;
CREATE POLICY flow_nodes_insert ON public.flow_nodes
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM flows f
       WHERE f.id = flow_nodes.flow_id
         AND f.account_id = ANY ((SELECT public.capability_account_ids('flows.manage'))::uuid[])
    )
  );
CREATE POLICY flow_nodes_update ON public.flow_nodes
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM flows f
       WHERE f.id = flow_nodes.flow_id
         AND f.account_id = ANY ((SELECT public.capability_account_ids('flows.manage'))::uuid[])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM flows f
       WHERE f.id = flow_nodes.flow_id
         AND f.account_id = ANY ((SELECT public.capability_account_ids('flows.manage'))::uuid[])
    )
  );
CREATE POLICY flow_nodes_delete ON public.flow_nodes
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM flows f
       WHERE f.id = flow_nodes.flow_id
         AND f.account_id = ANY ((SELECT public.capability_account_ids('flows.manage'))::uuid[])
    )
  );

DROP POLICY IF EXISTS teams_insert ON public.teams;
DROP POLICY IF EXISTS teams_update ON public.teams;
DROP POLICY IF EXISTS teams_delete ON public.teams;
CREATE POLICY teams_insert ON public.teams
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('teams.manage'))::uuid[])
  );
CREATE POLICY teams_update ON public.teams
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('teams.manage'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('teams.manage'))::uuid[])
  );
CREATE POLICY teams_delete ON public.teams
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('teams.manage'))::uuid[])
  );

DROP POLICY IF EXISTS team_members_modify ON public.team_members;
DROP POLICY IF EXISTS team_members_insert ON public.team_members;
DROP POLICY IF EXISTS team_members_update ON public.team_members;
DROP POLICY IF EXISTS team_members_delete ON public.team_members;
CREATE POLICY team_members_insert ON public.team_members
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM teams tm
       WHERE tm.id = team_members.team_id
         AND tm.account_id = ANY ((SELECT public.capability_account_ids('teams.manage'))::uuid[])
    )
  );
CREATE POLICY team_members_update ON public.team_members
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM teams tm
       WHERE tm.id = team_members.team_id
         AND tm.account_id = ANY ((SELECT public.capability_account_ids('teams.manage'))::uuid[])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM teams tm
       WHERE tm.id = team_members.team_id
         AND tm.account_id = ANY ((SELECT public.capability_account_ids('teams.manage'))::uuid[])
    )
  );
CREATE POLICY team_members_delete ON public.team_members
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM teams tm
       WHERE tm.id = team_members.team_id
         AND tm.account_id = ANY ((SELECT public.capability_account_ids('teams.manage'))::uuid[])
    )
  );

-- Invitations: the list (token hashes) and every write need members.invite. The
-- before-insert trigger from 079/083 still limits the role to below the inviter's own.
DROP POLICY IF EXISTS account_invitations_modify ON public.account_invitations;
DROP POLICY IF EXISTS account_invitations_select ON public.account_invitations;
DROP POLICY IF EXISTS account_invitations_insert ON public.account_invitations;
DROP POLICY IF EXISTS account_invitations_update ON public.account_invitations;
DROP POLICY IF EXISTS account_invitations_delete ON public.account_invitations;
CREATE POLICY account_invitations_select ON public.account_invitations
  FOR SELECT
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('members.invite'))::uuid[])
  );
CREATE POLICY account_invitations_insert ON public.account_invitations
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('members.invite'))::uuid[])
  );
CREATE POLICY account_invitations_update ON public.account_invitations
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('members.invite'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('members.invite'))::uuid[])
  );
CREATE POLICY account_invitations_delete ON public.account_invitations
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('members.invite'))::uuid[])
  );

-- accounts: the row-level rule lets in anyone who holds one of the three
-- capabilities that own a column of the row; accounts_capability_guard (below)
-- then decides per changed column.
DROP POLICY IF EXISTS accounts_update ON public.accounts;
CREATE POLICY accounts_update ON public.accounts
  FOR UPDATE
  USING (
    ((id = ANY ((SELECT public.capability_account_ids('settings.workspace'))::uuid[]))
    OR (id = ANY ((SELECT public.capability_account_ids('tickets.configure-form'))::uuid[]))
    OR (id = ANY ((SELECT public.capability_account_ids('tags.manage'))::uuid[])))
  )
  WITH CHECK (
    ((id = ANY ((SELECT public.capability_account_ids('settings.workspace'))::uuid[]))
    OR (id = ANY ((SELECT public.capability_account_ids('tickets.configure-form'))::uuid[]))
    OR (id = ANY ((SELECT public.capability_account_ids('tags.manage'))::uuid[])))
  );

DROP POLICY IF EXISTS tickets_insert ON public.tickets;
DROP POLICY IF EXISTS tickets_update ON public.tickets;
DROP POLICY IF EXISTS tickets_delete ON public.tickets;
CREATE POLICY tickets_insert ON public.tickets
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
  );
CREATE POLICY tickets_update ON public.tickets
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
  );
CREATE POLICY tickets_delete ON public.tickets
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.delete'))::uuid[])
  );

-- Ticket comments: anyone with tickets.work adds one; only the author edits or
-- removes their own.
DROP POLICY IF EXISTS ticket_comments_insert ON public.ticket_comments;
DROP POLICY IF EXISTS ticket_comments_update ON public.ticket_comments;
DROP POLICY IF EXISTS ticket_comments_delete ON public.ticket_comments;
CREATE POLICY ticket_comments_insert ON public.ticket_comments
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
  );
CREATE POLICY ticket_comments_update ON public.ticket_comments
  FOR UPDATE
  USING (
    author_id = auth.uid()
    AND account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
  )
  WITH CHECK (
    author_id = auth.uid()
    AND account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
  );
CREATE POLICY ticket_comments_delete ON public.ticket_comments
  FOR DELETE
  USING (
    author_id = auth.uid()
    AND account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
  );

DROP POLICY IF EXISTS ticket_links_insert ON public.ticket_links;
DROP POLICY IF EXISTS ticket_links_delete ON public.ticket_links;
CREATE POLICY ticket_links_insert ON public.ticket_links
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
    AND (
      SELECT count(*) FROM tickets t
       WHERE t.id = ANY (ARRAY[ticket_links.from_ticket_id, ticket_links.to_ticket_id])
         AND t.account_id = ticket_links.account_id
    ) = 2
  );
CREATE POLICY ticket_links_delete ON public.ticket_links
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
  );

-- Watching is an own-row rule: you add or remove yourself only.
DROP POLICY IF EXISTS ticket_watchers_insert ON public.ticket_watchers;
DROP POLICY IF EXISTS ticket_watchers_delete ON public.ticket_watchers;
CREATE POLICY ticket_watchers_insert ON public.ticket_watchers
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
  );
CREATE POLICY ticket_watchers_delete ON public.ticket_watchers
  FOR DELETE
  USING (
    user_id = auth.uid()
    AND account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
  );

-- Attachments: tickets.work to add or remove your own; removing someone else's
-- stays with admins (role floor kept on purpose, see docs/access-control-enforcement.md).
DROP POLICY IF EXISTS ticket_attachments_insert ON public.ticket_attachments;
DROP POLICY IF EXISTS ticket_attachments_delete ON public.ticket_attachments;
CREATE POLICY ticket_attachments_insert ON public.ticket_attachments
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
    AND uploaded_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM tickets t
       WHERE t.id = ticket_attachments.ticket_id AND t.account_id = ticket_attachments.account_id
    )
  );
CREATE POLICY ticket_attachments_delete ON public.ticket_attachments
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('tickets.work'))::uuid[])
    AND ((uploaded_by = auth.uid())
    OR (public.is_account_member(account_id, 'admin'::account_role_enum)))
  );

DROP POLICY IF EXISTS deals_insert ON public.deals;
DROP POLICY IF EXISTS deals_update ON public.deals;
DROP POLICY IF EXISTS deals_delete ON public.deals;
CREATE POLICY deals_insert ON public.deals
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('deals.manage'))::uuid[])
  );
CREATE POLICY deals_update ON public.deals
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('deals.manage'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('deals.manage'))::uuid[])
  );
CREATE POLICY deals_delete ON public.deals
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('deals.manage'))::uuid[])
  );

DROP POLICY IF EXISTS contacts_insert ON public.contacts;
DROP POLICY IF EXISTS contacts_update ON public.contacts;
DROP POLICY IF EXISTS contacts_delete ON public.contacts;
CREATE POLICY contacts_insert ON public.contacts
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
  );
CREATE POLICY contacts_update ON public.contacts
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
  );
CREATE POLICY contacts_delete ON public.contacts
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
  );

-- Notes: contacts.edit to add; edit or remove your own; other people's notes stay
-- with admins (role floor kept on purpose, see docs/access-control-enforcement.md).
DROP POLICY IF EXISTS contact_notes_insert ON public.contact_notes;
DROP POLICY IF EXISTS contact_notes_update ON public.contact_notes;
DROP POLICY IF EXISTS contact_notes_delete ON public.contact_notes;
CREATE POLICY contact_notes_insert ON public.contact_notes
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
  );
CREATE POLICY contact_notes_update ON public.contact_notes
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
    AND ((user_id = auth.uid())
    OR (public.is_account_member(account_id, 'admin'::account_role_enum)))
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
    AND ((user_id = auth.uid())
    OR (public.is_account_member(account_id, 'admin'::account_role_enum)))
  );
CREATE POLICY contact_notes_delete ON public.contact_notes
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
    AND ((user_id = auth.uid())
    OR (public.is_account_member(account_id, 'admin'::account_role_enum)))
  );

DROP POLICY IF EXISTS contact_tags_modify ON public.contact_tags;
DROP POLICY IF EXISTS contact_tags_insert ON public.contact_tags;
DROP POLICY IF EXISTS contact_tags_update ON public.contact_tags;
DROP POLICY IF EXISTS contact_tags_delete ON public.contact_tags;
CREATE POLICY contact_tags_insert ON public.contact_tags
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = contact_tags.contact_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
    )
  );
CREATE POLICY contact_tags_update ON public.contact_tags
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = contact_tags.contact_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = contact_tags.contact_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
    )
  );
CREATE POLICY contact_tags_delete ON public.contact_tags
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = contact_tags.contact_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
    )
  );

DROP POLICY IF EXISTS contact_custom_values_modify ON public.contact_custom_values;
DROP POLICY IF EXISTS contact_custom_values_insert ON public.contact_custom_values;
DROP POLICY IF EXISTS contact_custom_values_update ON public.contact_custom_values;
DROP POLICY IF EXISTS contact_custom_values_delete ON public.contact_custom_values;
CREATE POLICY contact_custom_values_insert ON public.contact_custom_values
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = contact_custom_values.contact_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
    )
  );
CREATE POLICY contact_custom_values_update ON public.contact_custom_values
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = contact_custom_values.contact_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = contact_custom_values.contact_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
    )
  );
CREATE POLICY contact_custom_values_delete ON public.contact_custom_values
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = contact_custom_values.contact_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('contacts.edit'))::uuid[])
    )
  );

DROP POLICY IF EXISTS broadcasts_insert ON public.broadcasts;
DROP POLICY IF EXISTS broadcasts_update ON public.broadcasts;
DROP POLICY IF EXISTS broadcasts_delete ON public.broadcasts;
CREATE POLICY broadcasts_insert ON public.broadcasts
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('broadcasts.send'))::uuid[])
  );
CREATE POLICY broadcasts_update ON public.broadcasts
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('broadcasts.send'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('broadcasts.send'))::uuid[])
  );
CREATE POLICY broadcasts_delete ON public.broadcasts
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('broadcasts.send'))::uuid[])
  );

DROP POLICY IF EXISTS broadcast_recipients_modify ON public.broadcast_recipients;
DROP POLICY IF EXISTS broadcast_recipients_insert ON public.broadcast_recipients;
DROP POLICY IF EXISTS broadcast_recipients_update ON public.broadcast_recipients;
DROP POLICY IF EXISTS broadcast_recipients_delete ON public.broadcast_recipients;
CREATE POLICY broadcast_recipients_insert ON public.broadcast_recipients
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM broadcasts b
       WHERE b.id = broadcast_recipients.broadcast_id
         AND b.account_id = ANY ((SELECT public.capability_account_ids('broadcasts.send'))::uuid[])
    )
  );
CREATE POLICY broadcast_recipients_update ON public.broadcast_recipients
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM broadcasts b
       WHERE b.id = broadcast_recipients.broadcast_id
         AND b.account_id = ANY ((SELECT public.capability_account_ids('broadcasts.send'))::uuid[])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM broadcasts b
       WHERE b.id = broadcast_recipients.broadcast_id
         AND b.account_id = ANY ((SELECT public.capability_account_ids('broadcasts.send'))::uuid[])
    )
  );
CREATE POLICY broadcast_recipients_delete ON public.broadcast_recipients
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM broadcasts b
       WHERE b.id = broadcast_recipients.broadcast_id
         AND b.account_id = ANY ((SELECT public.capability_account_ids('broadcasts.send'))::uuid[])
    )
  );

DROP POLICY IF EXISTS ai_knowledge_citations_insert ON public.ai_knowledge_citations;
CREATE POLICY ai_knowledge_citations_insert ON public.ai_knowledge_citations
  FOR INSERT
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('ai.use'))::uuid[])
  );

-- Conversations. Sending a reply (messages.send) also creates a conversation for a
-- contact and bumps its last-message fields, so that capability may INSERT/UPDATE
-- too, but conversations_capability_guard (below) lets a caller who lacks
-- conversations.manage change the activity columns only.
DROP POLICY IF EXISTS conversations_insert ON public.conversations;
DROP POLICY IF EXISTS conversations_update ON public.conversations;
DROP POLICY IF EXISTS conversations_delete ON public.conversations;
CREATE POLICY conversations_insert ON public.conversations
  FOR INSERT
  WITH CHECK (
    ((account_id = ANY ((SELECT public.capability_account_ids('conversations.manage'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('messages.send'))::uuid[])))
  );
CREATE POLICY conversations_update ON public.conversations
  FOR UPDATE
  USING (
    ((account_id = ANY ((SELECT public.capability_account_ids('conversations.manage'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('messages.send'))::uuid[])))
  )
  WITH CHECK (
    ((account_id = ANY ((SELECT public.capability_account_ids('conversations.manage'))::uuid[]))
    OR (account_id = ANY ((SELECT public.capability_account_ids('messages.send'))::uuid[])))
  );
CREATE POLICY conversations_delete ON public.conversations
  FOR DELETE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('conversations.manage'))::uuid[])
  );

DROP POLICY IF EXISTS conversation_labels_modify ON public.conversation_labels;
DROP POLICY IF EXISTS conversation_labels_insert ON public.conversation_labels;
DROP POLICY IF EXISTS conversation_labels_update ON public.conversation_labels;
DROP POLICY IF EXISTS conversation_labels_delete ON public.conversation_labels;
CREATE POLICY conversation_labels_insert ON public.conversation_labels
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations c
       WHERE c.id = conversation_labels.conversation_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('conversations.manage'))::uuid[])
    )
  );
CREATE POLICY conversation_labels_update ON public.conversation_labels
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
       WHERE c.id = conversation_labels.conversation_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('conversations.manage'))::uuid[])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations c
       WHERE c.id = conversation_labels.conversation_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('conversations.manage'))::uuid[])
    )
  );
CREATE POLICY conversation_labels_delete ON public.conversation_labels
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
       WHERE c.id = conversation_labels.conversation_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('conversations.manage'))::uuid[])
    )
  );

-- Messages: replies need messages.send; internal notes (is_internal) need
-- conversations.manage. Replaces the single ALL policy, so a read no longer
-- evaluates a second write rule.
DROP POLICY IF EXISTS messages_modify ON public.messages;
DROP POLICY IF EXISTS messages_insert ON public.messages;
DROP POLICY IF EXISTS messages_update ON public.messages;
DROP POLICY IF EXISTS messages_delete ON public.messages;
CREATE POLICY messages_insert ON public.messages
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations c
       WHERE c.id = messages.conversation_id
         AND c.account_id = ANY (
               CASE WHEN messages.is_internal IS TRUE
                    THEN (SELECT public.capability_account_ids('conversations.manage'))::uuid[]
                    ELSE (SELECT public.capability_account_ids('messages.send'))::uuid[]
               END)
    )
  );
CREATE POLICY messages_update ON public.messages
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
       WHERE c.id = messages.conversation_id
         AND c.account_id = ANY (
               CASE WHEN messages.is_internal IS TRUE
                    THEN (SELECT public.capability_account_ids('conversations.manage'))::uuid[]
                    ELSE (SELECT public.capability_account_ids('messages.send'))::uuid[]
               END)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations c
       WHERE c.id = messages.conversation_id
         AND c.account_id = ANY (
               CASE WHEN messages.is_internal IS TRUE
                    THEN (SELECT public.capability_account_ids('conversations.manage'))::uuid[]
                    ELSE (SELECT public.capability_account_ids('messages.send'))::uuid[]
               END)
    )
  );
CREATE POLICY messages_delete ON public.messages
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
       WHERE c.id = messages.conversation_id
         AND c.account_id = ANY (
               CASE WHEN messages.is_internal IS TRUE
                    THEN (SELECT public.capability_account_ids('conversations.manage'))::uuid[]
                    ELSE (SELECT public.capability_account_ids('messages.send'))::uuid[]
               END)
    )
  );

DROP POLICY IF EXISTS message_reactions_modify ON public.message_reactions;
DROP POLICY IF EXISTS message_reactions_insert ON public.message_reactions;
DROP POLICY IF EXISTS message_reactions_update ON public.message_reactions;
DROP POLICY IF EXISTS message_reactions_delete ON public.message_reactions;
CREATE POLICY message_reactions_insert ON public.message_reactions
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = message_reactions.message_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('messages.send'))::uuid[])
    )
  );
CREATE POLICY message_reactions_update ON public.message_reactions
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = message_reactions.message_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('messages.send'))::uuid[])
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = message_reactions.message_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('messages.send'))::uuid[])
    )
  );
CREATE POLICY message_reactions_delete ON public.message_reactions
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = message_reactions.message_id
         AND c.account_id = ANY ((SELECT public.capability_account_ids('messages.send'))::uuid[])
    )
  );

-- Comments: moderating (reply, hide, resolve, assign) needs comments.moderate;
-- marking one deleted also needs comments.delete.
DROP POLICY IF EXISTS comments_update ON public.comments;
CREATE POLICY comments_update ON public.comments
  FOR UPDATE
  USING (
    account_id = ANY ((SELECT public.capability_account_ids('comments.moderate'))::uuid[])
  )
  WITH CHECK (
    account_id = ANY ((SELECT public.capability_account_ids('comments.moderate'))::uuid[])
    AND ((status <> 'deleted')
    OR (account_id = ANY ((SELECT public.capability_account_ids('comments.delete'))::uuid[])))
  );


-- ------------------------------------------------------------
-- 4. Guard triggers (column-level rules)
--    Both are SECURITY INVOKER on purpose: current_user is then the
--    caller's database role, so service-role code and SECURITY DEFINER
--    functions (they run as the function owner) are never restricted,
--    only a person calling the database with their own login.
-- ------------------------------------------------------------

-- accounts: one row holds columns owned by different capabilities.
--   ticket_key_prefix     -> tickets.configure-form
--   auto_label_ai_enabled -> tags.manage
--   everything else the app writes (name, default_currency, currencies,
--   sla_response_minutes, status_colors) -> settings.workspace
CREATE OR REPLACE FUNCTION public.accounts_capability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_prefix BOOLEAN;
  v_auto   BOOLEAN;
  v_other  BOOLEAN;
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  v_prefix := NEW.ticket_key_prefix IS DISTINCT FROM OLD.ticket_key_prefix;
  v_auto   := NEW.auto_label_ai_enabled IS DISTINCT FROM OLD.auto_label_ai_enabled;
  v_other  := (to_jsonb(NEW) - 'ticket_key_prefix' - 'auto_label_ai_enabled' - 'updated_at')
              IS DISTINCT FROM
              (to_jsonb(OLD) - 'ticket_key_prefix' - 'auto_label_ai_enabled' - 'updated_at');

  IF v_other AND NOT has_capability(OLD.id, 'settings.workspace') THEN
    RAISE EXCEPTION 'This action requires the ''settings.workspace'' permission'
      USING ERRCODE = '42501';
  END IF;
  IF v_prefix AND NOT has_capability(OLD.id, 'tickets.configure-form') THEN
    RAISE EXCEPTION 'This action requires the ''tickets.configure-form'' permission'
      USING ERRCODE = '42501';
  END IF;
  IF v_auto AND NOT has_capability(OLD.id, 'tags.manage') THEN
    RAISE EXCEPTION 'This action requires the ''tags.manage'' permission'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.accounts_capability_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS accounts_capability_guard ON public.accounts;
CREATE TRIGGER accounts_capability_guard
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.accounts_capability_guard();

-- conversations: replying (messages.send) bumps the last-message fields and
-- may open the conversation for a contact; that is the ONLY thing a caller who
-- lacks conversations.manage may change. Assigning, closing, prioritising and
-- the rest need conversations.manage.
CREATE OR REPLACE FUNCTION public.conversations_capability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_activity CONSTANT text[] := ARRAY[
    'last_message_text', 'last_message_at', 'last_channel_type',
    'awaiting_response', 'updated_at', 'unread_count'
  ];
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - v_activity) IS NOT DISTINCT FROM (to_jsonb(OLD) - v_activity) THEN
    RETURN NEW;
  END IF;
  IF has_capability(OLD.account_id, 'conversations.manage') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'This action requires the ''conversations.manage'' permission'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.conversations_capability_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS conversations_capability_guard ON public.conversations;
CREATE TRIGGER conversations_capability_guard
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_capability_guard();

-- ------------------------------------------------------------
-- 5. Functions that checked a role floor
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_conversation_with_note(p_conversation_id uuid, p_note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT account_id INTO v_account_id FROM conversations WHERE id = p_conversation_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Conversation % not found', p_conversation_id;
  END IF;
  IF auth.uid() IS NOT NULL AND NOT has_capability(v_account_id, 'conversations.manage') THEN
    RAISE EXCEPTION 'This action requires the ''conversations.manage'' permission'
      USING ERRCODE = '42501';
  END IF;
  IF p_note IS NULL OR length(trim(p_note)) = 0 THEN
    RAISE EXCEPTION 'A closure note is required to close a conversation';
  END IF;

  UPDATE conversations SET status = 'closed', closed_at = NOW() WHERE id = p_conversation_id;

  INSERT INTO conversation_events (conversation_id, event_type, actor_user_id, note)
  VALUES (p_conversation_id, 'closed', auth.uid(), p_note);
END;
$$;

CREATE OR REPLACE FUNCTION public.reopen_conversation(p_conversation_id uuid, p_note text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT account_id INTO v_account_id FROM conversations WHERE id = p_conversation_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Conversation % not found', p_conversation_id;
  END IF;
  IF auth.uid() IS NOT NULL AND NOT has_capability(v_account_id, 'conversations.manage') THEN
    RAISE EXCEPTION 'This action requires the ''conversations.manage'' permission'
      USING ERRCODE = '42501';
  END IF;

  UPDATE conversations SET status = 'open', closed_at = NULL WHERE id = p_conversation_id;

  INSERT INTO conversation_events (conversation_id, event_type, actor_user_id, note)
  VALUES (p_conversation_id, 'reopened', auth.uid(), NULLIF(trim(p_note), ''));
END;
$$;

CREATE OR REPLACE FUNCTION public.next_ticket_number(p_account_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next INTEGER;
BEGIN
  IF NOT has_capability(p_account_id, 'tickets.work') THEN
    RAISE EXCEPTION 'This action requires the ''tickets.work'' permission'
      USING ERRCODE = '42501';
  END IF;

  UPDATE accounts SET ticket_seq = ticket_seq + 1
  WHERE id = p_account_id
  RETURNING ticket_seq INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Account % not found', p_account_id;
  END IF;

  RETURN v_next;
END;
$$;


-- ------------------------------------------------------------
-- 6. Hide pending_edit (084, decision 3)
--    Any member could read the proposed values of tags and snippets from the
--    live rows. They now live in approval_pending_edits, which only the
--    proposer and approvals.review holders can read; the live rows keep only
--    edit_status (pending | rejected). Existing pending edits are copied over
--    before the column is dropped.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.approval_pending_edits (
  entity_type TEXT        NOT NULL CHECK (entity_type IN ('tag', 'snippet')),
  entity_id   UUID        NOT NULL,
  account_id  UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  proposed_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  patch       JSONB       NOT NULL CHECK (jsonb_typeof(patch) = 'object'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_approval_pending_edits_account
  ON public.approval_pending_edits (account_id);

ALTER TABLE public.approval_pending_edits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approval_pending_edits_select ON public.approval_pending_edits;
CREATE POLICY approval_pending_edits_select ON public.approval_pending_edits
  FOR SELECT USING (
    is_account_member(account_id)
    AND (proposed_by = auth.uid() OR has_capability(account_id, 'approvals.review'))
  );

-- Nobody writes it directly: only the approval RPCs (SECURITY DEFINER).
REVOKE ALL ON public.approval_pending_edits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.approval_pending_edits TO authenticated;

CREATE OR REPLACE FUNCTION public.approvals_pending_patch(p_type text, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.patch FROM approval_pending_edits e
   WHERE e.entity_type = p_type AND e.entity_id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.approvals_set_pending_patch(
  p_type text, p_id uuid, p_account uuid, p_by uuid, p_patch jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO approval_pending_edits (entity_type, entity_id, account_id, proposed_by, patch)
  VALUES (p_type, p_id, p_account, p_by, p_patch)
  ON CONFLICT (entity_type, entity_id) DO UPDATE
    SET account_id = EXCLUDED.account_id,
        proposed_by = EXCLUDED.proposed_by,
        patch = EXCLUDED.patch,
        updated_at = now();
$$;

CREATE OR REPLACE FUNCTION public.approvals_clear_pending_patch(p_type text, p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM approval_pending_edits WHERE entity_type = p_type AND entity_id = p_id;
$$;

REVOKE ALL ON FUNCTION public.approvals_pending_patch(text, uuid)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approvals_set_pending_patch(text, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approvals_clear_pending_patch(text, uuid)                  FROM PUBLIC, anon, authenticated;

-- A hard delete of a live row takes its pending edit with it (a soft delete
-- keeps it, so a restore brings the proposal back too).
CREATE OR REPLACE FUNCTION public.approvals_drop_pending_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM approval_pending_edits
   WHERE entity_type = TG_ARGV[0] AND entity_id = OLD.id;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.approvals_drop_pending_edit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS approvals_drop_pending_edit ON public.tags;
CREATE TRIGGER approvals_drop_pending_edit
  AFTER DELETE ON public.tags
  FOR EACH ROW EXECUTE FUNCTION public.approvals_drop_pending_edit('tag');

DROP TRIGGER IF EXISTS approvals_drop_pending_edit ON public.quick_replies;
CREATE TRIGGER approvals_drop_pending_edit
  AFTER DELETE ON public.quick_replies
  FOR EACH ROW EXECUTE FUNCTION public.approvals_drop_pending_edit('snippet');

-- Copy existing pending edits, then drop the column (idempotent: the block
-- only runs while the column still exists).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'tags' AND column_name = 'pending_edit') THEN
    INSERT INTO public.approval_pending_edits (entity_type, entity_id, account_id, proposed_by, patch)
    SELECT 'tag', t.id, t.account_id, t.proposed_by, t.pending_edit
      FROM public.tags t WHERE t.pending_edit IS NOT NULL
    ON CONFLICT (entity_type, entity_id) DO NOTHING;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'quick_replies' AND column_name = 'pending_edit') THEN
    INSERT INTO public.approval_pending_edits (entity_type, entity_id, account_id, proposed_by, patch)
    SELECT 'snippet', q.id, q.account_id, q.proposed_by, q.pending_edit
      FROM public.quick_replies q WHERE q.pending_edit IS NOT NULL
    ON CONFLICT (entity_type, entity_id) DO NOTHING;
  END IF;
END $$;

ALTER TABLE public.tags          DROP CONSTRAINT IF EXISTS tags_pending_edit_shape;
ALTER TABLE public.quick_replies DROP CONSTRAINT IF EXISTS quick_replies_pending_edit_shape;
ALTER TABLE public.tags          DROP COLUMN IF EXISTS pending_edit;
ALTER TABLE public.quick_replies DROP COLUMN IF EXISTS pending_edit;

-- ------------------------------------------------------------
-- The approval functions, rewritten for the side table. Same behaviour as
-- 084 except where they read or write the proposed values.
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
    NEW.edit_status     := NULL;
  ELSE
    NEW.approval_status := OLD.approval_status;
    NEW.proposed_by     := OLD.proposed_by;
    NEW.proposed_at     := OLD.proposed_at;
    NEW.decided_by      := OLD.decided_by;
    NEW.decided_at      := OLD.decided_at;
    NEW.decision_note   := OLD.decision_note;
    NEW.edit_status     := OLD.edit_status;
  END IF;
  RETURN NEW;
END;
$$;
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
    edit_status = 'pending',
    proposed_by = v_uid, proposed_at = now(),
    decided_by = NULL, decided_at = NULL, decision_note = NULL
   WHERE id = r.id;
  PERFORM approvals_set_pending_patch('tag', r.id, v_acct, v_uid, v_diff);
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
    edit_status = 'pending',
    proposed_by = v_uid, proposed_at = now(),
    decided_by = NULL, decided_at = NULL, decision_note = NULL
   WHERE id = r.id;
  PERFORM approvals_set_pending_patch('snippet', r.id, v_acct, v_uid, v_diff);
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
    SELECT approval_status, approvals_pending_patch('tag', id), proposed_by, name INTO v_status, v_edit, v_by, v_label
      FROM tags WHERE id = p_id AND account_id = v_acct AND deleted_at IS NULL FOR UPDATE;
  ELSIF p_entity_type = 'snippet' THEN
    SELECT approval_status, approvals_pending_patch('snippet', id), proposed_by, title INTO v_status, v_edit, v_by, v_label
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
    UPDATE tags SET edit_status = NULL,
           decided_by = NULL, decided_at = NULL, decision_note = NULL
     WHERE id = p_id;
  ELSE
    UPDATE quick_replies SET edit_status = NULL,
           decided_by = NULL, decided_at = NULL, decision_note = NULL
     WHERE id = p_id;
  END IF;
  PERFORM approvals_clear_pending_patch(p_entity_type, p_id);
  PERFORM set_config('vircle.approval_rpc', 'off', true);
  PERFORM set_config('vircle.audit_skip', 'off', true);
  PERFORM log_audit(v_acct, 'deleted', p_entity_type, p_id, v_label,
    jsonb_build_object('proposal', 'edit', 'withdrawn', true));
  RETURN jsonb_build_object('withdrawn', true);
END;
$$;
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
       OR (NOT v_new AND (tg.edit_status IS DISTINCT FROM 'pending' OR approvals_pending_patch('tag', tg.id) IS NULL)) THEN
      RAISE EXCEPTION 'not_pending' USING ERRCODE = 'P0001';
    END IF;
    IF tg.proposed_by IS NOT DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'own_proposal' USING ERRCODE = '42501';
    END IF;

    v_live     := approvals_tag_values(tg);
    v_proposed := CASE WHEN v_new THEN v_live ELSE v_live || approvals_pending_patch('tag', tg.id) END;
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
        approval_status = 'approved', edit_status = NULL,
        decided_by = v_uid, decided_at = now(), decision_note = v_note
       WHERE id = tg.id;
      PERFORM approvals_clear_pending_patch('tag', tg.id);
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
       OR (NOT v_new AND (sn.edit_status IS DISTINCT FROM 'pending' OR approvals_pending_patch('snippet', sn.id) IS NULL)) THEN
      RAISE EXCEPTION 'not_pending' USING ERRCODE = 'P0001';
    END IF;
    IF sn.proposed_by IS NOT DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'own_proposal' USING ERRCODE = '42501';
    END IF;

    v_live     := approvals_snippet_values(sn);
    v_proposed := CASE WHEN v_new THEN v_live ELSE v_live || approvals_pending_patch('snippet', sn.id) END;
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
        approval_status = 'approved', edit_status = NULL,
        decided_by = v_uid, decided_at = now(), decision_note = v_note
       WHERE id = sn.id;
      PERFORM approvals_clear_pending_patch('snippet', sn.id);
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
             OR (t.approval_status = 'approved' AND t.edit_status = 'pending' AND approvals_pending_patch('tag', t.id) IS NOT NULL)))
  + (SELECT count(*) FROM quick_replies q
      WHERE q.account_id = v_acct AND q.deleted_at IS NULL
        AND (q.approval_status = 'pending'
             OR (q.approval_status = 'approved' AND q.edit_status = 'pending' AND approvals_pending_patch('snippet', q.id) IS NOT NULL)))
  + (SELECT count(*) FROM ai_knowledge_documents d
       JOIN profiles p ON p.user_id = d.created_by AND p.account_id = d.account_id
      WHERE d.account_id = v_acct AND d.status = 'draft' AND d.deleted_at IS NULL
        AND btrim(d.content) <> ''
        AND NOT effective_capability(p.account_id, p.account_role, 'knowledge.publish'))
  INTO v_n;
  RETURN COALESCE(v_n, 0);
END;
$$;
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
                                                 ELSE approvals_tag_values(t) || approvals_pending_patch('tag', t.id) END),
                 'title', t.name,
                 'status', 'pending',
                 'proposer_id', t.proposed_by,
                 'proposer_name', approvals_person(t.proposed_by),
                 'proposed_at', t.proposed_at,
                 'current', CASE WHEN t.approval_status = 'pending' THEN NULL ELSE approvals_tag_values(t) END,
                 'proposed', CASE WHEN t.approval_status = 'pending'
                                  THEN approvals_tag_values(t)
                                  ELSE approvals_tag_values(t) || approvals_pending_patch('tag', t.id) END,
                 'changed', CASE WHEN t.approval_status = 'pending' THEN NULL
                                 ELSE (SELECT jsonb_agg(k) FROM jsonb_object_keys(approvals_pending_patch('tag', t.id)) AS k) END
               ) AS item
          FROM tags t
         WHERE t.account_id = v_acct AND t.deleted_at IS NULL
           AND (t.approval_status = 'pending'
                OR (t.approval_status = 'approved' AND t.edit_status = 'pending' AND approvals_pending_patch('tag', t.id) IS NOT NULL))
           AND (p_proposer IS NULL OR t.proposed_by = p_proposer)
           AND (p_type IS NULL OR p_type IN ('tag', 'label'))
        UNION ALL
        -- snippets
        SELECT jsonb_build_object(
                 'entity_type', 'snippet',
                 'entity_id', q.id,
                 'action', CASE WHEN q.approval_status = 'pending' THEN 'new' ELSE 'edit' END,
                 'kind', CASE WHEN q.approval_status = 'pending' THEN q.kind
                              ELSE COALESCE(approvals_pending_patch('snippet', q.id) ->> 'kind', q.kind) END,
                 'title', q.title,
                 'status', 'pending',
                 'proposer_id', q.proposed_by,
                 'proposer_name', approvals_person(q.proposed_by),
                 'proposed_at', q.proposed_at,
                 'current', CASE WHEN q.approval_status = 'pending' THEN NULL ELSE approvals_snippet_values(q) END,
                 'proposed', CASE WHEN q.approval_status = 'pending'
                                  THEN approvals_snippet_values(q)
                                  ELSE approvals_snippet_values(q) || approvals_pending_patch('snippet', q.id) END,
                 'changed', CASE WHEN q.approval_status = 'pending' THEN NULL
                                 ELSE (SELECT jsonb_agg(k) FROM jsonb_object_keys(approvals_pending_patch('snippet', q.id)) AS k) END
               ) AS item
          FROM quick_replies q
         WHERE q.account_id = v_acct AND q.deleted_at IS NULL
           AND (q.approval_status = 'pending'
                OR (q.approval_status = 'approved' AND q.edit_status = 'pending' AND approvals_pending_patch('snippet', q.id) IS NOT NULL))
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

NOTIFY pgrst, 'reload schema';
