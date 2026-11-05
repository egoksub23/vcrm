"use client";

import { useCallback, useEffect, useState } from "react";
import type { InboxView } from "@/types";

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
    setLoading(true);
    fetch("/api/account/inbox-views")
      .then((r) => r.json())
      .then(({ views: data }: { views?: InboxView[] }) => {
        if (cancelled) return;
        setViews(data ?? []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[useInboxViews] fetch error:", err);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return { views, loading, refetch };
}
