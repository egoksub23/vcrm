"use client";

import { useCallback, useEffect, useState } from "react";

/** How often the sidebar asks again, in ms (the Secure Sign badge and the approvals count refresh the same way). */
const REFRESH_MS = 60_000;

/**
 * How many Compliance requests wait for THIS person: cases awaiting their sign-off (compliance.approve) and cases waiting for an identity check or an
 * officer's review (compliance.review). Nothing is asked of the server when `enabled` is false (the person holds neither permission, or the area is off);
 * the server answers 0 for anyone else too, so it cannot leak. Refreshes on focus and on a slow interval, and when a screen says something moved
 * (`notifyComplianceChanged`).
 */
export function useComplianceWaiting(enabled: boolean): { count: number; refresh: () => void } {
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    if (!enabled) return;
    fetch("/api/compliance/badge", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { count?: number } | null) => {
        if (d && typeof d.count === "number") setCount(d.count);
      })
      .catch(() => {});
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("vircle:compliance-changed", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("vircle:compliance-changed", onFocus);
    };
  }, [enabled, refresh]);

  return { count: enabled ? count : 0, refresh };
}

/** Tell every mounted badge to ask again (after a case moved). */
export function notifyComplianceChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("vircle:compliance-changed"));
}
