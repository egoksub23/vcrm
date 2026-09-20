// ============================================================
// Pure helpers for the ticket side of the Jira link: status lozenge colours,
// which banners a card shows, error code -> message key, pasted key / URL
// parsing and small formatters. No I/O, no React, safe on the client.
// ============================================================

import type { JiraStatusCategory, SyncState, TicketJiraLinkRow } from "@/lib/jira/types";

/** What a board card or list row shows for one linked issue. */
export interface JiraChip {
  key: string;
  category: JiraStatusCategory | null;
  url: string | null;
  state: SyncState;
}

/** Soft tinted lozenge per Jira status category, readable in light and dark. */
export const CATEGORY_TONE: Record<JiraStatusCategory, string> = {
  new: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  indeterminate: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  undefined: "bg-muted text-muted-foreground",
};

export function normalizeCategory(value: string | null | undefined): JiraStatusCategory {
  return value === "new" || value === "indeterminate" || value === "done" ? value : "undefined";
}

export function categoryTone(value: string | null | undefined): string {
  return CATEGORY_TONE[normalizeCategory(value)];
}

/** Jira text and URLs are untrusted: only http(s) addresses become links. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The address of an issue: the cached one, else built from the site address. */
export function issueUrlOf(link: Pick<TicketJiraLinkRow, "issue_url" | "issue_key">, siteUrl?: string | null): string | null {
  const cached = safeHttpUrl(link.issue_url);
  if (cached) return cached;
  const site = safeHttpUrl(siteUrl);
  if (!site || !link.issue_key) return null;
  return `${site.replace(/\/+$/, "")}/browse/${encodeURIComponent(link.issue_key)}`;
}

// ------------------------------------------------------------
// Banners
// ------------------------------------------------------------

export type JiraBanner = "not_found" | "no_access" | "paused" | "reconnect" | "no_transition" | "screen_fields" | "permission";

/** The notices a link card shows, most important first. */
export function bannersFor(
  link: Pick<TicketJiraLinkRow, "sync_state" | "sync_error" | "last_push">,
  opts: { needsReconnect: boolean },
): JiraBanner[] {
  const out: JiraBanner[] = [];
  if (link.sync_state === "broken") {
    out.push(link.sync_error === "no_access" ? "no_access" : "not_found");
  } else if (opts.needsReconnect) {
    out.push("reconnect");
  } else if (link.sync_state === "paused") {
    out.push("paused");
  }
  const push = link.last_push;
  if (link.sync_state === "ok" && push && push.ok === false) {
    if (push.reason === "no_transition" || push.reason === "screen_fields" || push.reason === "permission") {
      out.push(push.reason);
    }
  }
  return out;
}

// ------------------------------------------------------------
// Errors
// ------------------------------------------------------------

/** Codes that have their own sentence in Jira.errors; anything else falls back to "generic". */
export const KNOWN_ERROR_CODES = [
  "reauth_required",
  "no_connection",
  "jira_not_configured",
  "jira_permission",
  "jira_not_found",
  "jira_rate_limited",
  "jira_rejected",
  "jira_unavailable",
  "link_limit",
  "already_linked",
  "project_not_allowed",
  "bad_reference",
  "unsupported_fields",
  "missing_fields",
  "no_permission",
  "transition_unavailable",
  "resync_too_soon",
  "toggle_off",
  "not_shareable",
  "no_links",
  "link_not_ok",
  "forbidden",
  "network",
  "inactive",
  "not_found",
  "bad_request",
  // 0.45.0: bulk actions and attachments
  "bulk_limit",
  "too_large",
  "issue_full",
  "mime_refused",
  "mime_mismatch",
  "active_content",
  "attachments_disabled",
  "already",
  "duplicate",
  "from_jira",
  "bad_path",
] as const;

export type JiraErrorCode = (typeof KNOWN_ERROR_CODES)[number];

export function errorKeyOf(code: string | null | undefined): JiraErrorCode | "generic" {
  return (KNOWN_ERROR_CODES as readonly string[]).includes(code ?? "") ? (code as JiraErrorCode) : "generic";
}

// ------------------------------------------------------------
// Pasted references
// ------------------------------------------------------------

const KEY_RE = /\b([A-Za-z][A-Za-z0-9_]{1,9}-\d{1,9})\b/;

/** The issue key in what an agent pasted (a key, a /browse/ URL or a selectedIssue URL), or null. */
export function extractIssueKey(input: string): string | null {
  const s = input.trim();
  if (!s || s.length > 500) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const fromQuery = u.searchParams.get("selectedIssue") ?? u.searchParams.get("issueKey");
    const m = KEY_RE.exec(fromQuery ?? "") ?? KEY_RE.exec(u.pathname);
    return m ? m[1].toUpperCase() : null;
  } catch {
    // not a URL
  }
  return /^[A-Za-z][A-Za-z0-9_]{1,9}-\d{1,9}$/.test(s) ? s.toUpperCase() : null;
}

// ------------------------------------------------------------
// Chips and forms
// ------------------------------------------------------------

/** At most `max` chips are shown; the rest collapse into "+N". */
export function visibleChips<T>(chips: readonly T[], max = 2): { shown: T[]; extra: number } {
  return { shown: chips.slice(0, max), extra: Math.max(0, chips.length - max) };
}

/** Has a required create field been given a usable value? */
export function fieldHasValue(kind: string, value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    const v = value.trim();
    if (!v) return false;
    return kind === "number" ? Number.isFinite(Number(v)) : true;
  }
  return false;
}

/** Split free text into label words (Jira labels have no spaces). */
export function splitLabels(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 10);
}

/** A whole-number count of seconds for a "try again in N seconds" message. */
export function retrySeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.ceil(value)) : 30;
}

/**
 * A translator for keys built at run time (error codes, categories): the
 * typed `t` refuses a computed key together with values, so it is viewed
 * loosely here. A missing key still throws in the render tests.
 */
export type LooseTranslate = (key: string, values?: Record<string, string | number>) => string;
export const loose = (t: unknown): LooseTranslate => t as LooseTranslate;
