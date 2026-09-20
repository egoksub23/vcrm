"use client";

import { useCallback, useEffect, useState } from "react";

import { useCapability } from "@/hooks/use-auth";

/** Same value the sidebar / settings rail refresh on, in ms. */
const REFRESH_MS = 60_000;

/**
 * How many proposals wait for a decision, for the badge on Settings and on
 * the Approvals section. 0 (and no request at all) for anyone without
 * `approvals.review`; the server returns 0 for them too, so it cannot leak.
 * Refreshes on focus and on a slow interval; `refresh()` is for the queue
 * itself, right after a decision.
 */
export function useApprovalsCount(): { count: number; refresh: () => void } {
  const canReview = useCapability("approvals.review");
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    if (!canReview) return;
    fetch("/api/account/approvals/count", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { count?: number } | null) => {
        if (d && typeof d.count === "number") setCount(d.count);
      })
      .catch(() => {});
  }, [canReview]);

  useEffect(() => {
    if (!canReview) return;
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("vircle:approvals-changed", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("vircle:approvals-changed", onFocus);
    };
  }, [canReview, refresh]);

  return { count: canReview ? count : 0, refresh };
}

/** Tell every mounted badge to refresh (after a decision or a new proposal). */
export function notifyApprovalsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("vircle:approvals-changed"));
  }
}
