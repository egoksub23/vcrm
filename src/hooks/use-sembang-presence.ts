"use client";

import { useEffect, useRef, useState } from "react";

export interface PresentUser {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

interface UsePresenceResult {
  presentUsers: PresentUser[];
}

const HEARTBEAT_MS = 15_000; // send presence POST every 15 s
const POLL_MS      = 20_000; // read presence GET every 20 s

/**
 * Tracks who else is currently viewing the same Sembang channel.
 *
 * - Sends POST /api/sembang/channels/[id]/presence every 15 s to stay "alive".
 * - Polls GET every 20 s to get the list of other present members.
 * - The server TTL is 30 s, so a disconnected tab clears within one poll cycle.
 */
export function useSembangPresence(
  channelId: string | null,
  userId: string | null,
  userName: string,
  avatarUrl: string | null,
): UsePresenceResult {
  const [presentUsers, setPresentUsers] = useState<PresentUser[]>([]);
  const channelIdRef  = useRef(channelId);
  const userNameRef   = useRef(userName);
  const avatarUrlRef  = useRef(avatarUrl);

  useEffect(() => { channelIdRef.current = channelId }, [channelId]);
  useEffect(() => { userNameRef.current  = userName  }, [userName]);
  useEffect(() => { avatarUrlRef.current = avatarUrl }, [avatarUrl]);

  // Heartbeat — POST to keep our entry alive in the server store.
  useEffect(() => {
    if (!channelId || !userId) return;

    const beat = () => {
      const id = channelIdRef.current;
      if (!id) return;
      void fetch(`/api/sembang/channels/${id}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: userNameRef.current, avatarUrl: avatarUrlRef.current }),
        cache: "no-store",
      }).catch(() => {});
    };

    beat(); // immediate on open
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [channelId, userId]);

  // Poll GET to know who else is here.
  useEffect(() => {
    if (!channelId || !userId) {
      setPresentUsers([]);
      return;
    }

    const poll = async () => {
      const id = channelIdRef.current;
      if (!id) return;
      try {
        const res = await fetch(`/api/sembang/channels/${id}/presence`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { present?: PresentUser[] };
        setPresentUsers(data.present ?? []);
      } catch { /* best-effort */ }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);

    return () => {
      clearInterval(timer);
      setPresentUsers([]);
    };
  }, [channelId, userId]);

  return { presentUsers };
}
