"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useAccountSse, type SsePayload } from "@/hooks/use-account-sse";
import type { Conversation } from "@/types";

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Used by the sidebar to surface a green dot on the
 * Inbox nav entry when the user is elsewhere in the app.
 */
export function useTotalUnread(): number {
  const { accountId } = useAuth();
  const [total, setTotal] = useState(0);

  const countsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase.from("conversations").select("id, unread_count");
      if (cancelled || error || !data) return;

      const map = new Map<string, number>();
      let sum = 0;
      for (const row of data as { id: string; unread_count: number }[]) {
        const n = row.unread_count ?? 0;
        map.set(row.id, n);
        if (n > 0) sum += 1;
      }
      countsRef.current = map;
      setTotal(sum);
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useAccountSse(
    "conversations",
    accountId
      ? (payload: SsePayload) => {
          const map = countsRef.current;
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Conversation>;
            if (oldRow.id) map.delete(oldRow.id);
          } else {
            const row = payload.new as Conversation;
            map.set(row.id, row.unread_count ?? 0);
          }
          let sum = 0;
          for (const n of map.values()) if (n > 0) sum += 1;
          setTotal(sum);
        }
      : undefined,
    !!accountId,
  );

  return total;
}
