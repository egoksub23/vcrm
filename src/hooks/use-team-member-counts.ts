"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * How many people each team has (team id -> count), for the @team picker in
 * ticket comments. One light read of the join table (RLS scopes it to the
 * account); an empty map until it arrives or when it fails, in which case the
 * picker simply shows no teams.
 */
export function useTeamMemberCounts(enabled = true): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void createClient()
      .from("team_members")
      .select("team_id")
      .limit(5000)
      .then(({ data, error }) => {
        if (cancelled || error) return;
        const next: Record<string, number> = {};
        for (const row of (data ?? []) as { team_id: string }[]) next[row.team_id] = (next[row.team_id] ?? 0) + 1;
        setCounts(next);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return counts;
}
