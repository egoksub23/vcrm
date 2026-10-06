"use client";

// A SaveQueue (src/lib/sign/client/save-queue.ts) for a component: its state as React state, a warning when the
// page is closed with unsaved changes, a send when the tab is hidden, and a last send when the screen is left.

import { useEffect, useRef, useState } from "react";

import { SaveQueue, type SaveState } from "@/lib/sign/client/save-queue";

import { useStableCallback } from "./use-editor-model";

export interface UseSaveQueue<T> {
  state: SaveState;
  schedule: (value: T) => void;
  cancel: () => void;
  /** Send now; resolves when done. Check `unsaved()` afterwards to know whether it worked. */
  flush: () => Promise<void>;
  unsaved: () => boolean;
}

export function useSaveQueue<T>(send: (value: T) => Promise<unknown>): UseSaveQueue<T> {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const sendLatest = useStableCallback(send);
  const queue = useRef<SaveQueue<T> | null>(null);

  useEffect(() => {
    const q = new SaveQueue<T>({ send: (v) => sendLatest(v), onState: setState });
    queue.current = q;
    const onHide = () => {
      if (document.visibilityState === "hidden" && q.unsaved) void q.flush();
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!q.unsaved) return;
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
      queue.current = null;
      q.disposeAndSend();
    };
  }, [sendLatest]);

  return {
    state,
    schedule: (value) => queue.current?.schedule(value),
    cancel: () => queue.current?.cancel(),
    flush: async () => {
      await queue.current?.flush();
    },
    unsaved: () => queue.current?.unsaved ?? false,
  };
}
