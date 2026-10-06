"use client";

import { useCallback, useEffect, useState } from "react";

import { SignApiError, signRequest, type SignIssue } from "@/lib/sign/client/api";
import type { EnvelopeBrief } from "@/lib/sign/service/envelopes";
import type { SignDocumentRow, SignSignerRow } from "@/lib/sign/types";

export interface DraftData {
  document: SignDocumentRow;
  signers: SignSignerRow[];
  files: { id: string; kind: string; name: string; mime: string | null; size_bytes: number }[];
  /** What stops the draft being sent, as the server saw it when this was read. */
  problems: SignIssue[];
  /** Migration 171: the envelope this draft is a document of, with its siblings (their titles and states); null for a document on its own. */
  envelope?: EnvelopeBrief | null;
}

interface Slot {
  id: string;
  data: DraftData | null;
  error: SignApiError | null;
}

/**
 * One draft as the server holds it: the document, its saved signing list and what still stops it being
 * sent. `reload` reads it again (after the fields editor or a save changed something) and resolves with
 * the fresh copy; `setDocument` swaps in the row a save returned without another read.
 */
export function useSignDraft(documentId: string) {
  const [slot, setSlot] = useState<Slot | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await signRequest<DraftData>(`/api/sign/documents/${documentId}`, { signal: controller.signal });
        setSlot({ id: documentId, data, error: null });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setSlot({ id: documentId, data: null, error: err instanceof SignApiError ? err : new SignApiError("request_failed", "Request failed.", 0) });
      }
    })();
    return () => controller.abort();
  }, [documentId, tick]);

  const reload = useCallback(async (): Promise<DraftData | null> => {
    try {
      const data = await signRequest<DraftData>(`/api/sign/documents/${documentId}`);
      setSlot({ id: documentId, data, error: null });
      return data;
    } catch (err) {
      setSlot((prev) => (prev && prev.id === documentId && prev.data ? prev : { id: documentId, data: null, error: err instanceof SignApiError ? err : new SignApiError("request_failed", "Request failed.", 0) }));
      return null;
    }
  }, [documentId]);

  const retry = useCallback(() => setTick((t) => t + 1), []);

  const setDocument = useCallback((document: SignDocumentRow) => {
    setSlot((prev) => (prev && prev.data && prev.data.document.id === document.id ? { ...prev, data: { ...prev.data, document } } : prev));
  }, []);

  const current = slot && slot.id === documentId ? slot : null;
  return { data: current?.data ?? null, error: current?.error ?? null, loading: !current, reload, retry, setDocument };
}
