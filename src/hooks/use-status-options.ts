"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { statusText, type StatusOption } from "@/lib/incidents/platform/statuses";

// The statuses of the school the person is in (migration 226): the six base statuses with the school's own wording where it renamed one, and its extras.
// Read once per page and shared by every status label on it; the setup page asks for a fresh read after a change.

let cache: Promise<StatusOption[]> | null = null;
const listeners = new Set<() => void>();

async function fetchOptions(): Promise<StatusOption[]> {
  try {
    const res = await fetch("/api/incidents/status-options");
    if (!res.ok) return [];
    const json = (await res.json()) as { options?: StatusOption[] };
    return json.options ?? [];
  } catch {
    return [];
  }
}

export function invalidateStatusOptions(): void {
  cache = null;
  listeners.forEach((f) => f());
}

export function useStatusOptions() {
  const t = useTranslations("Incidents.common.status");
  const [options, setOptions] = useState<StatusOption[]>([]);

  useEffect(() => {
    let live = true;
    const load = () => {
      cache ??= fetchOptions();
      void cache.then((o) => {
        if (live) setOptions(o);
      });
    };
    load();
    listeners.add(load);
    return () => {
      live = false;
      listeners.delete(load);
    };
  }, []);

  /** The words for an incident's status: the school's own, or the app's translated name for the base status. */
  const label = useCallback(
    (status: string, statusKey?: string | null) =>
      statusText(options, status, statusKey, (base) => {
        try {
          return t(base as never);
        } catch {
          return base;
        }
      }),
    [options, t],
  );

  return { options, label };
}
