// ============================================================
// Doc Sign, browser side: the documents list's filters turned into what the database is asked. Pure, so the
// rules (which statuses make a group, how a search is made safe, how a page is cut) are tested.
// ============================================================

import type { DocumentStatus } from "../types";

export const PAGE_SIZE = 25;

// "test" is the documents sent from a template to try it out (F-10): every status, but only the tests. The other groups include them, marked.
// "cancelled" (migration 181) is the completed documents that were cancelled afterwards: they are still completed in the database, so "completed" leaves
// them out (see GROUP_CANCELLED) and "all" keeps them.
export const STATUS_GROUPS = ["all", "draft", "waiting", "completed", "cancelled", "stopped", "test"] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];

/** The statuses in each group; `null` is "every status". */
export const GROUP_STATUSES: Record<StatusGroup, readonly DocumentStatus[] | null> = {
  all: null,
  draft: ["draft"],
  // "sealing" is the short moment after the last signature while the signed file is made
  waiting: ["sent", "in_progress", "sealing"],
  completed: ["completed"],
  cancelled: ["completed"],
  stopped: ["declined", "expired", "voided", "failed"],
  test: null,
};

/** Of the documents in a group, which to keep: `no` the ones that were not cancelled, `yes` only the cancelled ones, `null` both. */
export const GROUP_CANCELLED: Record<StatusGroup, "yes" | "no" | null> = {
  all: null,
  draft: null,
  waiting: null,
  completed: "no",
  cancelled: "yes",
  stopped: null,
  test: null,
};

/** The part of a PostgREST filter builder that a group's rule uses (each method returns the builder). */
interface GroupFilterable {
  in(column: string, values: readonly string[]): GroupFilterable;
  is(column: string, value: null): GroupFilterable;
  not(column: string, operator: string, value: null): GroupFilterable;
}

/**
 * Narrow a documents or collections query to a status group: its statuses, and (migration 181) whether the cancelled ones are in. "Completed" leaves out the
 * documents that were cancelled afterwards; "Cancelled" is only those; every other group, and no group at all ("All"), takes them as they come. One rule for
 * the list, its counts and the CSV export.
 */
export function narrowByGroup<T>(query: T, group: StatusGroup | null): T {
  if (!group) return query;
  let q = query as unknown as GroupFilterable;
  const statuses = GROUP_STATUSES[group];
  if (statuses) q = q.in("status", statuses);
  const cancelled = GROUP_CANCELLED[group];
  if (cancelled === "no") q = q.is("cancelled_at", null);
  else if (cancelled === "yes") q = q.not("cancelled_at", "is", null);
  return q as unknown as T;
}

/** The category filter: every category, none, or one. */
export type CategoryFilter = "all" | "none" | string;

export interface ListFilters {
  group: StatusGroup;
  category: CategoryFilter;
  search: string;
  /** `YYYY-MM-DD`: documents made on or after this day (in the workspace's time zone). Empty or absent: no start. */
  from?: string;
  /** `YYYY-MM-DD`: documents made on or before this day. Empty or absent: no end. */
  to?: string;
  /** Only the documents of this contact. Null or absent: every contact. */
  contactId?: string | null;
}

export const EMPTY_FILTERS: ListFilters = { group: "all", category: "all", search: "" };

/** True when anything narrows the list. */
export function isFiltered(f: ListFilters): boolean {
  return f.group !== "all" || f.category !== "all" || sanitizeSearch(f.search) !== "" || !!validDay(f.from) || !!validDay(f.to) || !!f.contactId;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` that is a real calendar day, else an empty string (a half-typed or impossible date is no filter). */
export function validDay(v: string | null | undefined): string {
  const m = v ? DAY_RE.exec(v) : null;
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? (v as string) : "";
}

/** True when both days are set and the start is after the end: nothing can match, so the screen says so instead of showing an empty list. */
export const rangeIsBackwards = (f: Pick<ListFilters, "from" | "to">): boolean => {
  const a = validDay(f.from);
  const b = validDay(f.to);
  return a !== "" && b !== "" && a > b;
};

/** A stable string for "the same filters", to know when the list must start again. */
export function filtersKey(f: ListFilters): string {
  return `${f.group}|${f.category}|${sanitizeSearch(f.search).toLowerCase()}|${validDay(f.from)}|${validDay(f.to)}|${f.contactId ?? ""}`;
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
