"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useAccountSse } from "@/hooks/use-account-sse";
import {
  PAGE_SIZE,
  filtersKey,
  narrowByGroup,
  pageRange,
  sanitizeSearch,
  validDay,
  type ListFilters,
  type StatusGroup,
} from "@/lib/sign/client/list-filters";
import { createdRange } from "@/lib/sign/export/documents";
import type { DocumentStatus, SignerKind } from "@/lib/sign/types";
import type { EnvelopeRowExtras } from "@/lib/sign/client/list-merge";

export interface SignListSigner {
  id: string;
  full_name: string;
  status: string;
  order_no: number;
  kind: SignerKind;
  /** A person handed one part of someone's form (migration 166): not counted as a person of the document. */
  part_keys?: string[] | null;
  /** Migration 187: the person this one can sign instead of (the two people of a role are one place in the progress). */
  alternate_of?: string | null;
}

export interface SignListRow {
  id: string;
  reference: string | null;
  title: string;
  status: DocumentStatus;
  /** Migration 169: an agreement to sign, or a form without a signature. */
  mode?: "sign" | "form";
  /** Migration 170: sent from a template to try it out (F-10). */
  test?: boolean;
  /** Migration 176: private (only its uploader, admins and the Halo users named on it can see it): the list marks it with a lock. */
  is_private?: boolean;
  category_id: string | null;
  contact_id: string | null;
  sign_in_order: boolean;
  sent_at: string | null;
  expires_at: string | null;
  completed_at: string | null;
  /** Migration 181: a completed document that was cancelled afterwards (it stays completed; the list shows "Cancelled" instead). */
  cancelled_at?: string | null;
  /** Who made it: they, and the workspace's admins, are offered "Cancel document" on a completed row. */
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  contacts: { name: string | null } | null;
  sign_signers: SignListSigner[] | null;
  /** Migration 171: "envelope" for a row that is an envelope (several documents signed in one sitting), with its documents below. */
  kind?: EnvelopeRowExtras["kind"];
  envelope_documents?: EnvelopeRowExtras["envelope_documents"];
}

export type StatusCounts = Record<StatusGroup, number>;

/** The part of a PostgREST filter builder these queries use; every method returns the builder. */
interface Filterable {
  in(column: string, values: readonly string[]): Filterable;
  is(column: string, value: null): Filterable;
  not(column: string, operator: string, value: null): Filterable;
  eq(column: string, value: string): Filterable;
  or(filters: string): Filterable;
  gte(column: string, value: string): Filterable;
  lt(column: string, value: string): Filterable;
}

/** The days of the date range as instants in the workspace's time zone (the day a document was made), as the export reads them. */
type Range = { gte: string | null; lt: string | null };
export const rangeOf = (f: ListFilters, timeZone: string): Range => createdRange({ from: validDay(f.from) || null, to: validDay(f.to) || null }, timeZone);

/** What documents and envelopes share: the contact and the day the row was made. */
export function narrowShared<T>(query: T, f: ListFilters, range: Range): T {
  let q = query as unknown as Filterable;
  if (f.contactId) q = q.eq("contact_id", f.contactId);
  if (range.gte) q = q.gte("created_at", range.gte);
  if (range.lt) q = q.lt("created_at", range.lt);
  return q as unknown as T;
}

export function narrow<T>(query: T, group: StatusGroup | null, f: ListFilters, clause: string | null, range: Range): T {
  let q = narrowByGroup(query, group) as unknown as Filterable;
  // the Test group: only the documents sent to try a template out (migration 170)
  if (group === "test") q = q.eq("test", "true");
  if (f.category === "none") q = q.is("category_id", null);
  else if (f.category !== "all") q = q.eq("category_id", f.category);
  q = narrowShared(q, f, range) as unknown as Filterable;
  if (clause) q = q.or(clause);
  return q as unknown as T;
}

