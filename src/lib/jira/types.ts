// ============================================================
// Jira Cloud link (migration 085): shared constants and types.
// Pure, no I/O. The design is in Vircle-Jira-Integration-Design.docx and the
// research notes it points to; docs/jira-setup.md is the operator's version.
// ============================================================

/** The scopes the Vircle Atlassian app requests. Classic scopes, five in all. */
export const JIRA_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "manage:jira-webhook",
  "offline_access",
] as const;

export const JIRA_AUTH_URL = "https://auth.atlassian.com/authorize";
export const JIRA_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
export const JIRA_API_BASE = "https://api.atlassian.com";

/** A ticket links at most this many Jira issues (enforced by a trigger too). */
export const MAX_LINKS_PER_TICKET = 5;

/** Jira's limits. */
export const JIRA_SUMMARY_MAX = 255;
export const JIRA_TEXT_MAX = 32_767;

/** Refresh an access token this long before it expires. */
export const TOKEN_SKEW_MS = 60_000;

/** The dynamic-webhook events Vircle registers for. */
export const JIRA_WEBHOOK_EVENTS = [
  "jira:issue_updated",
  "jira:issue_deleted",
  "comment_created",
  "comment_updated",
  "comment_deleted",
] as const;
export type JiraWebhookEvent = (typeof JIRA_WEBHOOK_EVENTS)[number];

/** Jira webhooks expire after 30 days; renew well before that. */
export const WEBHOOK_LIFETIME_DAYS = 30;
export const WEBHOOK_RENEW_BEFORE_DAYS = 20;

/** The Jira status category keys. */
export type JiraStatusCategory = "new" | "indeterminate" | "done" | "undefined";
export const JIRA_STATUS_CATEGORIES: readonly JiraStatusCategory[] = [
  "new",
  "indeterminate",
  "done",
  "undefined",
];

export type TicketStatusValue = "open" | "in_progress" | "pending" | "resolved" | "closed";
export const TICKET_STATUSES: readonly TicketStatusValue[] = [
  "open",
  "in_progress",
  "pending",
  "resolved",
  "closed",
];
export type TicketPriorityValue = "urgent" | "high" | "normal" | "low";
export const TICKET_PRIORITIES: readonly TicketPriorityValue[] = ["urgent", "high", "normal", "low"];

export type ConnectionStatus = "active" | "reauth_required" | "revoked";
export type SyncState = "ok" | "paused" | "broken";

// ------------------------------------------------------------
// Settings (jira_connections.settings, snake_case because SQL reads it)
// ------------------------------------------------------------

export interface JiraSettings {
  projects: {
    /** Project keys tickets may link to; empty = every project the user can see. */
    allowed: string[];
    default_project: string | null;
    default_issue_type: string | null;
  };
  mapping: {
    /** Vircle priority -> the site's priority NAME. Unmapped = Jira's default. */
    priority: Partial<Record<TicketPriorityValue, string>>;
    /** Jira status NAME (lower case) -> ticket status. Beats the category default. */
    status_from_jira: Record<string, TicketStatusValue>;
    /** Ticket status -> the Jira status NAME to land on. Beats the category default. */
    status_to_jira: Partial<Record<TicketStatusValue, string>>;
    /** Add the ticket category as a label on new issues. */
    category_label: boolean;
  };
  direction: {
    comments_to_jira: boolean;
    comments_from_jira: boolean;
    status_from_jira: boolean;
    status_to_jira: boolean;
    assignee: boolean;
  };
  privacy: {
    include_customer: boolean;
    preview_before_send: boolean;
  };
  /** What happens when a linked issue reaches Done. */
  done_behaviour: "note" | "resolve";
  /** Resolution supplied when a transition screen demands one. */
  resolution: string;
  /** The weekly personal-data report Atlassian requires. */
  personal_data_report: boolean;
}

export const DEFAULT_JIRA_SETTINGS: JiraSettings = {
  projects: { allowed: [], default_project: null, default_issue_type: null },
  mapping: { priority: {}, status_from_jira: {}, status_to_jira: {}, category_label: true },
  direction: {
    comments_to_jira: true,
    comments_from_jira: true,
    status_from_jira: true,
    status_to_jira: false,
    assignee: false,
  },
  privacy: { include_customer: false, preview_before_send: true },
  done_behaviour: "note",
  resolution: "Done",
  personal_data_report: true,
};

