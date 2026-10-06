"use client";

import { useCallback, useMemo, useState } from "react";

import { toggleId, toggleMany } from "@/lib/sign/client/selection";

/**
 * The documents ticked in the list. The selection starts again when `resetKey` changes (other filters mean other
 * documents), and never holds more than `max`.
 */
export function useSelection(resetKey: string, max: number) {
  const [state, setState] = useState<{ key: string; ids: string[] }>({ key: resetKey, ids: [] });
  const ids = useMemo(() => (state.key === resetKey ? state.ids : []), [state, resetKey]);
  const selected = useMemo(() => new Set(ids), [ids]);

  const toggle = useCallback((id: string) => setState((s) => ({ key: resetKey, ids: toggleId(s.key === resetKey ? s.ids : [], id, max) })), [resetKey, max]);
  const toggleAll = useCallback((these: readonly string[], on: boolean) => setState((s) => ({ key: resetKey, ids: toggleMany(s.key === resetKey ? s.ids : [], these, on, max) })), [resetKey, max]);
  const clear = useCallback(() => setState({ key: resetKey, ids: [] }), [resetKey]);

  return { ids, selected, count: ids.length, full: ids.length >= max, max, toggle, toggleAll, clear };
}
