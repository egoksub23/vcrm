"use client";

// Realtime for Sembang — modeled on `useRealtime` (@/hooks/use-realtime.ts):
// ref-stashed callbacks so subscribers don't need to memoize, one
// `.channel()` per hook instance, cleanup on unmount. Two small hooks
// rather than one parametrized one, matching how the two call sites
// actually differ:
//
//  - `useSembangChannelRealtime` — ONE open channel's message list,
//    filtered `channel_id=eq.<id>` so a busy account's other channels
//    don't generate noise in the open thread.
//  - `useSembangSidebarRealtime` — account-wide (unfiltered; RLS already
//    scopes what the caller actually receives) across all three tables,
//    for the channel-list sidebar to reorder/update live.

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

export interface SembangMessageRow {
  id: string;
  channel_id: string;
  account_id: string;
  author_id: string;
  body: string;
  mentions: string[];
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
}

export interface SembangChannelRow {
  id: string;
  account_id: string;
  name: string;
  topic: string | null;
  is_private: boolean;
  created_by: string;
  created_at: string;
  archived_at: string | null;
}

export interface SembangChannelMemberRow {
  channel_id: string;
  account_id: string;
  user_id: string;
  role: "member" | "moderator";
  joined_at: string;
  last_read_at: string;
}

interface UseSembangChannelRealtimeOptions {
  /** null/undefined disables the subscription (no thread open yet). */
  channelId: string | null | undefined;
  onMessageEvent?: (event: RealtimeEvent<SembangMessageRow>) => void;
  enabled?: boolean;
}

/** Realtime for the open channel's message list. */
export function useSembangChannelRealtime({
  channelId,
  onMessageEvent,
  enabled = true,
}: UseSembangChannelRealtimeOptions): { isConnected: boolean } {
  const [isConnected, setIsConnected] = useState(false);

  const onMessageRef = useRef(onMessageEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
  });

  useEffect(() => {
    if (!enabled || !channelId) return;

    const supabase = createClient();
    const channel = supabase
      .channel(`sembang-messages-${channelId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "sembang_messages",
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<SembangMessageRow>["eventType"],
            new: payload.new as SembangMessageRow,
            old: payload.old as Partial<SembangMessageRow>,
          });
        },
      )
      .subscribe((status) => setIsConnected(status === "SUBSCRIBED"));

    return () => {
      supabase.removeChannel(channel);
      setIsConnected(false);
    };
  }, [channelId, enabled]);

  return { isConnected };
}

interface UseSembangSidebarRealtimeOptions {
  onChannelEvent?: (event: RealtimeEvent<SembangChannelRow>) => void;
  onMemberEvent?: (event: RealtimeEvent<SembangChannelMemberRow>) => void;
  /** Unfiltered messages across every channel the caller can see — used
   *  only to know "something changed, re-sort/refetch", not to render
   *  message bodies (the open thread has its own filtered subscription
   *  for that). */
  onMessageEvent?: (event: RealtimeEvent<SembangMessageRow>) => void;
  enabled?: boolean;
}

/** Account-wide realtime for the channel-list sidebar. */
export function useSembangSidebarRealtime({
  onChannelEvent,
  onMemberEvent,
  onMessageEvent,
  enabled = true,
}: UseSembangSidebarRealtimeOptions): { isConnected: boolean } {
  const [isConnected, setIsConnected] = useState(false);

  const onChannelRef = useRef(onChannelEvent);
  const onMemberRef = useRef(onMemberEvent);
  const onMessageRef = useRef(onMessageEvent);
  useEffect(() => {
    onChannelRef.current = onChannelEvent;
    onMemberRef.current = onMemberEvent;
    onMessageRef.current = onMessageEvent;
  });

  useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();
    const channel = supabase
      .channel("sembang-sidebar")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sembang_channels" },
        (payload) => {
          onChannelRef.current?.({
            eventType: payload.eventType as RealtimeEvent<SembangChannelRow>["eventType"],
            new: payload.new as SembangChannelRow,
            old: payload.old as Partial<SembangChannelRow>,
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sembang_channel_members" },
        (payload) => {
          onMemberRef.current?.({
            eventType: payload.eventType as RealtimeEvent<SembangChannelMemberRow>["eventType"],
            new: payload.new as SembangChannelMemberRow,
            old: payload.old as Partial<SembangChannelMemberRow>,
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sembang_messages" },
        (payload) => {
          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<SembangMessageRow>["eventType"],
            new: payload.new as SembangMessageRow,
            old: payload.old as Partial<SembangMessageRow>,
          });
        },
      )
      .subscribe((status) => setIsConnected(status === "SUBSCRIBED"));

    return () => {
      supabase.removeChannel(channel);
      setIsConnected(false);
    };
  }, [enabled]);

  return { isConnected };
}
