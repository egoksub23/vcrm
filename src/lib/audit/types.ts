// ============================================================
// Audit trail types (migration 082) — pure, shared by the API routes
// and the Settings > Audit log screen. No I/O.
// ============================================================

/** The `audit_log.action` values (a CHECK constraint mirrors this list). */
export const AUDIT_ACTIONS = [
  "created",
  "updated",
  "deleted",
  "restored",
  "applied",
  "removed",
  "role_changed",
  "capability_changed",
  "invited",
  "member_removed",
  "team_member_added",
  "team_member_removed",
  "approved",
  "rejected",
  // Migration 085 (Jira link).
  "connected",
  "disconnected",
  "reconnected",
  "linked",
  "unlinked",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTOR_KINDS = ["user", "system", "automation", "api"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/**
 * What the triggers write into `entity_type`. `tag` covers both contact
 * tags and conversation labels (one table); applying / removing one is
 * logged against the `conversation` or `contact` it was applied to.
 */
export const AUDIT_ENTITY_TYPES = [
  "tag",
  "snippet",
  "article",
  "team",
  "conversation",
  "contact",
  "member",
  "invitation",
  "role",
  "channel_config",
  "ai_settings",
  "api_key",
  "webhook",
  // Migration 085 (Jira link).
  "jira_connection",
  "ticket_jira_link",
  // Migration 086 (ticket SLA).
  "business_hours",
  "business_hours_holiday",
  "sla_policy",
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/** Entities that can be soft-deleted and restored ("Recently removed"). */
export const RESTORABLE_ENTITY_TYPES = ["tag", "snippet", "article"] as const;
export type RestorableEntityType = (typeof RESTORABLE_ENTITY_TYPES)[number];

/** Capability needed to restore each kind (the item's own manage action). */
export const RESTORE_CAPABILITY: Readonly<Record<RestorableEntityType, string>> = {
  tag: "tags.manage",
  snippet: "snippets.manage",
  article: "knowledge.publish",
};

/** Entity types that Activity drawers are offered on. */
export const ACTIVITY_ENTITY_TYPES = ["tag", "snippet", "article"] as const;

/** A row of `audit_log`, as selected by the routes. */
export interface AuditRow {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_kind: AuditActorKind;
  actor_label: string | null;
  action: AuditAction;
  entity_type: string;
  entity_id: string | null;
  entity_label: string | null;
  summary: Record<string, unknown> | null;
}

export const AUDIT_ROW_COLUMNS =
  "id, created_at, actor_id, actor_kind, actor_label, action, entity_type, entity_id, entity_label, summary";

/** What the API returns for one row. */
export interface AuditEntry {
  id: string;
  createdAt: string;
  actor: {
    id: string | null;
    kind: AuditActorKind;
    /** Display name (member name, automation or key name); "" when unknown. */
    name: string;
  };
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  summary: Record<string, unknown> | null;
  /**
   * Whether the item is still there (true/false) for entity types that
   * can disappear and be checked cheaply; null when not checked.
   */
  entityExists: boolean | null;
}

/** An item in Recently removed. */
export interface RemovedItem {
  entityType: RestorableEntityType;
  entityId: string;
  label: string;
  /** tag: tag | label | both; snippet: text | interactive; article: language. */
  kind: string;
  deletedAt: string;
  deletedBy: string | null;
  deletedByName: string;
}

export interface AuditFilters {
  /** A member's user id, or a non-user actor kind. */
  actor: string | null;
  action: AuditAction | null;
  entityType: string | null;
  /** ISO timestamps, inclusive lower / exclusive upper bound. */
  from: string | null;
  to: string | null;
  /** Case-insensitive text search on entity_label. */
  q: string | null;
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = {
  actor: null,
  action: null,
  entityType: null,
  from: null,
  to: null,
  q: null,
};

export function isAuditAction(v: unknown): v is AuditAction {
  return typeof v === "string" && (AUDIT_ACTIONS as readonly string[]).includes(v);
}

export function isAuditEntityType(v: unknown): v is AuditEntityType {
  return typeof v === "string" && (AUDIT_ENTITY_TYPES as readonly string[]).includes(v);
}

export function isRestorableEntityType(v: unknown): v is RestorableEntityType {
  return typeof v === "string" && (RESTORABLE_ENTITY_TYPES as readonly string[]).includes(v);
}
