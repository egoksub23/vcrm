"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { InboxView } from "@/types";

/**
 * Saved inbox views (migration 051) — the caller's own views plus every
 * shared (owner_id IS NULL) one, per inbox_views_select RLS. A direct
 * table read is enough here since RLS already does the scoping; only
 * writes need the API route (create/delete enforce the shared/admin-only
 * rule, which the service-role write path can't get from RLS alone).
 */
export function useInboxViews(): {
  views: InboxView[];
  loading: boolean;
  refetch: () => void;
} {
  const [views, setViews] = useState<InboxView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

  const refetch = useCallback(() => setRefreshToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from("inbox_views")
      .select("*")
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[useInboxViews] fetch error:", error);
          setLoading(false);
          return;
        }
        setViews((data as InboxView[]) ?? []);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return { views, loading, refetch };
}
