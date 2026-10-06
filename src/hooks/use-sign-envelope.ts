"use client";

// ============================================================
// Doc Sign, an envelope's screens (migration 171): load the envelope through its route (which checks the capability), load it again after every
// action, and keep it fresh with a light poll while it can still change (paused while the tab is hidden). A draft is not polled: its screen
// holds the sender's own edits.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

import { SignApiError, signRequest } from "@/lib/sign/client/api";
import type { EnvelopeData } from "@/lib/sign/service/envelopes";

export type { EnvelopeData };

const POLL_MS = 10_000;
const OPEN_STATUSES = new Set(["sent", "in_progress", "sealing"]);

interface Result {
  id: string;
  data: EnvelopeData | null;
  error: SignApiError | null;
}

export function useSignEnvelope(envelopeId: string) {
  const [result, setResult] = useState<Result | null>(null);
  // Each read gets a number; a read that finishes after a newer one started, or after the screen left, is dropped.
  const sequence = useRef(0);

  const load = useCallback(async (): Promise<EnvelopeData | null> => {
    const mine = ++sequence.current;
    try {
      const data = await signRequest<EnvelopeData>(`/api/sign/envelopes/${envelopeId}`);
      if (mine !== sequence.current) return null;
      setResult({ id: envelopeId, data, error: null });
      return data;
    } catch (err) {
      if (mine !== sequence.current) return null;
      const error = err instanceof SignApiError ? err : new SignApiError("network", "Could not reach the server.", 0);
      // A poll that fails because the connection blinked must not replace what is on screen.
      setResult((prev) => (prev && prev.id === envelopeId && prev.data && error.code === "network" ? prev : { id: envelopeId, data: null, error }));
      return null;
    }
  }, [envelopeId]);

  useEffect(() => {
    void load();
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
    };
  }, [load]);

  const current = result && result.id === envelopeId ? result : null;
  const status = current?.data?.envelope.status ?? null;

  useEffect(() => {
    if (!status || !OPEN_STATUSES.has(status)) return;
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [status, load]);

  return { data: current?.data ?? null, error: current?.error ?? null, loading: current === null, reload: load };
}
