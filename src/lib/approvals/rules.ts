// ============================================================
// Pure rules for propose and approve. No I/O: the routes, the browser
// writers and the tests all share these.
// ============================================================

import type {
  ApprovalColumns,
  ApprovalErrorCode,
  ApprovalItem,
  ApprovalValues,
  WriteMode,
} from "./types";
import { APPROVAL_ERROR_CODES } from "./types";

type CapSet = ReadonlySet<string> | readonly string[];

function holds(caps: CapSet, cap: string): boolean {
  return Array.isArray(caps)
    ? (caps as readonly string[]).includes(cap)
    : (caps as ReadonlySet<string>).has(cap);
}

/**
 * What a write becomes for this caller. The same rule in the app, the API
 * routes and the database RPCs: the direct `manage` capability => the change
 * goes live; else the `propose` capability => it is recorded as pending; else
 * it is refused.
 */
export function writeMode(
  caps: CapSet,
  manageCap: string,
  proposeCap: string,
): WriteMode {
  if (holds(caps, manageCap)) return "direct";
  if (holds(caps, proposeCap)) return "propose";
  return "deny";
}

// ------------------------------------------------------------
// pending_edit
// ------------------------------------------------------------

/**
 * The values a live row would have once its `pending_edit` is approved: the
 * live values overlaid with the proposed replacements. Keys the edit does not
 * name keep their live value; a key set to null is a real change to null.
 */
