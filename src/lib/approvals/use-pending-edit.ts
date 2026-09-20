"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * The proposed values of a live tag or snippet (migration 088 moved them out of
 * the live row, so other members can never read them). Row level security
 * only returns the row to its proposer and to approvals.review holders; for
 * anyone else, or when there is no edit, this stays null.
 */
export function usePendingEdit(
  entityType: "tag" | "snippet",
  id: string | null | undefined,
  enabled: boolean,
): Record<string, unknown> | null {
  const [state, setState] = useState<{ key: string; patch: Record<string, unknown> | null }>({
    key: "",
    patch: null,
  });
  const key = `${entityType}:${id ?? ""}`;

  useEffect(() => {
    if (!enabled || !id) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await createClient()
          .from("approval_pending_edits")
          .select("patch")
          .eq("entity_type", entityType)
          .eq("entity_id", id)
          .maybeSingle();
        if (!cancelled) {
          setState({ key, patch: (data?.patch as Record<string, unknown> | null) ?? null });
        }
      } catch {
        if (!cancelled) setState({ key, patch: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, id, entityType, key]);

  return enabled && state.key === key ? state.patch : null;
}
