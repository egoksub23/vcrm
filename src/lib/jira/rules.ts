// ============================================================
// The two-way sync rules, as pure functions (design section 3): what to do
// with an incoming Jira change, and how the echo guards recognise Vircle's
// own writes coming back. Nothing here does I/O, so every rule is unit-tested
// on its own; ./sync.ts applies the decisions.
//
// Echo-loop guards, in the order they are applied:
//   1. A Jira comment whose id we recorded (jira_comment_map, origin
//      'vircle') is ours: ignored. A comment carrying our property marker is
//      ours even if the webhook beat the map row.
//   2. A note that came FROM Jira (source 'jira') is never sent back.
//   3. For status we remember the last category we wrote and when; an
//      incoming state equal to it within the window is our own echo.
//   4. Applying is idempotent: the ticket only changes when the value differs.
//   5. An update older than the last one applied is dropped.
//   6. Something that came from Jira never queues an outbound push (the SQL
//      trigger checks the vircle.source session marker).
// ============================================================

import { createHash } from "node:crypto";

import { mapJiraStatusToTicket, normalizeCategory } from "./settings";
import {
  VIRCLE_COMMENT_PROPERTY,
  type JiraComment,
  type JiraSettings,
  type LastWritten,
  type TicketStatusValue,
} from "./types";

/** How long after a push a matching Jira state still counts as our own echo. */
export const ECHO_WINDOW_MS = 10 * 60_000;

export function hashText(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 32);
}

// ------------------------------------------------------------
// Ordering
// ------------------------------------------------------------

/** Is `incoming` (Jira's `updated`) older than the last change we applied? */
export function isOlderEvent(incoming: string | null | undefined, lastApplied: string | null | undefined): boolean {
  if (!incoming || !lastApplied) return false;
  const a = Date.parse(incoming);
  const b = Date.parse(lastApplied);
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}

// ------------------------------------------------------------
// Status
// ------------------------------------------------------------

export function isOwnStatusEcho(
  written: LastWritten | null | undefined,
  now: { name?: string | null; category?: string | null },
  at: number = Date.now(),
): boolean {
  if (!written?.at || !written.status_category) return false;
  const when = Date.parse(written.at);
  if (!Number.isFinite(when) || at - when > ECHO_WINDOW_MS || at < when - 60_000) return false;
  if (written.status_name && now.name && written.status_name.toLowerCase() !== now.name.toLowerCase()) return false;
  return written.status_category === now.category;
}

export type StatusDecision =
  | { apply: TicketStatusValue; reason: "changed" }
  | { apply: null; reason: "toggle_off" | "unchanged" | "first_sync" | "echo" | "unmapped" | "same_as_ticket" | "ticket_closed" | "not_all_done" }
  | { apply: null; reason: "done_note" };

export interface StatusDecisionInput {
  settings: JiraSettings;
  /** The link before this sync (its cached status is what "changed" is measured against). */
  cached: { status_id: string | null; status_name: string | null; last_synced_at: string | null; last_written: LastWritten };
  /** The status the issue has now. */
  now: { id?: string | null; name?: string | null; category?: string | null };
  ticketStatus: TicketStatusValue;
  /** The other links of the ticket, after this sync: are they all Done? */
  otherLinksAllDone: boolean;
  at?: number;
}

/**
 * Should the ticket status follow this Jira status? Jira wins for status, but
 * only when Jira's status CHANGED since the last sync (a ticket resolved by an
 * agent is not reopened just because the issue is still In progress), never
 * as an echo of our own push, and a closed ticket is never reopened.
 */
