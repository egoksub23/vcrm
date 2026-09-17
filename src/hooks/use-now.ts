"use client";

import { useEffect, useState } from "react";

/**
 * Current timestamp (ms), refreshed every `intervalMs`.
 *
 * Reading `Date.now()` directly during render is impure
 * (react-hooks/purity — the same value must come out of a render given
 * the same props/state) — this hook moves that read into state instead
 * (the lazy `useState` initializer, same pattern `usePresence` already
 * uses for its own ticking clock), and gives "aging" indicators (the
 * Inbox's awaiting-response chip) a live tick for free rather than
 * only updating whenever something else causes a re-render.
 */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
