"use client";

// ============================================================
// Doc Sign, signing page: dates in the signer's language and the signer's own time zone. The server
// renders the first paint without knowing the time zone, so the zone is UTC until the page is in the
// browser, then the browser's own (useSyncExternalStore keeps the two renders from disagreeing).
// ============================================================

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export function useBrowserTimeZone(): string {
  return useSyncExternalStore(subscribe, browserZone, () => "UTC");
}

/** "20 Oct 2026" in the language, for an ISO instant. Empty for something that is not a date. */
export function formatDay(iso: string | null | undefined, locale: string, timeZone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(date);
  }
}
