"use client";

import { useEffect, useState } from "react";
import type { Team } from "@/types";

export function useTeams(): { teams: Team[]; loading: boolean } {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account/teams")
      .then((r) => r.json())
      .then(({ teams: data }: { teams?: Team[] }) => {
        if (cancelled) return;
        setTeams(data ?? []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[useTeams] fetch error:", err);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { teams, loading };
}
