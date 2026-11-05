"use client";

import { useEffect, useState } from "react";

export function useTeamMemberCounts(enabled = true): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/account/team-member-counts")
      .then((r) => r.json())
      .then(({ counts: data }: { counts?: Record<string, number> }) => {
        if (cancelled) return;
        setCounts(data ?? {});
      })
      .catch(() => {/* ignore */});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return counts;
}
