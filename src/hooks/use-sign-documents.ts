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
import { envelopesIncluded, envelopeToRow, mergeNewestFirst, type EnvelopeListRaw, type EnvelopeRowExtras } from "@/lib/sign/client/list-merge";
import type { DocumentStatus, SignerKind } from "@/lib/sign/types";
import { createClient } from "@/lib/supabase/client";

export interface SignListSigner {
  id: string;
  full_name: string;
  status: string;
  order_no: number;
  kind: SignerKind;
  /** A person handed one part of someone's form (migration 166): not counted as a person of the document. */
  part_keys?: string[] | null;
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
  /** Migration 171: "envelope" for a row that is an envelope (several documents signed in one sitting), with its documents below. */
  kind?: EnvelopeRowExtras["kind"];
  envelope_documents?: EnvelopeRowExtras["envelope_documents"];
}

export type StatusCounts = Record<StatusGroup, number>;

const SELECT =
  "id, reference, title, status, mode, test, category_id, contact_id, sign_in_order, sent_at, expires_at, completed_at, created_at, updated_at, contacts(name), sign_signers(id, full_name, status, order_no, kind, part_keys)";

/** An envelope with its documents and their people (migration 171); the list shows it as one row. */
const ENVELOPE_SELECT =
  "id, reference, title, status, contact_id, sign_in_order, sent_at, expires_at, completed_at, created_at, updated_at, contacts(name), sign_documents!sign_documents_envelope_fk(id, title, status, envelope_position, sign_signers(id, full_name, status, order_no, kind, part_keys, party_id))";

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
  // the Test group: only the documents sent to try a template out (migration 170)
  if (group === "test") q = q.eq("test", "true");
  if (f.category === "none") q = q.is("category_id", null);
  else if (f.category !== "all") q = q.eq("category_id", f.category);
  if (clause) q = q.or(clause);
  return q as unknown as T;
}

/** The ids of documents (and of the envelopes those are in) with a person whose name or email matches the search (up to 200). */
async function signerMatches(search: string): Promise<{ documents: string[]; envelopes: string[] }> {
  const clause = signerSearchClause(search);
  if (!clause) return { documents: [], envelopes: [] };
  const { data, error } = await createClient().from("sign_signers").select("document_id, sign_documents(envelope_id)").or(clause).limit(200);
  if (error) throw error;
  const rows = (data as unknown as { document_id: string; sign_documents: { envelope_id: string | null } | null }[] | null) ?? [];
  return {
    documents: [...new Set(rows.map((r) => r.document_id))],
    envelopes: [...new Set(rows.map((r) => r.sign_documents?.envelope_id).filter((id): id is string => !!id))],
  };
}

/** The two search filters (documents, envelopes) for one search text. */
async function searchClauses(search: string): Promise<{ docs: string | null; envs: string | null }> {
  const matches = await signerMatches(search);
  return { docs: searchClause(search, matches.documents), envs: searchClause(search, matches.envelopes) };
}

/**
 * The first `want` rows newest first: the documents that are on their own and the envelopes (each ONE row), read together and cut.
 * A document of an envelope is not a row of its own (it is on its envelope's row).
 */
async function fetchRows(f: ListFilters, clauses: { docs: string | null; envs: string | null }, want: number): Promise<{ rows: SignListRow[]; hasMore: boolean }> {
  const supabase = createClient();
  const docQuery = supabase.from("sign_documents").select(SELECT).is("envelope_id", null).order("created_at", { ascending: false }).order("id", { ascending: false });
  const { data, error } = await narrow(docQuery, f.group, f, clauses.docs).range(0, want - 1);
  if (error) throw error;
  let envs: SignListRow[] = [];
  if (envelopesIncluded(f)) {
    let q = supabase.from("sign_envelopes").select(ENVELOPE_SELECT).order("created_at", { ascending: false }).order("id", { ascending: false }) as unknown as Filterable;
    const statuses = GROUP_STATUSES[f.group];
    if (statuses) q = q.in("status", statuses);
    if (clauses.envs) q = q.or(clauses.envs);
    const res = await (q as unknown as { range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }> }).range(0, want - 1);
    if (res.error) throw res.error;
    envs = ((res.data as EnvelopeListRaw[] | null) ?? []).map((e) => envelopeToRow(e) as unknown as SignListRow);
  }
  return mergeNewestFirst((data as unknown as SignListRow[]) ?? [], envs, want);
}

async function fetchCounts(f: ListFilters, clauses: { docs: string | null; envs: string | null }): Promise<StatusCounts> {
  const supabase = createClient();
  const withEnvelopes = envelopesIncluded(f);
  const entries = await Promise.all(
    STATUS_GROUPS.map(async (g) => {
      const { count, error } = await narrow(supabase.from("sign_documents").select("id", { count: "exact", head: true }).is("envelope_id", null), g, f, clauses.docs);
      if (error) throw error;
      let extra = 0;
      if (withEnvelopes && g !== "test") {
        let q = supabase.from("sign_envelopes").select("id", { count: "exact", head: true }) as unknown as Filterable;
        const statuses = GROUP_STATUSES[g];
        if (statuses) q = q.in("status", statuses);
        if (clauses.envs) q = q.or(clauses.envs);
        const res = await (q as unknown as PromiseLike<{ count: number | null; error: unknown }>);
        if (res.error) throw res.error;
        extra = res.count ?? 0;
      }
      return [g, (count ?? 0) + extra] as const;
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
        const clauses = await searchClauses(search);
        const [page, counts] = await Promise.all([fetchRows(f, clauses, want), fetchCounts(f, clauses)]);
        if (cancelled) return;
        shown.current = { key, count: page.rows.length };
        setLoaded({ key, rows: page.rows, counts, hasMore: page.hasMore, error: false });
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
    onScopedChanges(channel, { table: "sign_envelopes", filter: scope }, onChange);
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
      const clauses = await searchClauses(search);
      // two sources are merged by date, so the next page is read again from the start up to the new length (nothing is added out of order)
      const page = await fetchRows(f, clauses, pageRange(0, current.rows.length + PAGE_SIZE).to + 1);
      setLoaded((prev) => {
        if (!prev || prev.key !== key) return prev;
        shown.current = { key, count: page.rows.length };
        return { ...prev, rows: page.rows, hasMore: page.hasMore };
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
