"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { TicketFieldDefinition } from "@/types";

/**
 * The account's customizable ticket form (migration 066) — ALL definitions,
 * archived ones included, since an archived field still has to label the
 * values old tickets hold. Callers narrow with `fieldsForCategory` /
 * `fieldsForTicket`. RLS scopes the read to the caller's account.
 */
export function useTicketFields(enabled = true): {
  fields: TicketFieldDefinition[];
  loading: boolean;
  reload: () => Promise<void>;
} {
  const [fields, setFields] = useState<TicketFieldDefinition[]>([]);
  const [loading, setLoading] = useState(enabled);

  const reload = useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("ticket_field_definitions")
      .select("*")
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) console.error("[useTicketFields] fetch error:", error);
    setFields((data as TicketFieldDefinition[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [enabled, reload]);

  return { fields, loading, reload };
}
