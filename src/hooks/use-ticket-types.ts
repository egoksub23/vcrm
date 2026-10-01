"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { TicketType } from "@/types";

// The account's ticket types (migration 128), read once per session and
// shared — the board, the list, the create dialog and the filter bar all
// need the names, and Settings updates them in place. Mirrors
// use-ticket-resolutions.ts exactly (same table shape, same catalogue idea).
interface State {
  types: TicketType[];
  loaded: boolean;
}

const EMPTY: State = { types: [], loaded: false };
const cache = new Map<string, State>();
const inflight = new Map<string, Promise<void>>();
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

async function load(accountId: string): Promise<void> {
  const existing = inflight.get(accountId);
  if (existing) return existing;
  const run = (async () => {
    const { data, error } = await createClient()
      .from("ticket_types")
      .select("*")
      .eq("account_id", accountId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) console.error("[useTicketTypes] fetch error:", error);
    cache.set(accountId, {
      types: (data as TicketType[] | null) ?? cache.get(accountId)?.types ?? [],
      loaded: !error,
    });
    emit();
  })().finally(() => {
    inflight.delete(accountId);
  });
  inflight.set(accountId, run);
  return run;
}

/** After an admin changed the catalogue: everything showing it updates. */
export function refreshTicketTypes(accountId: string): Promise<void> {
  return load(accountId);
}

export interface TicketTypesState {
  /** Every type, archived ones included (they still name old tickets). */
  types: TicketType[];
  /** The ones that can be picked, in the admin's order. */
  active: TicketType[];
  bySlug: Map<string, TicketType>;
  loaded: boolean;
  reload: () => Promise<void>;
}

export function useTicketTypes(): TicketTypesState {
  const { accountId } = useAuth();

  const state = useSyncExternalStore(
    subscribe,
    () => (accountId ? cache.get(accountId) : undefined) ?? EMPTY,
    () => EMPTY,
  );

  useEffect(() => {
    if (!accountId || cache.has(accountId)) return;
    void load(accountId);
  }, [accountId]);

  const active = useMemo(() => state.types.filter((t) => t.is_active), [state.types]);
  const bySlug = useMemo(() => new Map(state.types.map((t) => [t.slug, t])), [state.types]);
  const reload = useCallback(async () => {
    if (accountId) await load(accountId);
  }, [accountId]);

  return { types: state.types, active, bySlug, loaded: state.loaded, reload };
}
