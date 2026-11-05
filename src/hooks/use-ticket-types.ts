"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import type { TicketType } from "@/types";

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
    try {
      const res = await fetch("/api/account/ticket-types");
      const { types } = (await res.json()) as { types?: TicketType[] };
      cache.set(accountId, { types: types ?? [], loaded: true });
    } catch (err) {
      console.error("[useTicketTypes] fetch error:", err);
      cache.set(accountId, { types: cache.get(accountId)?.types ?? [], loaded: false });
    }
    emit();
  })().finally(() => {
    inflight.delete(accountId);
  });
  inflight.set(accountId, run);
  return run;
}

export function refreshTicketTypes(accountId: string): Promise<void> {
  cache.delete(accountId);
  return load(accountId);
}

export interface TicketTypesState {
  types: TicketType[];
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
    if (accountId) {
      cache.delete(accountId);
      await load(accountId);
    }
  }, [accountId]);

  return { types: state.types, active, bySlug, loaded: state.loaded, reload };
}
