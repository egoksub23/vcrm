"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import type { BusinessSchedule } from "@/lib/sla/business-time";
import { toBusinessSchedule } from "@/lib/sla/policy";
import type { SlaPolicy, SlaSchedule } from "@/lib/sla/types";

// ============================================================
// The account's SLA configuration (migration 086): business-hour schedules
// (with their holidays) and SLA policies. Every member can read it (RLS), so
// the ticket badge can show "due in 2h 10m of business time" and the schedule
// name without asking the server per ticket. One cached read shared by every
// badge on screen; `invalidateSlaConfig()` (after a settings save) refreshes it.
// ============================================================

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
  const supabase = createClient();
  const load = (async () => {
    const [sch, pol] = await Promise.all([
      supabase
        .from("business_hours_schedules")
        .select("*, holidays:business_hours_holidays(id, schedule_id, holiday_date, name)")
        .order("created_at", { ascending: true }),
      supabase.from("ticket_sla_policies").select("*").order("position", { ascending: true }).order("created_at", { ascending: true }),
    ]);
    if (sch.error) throw sch.error;
    if (pol.error) throw pol.error;
    const schedules = ((sch.data ?? []) as unknown as SlaSchedule[]).map((s) => ({
      ...s,
      holidays: [...(s.holidays ?? [])].sort((a, b) => a.holiday_date.localeCompare(b.holiday_date)),
    }));
    const data: SlaConfig = { schedules, policies: (pol.data ?? []) as unknown as SlaPolicy[] };
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
  /** The schedule a policy measures in, as the business-time maths wants it (null = 24/7 or unknown). */
  businessScheduleForPolicy: (policyId: string | null | undefined) => BusinessSchedule | null;
}

/**
 * `enabled` false skips the read (a surface that only shows tickets without
 * an SLA can avoid the request).
 */
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