export function mergePendingEdit<T extends object>(
  live: T,
  pendingEdit: Partial<T> | Record<string, unknown> | null | undefined,
): T {
  if (!pendingEdit) return { ...live };
  return { ...live, ...(pendingEdit as Partial<T>) };
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The minimal patch to store as `pending_edit`: only the keys whose value
 * differs from the live row. An empty patch means "nothing to propose".
 */
export function buildEditPatch<T extends object>(
  live: T,
  next: Partial<T>,
  keys?: readonly (keyof T)[],
): Partial<T> {
  const out: Partial<T> = {};
  const wanted = keys ?? (Object.keys(next) as (keyof T)[]);
  for (const k of wanted) {
    if (!(k in next)) continue;
    if (!same(live[k], next[k])) out[k] = next[k];
  }
  return out;
}

// ------------------------------------------------------------
// Who sees what: chips
// ------------------------------------------------------------

/**
 * The chip a row wears for this viewer, or null when they should see no
 * sign of a proposal at all (a non-reviewer who did not propose it).
 *
 *   pending          a creation waiting for a decision
 *   rejected         a rejected creation (kept for its proposer to edit or dismiss)
 *   pending_changes  a live item with an edit waiting for a decision
 *   changes_rejected a live item whose edit was rejected
 */
export type ChipState =
  | "pending"
  | "rejected"
  | "pending_changes"
  | "changes_rejected";

export function chipState(
  row: ApprovalColumns,
  viewerId: string | null | undefined,
  canReview: boolean,
): ChipState | null {
  const mine = !!viewerId && row.proposed_by === viewerId;
  if (!mine && !canReview) return null;

  const status = row.approval_status ?? "approved";
  if (status === "pending") return "pending";
  if (status === "rejected") return "rejected";
  if (row.pending_edit && row.edit_status === "pending") return "pending_changes";
  if (row.pending_edit && row.edit_status === "rejected") return "changes_rejected";
  return null;
}

/** A row that may be applied, inserted or sent: only a live approved one. */
export function isUsable(row: ApprovalColumns): boolean {
  return (row.approval_status ?? "approved") === "approved";
}

/** A pending edit must never reach someone who may not see it. */
export function stripPendingEdit<T extends ApprovalColumns>(
  row: T,
  viewerId: string | null | undefined,
  canReview: boolean,
): T {
  if (!row.pending_edit) return row;
  if (canReview || (!!viewerId && row.proposed_by === viewerId)) return row;
  return { ...row, pending_edit: null, edit_status: null };
}

/** A proposer may edit, resubmit or withdraw only what is theirs and undecided or rejected. */
export function canWithdraw(
  row: ApprovalColumns,
  viewerId: string | null | undefined,
): boolean {
  return !!viewerId && row.proposed_by === viewerId && chipState(row, viewerId, false) !== null;
}

// ------------------------------------------------------------
// Diff (Current vs Proposed)
// ------------------------------------------------------------

export interface DiffRow {
  field: string;
  from: unknown;
  to: unknown;
  changed: boolean;
}

/** Fields shown per entity, in display order. */
export const DIFF_FIELDS = {
  tag: ["name", "color", "description", "for_contacts", "for_conversations"],
  snippet: ["title", "kind", "content_text", "interactive_payload"],
  article: ["title", "language", "content_text"],
} as const;

/**
 * Rows for the side-by-side view. For an edit each row says whether the value
 * changes; for a creation (`current` null) every present value is new.
 */
export function buildDiff(
  entity: keyof typeof DIFF_FIELDS,
  current: ApprovalValues | Record<string, unknown> | null,
  proposed: ApprovalValues | Record<string, unknown> | null,
): DiffRow[] {
  const cur = (current ?? {}) as Record<string, unknown>;
  const next = (proposed ?? {}) as Record<string, unknown>;
  const rows: DiffRow[] = [];
  for (const field of DIFF_FIELDS[entity]) {
    const to = next[field];
    const from = current ? cur[field] : undefined;
    if (!current && (to === undefined || to === null || to === "")) continue;
    // A snippet shows only the body that matches its kind.
    if (entity === "snippet") {
      const kind = (next.kind ?? cur.kind) as string | undefined;
      if (field === "content_text" && kind === "interactive" && !to && !from) continue;
      if (field === "interactive_payload" && kind === "text" && !to && !from) continue;
    }
    rows.push({ field, from, to, changed: current ? !same(from, to) : true });
  }
  return rows;
}

/** How many rows differ (edits), or how many are shown (creations). */
export function changedCount(rows: readonly DiffRow[]): number {
  return rows.filter((r) => r.changed).length;
}

// ------------------------------------------------------------
// Badge and list helpers
// ------------------------------------------------------------

/** "9+" once the count passes nine; empty for zero or an unknown count. */
export function badgeLabel(count: number | null | undefined): string {
  if (!count || count < 1) return "";
  return count > 9 ? "9+" : String(count);
}

/** Counts of a queue page, by entity type. */
export function countByType(
  items: readonly Pick<ApprovalItem, "entity_type">[],
): Record<"tag" | "snippet" | "article", number> {
  const out = { tag: 0, snippet: 0, article: 0 };
  for (const it of items) out[it.entity_type] += 1;
  return out;
}

/** Row key: an item can be both a creation and (later) an edit. */
export function itemKey(item: Pick<ApprovalItem, "entity_type" | "entity_id" | "action">): string {
  return `${item.entity_type}:${item.entity_id}:${item.action}`;
}

/** Which of the selected rows can be bulk approved (articles are approved = published one by one too). */
export function bulkApprovable<T extends Pick<ApprovalItem, "status">>(
  items: readonly T[],
): T[] {
  return items.filter((i) => i.status === "pending");
}

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

/**
 * Map a database / route error to a machine code. RPC errors carry the code
 * as their message (`name_conflict`, `note_required`, ...); anything with a
 * permission SQLSTATE is `forbidden`.
 */
export function approvalErrorCode(
  err: { message?: string | null; code?: string | null } | null | undefined,
): ApprovalErrorCode {
  if (!err) return "unknown";
  const msg = (err.message ?? "").trim();
  if ((APPROVAL_ERROR_CODES as readonly string[]).includes(msg)) {
    return msg as ApprovalErrorCode;
  }
  const known = APPROVAL_ERROR_CODES.find((c) => msg.startsWith(c));
  if (known) return known;
  if (err.code === "23505") return "name_conflict";
  if (err.code === "42501") return "forbidden";
  if (err.code === "P0002") return "not_found";
  return "unknown";
}

/** HTTP status for an error code. */
export function approvalErrorStatus(code: ApprovalErrorCode): number {
  switch (code) {
    case "forbidden":
    case "own_proposal":
      return 403;
    case "not_found":
      return 404;
    case "name_conflict":
    case "not_pending":
    case "not_live":
    case "edit_pending":
      return 409;
    case "unknown":
      return 500;
    default:
      return 400;
  }
}