export function decideStatusApply(input: StatusDecisionInput): StatusDecision {
  const { settings, cached, now, ticketStatus } = input;
  if (!settings.direction.status_from_jira) return { apply: null, reason: "toggle_off" };
  if (!cached.last_synced_at) return { apply: null, reason: "first_sync" };

  const changed =
    (now.id != null && cached.status_id != null ? now.id !== cached.status_id : (now.name ?? "") !== (cached.status_name ?? ""));
  if (!changed) return { apply: null, reason: "unchanged" };
  if (isOwnStatusEcho(cached.last_written, { name: now.name, category: now.category }, input.at)) return { apply: null, reason: "echo" };

  const mapped = mapJiraStatusToTicket(settings, { name: now.name, category: now.category });
  if (!mapped) return { apply: null, reason: "unmapped" };

  if (normalizeCategory(now.category) === "done" && !mapped.explicit) {
    if (settings.done_behaviour === "note") return { apply: null, reason: "done_note" };
    if (!input.otherLinksAllDone) return { apply: null, reason: "not_all_done" };
  }
  if (ticketStatus === "closed" && mapped.status !== "closed") return { apply: null, reason: "ticket_closed" };
  if (mapped.status === ticketStatus) return { apply: null, reason: "same_as_ticket" };
  return { apply: mapped.status, reason: "changed" };
}

// ------------------------------------------------------------
// Comments
// ------------------------------------------------------------

export interface CommentMapEntry {
  id: string;
  origin: "vircle" | "jira";
  ticket_comment_id: string | null;
  body_hash: string | null;
  deleted_in_jira: boolean;
}

export type CommentAction =
  | { kind: "ignore"; reason: "ours" | "unchanged" | "restricted" | "already_deleted" | "empty" | "toggle_off" }
  | { kind: "remember_ours" }
  | { kind: "seed" }
  | { kind: "create" }
  | { kind: "update" }
  | { kind: "mark_deleted" };

/** The marker Vircle puts on the comments it posts (a comment property). */
export function hasVircleMarker(comment: Pick<JiraComment, "properties">): boolean {
  return (comment.properties ?? []).some((p) => p.key === VIRCLE_COMMENT_PROPERTY);
}

export interface CommentDecisionInput {
  comment: JiraComment & { visibility?: unknown };
  /** The plain text of the comment body. */
  text: string;
  mapped: CommentMapEntry | null;
  commentsFromJira: boolean;
  /** First sync of a new link: existing comments are noted as seen, not imported. */
  seedOnly: boolean;
}

/** What to do with one comment read from Jira. */
export function decideCommentAction(input: CommentDecisionInput): CommentAction {
  const { comment, mapped } = input;

  // Guard 1: our own comment, by map or by marker.
  if (mapped?.origin === "vircle") return { kind: "ignore", reason: "ours" };
  if (!mapped && hasVircleMarker(comment)) return { kind: "remember_ours" };

  if (!input.commentsFromJira) return { kind: "ignore", reason: "toggle_off" };
  // A comment restricted to a role or group in Jira is not copied to a ticket every agent can read.
  if (comment.visibility) return { kind: "ignore", reason: "restricted" };
  if (!input.text.trim()) return { kind: "ignore", reason: "empty" };

  if (!mapped) return input.seedOnly ? { kind: "seed" } : { kind: "create" };
  if (mapped.deleted_in_jira) return { kind: "ignore", reason: "already_deleted" };
  if (mapped.body_hash === hashText(input.text)) return { kind: "ignore", reason: "unchanged" };
  return mapped.ticket_comment_id ? { kind: "update" } : { kind: "ignore", reason: "unchanged" };
}

/** A comment we know about that Jira no longer lists (or a comment_deleted event). */
export function decideCommentDeleted(mapped: CommentMapEntry | null): CommentAction {
  if (!mapped) return { kind: "ignore", reason: "unchanged" };
  // Guard 1 again: deleting in Jira never removes a note that Vircle wrote.
  if (mapped.origin === "vircle") return { kind: "ignore", reason: "ours" };
  if (mapped.deleted_in_jira) return { kind: "ignore", reason: "already_deleted" };
  return { kind: "mark_deleted" };
}

/**
 * Guard 2: which notes may be sent to Jira. Only notes written in Vircle, by
 * a person, with text; never a note that came from Jira.
 */
export function canShareNote(note: { source: string; author_id: string | null; body: string }): boolean {
  return note.source === "vircle" && !!note.author_id && note.body.trim().length > 0;
}
