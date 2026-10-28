"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Message } from "@/types";
import { shouldNotifyForMessage } from "@/lib/notifications/browser-notify";
import {
  playNotificationSound,
  readSoundNotifyPref,
  subscribeSoundNotifyPref,
} from "@/lib/notifications/sound";

const serverSnapshot = () => false;

export function useSoundNotifyPref(): boolean {
  return useSyncExternalStore(subscribeSoundNotifyPref, readSoundNotifyPref, serverSnapshot);
}

/**
 * Audible ding for new inbound events. Mount ONCE per dashboard tab via
 * <SoundNotificationsListener /> in the dashboard shell.
 *
 * Two subscriptions:
 * 1. `messages` INSERT — plays for every new customer message that
 *    `shouldNotifyForMessage` would also flag (not the conversation the
 *    user is currently reading).
 * 2. `notifications` INSERT for this user — covers assignments, mentions,
 *    ticket events, etc. A separate ding so the inbox isn't the only
 *    event that gets audio feedback.
 */
export function useSoundNotifications(): void {
  const enabled = useSoundNotifyPref();
  const { accountId, user } = useAuth();
  const userId = user?.id ?? null;
  const seenRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!enabled || !accountId || !userId) return;

    const supabase = createClient();

    const channel = supabase
      .channel("sound-notifications")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `account_id=eq.${accountId}`,
        },
        (payload) => {
          const msg = payload.new as Message;
          const shouldPlay = shouldNotifyForMessage(msg, {
            documentVisible: document.visibilityState === "visible",
            viewingConversationId: new URLSearchParams(window.location.search).get("c"),
            seen: seenRef.current,
          });
          if (shouldPlay) playNotificationSound();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          playNotificationSound();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [enabled, accountId, userId]);
}
