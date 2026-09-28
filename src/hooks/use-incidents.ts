"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { LIST_PAGE_SIZE } from "@/lib/incidents/constants";
import type { Incident } from "@/lib/incidents/types";

/**
 * The incidents this account member can see (RLS decides — a plain
 * reporter/watcher gets only their own, incidents.manage gets the whole
 * register). One unpaginated fetch: incident volume is expected to be
 * far lower than ticket volume, so this skips use-ticket-store's
 * per-column pagination machinery entirely.
 */
export function useIncidents() {
  const { accountId } = useAuth();
  const [rows, setRows] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const rowsRef = useRef<Incident[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { data, error: fetchError } = await createClient()
      .from("incidents")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(LIST_PAGE_SIZE);
    if (fetchError) {
      console.error("[useIncidents] fetch error:", fetchError);
      setError(true);
      setLoading(false);
      return;
    }
    setRows((data as Incident[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (accountId) void reload();
  }, [accountId, reload]);

  // Optimistic patch: applied immediately, left in place if the write
  // succeeds (the realtime UPDATE below is then a no-op merge).
  const applyPatch = useCallback((id: string, patch: Partial<Incident>) => {
    const prev = rowsRef.current;
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    return () => setRows(prev);
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((cur) => cur.filter((r) => r.id !== id));
  }, []);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`incidents-store-${accountId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "incidents", filter: `account_id=eq.${accountId}` },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const id = (payload.old as { id?: string }).id;
            if (id) removeRow(id);
            return;
          }
          const next = payload.new as Incident;
          setRows((cur) => {
            const known = cur.find((r) => r.id === next.id);
            if (known) return cur.map((r) => (r.id === next.id ? { ...r, ...next } : r));
            // A newly-visible row (just raised, or RLS now allows it — e.g.
            // this member was just made a watcher): prepend it.
            return [next, ...cur];
          });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [accountId, removeRow]);

  return { rows, loading, error, reload, applyPatch, removeRow };
}
