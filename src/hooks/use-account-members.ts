"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import type { Profile } from "@/types";

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
  try {
    const res = await fetch("/api/account/profiles");
    const { profiles } = (await res.json()) as { profiles?: Profile[] };
    members = profiles ?? EMPTY;
    loadedFor = accountId;
    emit();
  } catch (err) {
    console.error("[useAccountMembers] fetch error:", err);
  } finally {
    inflight = false;
  }
}

export function useAccountMembers(): {
  members: Profile[];
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
