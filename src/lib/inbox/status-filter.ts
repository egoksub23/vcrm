// ============================================================
// The Inbox's status filter: which chats the list shows by what state they are in.
//
// Kept apart from the ownership tabs (All / Mine / Unassigned / Unread): the two combine, so "Mine" and "Closed" together is "my closed chats".
//
//   active    open and pending: everything still being worked on. THE DEFAULT, so a chat that was closed leaves the list.
//   open      status open
//   pending   status pending
//   expired   not closed, but the WhatsApp reply window has run out: 24 hours since the customer's last message
//             (or the customer never wrote). Only WhatsApp chats have such a window.
//   closed    status closed
//   all       every status
//
// While the person is searching, a closed chat is still found (see `effectiveStatusFilter`): hiding it would make an old chat unreachable.
// ============================================================

import type { ConversationStatus } from "@/types";

export const STATUS_FILTERS = ["active", "open", "pending", "expired", "closed", "all"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export const DEFAULT_STATUS_FILTER: StatusFilter = "active";

/** WhatsApp lets a business reply freely for this long after the customer's last message. */
export const REPLY_WINDOW_MS = 24 * 3600 * 1000;

export interface StatusFilterRow {
  status: ConversationStatus;
  last_channel_type: string;
  last_customer_message_at?: string | null;
}

export function isStatusFilter(v: unknown): v is StatusFilter {
  return typeof v === "string" && (STATUS_FILTERS as readonly string[]).includes(v);
}

/** True when this chat is not closed, is a WhatsApp chat, and the 24-hour reply window has run out. */
export function isReplyWindowExpired(c: StatusFilterRow, now: number): boolean {
  if (c.status === "closed" || c.last_channel_type !== "whatsapp") return false;
  if (!c.last_customer_message_at) return true; // the customer never wrote: only a template can open it
  const t = Date.parse(c.last_customer_message_at);
  return Number.isFinite(t) && now - t >= REPLY_WINDOW_MS;
}

export function matchesStatusFilter(c: StatusFilterRow, filter: StatusFilter, now: number): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return c.status !== "closed";
    case "open":
    case "pending":
    case "closed":
      return c.status === filter;
    case "expired":
      return isReplyWindowExpired(c, now);
  }
}

/** The filter that really applies: while searching, the default view widens to every status so a closed chat can still be found. */
export function effectiveStatusFilter(filter: StatusFilter, searching: boolean): StatusFilter {
  return searching && filter === "active" ? "all" : filter;
}

/** How many of these chats each status would show (for the numbers in the menu). */
export function countByStatus(rows: readonly StatusFilterRow[], now: number): Record<StatusFilter, number> {
  const out = Object.fromEntries(STATUS_FILTERS.map((f) => [f, 0])) as Record<StatusFilter, number>;
  for (const c of rows) for (const f of STATUS_FILTERS) if (matchesStatusFilter(c, f, now)) out[f]++;
  return out;
}

/**
 * The status filter a saved view means. A view saved with a `status` uses it. A view saved before the status filter existed said
 * "open", "pending" or "closed" in its single `filter` and meant exactly that; any other old view showed every status and keeps doing so.
 */
export function statusFromView(cfg: { status?: unknown; filter?: unknown }): StatusFilter {
  if (isStatusFilter(cfg.status)) return cfg.status;
  if (cfg.filter === "open" || cfg.filter === "pending" || cfg.filter === "closed") return cfg.filter;
  return "all";
}

/** The ownership part of a saved view: the old status words are not ownership, so they mean "all". */
export type OwnershipFilter = "all" | "mine" | "unassigned" | "unread";
export function ownershipFromView(cfg: { filter?: unknown }): OwnershipFilter {
  return cfg.filter === "mine" || cfg.filter === "unassigned" || cfg.filter === "unread" ? cfg.filter : "all";
}
