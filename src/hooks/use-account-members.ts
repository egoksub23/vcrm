"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Profile } from "@/types";

// The people in the caller's account, for assignee pickers, avatars and
// @mentions. Shared across the ticket screens (a board card, a list row and
// the open ticket all need names) and fetched once per session. RLS scopes
// the read to the account.
const EMPTY: Profile[] = [];
let members: Profile[] = EMPTY;
let loadedFor: string | null = null;
let inflight = false;
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

async function load(accountId: string) {
  if (inflight) return;
  inflight = true;
  const { data, error } = await createClient().from("profiles").select("*").order("full_name");
  inflight = false;
  if (error) {
    console.error("[useAccountMembers] fetch error:", error);
    return;
  }
  members = (data as Profile[]) ?? EMPTY;
  loadedFor = accountId;
  emit();
}

export function useAccountMembers(): {
  members: Profile[];
  /** A person's name, or `fallback` when unknown / unassigned. */
  nameOf: (userId: string | null | undefined, fallback?: string) => string;
  profileOf: (userId: string | null | undefined) => Profile | undefined;
} {
  const { accountId } = useAuth();
  const list = useSyncExternalStore(
    subscribe,
    () => members,
    () => EMPTY,
  );

  useEffect(() => {
    if (accountId && loadedFor !== accountId) void load(accountId);
  }, [accountId]);

  const profileOf = useCallback(
    (userId: string | null | undefined) => (userId ? list.find((p) => p.user_id === userId) : undefined),
    [list],
  );
  const nameOf = useCallback(
    (userId: string | null | undefined, fallback = "") => profileOf(userId)?.full_name || fallback,
    [profileOf],
  );
  return { members: list, nameOf, profileOf };
}
