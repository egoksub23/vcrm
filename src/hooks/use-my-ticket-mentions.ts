"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { oldestOpenByTicket, waitingTicketCount } from "@/lib/tickets/mentions";
import type { TicketMention } from "@/types";

/** Backup for a missed realtime event, and the whole mechanism if realtime is down. */
const REFRESH_MS = 60_000;
/** Other parts of the app say "the requests changed" (Mark as done, a reply). */
export const MENTIONS_CHANGED_EVENT = "vircle:ticket-mentions-changed";

export function notifyTicketMentionsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(MENTIONS_CHANGED_EVENT));
}

const COLUMNS = "id, account_id, ticket_id, comment_id, mentioned_user_id, requested_by, via_team_id, kind, status, created_at, resolved_at, resolved_by, resolved_reason, nudged_at";

/**
 * The "needs your response" requests waiting on the signed-in person (migration
 * 095): loaded on login, kept live over realtime, re-read on focus and once a
 * minute. Feeds the Tickets bubble in the sidebar, the "Mentioned me" filter and
 * the "Waiting on you" chips, so all three always agree.
 *
 * `enabled` is false for someone who cannot open tickets: nothing is fetched.
 */
export function useMyTicketMentions(enabled = true): {
  requests: TicketMention[];
  /** Distinct tickets waiting on the person: the bubble's number. */
  count: number;
  ticketIds: Set<string>;
  /** The oldest open request per ticket id. */
  byTicket: Map<string, TicketMention>;
  refresh: () => void;
} {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const channelKey = useId();
  const [requests, setRequests] = useState<TicketMention[]>([]);

  const load = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await createClient()
      .from("ticket_mentions")
      .select(COLUMNS)
      .eq("mentioned_user_id", userId)
      .eq("status", "open")
      .eq("kind", "response")
      .order("created_at", { ascending: true })
      .limit(1000);
    if (error) {
      console.error("[useMyTicketMentions] fetch error:", error);
      return;
    }
    setRequests((data ?? []) as TicketMention[]);
  }, [userId]);

  useEffect(() => {
    if (!enabled || !userId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();

    const supabase = createClient();
    const channel = supabase
      .channel(`ticket-mentions-mine-${channelKey}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ticket_mentions", filter: `mentioned_user_id=eq.${userId}` },
        () => void load(),
      )
      .subscribe();

    const onWake = () => void load();
    const timer = window.setInterval(onWake, REFRESH_MS);
    window.addEventListener("focus", onWake);
    window.addEventListener(MENTIONS_CHANGED_EVENT, onWake);
    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(timer);
      window.removeEventListener("focus", onWake);
      window.removeEventListener(MENTIONS_CHANGED_EVENT, onWake);
    };
  }, [enabled, userId, channelKey, load]);

  const shown = useMemo(() => (enabled ? requests : []), [enabled, requests]);
  const count = useMemo(() => waitingTicketCount(shown), [shown]);
  const ticketIds = useMemo(() => new Set(shown.map((r) => r.ticket_id)), [shown]);
  const byTicket = useMemo(() => oldestOpenByTicket(shown), [shown]);

  return { requests: shown, count, ticketIds, byTicket, refresh: () => void load() };
}
