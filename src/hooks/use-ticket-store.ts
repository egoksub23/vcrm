"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { BOARD_COLUMN_PAGE_SIZE, LIST_PAGE_SIZE, TICKET_STATUSES } from "@/lib/tickets/constants";
import type { Contact, Ticket, TicketStatus } from "@/types";

/** The bits of the customer a card or row shows. */
export type TicketContact = Pick<Contact, "id" | "name" | "phone" | "wa_username" | "wa_user_id">;

export interface TicketRow extends Omit<Ticket, "contact"> {
  contact: TicketContact | null;
  labels: string[];
  comment_count: number;
}

export type TicketViewMode = "board" | "list";

const SELECT =
  "*, contact:contacts(id, name, phone, wa_username, wa_user_id), comments:ticket_comments(count)";

type RawTicket = Ticket & {
  contact?: TicketContact | null;
  comments?: { count: number }[] | null;
};

function normalize(raw: RawTicket): TicketRow {
  const { comments, contact, ...rest } = raw;
  return {
    ...rest,
    contact: contact ?? null,
    labels: rest.labels ?? [],
    comment_count: comments?.[0]?.count ?? 0,
  };
}

function mergeById(prev: TicketRow[], incoming: TicketRow[]): TicketRow[] {
  const byId = new Map(prev.map((r) => [r.id, r]));
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()];
}

const emptyTotals = (): Record<TicketStatus, number> => ({
  open: 0,
  in_progress: 0,
  pending: 0,
  resolved: 0,
  closed: 0,
});

/**
 * The tickets on the Tickets screen, loaded in pages and kept live.
 *
 * - List view: the most recently updated tickets, LIST_PAGE_SIZE at a time
 *   ("Load more").
 * - Board view: each column loads its own top BOARD_COLUMN_PAGE_SIZE by rank
 *   ("Show more" per column) and knows its real total. The Closed column is
 *   only fetched once it is opened, since it is collapsed by default.
 * - Realtime payloads are applied to the row with that id instead of
 *   refetching everything; only a ticket that is new to this client costs a
 *   one-row fetch (payloads carry no customer join).
 *
 * Filters and search run on what is loaded (see the page); pushing them to the
 * server is the follow-up for accounts with very many tickets.
 */
