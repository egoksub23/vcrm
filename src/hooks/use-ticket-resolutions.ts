"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { activeResolutions } from "@/lib/tickets/resolution";
import type { TicketResolution } from "@/types";

// The account's ticket resolutions (migration 096) and its "require a
// resolution" switch, read once per session and shared: the board, the list,
// the detail and the dialogs all need the names, and Settings updates them in
// place. Both tables are readable by every member, so these are plain selects.
interface State {
  resolutions: TicketResolution[];
  /** Until the switch is read it counts as ON: the database enforces it anyway. */
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
    const supabase = createClient();
    const [list, account] = await Promise.all([
      supabase
        .from("ticket_resolutions")
        .select("*")
        .eq("account_id", accountId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase.from("accounts").select("require_ticket_resolution").eq("id", accountId).maybeSingle(),
    ]);
    if (list.error) console.error("[useTicketResolutions] fetch error:", list.error);
    const required = (account.data as { require_ticket_resolution?: boolean } | null)?.require_ticket_resolution;
    cache.set(accountId, {
      resolutions: (list.data as TicketResolution[] | null) ?? cache.get(accountId)?.resolutions ?? [],
      required: required ?? cache.get(accountId)?.required ?? true,
      loaded: !list.error,
    });
    emit();
  })().finally(() => {
    inflight.delete(accountId);
  });
  inflight.set(accountId, run);
  return run;
}

/** After an admin changed the catalogue or the switch: everything showing them updates. */
export function refreshTicketResolutions(accountId: string): Promise<void> {
  return load(accountId);
}

/** Put a known value of the switch into the cache (Settings, right after saving it). */
export function setCachedRequireResolution(accountId: string, required: boolean) {
  const prev = cache.get(accountId) ?? EMPTY;
  cache.set(accountId, { ...prev, required });
  emit();
}

export interface TicketResolutionsState {
  /** Every resolution, archived ones included (they still name old tickets). */
  resolutions: TicketResolution[];
  /** The ones that can be picked, in the admin's order. */
  active: TicketResolution[];
  byId: Map<string, TicketResolution>;
  /** Whether moving a ticket to Resolved or Closed needs a resolution. */
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
    if (accountId) await load(accountId);
  }, [accountId]);

  return { resolutions: state.resolutions, active, byId, required: state.required, loaded: state.loaded, reload };
}
