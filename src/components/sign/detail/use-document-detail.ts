"use client";

// ============================================================
// Doc Sign, the detail screen: load a document that was sent (through the route, which checks the capability),
// load it again after every action, and keep it fresh with a light poll while it can still change. The poll
// pauses while the tab is hidden and catches up the moment the tab is shown again.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

import { SignApiError, signRequest } from "@/lib/sign/client/api";
import type { EnvelopeBrief } from "@/lib/sign/service/envelopes";
import type { SignCopyRecipientRow, SignDocumentRow, SignSignerRow } from "@/lib/sign/types";

import { POLL_MS, shouldPoll } from "./logic";

export interface DetailFile {
  id: string;
  kind: "source" | "converted" | "annex" | "signer_upload" | "signed" | "certificate";
  name: string;
  mime: string | null;
  size_bytes: number;
  sha256: string | null;
  created_at: string;
}

export interface DocumentDetailData {
  document: SignDocumentRow;
  signers: SignSignerRow[];
  files: DetailFile[];
  /** Migration 171: the envelope this document is one of, with its siblings' titles and states; null for a document on its own. */
  envelope?: EnvelopeBrief | null;
  /** Migration 175: the people who receive the signed copy of a document on its own (a document of a collection has none of its own). Not signers. */
  copies?: SignCopyRecipientRow[];
}

interface Result {
  id: string;
  data: DocumentDetailData | null;
  error: SignApiError | null;
}

/** Changes whenever something the screen shows has changed, so the history is read again only then. */
export function dataFingerprint(d: DocumentDetailData): string {
  const last = d.signers.reduce((m, s) => (s.updated_at > m ? s.updated_at : m), "");
  const copies = d.copies ?? [];
  const copyPrint = copies.map((c) => `${c.id}:${c.notified_at ?? ""}`).join(",");
  return `${d.document.updated_at}|${d.signers.length}|${last}${copies.length > 0 ? `|${copyPrint}` : ""}`;
}

export function useDocumentDetail(documentId: string) {
  const [result, setResult] = useState<Result | null>(null);
  /** Bumped when the data changed (or an action asks for a fresh read), for the history to follow. */
  const [version, setVersion] = useState(0);
  // Each read gets a number; a read that finishes after a newer one started, or after the screen left, is dropped.
  const sequence = useRef(0);
  const printRef = useRef("");

  const load = useCallback(
    async (force = false): Promise<void> => {
      const mine = ++sequence.current;
      try {
        const body = await signRequest<{ document: SignDocumentRow; signers: SignSignerRow[]; files: DetailFile[]; envelope?: EnvelopeBrief | null; copies?: SignCopyRecipientRow[] }>(`/api/sign/documents/${documentId}`);
        if (mine !== sequence.current) return;
        const data: DocumentDetailData = { document: body.document, signers: body.signers ?? [], files: body.files ?? [], envelope: body.envelope ?? null, copies: body.copies ?? [] };
        const print = dataFingerprint(data);
        if (force || print !== printRef.current) {
          printRef.current = print;
          setVersion((v) => v + 1);
        }
        setResult({ id: documentId, data, error: null });
      } catch (err) {
        if (mine !== sequence.current) return;
        const error = err instanceof SignApiError ? err : new SignApiError("network", "Could not reach the server.", 0);
        // A poll that fails because the connection blinked must not replace what is on screen.
        setResult((prev) => (prev && prev.id === documentId && prev.data && error.code === "network" ? prev : { id: documentId, data: null, error }));
      }
    },
    [documentId],
  );

  useEffect(() => {
    void load(true);
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
    };
  }, [load]);

  const current = result && result.id === documentId ? result : null;
  const status = current?.data?.document.status ?? null;

  // Light polling while the document can still change; paused while the tab is hidden.
  useEffect(() => {
    if (!status || !shouldPoll(status)) return;
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

  /** Read the document again now (after an action). The history is read again too. */
  const reload = useCallback(() => load(true), [load]);

  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: current === null,
    version,
    reload,
  };
}
