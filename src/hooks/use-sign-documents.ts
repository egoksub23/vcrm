"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { eq, onScopedChanges } from "@/lib/realtime/scoped-changes";
import {
  GROUP_STATUSES,
  PAGE_SIZE,
  STATUS_GROUPS,
  filtersKey,
  pageRange,
  sanitizeSearch,
  searchClause,
  signerSearchClause,
  type ListFilters,
  type StatusGroup,
} from "@/lib/sign/client/list-filters";
import type { DocumentStatus, SignerKind } from "@/lib/sign/types";
import { createClient } from "@/lib/supabase/client";

export interface SignListSigner {
  id: string;
  full_name: string;
  status: string;
  order_no: number;
  kind: SignerKind;
}

export interface SignListRow {
  id: string;
  reference: string | null;
  title: string;
  status: DocumentStatus;
  category_id: string | null;
  contact_id: string | null;
  sign_in_order: boolean;
  sent_at: string | null;
  expires_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  contacts: { name: string | null } | null;
  sign_signers: SignListSigner[] | null;
}

export type StatusCounts = Record<StatusGroup, number>;

const SELECT =
  "id, reference, title, status, category_id, contact_id, sign_in_order, sent_at, expires_at, completed_at, created_at, updated_at, contacts(name), sign_signers(id, full_name, status, order_no, kind)";

/** The part of a PostgREST filter builder these queries use; every method returns the builder. */
interface Filterable {
  in(column: string, values: readonly string[]): Filterable;
  is(column: string, value: null): Filterable;
  eq(column: string, value: string): Filterable;
  or(filters: string): Filterable;
}

function narrow<T>(query: T, group: StatusGroup | null, f: ListFilters, clause: string | null): T {
  let q = query as unknown as Filterable;
  const statuses = group ? GROUP_STATUSES[group] : null;
  if (statuses) q = q.in("status", statuses);
  if (f.category === "none") q = q.is("category_id", null);
  else if (f.category !== "all") q = q.eq("category_id", f.category);
  if (clause) q = q.or(clause);
  return q as unknown as T;
}

/** The ids of documents with a person whose name or email matches the search (up to 200). */
async function signerMatches(search: string): Promise<string[]> {
  const clause = signerSearchClause(search);
  if (!clause) return [];
  const { data, error } = await createClient().from("sign_signers").select("document_id").or(clause).limit(200);
  if (error) throw error;
  return [...new Set(((data as { document_id: string }[] | null) ?? []).map((r) => r.document_id))];
}

async function fetchRows(f: ListFilters, clause: string | null, from: number, to: number): Promise<SignListRow[]> {
  const query = createClient().from("sign_documents").select(SELECT).order("created_at", { ascending: false }).order("id", { ascending: false });
  const { data, error } = await narrow(query, f.group, f, clause).range(from, to);
  if (error) throw error;
  return (data as unknown as SignListRow[]) ?? [];
}

async function fetchCounts(f: ListFilters, clause: string | null): Promise<StatusCounts> {
  const supabase = createClient();
  const entries = await Promise.all(
    STATUS_GROUPS.map(async (g) => {
      const { count, error } = await narrow(supabase.from("sign_documents").select("id", { count: "exact", head: true }), g, f, clause);
      if (error) throw error;
      return [g, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(entries) as StatusCounts;
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
  const { accountId } = useAuth();
  const { group, category, search } = filters;
  const key = filtersKey({ group, category, search });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [tick, setTick] = useState(0);
  // how many rows are on screen for which filters: a refresh re-reads that many, not just the first page
  const shown = useRef({ key: "", count: 0 });

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const f: ListFilters = { group, category, search };
    const want = shown.current.key === key ? Math.max(PAGE_SIZE, shown.current.count) : PAGE_SIZE;
    void (async () => {
      try {
        const clause = searchClause(search, await signerMatches(search));
        const [rows, counts] = await Promise.all([fetchRows(f, clause, 0, pageRange(0, want).to), fetchCounts(f, clause)]);
        if (cancelled) return;
        shown.current = { key, count: rows.length };
        setLoaded({ key, rows, counts, hasMore: rows.length >= want, error: false });
      } catch (err) {
        if (cancelled) return;
        console.error("[useSignDocuments] fetch error:", err);
        setLoaded({ key, rows: [], counts: null, hasMore: false, error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, group, category, search, key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  // Refresh when the window regains focus (not more than once in five seconds) and, where the database
  // publishes changes, when the workspace's documents or people change.
  useEffect(() => {
    if (!accountId) return;
    let last = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      last = Date.now();
      setTick((t) => t + 1);
    };
    const onFocus = () => {
      if (document.visibilityState === "visible" && Date.now() - last > 5000) refresh();
    };
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 1000);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const supabase = createClient();
    const scope = eq("account_id", accountId);
    const channel = supabase.channel(`sign-documents-${accountId}`);
    onScopedChanges(channel, { table: "sign_documents", filter: scope }, onChange);
    onScopedChanges(channel, { table: "sign_signers", filter: scope, events: ["INSERT", "UPDATE"] }, onChange);
    channel.subscribe();
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [accountId]);

  const current = loaded && loaded.key === key ? loaded : null;

  const loadMore = useCallback(async () => {
    if (!current || !current.hasMore || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const f: ListFilters = { group, category, search };
      const clause = searchClause(search, await signerMatches(search));
      const { from, to } = pageRange(current.rows.length);
      const next = await fetchRows(f, clause, from, to);
      setLoaded((prev) => {
        if (!prev || prev.key !== key) return prev;
        const have = new Set(prev.rows.map((r) => r.id));
        const rows = [...prev.rows, ...next.filter((r) => !have.has(r.id))];
        shown.current = { key, count: rows.length };
        return { ...prev, rows, hasMore: next.length >= PAGE_SIZE };
      });
    } catch (err) {
      console.error("[useSignDocuments] load more error:", err);
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [current, loadingMore, group, category, search, key]);

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
