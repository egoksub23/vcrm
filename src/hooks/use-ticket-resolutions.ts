"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { activeResolutions } from "@/lib/tickets/resolution";
import type { TicketResolution } from "@/types";

interface State {
  resolutions: TicketResolution[];
  required: boolean;
  loaded: boolean;
}

const EMPTY: State = { resolutions: [], required: true, loaded: false };
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
      const res = await fetch("/api/account/ticket-resolutions");
      const { resolutions, required } = (await res.json()) as {
        resolutions?: TicketResolution[];
        required?: boolean;
      };
      cache.set(accountId, {
        resolutions: resolutions ?? cache.get(accountId)?.resolutions ?? [],
        required: required ?? cache.get(accountId)?.required ?? true,
        loaded: true,
      });
    } catch (err) {
      console.error("[useTicketResolutions] fetch error:", err);
      const prev = cache.get(accountId) ?? EMPTY;
      cache.set(accountId, { ...prev, loaded: false });
    }
    emit();
  })().finally(() => {
    inflight.delete(accountId);
  });
  inflight.set(accountId, run);
  return run;
}

export function refreshTicketResolutions(accountId: string): Promise<void> {
  cache.delete(accountId);
  return load(accountId);
}

export function setCachedRequireResolution(accountId: string, required: boolean) {
  const prev = cache.get(accountId) ?? EMPTY;
  cache.set(accountId, { ...prev, required });
  emit();
}

export interface TicketResolutionsState {
  resolutions: TicketResolution[];
  active: TicketResolution[];
  byId: Map<string, TicketResolution>;
  required: boolean;
  loaded: boolean;
  reload: () => Promise<void>;
}

export function useTicketResolutions(): TicketResolutionsState {
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

  const active = useMemo(() => activeResolutions(state.resolutions), [state.resolutions]);
  const byId = useMemo(() => new Map(state.resolutions.map((r) => [r.id, r])), [state.resolutions]);
  const reload = useCallback(async () => {
    if (accountId) {
      cache.delete(accountId);
      await load(accountId);
    }
  }, [accountId]);

  return { resolutions: state.resolutions, active, byId, required: state.required, loaded: state.loaded, reload };
}
