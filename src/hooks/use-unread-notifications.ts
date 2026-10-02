"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { eq, onScopedChanges } from "@/lib/realtime/scoped-changes";
import type { Notification } from "@/types";

/**
 * Count of unread notifications for the current user. Used by the
 * sidebar to surface a badge on the Notifications nav entry.
 *
 * RLS on `notifications` already scopes every read to `auth.uid() =
 * user_id`; the live subscription is filtered to the user too, so the
 * server does not weigh every other user's notifications.
 */
export function useUnreadNotifications(): number {
  const { user } = useAuth();
  const userId = user?.id;
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!userId) return;
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      // head:true skips fetching rows — we only need the `count`
      // supabase-js returns alongside the (empty) response body.
      const { count: unreadCount, error } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .is("read_at", null);
      if (cancelled || error) return;
      setCount(unreadCount ?? 0);
    })();

    const channel = supabase.channel("notifications-unread-count");
    // Only this user's notifications. A delete cannot be filtered, and
    // notifications replicate the whole row, so another user's delete is
    // recognised by its user_id and ignored.
    onScopedChanges(channel, { table: "notifications", filter: eq("user_id", userId) }, (payload) => {
          if (payload.eventType === "DELETE" && (payload.old as Partial<Notification>).user_id !== userId) return;
          if (payload.eventType === "INSERT") {
            const row = payload.new as Notification;
            if (!row.read_at) setCount((n) => n + 1);
          } else if (payload.eventType === "UPDATE") {
            // Updates here only ever set read_at (marking a notification
            // read). Derive purely from the new row so we don't rely on
            // payload.old columns, which require REPLICA IDENTITY FULL.
            const newRow = payload.new as Notification;
            if (newRow.read_at) setCount((n) => Math.max(0, n - 1));
          } else if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Notification>;
            if (!oldRow.read_at) setCount((n) => Math.max(0, n - 1));
          }
    });
    channel.subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId]);

  return count;
}