export function useTicketStore(mode: TicketViewMode, enabled = true) {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [listHasMore, setListHasMore] = useState(false);
  const [totals, setTotals] = useState<Record<TicketStatus, number>>(emptyTotals);
  const [columnLoaded, setColumnLoaded] = useState<Record<TicketStatus, boolean>>({
    open: false,
    in_progress: false,
    pending: false,
    resolved: false,
    closed: false,
  });
  const [loadingMore, setLoadingMore] = useState<string | null>(null);

  const rowsRef = useRef<TicketRow[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  const totalsRef = useRef(totals);
  useEffect(() => {
    totalsRef.current = totals;
  }, [totals]);
  const columnLoadedRef = useRef(columnLoaded);
  useEffect(() => {
    columnLoadedRef.current = columnLoaded;
  }, [columnLoaded]);
  // Bumped on every reload so a slow response from an older mode is ignored.
  const generation = useRef(0);

  // ---- Loading ---------------------------------------------------------
  const fetchList = useCallback(async (from: number) => {
    const { data, error: err } = await createClient()
      .from("tickets")
      .select(SELECT)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + LIST_PAGE_SIZE - 1);
    if (err) throw err;
    return ((data ?? []) as unknown as RawTicket[]).map(normalize);
  }, []);

  const fetchColumn = useCallback(async (status: TicketStatus, from: number) => {
    const { data, count, error: err } = await createClient()
      .from("tickets")
      .select(SELECT, { count: "exact" })
      .eq("status", status)
      .order("board_rank", { ascending: false })
      .order("created_at", { ascending: false })
      .range(from, from + BOARD_COLUMN_PAGE_SIZE - 1);
    if (err) throw err;
    return { rows: ((data ?? []) as unknown as RawTicket[]).map(normalize), total: count ?? 0 };
  }, []);

  const reload = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      if (mode === "list") {
        const page = await fetchList(0);
        if (gen !== generation.current) return;
        setRows(page);
        setListHasMore(page.length === LIST_PAGE_SIZE);
      } else {
        const supabase = createClient();
        // Closed stays collapsed until asked for: only its count is fetched.
        const open = TICKET_STATUSES.filter((s) => s !== "closed");
        const [columns, closedCount] = await Promise.all([
          Promise.all(open.map((s) => fetchColumn(s, 0))),
          supabase.from("tickets").select("id", { count: "exact", head: true }).eq("status", "closed"),
        ]);
        if (gen !== generation.current) return;
        const nextTotals = emptyTotals();
        open.forEach((s, i) => {
          nextTotals[s] = columns[i].total;
        });
        nextTotals.closed = closedCount.count ?? 0;
        setRows(columns.flatMap((c) => c.rows));
        setTotals(nextTotals);
        setColumnLoaded({ open: true, in_progress: true, pending: true, resolved: true, closed: false });
      }
    } catch (err) {
      if (gen !== generation.current) return;
      console.error("[useTicketStore] load failed:", err);
      setError(true);
    }
    if (gen === generation.current) setLoading(false);
  }, [mode, fetchList, fetchColumn]);

  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [enabled, reload]);

  const loadMore = useCallback(async () => {
    setLoadingMore("list");
    try {
      const page = await fetchList(rowsRef.current.length);
      setRows((prev) => mergeById(prev, page));
      setListHasMore(page.length === LIST_PAGE_SIZE);
    } catch (err) {
      console.error("[useTicketStore] load more failed:", err);
    }
    setLoadingMore(null);
  }, [fetchList]);

  /** Board: next page of one column (also the first page of Closed). */
  const loadColumn = useCallback(
    async (status: TicketStatus) => {
      setLoadingMore(status);
      try {
        const have = columnLoadedRef.current[status]
          ? rowsRef.current.filter((r) => r.status === status).length
          : 0;
        const col = await fetchColumn(status, have);
        setRows((prev) => mergeById(prev, col.rows));
        setTotals((prev) => ({ ...prev, [status]: col.total }));
        setColumnLoaded((prev) => ({ ...prev, [status]: true }));
      } catch (err) {
        console.error("[useTicketStore] load column failed:", err);
      }
      setLoadingMore(null);
    },
    [fetchColumn],
  );

  // ---- Local changes (optimistic edits, drops, deletes) -------------------
  /** Apply a patch to rows now; the returned function puts them back. */
  const applyPatch = useCallback((ids: string[], patch: Partial<Ticket>) => {
    const idSet = new Set(ids);
    const before = new Map<string, TicketRow>();
    for (const r of rowsRef.current) if (idSet.has(r.id)) before.set(r.id, r);
    setRows((prev) => prev.map((r) => (idSet.has(r.id) ? { ...r, ...patch } : r)));
    // Keep the column totals honest for a status change.
    if (patch.status) {
      const status = patch.status;
      setTotals((prev) => {
        const next = { ...prev };
        for (const r of before.values()) {
          if (r.status !== status) {
            next[r.status] = Math.max(0, next[r.status] - 1);
            next[status] += 1;
          }
        }
        return next;
      });
    }
    return () => {
      setRows((prev) => prev.map((r) => before.get(r.id) ?? r));
      if (patch.status) {
        setTotals((prev) => {
          const next = { ...prev };
          for (const r of before.values()) {
            if (r.status !== patch.status) {
              next[r.status] += 1;
              next[patch.status!] = Math.max(0, next[patch.status!] - 1);
            }
          }
          return next;
        });
      }
    };
  }, []);

  const removeRows = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    for (const r of rowsRef.current) {
      if (idSet.has(r.id)) setTotals((prev) => ({ ...prev, [r.status]: Math.max(0, prev[r.status] - 1) }));
    }
    setRows((prev) => prev.filter((r) => !idSet.has(r.id)));
  }, []);

  const upsertRow = useCallback((row: TicketRow) => {
    const known = rowsRef.current.find((r) => r.id === row.id);
    setRows((prev) => mergeById(prev, [row]));
    if (!known) setTotals((prev) => ({ ...prev, [row.status]: prev[row.status] + 1 }));
  }, []);

  /** Re-read one ticket (after its comment count changed, or right after it was created). */
  const refreshOne = useCallback(
    async (id: string) => {
      const { data } = await createClient().from("tickets").select(SELECT).eq("id", id).maybeSingle();
      if (data) upsertRow(normalize(data as unknown as RawTicket));
    },
    [upsertRow],
  );

  // ---- Realtime ------------------------------------------------------------
  // Whether a ticket this client has not loaded belongs in what it shows: it
  // does when it lands inside the loaded window (or everything is loaded).
  const belongsInWindow = useCallback((row: Ticket): boolean => {
    const loaded = rowsRef.current;
    if (modeRef.current === "list") {
      if (loaded.length < LIST_PAGE_SIZE) return true;
      const oldest = loaded.reduce((min, r) => (r.updated_at < min ? r.updated_at : min), loaded[0].updated_at);
      return row.updated_at >= oldest;
    }
    if (!columnLoadedRef.current[row.status]) return false;
    const column = loaded.filter((r) => r.status === row.status);
    if (column.length >= totalsRef.current[row.status]) return true;
    const lowest = column.reduce((min, r) => Math.min(min, r.board_rank ?? 0), Infinity);
    return (row.board_rank ?? 0) >= lowest;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`tickets-store-${mode}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, (payload) => {
        if (payload.eventType === "DELETE") {
          const id = (payload.old as { id?: string }).id;
          if (id) removeRows([id]);
          return;
        }
        const next = payload.new as Ticket;
        const known = rowsRef.current.find((r) => r.id === next.id);
        if (known) {
          // Merge: a payload can leave out large unchanged columns, and it
          // carries none of the joins.
          if (next.status !== known.status) {
            setTotals((prev) => ({
              ...prev,
              [known.status]: Math.max(0, prev[known.status] - 1),
              [next.status]: prev[next.status] + 1,
            }));
          }
          setRows((prev) => prev.map((r) => (r.id === next.id ? { ...r, ...next, contact: r.contact } : r)));
        } else if (payload.eventType === "INSERT" || belongsInWindow(next)) {
          void supabase
            .from("tickets")
            .select(SELECT)
            .eq("id", next.id)
            .maybeSingle()
            .then(({ data }) => {
              if (data) upsertRow(normalize(data as unknown as RawTicket));
            });
        }
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ticket_comments" }, (payload) => {
        const ticketId = (payload.new as { ticket_id?: string }).ticket_id;
        if (!ticketId) return;
        setRows((prev) =>
          prev.map((r) => (r.id === ticketId ? { ...r, comment_count: r.comment_count + 1 } : r)),
        );
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled, mode, removeRows, upsertRow, belongsInWindow]);

  return {
    rows,
    loading,
    error,
    listHasMore,
    totals,
    columnLoaded,
    loadingMore,
    reload,
    loadMore,
    loadColumn,
    applyPatch,
    removeRows,
    upsertRow,
    refreshOne,
  };
}
