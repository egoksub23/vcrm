"use client";

import { useEffect, useState } from "react";

import type { UsageMeter, UsageState } from "@/lib/platform/usage";

export interface AccountUsageView {
  meters: UsageMeter[];
  state: UsageState;
  storageMeasuredAt: string | null;
}

// One shared read per minute, so the dashboard notice and the Settings card do not each ask.
const TTL_MS = 60_000;
let cached: { at: number; value: AccountUsageView | null } | null = null;
let inflight: Promise<AccountUsageView | null> | null = null;

async function load(): Promise<AccountUsageView | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  inflight ??= fetch("/api/account/usage", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<AccountUsageView>) : null))
    .catch(() => null)
    .then((value) => {
      cached = { at: Date.now(), value };
      inflight = null;
      return value;
    });
  return inflight;
}

/** The workspace's usage against its plan limits; null while loading, when unavailable, or when the caller may not see it. */
export function useAccountUsage(enabled: boolean): AccountUsageView | null {
  const [value, setValue] = useState<AccountUsageView | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void load().then((v) => {
      if (alive) setValue(v);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return enabled ? value : null;
}
