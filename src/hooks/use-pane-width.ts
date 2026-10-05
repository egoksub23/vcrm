"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A panel width the person can drag, remembered in this browser only (a personal
 * layout preference, not a workspace setting). Renders the default first and reads the
 * stored value after mount, so the server and the first client render agree.
 * `setWidth` moves it live while dragging; `commit` stores it once the drag ends.
 */
export function usePaneWidth(storageKey: string, defaultPx: number) {
  const [width, setWidthState] = useState(defaultPx);
  const latest = useRef(defaultPx);

  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(stored) && stored > 0) {
        latest.current = stored;
        // Reconcile with the stored value after mount (see the note above): reading it in the
        // initializer would make the server and first client render disagree.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setWidthState(stored);
      }
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, [storageKey]);

  const setWidth = useCallback((px: number) => {
    latest.current = px;
    setWidthState(px);
  }, []);

  const commit = useCallback(() => {
    try {
      localStorage.setItem(storageKey, String(Math.round(latest.current)));
    } catch {
      // Persistence is best-effort.
    }
  }, [storageKey]);

  const reset = useCallback(() => {
    latest.current = defaultPx;
    setWidthState(defaultPx);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Persistence is best-effort.
    }
  }, [storageKey, defaultPx]);

  return { width, setWidth, commit, reset };
}
