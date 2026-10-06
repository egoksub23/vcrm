// ============================================================
// Doc Sign, browser side: the documents list's filters turned into what the database is asked. Pure, so the
// rules (which statuses make a group, how a search is made safe, how a page is cut) are tested.
// ============================================================

import type { DocumentStatus } from "../types";

export const PAGE_SIZE = 25;

export const STATUS_GROUPS = ["all", "draft", "waiting", "completed", "stopped"] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];

/** The statuses in each group; `null` is "every status". */
export const GROUP_STATUSES: Record<StatusGroup, readonly DocumentStatus[] | null> = {
  all: null,
  draft: ["draft"],
  // "sealing" is the short moment after the last signature while the signed file is made
  waiting: ["sent", "in_progress", "sealing"],
  completed: ["completed"],
  stopped: ["declined", "expired", "voided", "failed"],
};

/** The category filter: every category, none, or one. */
export type CategoryFilter = "all" | "none" | string;

export interface ListFilters {
  group: StatusGroup;
  category: CategoryFilter;
  search: string;
}

export const EMPTY_FILTERS: ListFilters = { group: "all", category: "all", search: "" };

/** True when anything narrows the list. */
export function isFiltered(f: ListFilters): boolean {
  return f.group !== "all" || f.category !== "all" || sanitizeSearch(f.search) !== "";
}

/** A stable string for "the same filters", to know when the list must start again. */
export function filtersKey(f: ListFilters): string {
  return `${f.group}|${f.category}|${sanitizeSearch(f.search).toLowerCase()}`;
}

/**
 * A search text made safe to place inside a PostgREST filter list: the characters that would end or
 * change the filter (comma, brackets, quotes, wildcards, backslash) become spaces. At most 80 characters.
 */
export function sanitizeSearch(raw: string): string {
  return raw.replace(/[,()%*\\"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * The `or(...)` filter for a search: title or reference contains the text, or the document is one of
 * those a signer matched (`signerDocumentIds`). Null when there is nothing to search for.
 */
export function searchClause(raw: string, signerDocumentIds: readonly string[] = []): string | null {
  const q = sanitizeSearch(raw);
  if (!q) return null;
  const parts = [`title.ilike.%${q}%`, `reference.ilike.%${q}%`];
  const ids = signerDocumentIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length) parts.push(`id.in.(${ids.join(",")})`);
  return parts.join(",");
}

/** The `or(...)` filter that finds the people a search text matches (their name or email). */
export function signerSearchClause(raw: string): string | null {
  const q = sanitizeSearch(raw);
  return q ? `full_name.ilike.%${q}%,email.ilike.%${q}%` : null;
}

/** The inclusive range of rows to read to have `count` rows after the `loaded` already shown. */
export function pageRange(loaded: number, count: number = PAGE_SIZE): { from: number; to: number } {
  const from = Math.max(0, Math.floor(loaded));
  return { from, to: from + Math.max(1, Math.floor(count)) - 1 };
}

/** An open document that stops accepting signatures within `days` days (and has not stopped yet). */
export function isExpiringSoon(status: string, expiresAt: string | null, nowMs: number, days = 3): boolean {
  if (!expiresAt || (status !== "sent" && status !== "in_progress")) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t > nowMs && t - nowMs <= days * 24 * 3600 * 1000;
}
