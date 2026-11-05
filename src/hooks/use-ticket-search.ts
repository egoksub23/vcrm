"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalize, type RawTicket, type TicketRow } from "./use-ticket-store";
import { parseTicketQuery } from "@/lib/tickets/key";
import { toDateInputValue } from "@/lib/tickets/due";
import type { TicketFilters } from "@/lib/tickets/filters";
import type { SortSpec } from "@/lib/tickets/sort-group";
import type { TicketViewMode } from "./use-ticket-store";

/**
 * Server-side search/filter/sort (migration 128's `tickets_search` RPC) for
 * when a filter or search term is active — `useTicketStore`'s own fetch only
 * ever sees LIST_PAGE_SIZE/BOARD_COLUMN_PAGE_SIZE rows per page, so a match
 * outside that window was previously invisible no matter what was typed.
 *
 * This only sources a wider CANDIDATE set; `applyFilters` (src/lib/tickets/
 * filters.ts) still runs over the result afterward in the page, same as it
 * always has, so the final result is always governed by that one already-
 * tested matcher — this hook only has to get "close enough" to be useful,
 * never byte-for-byte exact, which is a much safer bar for a hand-written
 * SQL WHERE clause to clear.
 */
const SEARCH_LIMIT = 500;

export interface TicketSearchResult {
  rows: TicketRow[];
  loading: boolean;
  totalCount: number;
}

export function useTicketSearch(
  enabled: boolean,
  filters: TicketFilters,
  sort: SortSpec,
  mode: TicketViewMode,
  accountId: string | null,
  userId: string | null,
): TicketSearchResult {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const generation = useRef(0);

  const runSearch = useCallback(async () => {
    if (!accountId) return;
    const gen = ++generation.current;
    setLoading(true);
    const q = parseTicketQuery(filters.q);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const res = await fetch("/api/tickets/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        p_search_text: q.text,
        p_search_number: q.number,
        p_search_prefix: q.prefix,
        p_quick: filters.quick.filter((c) => c !== "mentioned"),
        p_user_id: userId,
        p_today: toDateInputValue(now),
        p_today_start: todayStart.toISOString(),
        p_today_end: todayEnd.toISOString(),
        p_statuses: mode === "list" ? filters.statuses : null,
        p_assignees: filters.assignees,
        p_types: filters.types,
        p_priorities: filters.priorities,
        p_labels: filters.labels,
        p_teams: filters.teams,
        p_resolutions: filters.resolutions,
        p_sort_key: sort.key,
        p_sort_dir: sort.dir,
        p_limit: SEARCH_LIMIT,
        p_offset: 0,
      }),
    }).catch(() => null);
    if (gen !== generation.current) return;
    if (!res?.ok) {
      console.error("[useTicketSearch] search failed:", res?.status);
      setLoading(false);
      return;
    }
    const json = (await res.json().catch(() => null)) as { tickets?: unknown[]; total?: number } | null;
    if (gen !== generation.current) return;
    const ordered = ((json?.tickets ?? []) as unknown as RawTicket[]).map(normalize);
    setRows(ordered);
    setTotalCount(json?.total ?? 0);
    setLoading(false);
    // filters/sort/mode are plain data (not stable references) — depending on
    // them directly keeps this re-running on every real change, same shape as
    // useTicketStore's own fetchList/fetchColumn callbacks.
  }, [accountId, userId, mode, filters, sort]);

  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runSearch();
  }, [enabled, runSearch]);

  return { rows: enabled ? rows : [], loading: enabled && loading, totalCount };
}
