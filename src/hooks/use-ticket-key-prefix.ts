"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { DEFAULT_TICKET_PREFIX, ticketKey } from "@/lib/tickets/key";

const cache = new Map<string, string>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setCachedTicketKeyPrefix(accountId: string, prefix: string) {
  cache.set(accountId, prefix);
  emit();
}

export function useTicketKeyPrefix(): { prefix: string; keyOf: (ticketNumber: number) => string } {
  const { accountId } = useAuth();

  const prefix = useSyncExternalStore(
    subscribe,
    () => (accountId ? cache.get(accountId) : undefined) ?? DEFAULT_TICKET_PREFIX,
    () => DEFAULT_TICKET_PREFIX,
  );

  useEffect(() => {
    if (!accountId || cache.has(accountId) || inflight.has(accountId)) return;
    inflight.add(accountId);
    fetch("/api/account/ticket-key-prefix")
      .then((r) => r.json())
      .then(({ prefix: value }: { prefix?: string | null }) => {
        inflight.delete(accountId);
        if (value) {
          cache.set(accountId, value);
          emit();
        }
      })
      .catch(() => {
        inflight.delete(accountId);
      });
  }, [accountId]);

  const keyOf = useCallback((n: number) => ticketKey(prefix, n), [prefix]);
  return { prefix, keyOf };
}
