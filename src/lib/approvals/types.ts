// ============================================================
// Propose and approve (migration 084) — shared types.
//
// Agents propose, a reviewer (approvals.review) approves. Tags (contact tags
// AND conversation labels share the `tags` table) and snippets
// (`quick_replies`) carry a status on the row itself; the knowledge base
// keeps its draft / publish flow and is only listed in the same queue.
// ============================================================

/** What the queue lists. `tag` covers contact tags and conversation labels. */
export type ApprovalEntity = "tag" | "snippet" | "article";

/** The filter values of the queue: a tag used both ways matches tag and label. */
export type ApprovalTypeFilter = "tag" | "label" | "snippet" | "article";

/** Row state of a tag or snippet (the `approval_status` column). */
export type ApprovalStatus = "approved" | "pending" | "rejected";

/** State of a pending edit on a live row (the values themselves are in approval_pending_edits since migration 088). */
export type EditStatus = "pending" | "rejected";

/** "new" = a creation waiting for a decision, "edit" = a change to a live item. */
export type ApprovalAction = "new" | "edit";

/** What a person's write turns into: live now, a proposal, or refused. */
export type WriteMode = "direct" | "propose" | "deny";

export interface TagValues {
  name: string;
  color: string;
  description: string | null;
  for_contacts: boolean;
  for_conversations: boolean;
}

export interface SnippetValues {
  title: string;
  kind: "text" | "interactive";
  content_text: string | null;
  interactive_payload: Record<string, unknown> | null;
}

export interface ArticleValues {
  title: string;
  language: string;
  content_text: string;
}

export type ApprovalValues =
  | Partial<TagValues>
  | Partial<SnippetValues>
  | Partial<ArticleValues>;

/** One element of `approvals_list()` (both tabs). */
export interface ApprovalItem {
  entity_type: ApprovalEntity;
  entity_id: string;
  action: ApprovalAction;
  /** tag | label | both (tags), text | interactive (snippets), article. */
  kind: string | null;
  title: string | null;
  status: "pending" | "approved" | "rejected";
  proposer_id: string | null;
  proposer_name: string | null;
  proposed_at: string | null;
  /** Live values; null for a creation. */
  current: Record<string, unknown> | null;
  /** The values that would go live. */
  proposed: Record<string, unknown> | null;
  /** Keys the edit changes (edits only). */
  changed?: string[] | null;
  language?: string | null;
  decided_by?: string | null;
  decided_by_name?: string | null;
  decided_at?: string | null;
  decision_note?: string | null;
}

/** The approval columns any tag or snippet row carries. */
export interface ApprovalColumns {
  approval_status?: ApprovalStatus;
  proposed_by?: string | null;
  proposed_at?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
  decision_note?: string | null;
  pending_edit?: Record<string, unknown> | null;
  edit_status?: EditStatus | null;
}

/** Machine codes the routes and RPCs return. Each has an `Approvals.errors.*` string. */
export const APPROVAL_ERROR_CODES = [
  "name_conflict",
  "note_required",
  "own_proposal",
  "not_pending",
  "not_found",
  "not_live",
  "edit_pending",
  "no_changes",
  "invalid_name",
  "invalid_color",
  "invalid_description",
  "invalid_usage",
  "invalid_title",
  "invalid_kind",
  "invalid_content",
  "invalid_decision",
  "invalid_type",
  "reject_not_supported",
  "forbidden",
  "unknown",
] as const;

export type ApprovalErrorCode = (typeof APPROVAL_ERROR_CODES)[number];
