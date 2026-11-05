"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";

export type SseEventType = "INSERT" | "UPDATE" | "DELETE";

export interface SsePayload {
  table: string;
  eventType: SseEventType;
  new: unknown;
  old: unknown;
  _truncated?: boolean;
}

type SseHandler = (payload: SsePayload) => void;

interface Connection {
  es: EventSource;
  handlers: Map<string, Set<SseHandler>>;
  refCount: number;
}

// Module-level singleton — one SSE connection per logged-in account.
const connections = new Map<string, Connection>();

function getOrCreate(accountId: string): Connection {
  let conn = connections.get(accountId);
  if (!conn) {
    const es = new EventSource("/api/realtime");
    const handlers = new Map<string, Set<SseHandler>>();
    conn = { es, handlers, refCount: 0 };
    connections.set(accountId, conn);

    es.onmessage = (e: MessageEvent) => {
      try {
        const payload: SsePayload = JSON.parse(e.data as string);
        handlers.get(payload.table)?.forEach((h) => h(payload));
      } catch {
        /* ignore malformed frames */
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; no action needed here.
    };
  }
  return conn;
}

/**
 * Subscribe to real-time events for one table via the account-level SSE
 * connection. `handler` is stored in a ref — callers do not need to memoize it.
 */
export function useAccountSse(
  table: string,
  handler: SseHandler | undefined,
  enabled = true,
): void {
  const { accountId } = useAuth();
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!enabled || !accountId) return;

    const conn = getOrCreate(accountId);
    conn.refCount++;
    if (!conn.handlers.has(table)) conn.handlers.set(table, new Set());

    const stable: SseHandler = (p) => handlerRef.current?.(p);
    conn.handlers.get(table)!.add(stable);

    return () => {
      conn.handlers.get(table)?.delete(stable);
      if (conn.handlers.get(table)?.size === 0) conn.handlers.delete(table);
      conn.refCount--;
      if (conn.refCount === 0) {
        conn.es.close();
        connections.delete(accountId);
      }
    };
    // handler omitted intentionally — stored in ref to avoid re-subscribing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, enabled, table]);
}
