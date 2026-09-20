"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { buildAuditParams } from "@/lib/audit/client";
import type { AuditEntry, AuditFilters } from "@/lib/audit/types";

export const AUDIT_PAGE_SIZE = 50;

export type AuditLoadStatus = "loading" | "ready" | "error";

interface AuditPage {
  entries: AuditEntry[];
  nextCursor: string | null;
}

async function fetchAuditPage(
  filters: AuditFilters,
  cursor: string | null,
  signal: AbortSignal,
): Promise<AuditPage> {
  const params = buildAuditParams(filters, { cursor, limit: AUDIT_PAGE_SIZE });
  const res = await fetch(`/api/account/audit?${params.toString()}`, {
    cache: "no-store",
    signal,
  });
  const payload = (await res.json().catch(() => ({}))) as {
    entries?: AuditEntry[];
    nextCursor?: string | null;
    error?: string;
  };
  if (!res.ok || !payload.entries) throw new Error(payload.error ?? "");
  return { entries: payload.entries, nextCursor: payload.nextCursor ?? null };
}

/**
 * The audit list with "Load more" paging. Changing `filters` (compare
 * by identity: memoise them) starts over from the newest row.
 */
export function useAuditLog(filters: AuditFilters) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<AuditLoadStatus>("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    setStatus("loading");
    fetchAuditPage(filters, null, ctrl.signal)
      .then((page) => {
        if (ctrl.signal.aborted) return;
        setEntries(page.entries);
        setCursor(page.nextCursor);
        setStatus("ready");
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        setStatus("error");
      });
    return () => ctrl.abort();
  }, [filters, reloadKey]);

  const loadMore = useCallback(async () => {
    if (cursor === null || loadingMore) return;
    const ctrl = controller.current ?? new AbortController();
    setLoadingMore(true);
    try {
      const page = await fetchAuditPage(filters, cursor, ctrl.signal);
      setEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.nextCursor);
    } catch {
      if (!ctrl.signal.aborted) setStatus("error");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, filters, loadingMore]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return { entries, status, hasMore: cursor !== null, loadingMore, loadMore, reload };
}
