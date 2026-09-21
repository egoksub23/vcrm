"use client";

import { useCallback, useEffect, useId, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import type { TicketMention } from "@/types";
import { notifyTicketMentionsChanged } from "@/hooks/use-my-ticket-mentions";

const COLUMNS = "id, account_id, ticket_id, comment_id, mentioned_user_id, requested_by, via_team_id, kind, status, created_at, resolved_at, resolved_by, resolved_reason, nudged_at";

/**
 * The open "needs a response" requests on one ticket (both the ones asked of
 * the signed-in person and the ones they made), live over realtime. Used by the
 * banner in the ticket view.
 */
export function useTicketMentions(ticketId: string | null): {
  requests: TicketMention[];
  reload: () => Promise<void>;
} {
  const channelKey = useId();
  const [requests, setRequests] = useState<TicketMention[]>([]);

  const reload = useCallback(async () => {
    if (!ticketId) return;
    const { data, error } = await createClient()
      .from("ticket_mentions")
      .select(COLUMNS)
      .eq("ticket_id", ticketId)
      .eq("status", "open")
      .eq("kind", "response")
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[useTicketMentions] fetch error:", error);
      return;
    }
    setRequests((data ?? []) as TicketMention[]);
    // What the sidebar bubble counts may have moved with it.
    notifyTicketMentionsChanged();
  }, [ticketId]);

  useEffect(() => {
    if (!ticketId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    const supabase = createClient();
    const channel = supabase
      .channel(`ticket-mentions-${ticketId}-${channelKey}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ticket_mentions", filter: `ticket_id=eq.${ticketId}` },
        () => void reload(),
      )
      // A reply resolves a request in the database; the comment insert is the cue to re-read.
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ticket_comments", filter: `ticket_id=eq.${ticketId}` },
        () => window.setTimeout(() => void reload(), 400),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [ticketId, channelKey, reload]);

  return { requests: ticketId ? requests.filter((r) => r.ticket_id === ticketId) : [], reload };
}
