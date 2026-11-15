"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface TypingUser {
  userId: string;
  name: string;
}

interface UseTypingIndicatorResult {
  typingUsers: TypingUser[];
  /** Call this whenever the user types in the composer. The hook debounces
   *  the outgoing POST to at most once per 2 000 ms. */
  notifyTyping: () => void;
}

const POLL_MS = 2_000;      // how often to GET the typing list
const THROTTLE_MS = 2_000;  // minimum gap between outgoing POST calls

/**
 * Provides live "X is typing…" data for a Sembang channel.
 *
 * - Polls GET /api/sembang/channels/[id]/typing every 2 s.
 * - Sends POST at most once per 2 s when the user is typing.
 * - Cleans up timers on unmount or when channelId / userId change.
 */
export function useTypingIndicator(
  channelId: string | null,
  userId: string | null,
  userName: string,
): UseTypingIndicatorResult {
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const lastPostRef = useRef<number>(0);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const channelIdRef = useRef(channelId);
  const userNameRef = useRef(userName);

  // Keep refs current so the interval callback always reads the latest
  // values without needing to restart.
  useEffect(() => { channelIdRef.current = channelId }, [channelId]);
  useEffect(() => { userNameRef.current = userName }, [userName]);

  // Poll GET every POLL_MS while a channel is selected.
  useEffect(() => {
    if (!channelId) {
      setTypingUsers([]);
      return;
    }

    async function poll() {
      const id = channelIdRef.current;
      if (!id) return;
      try {
        const res = await fetch(`/api/sembang/channels/${id}/typing`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { typing?: TypingUser[] };
        setTypingUsers(data.typing ?? []);
      } catch {
        // Best-effort — a network hiccup just leaves the previous list.
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    pollTimerRef.current = timer;

    return () => {
      clearInterval(timer);
      pollTimerRef.current = null;
      setTypingUsers([]);
    };
  }, [channelId]);

  const notifyTyping = useCallback(() => {
    const id = channelIdRef.current;
    if (!id || !userId) return;
    const now = Date.now();
    if (now - lastPostRef.current < THROTTLE_MS) return;
    lastPostRef.current = now;
    void fetch(`/api/sembang/channels/${id}/typing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: userNameRef.current }),
      cache: "no-store",
    }).catch(() => {
      // Best-effort — if the POST fails, the indicator just won't show.
    });
  }, [userId]);

  return { typingUsers, notifyTyping };
}
