"use client";

import { useCallback, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useAccountSse, type SsePayload } from "@/hooks/use-account-sse";
import type { Message, Conversation } from "@/types";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  enabled?: boolean;
}

export function useRealtime({
  onMessageEvent,
  onConversationEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const { accountId } = useAuth();
  const [isConnected] = useState(true);

  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  onMessageRef.current = onMessageEvent;
  onConversationRef.current = onConversationEvent;

  const active = enabled && !!accountId;

  useAccountSse(
    "messages",
    active
      ? (payload: SsePayload) => {
          onMessageRef.current?.({
            eventType: payload.eventType,
            new: payload.new as Message,
            old: payload.old as Partial<Message>,
          });
        }
      : undefined,
    active,
  );

  useAccountSse(
    "conversations",
    active
      ? (payload: SsePayload) => {
          onConversationRef.current?.({
            eventType: payload.eventType,
            new: payload.new as Conversation,
            old: payload.old as Partial<Conversation>,
          });
        }
      : undefined,
    active,
  );

  const unsubscribe = useCallback(() => {
    // SSE unsubscribe is handled by the hook's cleanup on unmount.
  }, []);

  return { isConnected, unsubscribe };
}
