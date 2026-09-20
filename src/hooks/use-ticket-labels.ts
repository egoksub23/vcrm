"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export interface KnownLabel {
  label: string;
  uses: number;
}

/**
 * Labels already in use across the account's tickets (most used first), for
 * the label combobox, the label filter and the bulk "add label" box. One RPC
 * (ticket_label_suggestions, migration 081); RLS scopes it to the caller's
 * account.
 */
export function useTicketLabels(enabled = true): { labels: KnownLabel[]; reload: () => Promise<void> } {
  const [labels, setLabels] = useState<KnownLabel[]>([]);

  const reload = useCallback(async () => {
    const { data, error } = await createClient().rpc("ticket_label_suggestions");
    if (error) {
      console.error("[useTicketLabels] fetch error:", error);
      return;
    }
    setLabels(((data as { label: string; uses: number | string }[]) ?? []).map((r) => ({ label: r.label, uses: Number(r.uses) })));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [enabled, reload]);

  return { labels, reload };
}
