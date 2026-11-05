"use client";

import { useCallback, useEffect, useState } from "react";

export interface KnownLabel {
  label: string;
  uses: number;
}

export function useTicketLabels(enabled = true): { labels: KnownLabel[]; reload: () => Promise<void> } {
  const [labels, setLabels] = useState<KnownLabel[]>([]);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/account/ticket-labels");
      const { labels: data } = (await res.json()) as { labels?: KnownLabel[] };
      setLabels(data ?? []);
    } catch (err) {
      console.error("[useTicketLabels] fetch error:", err);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  return { labels, reload };
}
