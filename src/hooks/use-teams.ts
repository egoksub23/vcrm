"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Team } from "@/types";

/**
 * Lightweight team roster (id/name/color only — no member join) for the
 * inbox's team-bucket filter and the thread header's team-assign
 * dropdown. RLS scopes the read to the caller's account, same as the
 * tags/profiles fetches those components already do directly against
 * Supabase rather than through the Settings API (which additionally
 * joins each team's member list — more than either inbox surface needs).
 */
export function useTeams(): { teams: Team[]; loading: boolean } {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from("teams")
      .select("id, account_id, name, description, color, created_at, updated_at")
      .order("name")
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("[useTeams] fetch error:", error);
          setLoading(false);
          return;
        }
        setTeams((data as Team[]) ?? []);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { teams, loading };
}
