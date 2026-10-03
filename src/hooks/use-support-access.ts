"use client";

import { useCallback, useEffect, useState } from "react";

import type { SupportGrant, SupportLogEntry } from "@/lib/platform/support";

export interface SupportAccessView {
  grants: SupportGrant[];
  log: SupportLogEntry[];
}

/** Fired after the owner allows or ends support access, so the notice above the pages follows. */
export const SUPPORT_ACCESS_CHANGED = "vircle:support-access-changed";

/** The workspace's support-access grants and the log of looks, for admins; null while loading or when unavailable. */
export function useSupportAccess(enabled: boolean): { data: SupportAccessView | null; reload: () => void } {
  const [data, setData] = useState<SupportAccessView | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void fetch("/api/account/support-access", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<SupportAccessView>) : null))
      .catch(() => null)
      .then((v) => {
        if (alive) setData(v);
      });
    return () => {
      alive = false;
    };
  }, [enabled, tick]);

  useEffect(() => {
    const onChange = () => setTick((n) => n + 1);
    window.addEventListener(SUPPORT_ACCESS_CHANGED, onChange);
    return () => window.removeEventListener(SUPPORT_ACCESS_CHANGED, onChange);
  }, []);

  const reload = useCallback(() => {
    window.dispatchEvent(new Event(SUPPORT_ACCESS_CHANGED));
  }, []);

  return { data: enabled ? data : null, reload };
}
