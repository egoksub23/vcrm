"use client";

// ============================================================
// Doc Sign forms, the sender's progress view: read how far the people on a form document have got (through the
// route, which checks the capability), read it again after an action, and keep it fresh with a light poll while
// someone may still fill it in. Same pattern as the document detail: each read has a number, a late answer is
// dropped, a blink of the connection never replaces what is on screen, and the poll pauses while the tab is hidden.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

import type { StaffProgress } from "@/lib/sign/forms/api-types";
import { SignApiError, signRequest } from "@/lib/sign/client/api";

/** How often the screen asks again while the document is open (milliseconds). */
export const PROGRESS_POLL_MS = 10_000;

interface Slot {
  id: string;
  data: StaffProgress | null;
  error: SignApiError | null;
}

/**
 * `enabled`: read at all (a form document whose Progress tab is open). `poll`: keep reading while the document can
 * still change. The answers of a finished document are read once.
 */
export function useSignProgress(documentId: string, enabled: boolean, poll: boolean) {
  const [slot, setSlot] = useState<Slot | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++sequence.current;
    try {
      const data = await signRequest<StaffProgress>(`/api/sign/documents/${documentId}/progress`);
      if (mine !== sequence.current) return;
      setSlot({ id: documentId, data, error: null });
    } catch (err) {
      if (mine !== sequence.current) return;
      const error = err instanceof SignApiError ? err : new SignApiError("network", "Could not reach the server.", 0);
      setSlot((prev) => (prev && prev.id === documentId && prev.data && error.code === "network" ? prev : { id: documentId, data: null, error }));
    }
  }, [documentId]);

  useEffect(() => {
    if (!enabled) return;
    // Read after the render that turned it on (state is not set inside the effect body itself).
    const first = window.setTimeout(() => void load(), 0);
    const counter = sequence;
    return () => {
      window.clearTimeout(first);
      counter.current++;
    };
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || !poll) return;
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(tick, PROGRESS_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, poll, load]);

  const current = slot && slot.id === documentId ? slot : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: enabled && current === null,
    /** Read again now (after an action). */
    reload: load,
  };
}
