"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useAccountSse, type SsePayload } from "@/hooks/use-account-sse";
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
 */
export function useSoundNotifications(): void {
  const enabled = useSoundNotifyPref();
  const { accountId, user } = useAuth();
  const userId = user?.id ?? null;
  const seenRef = useRef<Map<string, number>>(new Map());

  const active = enabled && !!accountId && !!userId;

  useAccountSse(
    "messages",
    active
      ? (payload: SsePayload) => {
          if (payload.eventType !== "INSERT") return;
          const msg = payload.new as Message;
          const shouldPlay = shouldNotifyForMessage(msg, {
            documentVisible: document.visibilityState === "visible",
            viewingConversationId: new URLSearchParams(window.location.search).get("c"),
            seen: seenRef.current,
          });
          if (shouldPlay) playNotificationSound();
        }
      : undefined,
    active,
  );

  useAccountSse(
    "notifications",
    active
      ? (payload: SsePayload) => {
          if (payload.eventType !== "INSERT") return;
          if ((payload.new as { user_id?: string }).user_id !== userId) return;
          playNotificationSound();
        }
      : undefined,
    active,
  );

  // Keep seenRef available for effects above.
  useEffect(() => {
    seenRef.current = seenRef.current;
  }, []);
}
