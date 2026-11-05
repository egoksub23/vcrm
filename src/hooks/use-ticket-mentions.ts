"use client";

import { useCallback, useEffect, useId, useState } from "react";

import { useAccountSse, type SsePayload } from "@/hooks/use-account-sse";
import type { TicketMention } from "@/types";
import { notifyTicketMentionsChanged } from "@/hooks/use-my-ticket-mentions";

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
    const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/mentions`).catch(() => null);
    if (!res?.ok) {
      console.error("[useTicketMentions] fetch error");
      return;
    }
    const { mentions } = (await res.json().catch(() => ({ mentions: [] }))) as { mentions?: TicketMention[] };
    setRequests(mentions ?? []);
    notifyTicketMentionsChanged();
  }, [ticketId]);

  useEffect(() => {
    if (!ticketId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [ticketId, reload]);

  useAccountSse(
    "ticket_mentions",
    ticketId
      ? (payload: SsePayload) => {
          const row = payload.new as { ticket_id?: string };
          const old = payload.old as { ticket_id?: string };
          if ((row.ticket_id ?? old.ticket_id) !== ticketId) return;
          void reload();
        }
      : undefined,
    !!ticketId,
  );

  useAccountSse(
    "ticket_comments",
    ticketId
      ? (payload: SsePayload) => {
          if (payload.eventType !== "INSERT") return;
          if ((payload.new as { ticket_id?: string }).ticket_id !== ticketId) return;
          window.setTimeout(() => void reload(), 400);
        }
      : undefined,
    !!ticketId,
  );

  return { requests: ticketId ? requests.filter((r) => r.ticket_id === ticketId) : [], reload };
}