async function fetchAll(f: ListFilters, want: number, timeZone: string): Promise<{ rows: SignListRow[]; hasMore: boolean; counts: StatusCounts }> {
  const res = await fetch("/api/sign/documents/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filters: f, want, timeZone }),
  });
  if (!res.ok) throw new Error(`sign/documents/list failed: ${res.status}`);
  const json = (await res.json()) as { rows?: SignListRow[]; hasMore?: boolean; counts?: StatusCounts };
  return {
    rows: json.rows ?? [],
    hasMore: json.hasMore ?? false,
    counts: (json.counts ?? null) as unknown as StatusCounts,
  };
}

interface Loaded {
  key: string;
  rows: SignListRow[];
  counts: StatusCounts | null;
  hasMore: boolean;
  error: boolean;
}

/**
 * The documents list: the rows for the filters (25 at a time, newest first), the count in every status
 * group, load-more, and a refresh when the window regains focus or the workspace's documents change.
 * Read through row level security with the browser client (menu.sign).
 */
export function useSignDocuments(filters: ListFilters) {
  const { accountId, account } = useAuth();
  const { group, category, search, from, to, contactId } = filters;
  const key = filtersKey({ group, category, search, from, to, contactId });
  // the days of the range are days in the workspace's time zone
  const timeZone = account?.timezone || "UTC";
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [tick, setTick] = useState(0);
  // how many rows are on screen for which filters: a refresh re-reads that many, not just the first page
  const shown = useRef({ key: "", count: 0 });

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const f: ListFilters = { group, category, search, from, to, contactId };
    const want = shown.current.key === key ? Math.max(PAGE_SIZE, shown.current.count) : PAGE_SIZE;
    void (async () => {
      try {
        const result = await fetchAll(f, want, timeZone);
        if (cancelled) return;
        shown.current = { key, count: result.rows.length };
        setLoaded({ key, rows: result.rows, counts: result.counts, hasMore: result.hasMore, error: false });
      } catch (err) {
        if (cancelled) return;
        console.error("[useSignDocuments] fetch error:", err);
        setLoaded({ key, rows: [], counts: null, hasMore: false, error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, group, category, search, from, to, contactId, timeZone, key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshRef = useRef(0);

  // Refresh on window focus (throttled to 5 s).
  useEffect(() => {
    if (!accountId) return;
    const onFocus = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRefreshRef.current > 5000) {
        lastRefreshRef.current = Date.now();
        setTick((t) => t + 1);
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [accountId]);

  const handleSignChange = accountId
    ? () => {
        if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
        liveTimerRef.current = setTimeout(() => {
          lastRefreshRef.current = Date.now();
          setTick((t) => t + 1);
        }, 1000);
      }
    : undefined;

  useAccountSse("sign_documents", handleSignChange, !!accountId);
  useAccountSse("sign_envelopes", handleSignChange, !!accountId);
  useAccountSse(
    "sign_signers",
    accountId
      ? (payload) => {
          if (payload.eventType === "DELETE") return;
          handleSignChange?.();
        }
      : undefined,
    !!accountId,
  );

  const current = loaded && loaded.key === key ? loaded : null;

  const loadMore = useCallback(async () => {
    if (!current || !current.hasMore || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const f: ListFilters = { group, category, search, from, to, contactId };
      const want = pageRange(0, current.rows.length + PAGE_SIZE).to + 1;
      // two sources are merged by date, so the next page is read again from the start up to the new length (nothing is added out of order)
      const result = await fetchAll(f, want, timeZone);
      setLoaded((prev) => {
        if (!prev || prev.key !== key) return prev;
        shown.current = { key, count: result.rows.length };
        return { ...prev, rows: result.rows, hasMore: result.hasMore };
      });
    } catch (err) {
      console.error("[useSignDocuments] load more error:", err);
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [current, loadingMore, group, category, search, from, to, contactId, timeZone, key]);

  // while the next filters load, the last result stays on screen (dimmed by the screen) instead of flashing empty
  const visible = current ?? loaded;
  return {
    rows: visible?.rows ?? [],
    counts: visible?.counts ?? null,
    hasMore: current?.hasMore ?? false,
    loading: !loaded,
    refreshing: !current && !!loaded,
    error: current?.error ?? false,
    loadingMore,
    loadMoreFailed,
    loadMore,
    reload,
    /** True when a search is typed (so an empty result is "no match", not "nothing yet"). */
    searching: sanitizeSearch(search) !== "",
  };
}
