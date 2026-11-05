"use client";

import { useCallback, useEffect, useState } from "react";
import type { TicketFieldDefinition } from "@/types";

export function useTicketFields(enabled = true): {
  fields: TicketFieldDefinition[];
  loading: boolean;
  reload: () => Promise<void>;
} {
  const [fields, setFields] = useState<TicketFieldDefinition[]>([]);
  const [loading, setLoading] = useState(enabled);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/account/ticket-fields");
      const { fields: data } = (await res.json()) as { fields?: TicketFieldDefinition[] };
      setFields(data ?? []);
    } catch (err) {
      console.error("[useTicketFields] fetch error:", err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  return { fields, loading, reload };
}
