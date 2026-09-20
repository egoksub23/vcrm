// ============================================================
// Which menu capability guards which dashboard page, plus the pure
// helpers the sidebar, the page guard and the "no access" state share.
// No React, no I/O: unit-tested in page-access.test.ts.
//
// A capability check here is a UI convenience: the API routes and the
// database still enforce their own capability.
// ============================================================

import type { CapabilityKey } from "./capabilities";

export interface PageAccessEntry {
  /** Path prefix. Matches the path itself and everything below it. */
  prefix: string;
  /** The menu capability that unlocks the page. */
  cap: CapabilityKey;
  /** Key in the `Sidebar` i18n namespace holding the page name. */
  labelKey: string;
}

/**
 * Display order = sidebar order. `firstAccessiblePage` walks this list.
 * Deep links (/automations/[id]/edit, /knowledge/new, /flows/[id]/runs,
 * /broadcasts/new ...) fall under their section's prefix.
 */
export const PAGE_ACCESS: readonly PageAccessEntry[] = [
  { prefix: "/dashboard", cap: "menu.dashboard", labelKey: "dashboard" },
  { prefix: "/inbox", cap: "menu.inbox", labelKey: "inbox" },
  { prefix: "/notifications", cap: "menu.notifications", labelKey: "notifications" },
  { prefix: "/contacts", cap: "menu.contacts", labelKey: "contacts" },
  { prefix: "/pipelines", cap: "menu.pipelines", labelKey: "pipelines" },
  { prefix: "/broadcasts", cap: "menu.broadcasts", labelKey: "broadcasts" },
  { prefix: "/tickets", cap: "menu.tickets", labelKey: "tickets" },
  { prefix: "/automations", cap: "menu.automations", labelKey: "automations" },
  { prefix: "/flows", cap: "menu.flows", labelKey: "flows" },
  { prefix: "/knowledge", cap: "menu.knowledge", labelKey: "knowledge" },
  { prefix: "/agents", cap: "menu.agents", labelKey: "aiAgents" },
  { prefix: "/reports", cap: "menu.reports", labelKey: "reports" },
  { prefix: "/settings", cap: "menu.settings", labelKey: "settings" },
];

function matches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Normalise `/inbox/` and drop any query or hash a caller passed in. */
function cleanPath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] ?? "";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The entry guarding `pathname`, or null for paths that are not guarded. */
export function pageAccessForPath(
  pathname: string | null | undefined,
): PageAccessEntry | null {
  if (!pathname) return null;
  const path = cleanPath(pathname);
  return PAGE_ACCESS.find((e) => matches(path, e.prefix)) ?? null;
}

/** The menu capability guarding `pathname`; null = not guarded. */
export function capabilityForPath(
  pathname: string | null | undefined,
): CapabilityKey | null {
  return pageAccessForPath(pathname)?.cap ?? null;
}

/** The first page (sidebar order) the caller may open, or null. */
export function firstAccessiblePage(
  has: (cap: string) => boolean,
): PageAccessEntry | null {
  return PAGE_ACCESS.find((e) => has(e.cap)) ?? null;
}

/**
 * Keep the items the caller may see. An item without a `capability`
 * is always kept.
 */
export function filterByCapability<T extends { capability?: string }>(
  items: readonly T[],
  has: (cap: string) => boolean,
): T[] {
  return items.filter((i) => !i.capability || has(i.capability));
}
