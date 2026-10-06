"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchAttention, fetchAwaiting, type AttentionItem, type AwaitingItem, type ShortcutList } from "@/lib/sign/client/countersign";

/** How often the shortcut counts are asked again while the tab is visible. */
export const SHORTCUT_POLL_MS = 60_000;

interface State<T> {
  items: T[];
  count: number;
  loading: boolean;
  failed: boolean;
}

/**
 * One of the two shortcut lists of Doc Sign (documents awaiting my signature, documents that need attention). Read when
 * the screen opens, when the window regains focus (at most every five seconds) and every minute while visible. `enabled`
 * false reads nothing at all (a person without the capability, or while the capabilities are still loading).
 */
function useShortcut<T>(enabled: boolean, fetcher: (signal?: AbortSignal) => Promise<ShortcutList<T>>) {
  const [state, setState] = useState<State<T>>({ items: [], count: 0, loading: enabled, failed: false });
  const [tick, setTick] = useState(0);
  const last = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    last.current = Date.now();
    fetcher(controller.signal)
      .then((r) => setState({ items: r.items ?? [], count: r.count ?? (r.items ?? []).length, loading: false, failed: false }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        // a failed refresh keeps what is on screen; the first read that fails shows the failure
        console.error("[useSignShortcuts] read failed:", err instanceof Error ? err.message : err);
        setState((prev) => ({ ...prev, loading: false, failed: true }));
      });
    return () => controller.abort();
  }, [enabled, fetcher, tick]);

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => setTick((n) => n + 1);
    const onFocus = () => {
      if (document.visibilityState === "visible" && Date.now() - last.current > 5000) refresh();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, SHORTCUT_POLL_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, items: enabled ? state.items : [], count: enabled ? state.count : 0, reload };
}

/** The documents waiting for the signed-in person to sign (sign.sign). */
export const useAwaitingSignature = (enabled: boolean) => useShortcut<AwaitingItem>(enabled, fetchAwaiting);

/** The documents that stopped or whose message did not arrive (menu.sign). */
export const useNeedsAttention = (enabled: boolean) => useShortcut<AttentionItem>(enabled, fetchAttention);
