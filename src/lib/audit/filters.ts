// ============================================================
// Parsing and applying the audit-log filters shared by the list route,
// the CSV export and the screen. Pure apart from the query builder it is
// handed.
// ============================================================

import {
  AUDIT_ACTOR_KINDS,
  EMPTY_AUDIT_FILTERS,
  isAuditAction,
  isAuditEntityType,
  type AuditFilters,
} from "./types";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_QUERY_LENGTH = 100;

export type ParsedFilters =
  | { ok: true; filters: AuditFilters }
  | { ok: false; error: string };

function parseTimestamp(raw: string): string | null {
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Read ?actor= &action= &entity_type= &from= &to= &q= into typed
 * filters. Anything malformed is a 400, never silently ignored (a typo
 * must not turn a narrow export into an unfiltered one).
 */
export function parseAuditFilters(params: URLSearchParams): ParsedFilters {
  const filters: AuditFilters = { ...EMPTY_AUDIT_FILTERS };

  const actor = params.get("actor");
  if (actor) {
    if (!UUID_RE.test(actor) && !(AUDIT_ACTOR_KINDS as readonly string[]).includes(actor)) {
      return { ok: false, error: "'actor' must be a member id, system, automation or api" };
    }
    filters.actor = actor;
  }

  const action = params.get("action");
  if (action) {
    if (!isAuditAction(action)) return { ok: false, error: "Unknown 'action'" };
    filters.action = action;
  }

  const entityType = params.get("entity_type");
  if (entityType) {
    if (!isAuditEntityType(entityType)) return { ok: false, error: "Unknown 'entity_type'" };
    filters.entityType = entityType;
  }

  for (const [key, field] of [
    ["from", "from"],
    ["to", "to"],
  ] as const) {
    const raw = params.get(key);
    if (!raw) continue;
    const iso = parseTimestamp(raw);
    if (!iso) return { ok: false, error: `'${key}' must be a date` };
    filters[field] = iso;
  }
  if (filters.from && filters.to && filters.from >= filters.to) {
    return { ok: false, error: "'from' must be before 'to'" };
  }

  const q = params.get("q")?.trim();
  if (q) filters.q = q.slice(0, MAX_QUERY_LENGTH);

  return { ok: true, filters };
}

/** Escape LIKE wildcards so a search for "50%" matches literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------
// Cursor: rows share a created_at (one transaction writes several), so
// the cursor is the (created_at, id) pair of the last row of the page.
// ---------------------------------------------------------------

export interface AuditCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(c: AuditCursor): string {
  return `${c.createdAt}_${c.id}`;
}

export function decodeCursor(raw: string | null): AuditCursor | null | "invalid" {
  if (raw === null || raw === "") return null;
  const cut = raw.lastIndexOf("_");
  if (cut < 1) return "invalid";
  const createdAt = raw.slice(0, cut);
  const id = raw.slice(cut + 1);
  // The value ends up inside a PostgREST `or()` expression: only accept
  // the exact shapes the database produces.
  if (!UUID_RE.test(id)) return "invalid";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(createdAt)) {
    return "invalid";
  }
  return { createdAt, id };
}

/** The slice of the Supabase query builder the filters need. */
interface FilterableQuery<T> {
  eq(column: string, value: string): T;
  gte(column: string, value: string): T;
  lt(column: string, value: string): T;
  ilike(column: string, pattern: string): T;
  or(filters: string): T;
}

/**
 * Add the filters (and the cursor) to a query on `audit_log`. The
 * account scope is the caller's job.
 */
export function applyAuditFilters<T extends FilterableQuery<T>>(
  query: T,
  filters: AuditFilters,
  cursor: AuditCursor | null = null,
): T {
  let q = query;
  if (filters.actor) {
    q = (AUDIT_ACTOR_KINDS as readonly string[]).includes(filters.actor)
      ? q.eq("actor_kind", filters.actor)
      : q.eq("actor_id", filters.actor);
  }
  if (filters.action) q = q.eq("action", filters.action);
  if (filters.entityType) q = q.eq("entity_type", filters.entityType);
  if (filters.from) q = q.gte("created_at", filters.from);
  if (filters.to) q = q.lt("created_at", filters.to);
  if (filters.q) q = q.ilike("entity_label", `%${escapeLike(filters.q)}%`);
  if (cursor) {
    q = q.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  }
  return q;
}
