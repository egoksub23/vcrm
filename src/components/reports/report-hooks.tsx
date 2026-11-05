"use client";

import { useEffect, useState } from "react";
import type { DateRange } from "@/lib/reports/date-utils";

/**
 * Shared fetch-on-range-change plumbing for every report panel —
 * loading/error/data state, re-fetching whenever `range` changes, and
 * ignoring a response that lands after a newer request has already
 * started (range flipped again while the first request was in flight).
 */
export function useReportData<T>(
  queryName: string,
  _ignored: string | null,
  range: DateRange,
): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = `/api/reports?query=${queryName}&from=${range.from.toISOString()}&to=${range.to.toISOString()}`;
    fetch(url)
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) throw new Error(json.error);
        setData(json.data as T);
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
  }, [queryName, range.from.getTime(), range.to.getTime()]);

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
