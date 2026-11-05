"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useAccountSse, type SsePayload } from "@/hooks/use-account-sse";
import type { Notification } from "@/types";

export function useUnreadNotifications(): number {
  const { user } = useAuth();
  const userId = user?.id;
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    fetch("/api/account/notifications/unread-count")
      .then((r) => r.json())
      .then(({ count: c }: { count?: number }) => {
        if (cancelled) return;
        setCount(c ?? 0);
      })
      .catch(() => {/* ignore */});
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useAccountSse(
    "notifications",
    userId
      ? (payload: SsePayload) => {
          if (payload.eventType === "DELETE" && (payload.old as Partial<Notification>).user_id !== userId) return;
          if (payload.eventType === "INSERT") {
            const row = payload.new as Notification;
            if (row.user_id !== userId) return;
            if (!row.read_at) setCount((n) => n + 1);
          } else if (payload.eventType === "UPDATE") {
            const newRow = payload.new as Notification;
            if (newRow.user_id !== userId) return;
            if (newRow.read_at) setCount((n) => Math.max(0, n - 1));
          } else if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Notification>;
            if (!oldRow.read_at) setCount((n) => Math.max(0, n - 1));
          }
        }
      : undefined,
    !!userId,
  );

  return count;
}
