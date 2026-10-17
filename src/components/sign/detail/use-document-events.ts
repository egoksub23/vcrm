"use client";

// ============================================================
// Doc Sign, the history of a document: the rows of `sign_events` (readable by anyone with `menu.sign`, through
// row level security) and the live check of the hash chain (`sign_verify_chain`, which checks the same
// capability itself and is granted to signed-in people).
//
// A `writeback` event holds the contact's old and new value in its `detail`. Those are personal data, so the
// browser does not select them: write-back rows are read apart, with only the field and the contact
// (`WRITEBACK_COLUMNS`), and the values come from the server (`GET .../writebacks`), which gives the real ones
// only to a person who holds sign.reveal-sensitive and a mask to everyone else.
// ============================================================

import { useEffect, useState } from "react";

import { SignApiError, signRequest } from "@/lib/sign/client/api";
import type { WritebackHistory } from "@/lib/sign/forms/api-types";
import { createClient } from "@/lib/supabase/client";

import { chainState, EVENT_COLUMNS, WRITEBACK_COLUMNS, writebackEventRow, type ChainState, type SignEventRow } from "./events";

interface Loaded {
  key: string;
  events: SignEventRow[] | null;
  chain: ChainState | null;
  writebacks: WritebackHistory | null;
}

/** `version` changes when the document changed, so the history is read again. */
export function useDocumentEvents(documentId: string, version: number) {
  const key = `${documentId}|${version}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      // everything but the write-backs, in full; the write-backs without their values
      const [rest, writes] = await Promise.all([
        supabase.from("sign_events").select(EVENT_COLUMNS).eq("document_id", documentId).neq("type", "writeback").order("doc_seq", { ascending: true }).limit(1000),
        supabase.from("sign_events").select(WRITEBACK_COLUMNS).eq("document_id", documentId).eq("type", "writeback").order("doc_seq", { ascending: true }).limit(500),
      ]);
      if (cancelled) return;
      const error = rest.error ?? writes.error;
      if (error) {
        console.error("[sign] could not read the history:", error.message);
        // Keep what was shown if there was something; otherwise say it failed.
        setLoaded((prev) => (prev && prev.events ? { ...prev, key } : { key, events: null, chain: null, writebacks: null }));
        return;
      }
      const events = [...((rest.data ?? []) as unknown as SignEventRow[]), ...((writes.data ?? []) as unknown as Parameters<typeof writebackEventRow>[0][]).map(writebackEventRow)];
      setLoaded({ key, events, chain: null, writebacks: null });
      // The values of the write-backs come from the server, which decides who may see them.
      if (writes.data && writes.data.length > 0) {
        let writebacks: WritebackHistory | null = null;
        try {
          writebacks = await signRequest<WritebackHistory>(`/api/sign/documents/${encodeURIComponent(documentId)}/writebacks`);
        } catch (err) {
          if (!(err instanceof SignApiError)) console.error("[sign] could not read the contact changes");
        }
        if (cancelled) return;
        setLoaded((prev) => (prev && prev.key === key ? { ...prev, writebacks } : prev));
      }
      // The chain check is a second call: the list does not wait for it.
      const check = await supabase.rpc("sign_verify_chain", { p_document: documentId });
      if (cancelled) return;
      const chain: ChainState = check.error ? { state: "unknown" } : chainState(check.data);
      setLoaded((prev) => (prev && prev.key === key ? { ...prev, chain } : prev));
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId, key]);

  // Another document's rows are never shown.
  const mine = loaded && loaded.key.startsWith(`${documentId}|`) ? loaded : null;
  return {
    events: mine?.events ?? null,
    /** null while it is being checked. */
    chain: mine?.key === key ? mine.chain : null,
    /** The contact changes with their values as the server allows this reader to see them; null until they arrive (or when they could not be read). */
    writebacks: mine?.key === key ? mine.writebacks : null,
    loading: mine === null,
    failed: mine !== null && mine.events === null,
  };
}
