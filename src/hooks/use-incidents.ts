"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useAccountSse, type SsePayload } from "@/hooks/use-account-sse";
import type { Incident } from "@/lib/incidents/types";
import type { NamedStudent } from "@/lib/incidents/platform/dashboard";

export function useIncidents() {
  const { accountId } = useAuth();
  const [rows, setRows] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  /** The students named on each incident, for the dashboard's person filter. */
  const [involved, setInvolved] = useState<Record<string, NamedStudent[]>>({});
  const rowsRef = useRef<Incident[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/incidents");
      if (!res.ok) throw new Error("fetch failed");
      const body = (await res.json()) as { incidents?: Incident[]; involved?: Record<string, NamedStudent[]> };
      setRows(body.incidents ?? []);
      setInvolved(body.involved ?? {});
    } catch (fetchError) {
      console.error("[useIncidents] fetch error:", fetchError);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (accountId) void reload();
  }, [accountId, reload]);

  const applyPatch = useCallback((id: string, patch: Partial<Incident>) => {
    const prev = rowsRef.current;
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    return () => setRows(prev);
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((cur) => cur.filter((r) => r.id !== id));
  }, []);

  useAccountSse(
    "incidents",
    accountId
      ? (payload: SsePayload) => {
          if (payload.eventType === "DELETE") {
            const id = (payload.old as { id?: string }).id;
            if (id) removeRow(id);
            return;
          }
          const next = payload.new as Incident;
          setRows((cur) => {
            const known = cur.find((r) => r.id === next.id);
            if (known) return cur.map((r) => (r.id === next.id ? { ...r, ...next } : r));
            return [next, ...cur];
          });
        }
      : undefined,
    !!accountId,
  );

  return { rows, involved, loading, error, reload, applyPatch, removeRow };
}
