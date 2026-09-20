"use client";

import { useEffect, useState } from "react";

// One shared 30-second clock for every SLA countdown on screen. A board can
// show hundreds of badges; each one asking for its own interval would mean
// hundreds of timers, so they all subscribe to a single one that runs only
// while somebody is listening.

const TICK_MS = 30_000;
const subscribers = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: (now: number) => void): () => void {
  subscribers.add(fn);
  if (timer === null) {
    timer = setInterval(() => {
      const now = Date.now();
      for (const s of subscribers) s(now);
    }, TICK_MS);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/**
 * The current time (ms), refreshed every 30 seconds from the shared clock.
 * `enabled` false takes no part in the clock (the value stays as it was).
 */
export function useSharedNow(enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    // Catch up at once: the value may be a while old when this (re)subscribes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    return subscribe(setNow);
  }, [enabled]);
  return now;
}