// ------------------------------------------------------------
// Rows (what the routes read; the columns of the tables in 085)
// ------------------------------------------------------------

/** The safe columns of jira_connections (no token exists in this table). */
export interface JiraConnectionRow {
  id: string;
  account_id: string;
  cloud_id: string;
  site_url: string;
  site_name: string | null;
  connected_by: string | null;
  jira_account_id: string | null;
  jira_display_name: string | null;
  status: ConnectionStatus;
  status_reason: string | null;
  token_expires_at: string | null;
  webhook_ids: unknown;
  webhook_expires_at: string | null;
  webhook_checked_at: string | null;
  last_catchup_at: string | null;
  last_report_at: string | null;
  settings: unknown;
  rate_limit: RateLimitSnapshot | null;
  created_at: string;
  updated_at: string;
}

export const CONNECTION_COLUMNS =
  "id, account_id, cloud_id, site_url, site_name, connected_by, jira_account_id, jira_display_name, status, status_reason, token_expires_at, webhook_ids, webhook_expires_at, webhook_checked_at, last_catchup_at, last_report_at, settings, rate_limit, created_at, updated_at";

export interface TicketJiraLinkRow {
  id: string;
  account_id: string;
  ticket_id: string;
  connection_id: string;
  issue_id: string;
  issue_key: string;
  project_key: string | null;
  project_name: string | null;
  issue_type: string | null;
  summary: string | null;
  status_id: string | null;
  status_name: string | null;
  status_category: JiraStatusCategory | null;
  resolution: string | null;
  priority_name: string | null;
  assignee_account_id: string | null;
  assignee_name: string | null;
  reporter_name: string | null;
  issue_url: string | null;
  jira_updated_at: string | null;
  last_synced_at: string | null;
  sync_state: SyncState;
  sync_error: string | null;
  last_written: LastWritten;
  last_push: LastPush | null;
  remote_link_id: string | null;
  linked_by: string | null;
  last_resync_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What Vircle last wrote to Jira, so the webhook that announces it is recognised. */
export interface LastWritten {
  status_category?: JiraStatusCategory;
  status_name?: string;
  at?: string;
}

export interface LastPush {
  ok: boolean;
  /** no_transition | permission | screen_fields | not_mapped | error */
  reason?: string;
  wanted?: string;
  at: string;
}

export interface RateLimitSnapshot {
  reason?: string | null;
  remaining?: number | null;
  limit?: number | null;
  reset?: string | null;
  status?: number;
  at: string;
}

/** The issue fields Vircle reads. Nothing else is ever requested. */
export const ISSUE_FIELDS = [
  "summary",
  "status",
  "assignee",
  "reporter",
  "priority",
  "resolution",
  "issuetype",
  "project",
  "updated",
] as const;

/** The parts of an issue the sync cares about (from GET issue / bulkfetch / search). */
export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    status?: {
      id?: string;
      name?: string;
      statusCategory?: { key?: string; name?: string };
    };
    assignee?: JiraUserRef | null;
    reporter?: JiraUserRef | null;
    priority?: { id?: string; name?: string } | null;
    resolution?: { id?: string; name?: string } | null;
    issuetype?: { id?: string; name?: string } | null;
    project?: { id?: string; key?: string; name?: string } | null;
    updated?: string;
  };
}

export interface JiraUserRef {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
  active?: boolean;
}

export interface JiraComment {
  id: string;
  body?: unknown;
  author?: JiraUserRef;
  updateAuthor?: JiraUserRef;
  created?: string;
  updated?: string;
  properties?: { key: string; value: unknown }[];
}

/** The comment property that marks a comment Vircle posted. */
export const VIRCLE_COMMENT_PROPERTY = "vircle.sync";
/** The stable prefix of a remote link's globalId. */
export const REMOTE_LINK_GLOBAL_ID_PREFIX = "vircle";
