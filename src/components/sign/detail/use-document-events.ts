"use client";

// ============================================================
// Doc Sign, the history of a document: the rows of `sign_events` (readable by anyone with `menu.sign`, through
// row level security) and the live check of the hash chain (`sign_verify_chain`, which checks the same
// capability itself and is granted to signed-in people).
// ============================================================

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

import { chainState, EVENT_COLUMNS, type ChainState, type SignEventRow } from "./events";

interface Loaded {
  key: string;
  events: SignEventRow[] | null;
  chain: ChainState | null;
}

/** `version` changes when the document changed, so the history is read again. */
export function useDocumentEvents(documentId: string, version: number) {
  const key = `${documentId}|${version}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data, error } = await supabase.from("sign_events").select(EVENT_COLUMNS).eq("document_id", documentId).order("doc_seq", { ascending: true }).limit(1000);
      if (cancelled) return;
      if (error) {
        console.error("[sign] could not read the history:", error.message);
        // Keep what was shown if there was something; otherwise say it failed.
        setLoaded((prev) => (prev && prev.events ? { ...prev, key } : { key, events: null, chain: null }));
        return;
      }
      setLoaded({ key, events: (data ?? []) as SignEventRow[], chain: null });
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
    loading: mine === null,
    failed: mine !== null && mine.events === null,
  };
}
