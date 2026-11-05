"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { BusinessSchedule } from "@/lib/sla/business-time";
import { toBusinessSchedule } from "@/lib/sla/policy";
import type { SlaPolicy, SlaSchedule } from "@/lib/sla/types";

export interface SlaConfig {
  schedules: SlaSchedule[];
  policies: SlaPolicy[];
}

const TTL_MS = 60_000;
let cache: { at: number; data: SlaConfig } | null = null;
let inflight: Promise<SlaConfig> | null = null;
const listeners = new Set<() => void>();

export function invalidateSlaConfig(): void {
  cache = null;
  inflight = null;
  for (const l of listeners) l();
}

export async function fetchSlaConfig(force = false): Promise<SlaConfig> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!force && inflight) return inflight;
  const load = (async () => {
    const [schRes, polRes] = await Promise.all([
      fetch("/api/account/sla/schedules"),
      fetch("/api/account/sla/policies"),
    ]);
    const { schedules: rawSchedules } = (await schRes.json()) as { schedules?: unknown[] };
    const { policies: rawPolicies } = (await polRes.json()) as { policies?: unknown[] };
    const schedules = ((rawSchedules ?? []) as unknown as SlaSchedule[]).map((s) => ({
      ...s,
      holidays: [...(s.holidays ?? [])].sort((a, b) => a.holiday_date.localeCompare(b.holiday_date)),
    }));
    const data: SlaConfig = { schedules, policies: (rawPolicies ?? []) as unknown as SlaPolicy[] };
    cache = { at: Date.now(), data };
    return data;
  })();
  inflight = load;
  try {
    return await load;
  } finally {
    if (inflight === load) inflight = null;
  }
}

export interface SlaConfigApi extends SlaConfig {
  loading: boolean;
  error: boolean;
  reload: () => Promise<void>;
  policyById: (id: string | null | undefined) => SlaPolicy | null;
  scheduleById: (id: string | null | undefined) => SlaSchedule | null;
  businessScheduleForPolicy: (policyId: string | null | undefined) => BusinessSchedule | null;
}

export function useSlaConfig(enabled = true): SlaConfigApi {
  const [data, setData] = useState<SlaConfig>(() => cache?.data ?? { schedules: [], policies: [] });
  const [loading, setLoading] = useState(enabled && !cache);
  const [error, setError] = useState(false);

  const load = useCallback(async (force: boolean) => {
    try {
      const next = await fetchSlaConfig(force);
      setData(next);
      setError(false);
    } catch (e) {
      console.error("[useSlaConfig] load failed:", e);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load(false);
    const onInvalidate = () => void load(true);
    listeners.add(onInvalidate);
    return () => {
      listeners.delete(onInvalidate);
    };
  }, [enabled, load]);

  const reload = useCallback(async () => {
    await load(true);
  }, [load]);

  return useMemo(() => {
    const policyById = (id: string | null | undefined) => data.policies.find((p) => p.id === id) ?? null;
    const scheduleById = (id: string | null | undefined) => data.schedules.find((s) => s.id === id) ?? null;
    return {
      ...data,
      loading,
      error,
      reload,
      policyById,
      scheduleById,
      businessScheduleForPolicy: (policyId) => {
        const p = policyById(policyId);
        const s = p?.schedule_id ? scheduleById(p.schedule_id) : null;
        return s ? toBusinessSchedule(s) : null;
      },
    };
  }, [data, loading, error, reload]);
}
