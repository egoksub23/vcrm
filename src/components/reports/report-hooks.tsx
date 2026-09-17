"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { DateRange } from "@/lib/reports/date-utils";

/**
 * Shared fetch-on-range-change plumbing for every report panel —
 * loading/error/data state, re-fetching whenever `accountId` or
 * `range` changes, and ignoring a response that lands after a newer
 * request has already started (range flipped again while the first
 * request was in flight).
 */
export function useReportData<T>(
  loader: (db: ReturnType<typeof createClient>, accountId: string, range: DateRange) => Promise<T>,
  accountId: string | null,
  range: DateRange,
): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const supabase = createClient();
    loader(supabase, accountId, range)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[reports] load failed:", err);
        setError(err instanceof Error ? err.message : "Failed to load report");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `range` is a plain object recreated each render from `preset`, so
    // depend on its actual bounds rather than referential identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, range.from.getTime(), range.to.getTime()]);

  return { data, loading, error };
}

/** "45m" under an hour, "2h 5m" over — 0 minutes renders "0m" rather
 *  than an empty string. */
export function formatMinutes(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded}m`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}
