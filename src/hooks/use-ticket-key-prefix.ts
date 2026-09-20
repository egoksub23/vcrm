"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { DEFAULT_TICKET_PREFIX, ticketKey } from "@/lib/tickets/key";

// The account's ticket key prefix (migration 081) is read once per session
// and shared: dozens of cards and rows show a key, and the Settings screen
// updates it in place. accounts is readable by every member, so this is a
// plain select; until it lands the default prefix is shown.
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

/** After an admin saves a new prefix: everything showing a key updates. */
export function setCachedTicketKeyPrefix(accountId: string, prefix: string) {
  cache.set(accountId, prefix);
  emit();
}

/** The prefix (VIR) and a helper that turns a ticket number into its key. */
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
    void createClient()
      .from("accounts")
      .select("ticket_key_prefix")
      .eq("id", accountId)
      .maybeSingle()
      .then(({ data }) => {
        inflight.delete(accountId);
        const value = (data as { ticket_key_prefix?: string } | null)?.ticket_key_prefix;
        if (value) {
          cache.set(accountId, value);
          emit();
        }
      });
  }, [accountId]);

  const keyOf = useCallback((n: number) => ticketKey(prefix, n), [prefix]);
  return { prefix, keyOf };
}
